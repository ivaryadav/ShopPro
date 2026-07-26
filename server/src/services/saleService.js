/**
 * server/src/services/saleService.js
 *
 * Mirrors app/ShopERP_Pro_v8.html's Sale business rules exactly: hard
 * stock validation before saving (saveSale ~line 10029-10040), discount
 * bounds (~line 10046-10047), self-healing invoice numbering (nextInvoiceNo
 * ~line 3952-3964), and stock correction on edit (updateSale ~line
 * 9974-9982 — restore original items' stock, then deduct the new items').
 * Payment handling is delegated to paymentService (see its header for the
 * one documented simplification).
 */
'use strict';

const saleRepository = require('../repositories/saleRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const customerRepository = require('../repositories/customerRepository');
const stockMovementRepository = require('../repositories/stockMovementRepository');
const paymentService = require('./paymentService');
const { ValidationError, NotFoundError, ConflictError } = require('../errors');

/** Matches nextInvoiceNo's self-healing numbering exactly (~line 3952-3964). */
async function nextInvoiceNo(tenantId) {
  const max = await saleRepository.maxInvoiceNumber(tenantId);
  let next = max + 1;
  let no = 'INV-' + String(next).padStart(3, '0');
  while (await saleRepository.invoiceNoExists(tenantId, no)) {
    next += 1;
    no = 'INV-' + String(next).padStart(3, '0');
  }
  return no;
}

async function listSales(tenantId) {
  return saleRepository.listByTenant(tenantId);
}

async function getSale(tenantId, id) {
  const sale = await saleRepository.findById(tenantId, id);
  if (!sale) throw new NotFoundError('Sale not found');
  return sale;
}

/**
 * @param {number} tenantId @param {Array<{productId:number,qty:number}>} items
 * @returns {Promise<Map<number,object>>} productId -> live product row
 */
async function loadAndValidateStock(tenantId, items) {
  if (!items || items.length === 0) throw new ValidationError('Add at least one item');
  const products = new Map();
  const stockErrors = [];
  for (const item of items) {
    const product = await inventoryRepository.findById(tenantId, item.productId);
    if (!product) throw new NotFoundError(`Product ${item.productId} not found`);
    products.set(item.productId, product);
    if (item.qty > product.stock) {
      stockErrors.push(`"${product.name}": selling ${item.qty} but only ${product.stock} in stock`);
    }
  }
  if (stockErrors.length > 0) throw new ValidationError('Stock insufficient: ' + stockErrors.join('; '));
  return products;
}

/** @param {number} subtotal @param {number} discount */
function validateDiscount(subtotal, discount) {
  if (discount < 0) throw new ValidationError('Discount cannot be negative');
  if (discount > subtotal) throw new ValidationError(`Discount (₹${discount}) cannot exceed subtotal (₹${subtotal})`);
}

/**
 * Matches saveSale exactly (~line 10020-10078).
 * @param {{tenantId:number,customerId:number,items:Array<{productId:number,qty:number,price:number}>,
 *   discount?:number,saleDate:string,note?:string,createdBy?:number,
 *   payments?:Array<{method:string,amount:number}>}} params
 */
async function createSale(params) {
  const customer = await customerRepository.findById(params.tenantId, params.customerId);
  if (!customer) throw new ValidationError('Please select a customer');

  const products = await loadAndValidateStock(params.tenantId, params.items);
  const subtotal = params.items.reduce((a, i) => a + i.qty * i.price, 0);
  const discount = Number(params.discount) || 0;
  validateDiscount(subtotal, discount);
  const total = Math.max(0, subtotal - discount);

  const validPayments = paymentService.validateCollectionPayments(params.payments, total);
  const invoiceNo = await nextInvoiceNo(params.tenantId);

  // Decrement stock atomically BEFORE creating the sale row (RC1 Validation
  // fix): loadAndValidateStock's check above is a read-then-act gap — two
  // concurrent createSale calls for the same product could both pass it and
  // both proceed, overselling the last unit. decrementStock now re-validates
  // stock atomically at the moment of the actual UPDATE and reports failure;
  // any failure here reverts this attempt's own decrements (no sale is ever
  // recorded against stock that wasn't truly available) and aborts cleanly.
  const decremented = [];
  for (const item of params.items) {
    const ok = await inventoryRepository.decrementStock(params.tenantId, item.productId, item.qty);
    if (!ok) {
      for (const prev of decremented) await inventoryRepository.incrementStock(params.tenantId, prev.productId, prev.qty);
      throw new ConflictError(`"${products.get(item.productId).name}" no longer has enough stock — it was just sold by another transaction. Please refresh and try again.`);
    }
    decremented.push(item);
  }

  const sale = await saleRepository.create({
    tenantId: params.tenantId, invoiceNo, customerId: params.customerId, subtotal, discount, total,
    saleDate: params.saleDate, note: params.note, createdBy: params.createdBy,
    items: params.items.map((i) => ({ productId: i.productId, productName: products.get(i.productId).name, price: i.price, qty: i.qty })),
  });

  for (const item of params.items) {
    await stockMovementRepository.record({
      tenantId: params.tenantId, productId: item.productId, delta: -item.qty, reason: 'sale',
      referenceType: 'sale', referenceId: sale.id, createdBy: params.createdBy,
    });
  }
  if (validPayments.length) {
    await paymentService.replaceCollectionPayments(params.tenantId, 'sale', sale.id, validPayments, params.saleDate);
  }
  return getSale(params.tenantId, sale.id);
}

/**
 * Matches updateSale exactly (~line 9966-10018): restores original items'
 * stock, deducts new items', full-replaces items and payments.
 * @param {number} tenantId @param {number} id
 * @param {{customerId?:number,items:Array<{productId:number,qty:number,price:number}>,
 *   discount?:number,saleDate?:string,note?:string,payments?:Array<{method:string,amount:number}>}} params
 */
async function updateSale(tenantId, id, params) {
  const existing = await getSale(tenantId, id);
  if (!params.items || params.items.length === 0) throw new ValidationError('Add at least one item');

  const customerId = params.customerId || existing.customer_id;
  const customer = await customerRepository.findById(tenantId, customerId);
  if (!customer) throw new ValidationError('Please select a customer');

  // Restore stock from the original items before deducting the new ones —
  // matches updateSale's own restore-then-deduct order exactly.
  for (const orig of existing.items) {
    if (orig.product_id) {
      await inventoryRepository.incrementStock(tenantId, orig.product_id, orig.qty);
      await stockMovementRepository.record({
        tenantId, productId: orig.product_id, delta: orig.qty, reason: 'sale_edit_restore',
        referenceType: 'sale', referenceId: id, note: `Invoice ${existing.invoice_no} edited`,
      });
    }
  }
  const products = new Map();
  for (const item of params.items) {
    const product = await inventoryRepository.findById(tenantId, item.productId);
    if (!product) throw new NotFoundError(`Product ${item.productId} not found`);
    products.set(item.productId, product);
  }
  // RC1 Validation fix: the original port carried no stock-sufficiency
  // check at all on this path (unlike createSale's loadAndValidateStock) —
  // increasing an item's quantity on edit could silently oversell with no
  // error surfaced. decrementStock is now guarded+atomic; on failure, undo
  // both this loop's own partial decrements AND the original-items restore
  // above, returning inventory to exactly its pre-call state before aborting.
  const decremented = [];
  for (const item of params.items) {
    const ok = await inventoryRepository.decrementStock(tenantId, item.productId, item.qty);
    if (!ok) {
      for (const prev of decremented) await inventoryRepository.incrementStock(tenantId, prev.productId, prev.qty);
      for (const orig of existing.items) {
        if (orig.product_id) await inventoryRepository.decrementStock(tenantId, orig.product_id, orig.qty);
      }
      throw new ConflictError(`"${products.get(item.productId).name}" does not have enough stock for this change — please refresh and try again.`);
    }
    decremented.push(item);
  }
  for (const item of params.items) {
    await stockMovementRepository.record({
      tenantId, productId: item.productId, delta: -item.qty, reason: 'sale',
      referenceType: 'sale', referenceId: id, note: `Invoice ${existing.invoice_no} edited`,
    });
  }

  const subtotal = params.items.reduce((a, i) => a + i.qty * i.price, 0);
  const discount = params.discount !== undefined ? Number(params.discount) || 0 : existing.discount;
  validateDiscount(subtotal, discount);
  const total = Math.max(0, subtotal - discount);
  const saleDate = params.saleDate || existing.sale_date;

  const validPayments = paymentService.validateCollectionPayments(params.payments, total);

  const updated = await saleRepository.update(tenantId, id, {
    customerId, subtotal, discount, total, saleDate, note: params.note,
    items: params.items.map((i) => ({ productId: i.productId, productName: products.get(i.productId).name, price: i.price, qty: i.qty })),
  });

  await paymentService.replaceCollectionPayments(tenantId, 'sale', id, validPayments, saleDate);
  return updated;
}

module.exports = { nextInvoiceNo, listSales, getSale, createSale, updateSale };
