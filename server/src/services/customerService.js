/**
 * server/src/services/customerService.js
 *
 * Mirrors app/ShopERP_Pro_v8.html's Customer business rules. local.js has
 * a genuine, pre-existing inconsistency here (OperationsSchemaDesign.md,
 * confirmed again against the live code): saveCustomer (~line 11766-11789,
 * the full "Add Customer" form) warns on a duplicate phone but lets the
 * user confirm through it (`confirm('... Add anyway?')`), while
 * saveCustomerAndReturnToSale / the quick-add-from-POS path (~line 10158-10173)
 * hard-blocks any duplicate with no override. A stateless REST API can't
 * show a JS confirm() dialog, so this service reproduces BOTH real code
 * paths via an explicit `allowDuplicate` parameter — default false (hard
 * block, matching quick-add), true reproduces the "confirmed anyway" path
 * — rather than silently collapsing two real, different behaviors into one.
 */
'use strict';

const customerRepository = require('../repositories/customerRepository');
const { ValidationError, ConflictError, NotFoundError } = require('../errors');

const PHONE_RE = /^\d{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

function validate(name, phone, email) {
  if (!name) throw new ValidationError('Name is required');
  if (!PHONE_RE.test(phone)) throw new ValidationError('Phone must be exactly 10 digits');
  if (email && !EMAIL_RE.test(email)) throw new ValidationError('Invalid email address');
}

async function listCustomers(tenantId) {
  return customerRepository.listByTenant(tenantId);
}

async function getCustomer(tenantId, id) {
  const customer = await customerRepository.findById(tenantId, id);
  if (!customer) throw new NotFoundError('Customer not found');
  return customer;
}

/**
 * @param {{tenantId:number,name:string,phone:string,email?:string,address?:string,
 *   type?:string,note?:string,allowDuplicate?:boolean}} params
 */
async function createCustomer(params) {
  const name = (params.name || '').trim();
  const phone = normalizePhone(params.phone);
  const email = (params.email || '').trim();
  validate(name, phone, email);

  const dup = await customerRepository.findByPhone(params.tenantId, phone);
  if (dup && !params.allowDuplicate) {
    throw new ConflictError(`Phone already registered to "${dup.name}"`);
  }

  return customerRepository.create({
    tenantId: params.tenantId, name, phone, email, address: params.address, type: params.type, note: params.note,
  });
}

/** Matches doEditCustomer (~line 11819) — same duplicate-check semantics as create, excluding self. */
async function updateCustomer(tenantId, id, params) {
  await getCustomer(tenantId, id);
  const name = (params.name || '').trim();
  const phone = normalizePhone(params.phone);
  const email = (params.email || '').trim();
  validate(name, phone, email);

  const dup = await customerRepository.findByPhone(tenantId, phone, id);
  if (dup && !params.allowDuplicate) {
    throw new ConflictError(`Phone already registered to "${dup.name}"`);
  }

  return customerRepository.update(tenantId, id, {
    name, phone, email, address: params.address, type: params.type, note: params.note,
  });
}

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer };
