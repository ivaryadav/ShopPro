/**
 * server/src/services/inventoryService.js
 *
 * Mirrors app/ShopERP_Pro_v8.html's Inventory business rules exactly
 * (saveProduct/updateProduct/doAdjustStock/deleteProduct, ~line
 * 9057-9161). Server-side authorization for cost-price editing and
 * adjust/delete actions is NOT added here — local.js's own server has no
 * such gate today (the disabled cost-price input and the role check in
 * doAdjustStock/deleteProduct are pure client-side UI conveniences with
 * no backend enforcement in the current architecture); adding one now
 * would invent a restriction, not extract one. Route-level requireAuth/
 * requireActive still applies to every endpoint.
 */
'use strict';

const inventoryRepository = require('../repositories/inventoryRepository');
const stockMovementRepository = require('../repositories/stockMovementRepository');
const { ValidationError, ConflictError, NotFoundError } = require('../errors');

/** @param {string} imei */
function validateImei(imei) {
  if (!imei) return;
  if (!/^\d{15}$/.test(imei)) throw new ValidationError('IMEI must be exactly 15 digits');
}

async function listInventory(tenantId) {
  return inventoryRepository.listByTenant(tenantId);
}

async function getProduct(tenantId, id) {
  const product = await inventoryRepository.findById(tenantId, id);
  if (!product) throw new NotFoundError('Product not found');
  return product;
}

/**
 * Matches saveProduct exactly (~line 9057-9081).
 * @param {{tenantId:number,name:string,category?:string,sku?:string,imei?:string,
 *   costPrice?:number,sellPrice:number,stock?:number,minStock?:number,unit?:string}} params
 */
async function createProduct(params) {
  const name = (params.name || '').trim();
  const costPrice = Number(params.costPrice) || 0;
  const sellPrice = Number(params.sellPrice);
  const imei = (params.imei || '').trim();

  if (!name) throw new ValidationError('Product name is required');
  if (!Number.isFinite(sellPrice) || sellPrice < 0) throw new ValidationError('Sell price must be a non-negative number');
  if (sellPrice < costPrice) throw new ValidationError(`Sell price cannot be less than cost price (₹${costPrice})`);
  validateImei(imei);
  if (imei) {
    const dup = await inventoryRepository.findByImei(params.tenantId, imei);
    if (dup) throw new ConflictError(`IMEI already registered to "${dup.name}"`);
  }

  const created = await inventoryRepository.create({
    tenantId: params.tenantId, name, category: params.category, sku: (params.sku || '').trim() || null,
    imei: imei || null, costPrice, sellPrice, stock: parseInt(params.stock, 10) || 0,
    minStock: params.minStock !== undefined ? parseInt(params.minStock, 10) || 0 : 2, unit: params.unit,
  });

  // Matches saveProduct's 'PRD-'+padded fallback (~line 9073) — local.js
  // uses a pre-increment counter; here the AUTO_INCREMENT id fills the
  // same "auto-generated, distinguishing" role.
  if (!created.sku) {
    return inventoryRepository.update(params.tenantId, created.id, { ...created, sku: 'PRD-' + String(created.id).padStart(3, '0') });
  }
  return created;
}

/** Matches updateProduct exactly (~line 9105-9127). */
async function updateProduct(tenantId, id, params) {
  const existing = await getProduct(tenantId, id);
  const name = (params.name || '').trim() || existing.name;
  const costPrice = params.costPrice !== undefined ? Number(params.costPrice) || 0 : existing.cost_price;
  const sellPrice = Number(params.sellPrice);
  const imei = (params.imei || '').trim();

  if (!name) throw new ValidationError('Product name is required');
  if (!Number.isFinite(sellPrice) || sellPrice < 0) throw new ValidationError('Sell price must be a non-negative number');
  if (sellPrice < costPrice) throw new ValidationError(`Sell price (₹${sellPrice}) cannot be less than cost price (₹${costPrice})`);
  validateImei(imei);
  if (imei) {
    const dup = await inventoryRepository.findByImei(tenantId, imei, id);
    if (dup) throw new ConflictError(`IMEI already registered to "${dup.name}"`);
  }

  return inventoryRepository.update(tenantId, id, {
    name, category: params.category !== undefined ? params.category : existing.category,
    sku: (params.sku || '').trim() || existing.sku, imei: imei || null, costPrice, sellPrice,
    stock: params.stock !== undefined ? parseInt(params.stock, 10) || 0 : existing.stock,
    minStock: params.minStock !== undefined ? parseInt(params.minStock, 10) || 0 : existing.min_stock,
  });
}

/**
 * Matches doAdjustStock exactly (~line 9142-9153): add/remove/set, clamped
 * at 0, always reads-then-writes (not the atomic helpers) so the recorded
 * stock_movement delta reflects the true prev→new change, matching
 * local.js's own audit log message exactly.
 * @param {number} tenantId @param {number} id
 * @param {{type:'add'|'remove'|'set',qty:number,note?:string,actorUserId?:number}} params
 */
async function adjustStock(tenantId, id, params) {
  const qty = parseInt(params.qty, 10) || 0;
  if (qty <= 0) throw new ValidationError('Quantity must be at least 1');
  const product = await getProduct(tenantId, id);
  const prev = product.stock;
  let next;
  if (params.type === 'add') next = prev + qty;
  else if (params.type === 'remove') next = Math.max(0, prev - qty);
  else next = Math.max(0, qty);

  await inventoryRepository.setStock(tenantId, id, next);
  await stockMovementRepository.record({
    tenantId, productId: id, delta: next - prev, reason: 'manual_adjust',
    note: params.note, createdBy: params.actorUserId,
  });
  return getProduct(tenantId, id);
}

/**
 * Matches deleteProduct's unconditional hard delete (~line 9155-9161). A
 * final stock_movement is recorded for audit completeness before the row
 * disappears (see migrations/002_operations_domain.sql header) — this
 * does not restore or change any OTHER product's stock, purely a log entry.
 */
async function deleteProduct(tenantId, id, actorUserId) {
  const product = await getProduct(tenantId, id);
  await stockMovementRepository.record({
    tenantId, productId: id, delta: -product.stock, reason: 'product_delete_restore',
    note: 'Product deleted', createdBy: actorUserId,
  });
  await inventoryRepository.remove(tenantId, id);
}

module.exports = { listInventory, getProduct, createProduct, updateProduct, adjustStock, deleteProduct };
