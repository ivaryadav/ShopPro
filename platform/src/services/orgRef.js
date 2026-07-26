/**
 * platform/src/services/orgRef.js
 *
 * An organization ID reaching any Z-SUPERADMIN endpoint is one of two
 * things: a plain integer (a genuinely platform-owned `organizations` row
 * — used for products with no adapter yet), or a synthetic "<slug>:<id>"
 * string (an adapter-backed organization living entirely inside that
 * product's own database — ShopERP today). Every service that takes an
 * organization ID resolves it here ONCE, so the adapter-dispatch logic
 * isn't duplicated across organizationService/licenseService/etc.
 */
'use strict';

const { getAdapter } = require('../adapters');

/**
 * @param {string|number} rawId
 * @returns {{isAdapter:boolean, slug?:string, sourceId?:string, adapter?:object, localId?:number}}
 */
function resolve(rawId) {
  const s = String(rawId);
  const colonIdx = s.indexOf(':');
  if (colonIdx > 0) {
    const slug = s.slice(0, colonIdx);
    const sourceId = s.slice(colonIdx + 1);
    const adapter = getAdapter(slug);
    if (adapter) return { isAdapter: true, slug, sourceId, adapter };
  }
  return { isAdapter: false, localId: Number(rawId) };
}

module.exports = { resolve };
