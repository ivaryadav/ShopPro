/**
 * platform/src/services/productRegistryService.js — the Product Registry.
 * Registering ZLAB/ZHospital/etc. "for real" one day is exactly the same
 * shape of call createProduct() already supports today — configuration,
 * not code (Non-Negotiable Principle #4).
 */
'use strict';

const productRepository = require('../repositories/platformProductRepository');
const auditService = require('./auditService');
const { ValidationError, NotFoundError, ConflictError } = require('../errors');

function listProducts() {
  return productRepository.listAll().map(mapProduct);
}
function getProduct(id) {
  const p = productRepository.findById(id);
  if (!p) throw new NotFoundError('Product not found');
  return mapProduct(p);
}
function createProduct(data, actor) {
  if (!data.name || !data.slug) throw new ValidationError('name and slug are required');
  if (productRepository.findBySlug(data.slug)) throw new ConflictError('A product with this slug already exists');
  const product = productRepository.create(data);
  auditService.record({ platformUserId: actor.userId, productId: product.id, action: 'PRODUCT_REGISTERED', detail: `${product.name} (${product.slug})`, ip: actor.ip });
  return mapProduct(product);
}
function updateProduct(id, data, actor) {
  const existing = productRepository.findById(id);
  if (!existing) throw new NotFoundError('Product not found');
  const updated = productRepository.update(id, data);
  auditService.record({ platformUserId: actor.userId, productId: id, action: 'PRODUCT_UPDATED', oldValue: existing.status, newValue: updated.status, detail: `${updated.name} updated`, ip: actor.ip });
  return mapProduct(updated);
}
function mapProduct(p) {
  return {
    id: p.id, name: p.name, slug: p.slug, logoUrl: p.logo_url, description: p.description, version: p.version,
    status: p.status, licenseModel: p.license_model,
    featureFlags: JSON.parse(p.feature_flags || '[]'), routes: JSON.parse(p.routes || '[]'), permissions: JSON.parse(p.permissions || '[]'),
    createdAt: p.created_at,
  };
}

module.exports = { listProducts, getProduct, createProduct, updateProduct };
