/**
 * server/src/services/repairService.js
 *
 * Mirrors app/ShopERP_Pro_v8.html's Repair business rules exactly:
 * self-healing job numbering (nextJobNo ~line 3965-3976), part
 * consumption/restoration against inventory stock (addJobPart ~line
 * 11288-11300, removeJobPart ~line 11301-11306, deleteJob ~line
 * 10411-10427), free status transitions including warranty-reopen
 * (setJobStatus ~line 11123-11128), and auto-calculated final cost
 * (saveJobChanges ~line 11319-11334: final_cost = parts + labour, always).
 * No technician_id — explicitly out of scope for this phase.
 */
'use strict';

const repairRepository = require('../repositories/repairRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const customerRepository = require('../repositories/customerRepository');
const stockMovementRepository = require('../repositories/stockMovementRepository');
const paymentRepository = require('../repositories/paymentRepository');
const paymentService = require('./paymentService');
const { ValidationError, NotFoundError } = require('../errors');

const STATUSES = ['Received', 'Diagnosing', 'Repairing', 'Ready', 'Delivered'];

/** Matches nextJobNo's self-healing numbering exactly (~line 3965-3976). */
async function nextJobNo(tenantId) {
  const max = await repairRepository.maxJobNumber(tenantId);
  let next = max + 1;
  let no = 'JOB-' + String(next).padStart(3, '0');
  while (await repairRepository.jobNoExists(tenantId, no)) {
    next += 1;
    no = 'JOB-' + String(next).padStart(3, '0');
  }
  return no;
}

async function listRepairs(tenantId) {
  return repairRepository.listByTenant(tenantId);
}

async function getRepair(tenantId, id) {
  const repair = await repairRepository.findById(tenantId, id);
  if (!repair) throw new NotFoundError('Repair job not found');
  return repair;
}

/**
 * Matches saveJob exactly (~line 10662-10731) for the fields this phase's
 * scope covers. Advance-payment collection at creation is handled via the
 * same optional `payments` param saleService.createSale uses, resolved
 * through paymentService — no separate "advance" concept is modeled, since
 * it is just the same payments table with `payment_date = receivedDate`.
 * @param {{tenantId:number,customerId:number,device:string,issue:string,
 *   estimatedCost?:number,receivedDate:string,estimatedDelivery?:string,
 *   warrantyDays?:number,altWhatsapp?:string,note?:string,createdBy?:number,
 *   payments?:Array<{method:string,amount:number}>}} params
 */
async function createRepair(params) {
  const device = (params.device || '').trim();
  const issue = (params.issue || '').trim();
  if (!params.customerId) throw new ValidationError('Please select a customer');
  if (!device) throw new ValidationError('Device name is required');
  if (!issue) throw new ValidationError('Please describe the issue');

  const customer = await customerRepository.findById(params.tenantId, params.customerId);
  if (!customer) throw new ValidationError('Please select a customer');

  const receivedDate = params.receivedDate;
  const estimatedDelivery = params.estimatedDelivery || null;
  if (estimatedDelivery && receivedDate && estimatedDelivery < receivedDate) {
    throw new ValidationError('Estimated delivery date cannot be before received date');
  }
  const altWhatsapp = (params.altWhatsapp || '').replace(/\D/g, '');
  if (altWhatsapp && altWhatsapp.length !== 10) {
    throw new ValidationError('Alternate WhatsApp number must be exactly 10 digits');
  }
  const estimatedCost = Number(params.estimatedCost) || 0;
  if (estimatedCost < 0) throw new ValidationError('Estimated cost cannot be negative');
  const warrantyDays = params.warrantyDays !== undefined ? parseInt(params.warrantyDays, 10) || 0 : 30;
  if (warrantyDays < 0) throw new ValidationError('Warranty days cannot be negative');

  const jobNo = await nextJobNo(params.tenantId);
  const repair = await repairRepository.create({
    tenantId: params.tenantId, jobNo, customerId: params.customerId, device, issue, estimatedCost,
    receivedDate, estimatedDelivery, warrantyDays, altWhatsapp, note: params.note, createdBy: params.createdBy,
  });

  if (params.payments && params.payments.length) {
    // Matches saveJob's advance-collection guard (~line 10702): advance
    // cannot exceed the estimated cost.
    const validPayments = paymentService.validateCollectionPayments(params.payments, estimatedCost || Infinity);
    await paymentService.replaceCollectionPayments(params.tenantId, 'repair', repair.id, validPayments, receivedDate);
  }
  return getRepair(params.tenantId, repair.id);
}

/**
 * Matches addJobPart exactly (~line 11288-11300): merges qty into an
 * existing part row for the same product, validates against live stock,
 * decrements it.
 * @param {number} tenantId @param {number} repairId
 * @param {{productId:number,qty?:number,actorUserId?:number}} params
 */
async function addPart(tenantId, repairId, params) {
  await getRepair(tenantId, repairId);
  const qty = parseInt(params.qty, 10) || 1;
  const product = await inventoryRepository.findById(tenantId, params.productId);
  if (!product) throw new NotFoundError('Product not found');
  if (product.stock < qty) throw new ValidationError(`Only ${product.stock} unit(s) of "${product.name}" in stock`);

  await repairRepository.addOrMergePart(tenantId, repairId, {
    productId: product.id, productName: product.name, price: product.sell_price, qty,
  });
  await inventoryRepository.decrementStock(tenantId, product.id, qty);
  await stockMovementRepository.record({
    tenantId, productId: product.id, delta: -qty, reason: 'repair_parts',
    referenceType: 'repair', referenceId: repairId, createdBy: params.actorUserId,
  });
  return recalculateFinalCost(tenantId, repairId);
}

/** Matches removeJobPart exactly (~line 11301-11306): restores the part's qty to stock. */
async function removePart(tenantId, repairId, partId, actorUserId) {
  await getRepair(tenantId, repairId);
  const removed = await repairRepository.removePart(tenantId, repairId, partId);
  if (!removed) throw new NotFoundError('Part not found on this job');
  if (removed.product_id) {
    await inventoryRepository.incrementStock(tenantId, removed.product_id, removed.qty);
    await stockMovementRepository.record({
      tenantId, productId: removed.product_id, delta: removed.qty, reason: 'repair_parts',
      referenceType: 'repair', referenceId: repairId, createdBy: actorUserId,
    });
  }
  return recalculateFinalCost(tenantId, repairId);
}

/** Matches saveJobChanges' auto-calculation exactly (~line 11319-11334): final_cost = parts + labour, always. */
async function recalculateFinalCost(tenantId, repairId, labourCharge) {
  const repair = await getRepair(tenantId, repairId);
  const labour = labourCharge !== undefined ? Number(labourCharge) || 0 : Number(repair.labour_charge) || 0;
  if (labour < 0) throw new ValidationError('Labour charge cannot be negative');
  const partsTotal = repair.partsUsed.reduce((a, p) => a + p.qty * p.price, 0);
  const finalCost = partsTotal + labour;
  await repairRepository.updateFinancials(tenantId, repairId, labour, finalCost);
  return getRepair(tenantId, repairId);
}

/** Matches setJobStatus exactly (~line 11123-11128): free transition to any of the 5 states, auto-stamps delivered_date once. */
async function updateStatus(tenantId, id, status, deliveredDate) {
  if (!STATUSES.includes(status)) throw new ValidationError(`Unknown status '${status}'`);
  await getRepair(tenantId, id);
  await repairRepository.updateStatus(tenantId, id, status, deliveredDate);
  return getRepair(tenantId, id);
}

/**
 * Matches collectRepairPayment/doCollectRepairPayment exactly (~line
 * 8076-8115): due = final_cost - already paid; payments append (not
 * replace, unlike editSale) since local.js's `r.payments.push(...)`
 * appends rather than overwrites.
 */
async function collectPayment(tenantId, id, payments, paymentDate) {
  const repair = await getRepair(tenantId, id);
  const due = Math.max(0, Number(repair.final_cost) - Number(repair.paid));
  if (due <= 0) throw new ValidationError('This job is fully paid');
  const validPayments = paymentService.validateCollectionPayments(payments, due);
  if (!validPayments.length) throw new ValidationError('Enter amount to collect');
  for (const p of validPayments) {
    await paymentRepository.create({
      tenantId, sourceType: 'repair', sourceId: id, direction: 'in', method: p.method, amount: p.amount, paymentDate,
    });
  }
  return getRepair(tenantId, id);
}

/** Matches deleteJob exactly (~line 10411-10427): restores every part's qty to stock before deleting. */
async function deleteRepair(tenantId, id, actorUserId) {
  const repair = await getRepair(tenantId, id);
  for (const part of repair.partsUsed) {
    if (part.product_id) {
      await inventoryRepository.incrementStock(tenantId, part.product_id, part.qty);
      await stockMovementRepository.record({
        tenantId, productId: part.product_id, delta: part.qty, reason: 'repair_delete_restore',
        referenceType: 'repair', referenceId: id, note: `Job ${repair.job_no} deleted`, createdBy: actorUserId,
      });
    }
  }
  await repairRepository.remove(tenantId, id);
}

module.exports = {
  nextJobNo, listRepairs, getRepair, createRepair, addPart, removePart,
  recalculateFinalCost, updateStatus, collectPayment, deleteRepair, STATUSES,
};
