/**
 * Phase 4 test — services/expenseService.js and recurringExpenseService.js.
 * Verifies createExpense/deleteExpense match saveExpense/deleteExpense
 * exactly (~line 12571-12586), and applyForMonth matches
 * applyRecurringExpenses exactly (~line 12291-12310).
 *
 * Usage: node server/src/tests/expenseService.test.js
 */
'use strict';

const expenseRepository = require('../repositories/expenseRepository');
const recurringExpenseRepository = require('../repositories/recurringExpenseRepository');
const expenseService = require('../services/expenseService');
const recurringExpenseService = require('../services/recurringExpenseService');
const { ValidationError, NotFoundError } = require('../errors');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
  else { failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label); }
}
async function assertThrows(fn, ErrorClass, label) {
  try {
    await fn();
    failed++; console.log('  \x1b[31m✗ FAIL\x1b[0m ' + label + ' (did not throw)');
  } catch (e) {
    if (e instanceof ErrorClass) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + label); }
    else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${label} (got ${e.constructor.name}: ${e.message})`); }
  }
}
function patch(mod, overrides) {
  const originals = {};
  for (const [key, fn] of Object.entries(overrides)) { originals[key] = mod[key]; mod[key] = fn; }
  return () => { for (const [key, fn] of Object.entries(originals)) mod[key] = fn; };
}

async function main() {
  console.log('Phase 4: expenseService.js / recurringExpenseService.js tests');
  console.log('');

  await assertThrows(() => expenseService.createExpense({ tenantId: 1, title: '', amount: 100 }), ValidationError, 'createExpense rejects a missing title');
  await assertThrows(() => expenseService.createExpense({ tenantId: 1, title: 'Rent', amount: 0 }), ValidationError, "createExpense rejects amount < 0.01 — matches saveExpense:12576 exactly");
  {
    const restore = patch(expenseRepository, { findById: async () => null });
    await assertThrows(() => expenseService.deleteExpense(1, 999), NotFoundError, 'deleteExpense throws NotFoundError for a nonexistent expense');
    restore();
  }

  // ── applyForMonth ────────────────────────────────────────────────────────
  {
    let expenseCreated = null, lastAppliedSet = null;
    const restore = patch(recurringExpenseRepository, {
      listByTenant: async () => ([
        { id: 1, title: 'Rent', category: 'Rent', amount: 5000, is_active: 1, last_applied: null },
        { id: 2, title: 'Internet', category: 'Utilities', amount: 999, is_active: 0, last_applied: null },
        { id: 3, title: 'Staff Salary', category: 'Salary', amount: 10000, is_active: 1, last_applied: '2026-07' },
      ]),
      setLastApplied: async (t, id, month) => { lastAppliedSet = { id, month }; },
    });
    const restoreExp = patch(expenseRepository, { create: async (data) => { expenseCreated = data; return data; } });
    const applied = await recurringExpenseService.applyForMonth(1, new Date('2026-07-15T00:00:00.000Z'));
    assert(applied === 1, "applyForMonth skips inactive (id 2) and already-applied-this-month (id 3) — matches applyRecurringExpenses:12296-12297 exactly");
    assert(expenseCreated.title === 'Rent (Auto)', "applyForMonth titles the generated expense '<title> (Auto)' — matches ~line 12300 exactly");
    assert(expenseCreated.expenseDate === '2026-07-01', "applyForMonth dates the expense the 1st of the month — matches ~line 12303 exactly");
    assert(lastAppliedSet.id === 1 && lastAppliedSet.month === '2026-07', 'applyForMonth stamps last_applied for the entry it actually applied');
    restore(); restoreExp();
  }
  {
    const restore = patch(recurringExpenseRepository, {
      listByTenant: async () => ([{ id: 1, title: 'Rent', is_active: 1, last_applied: '2026-07' }]),
    });
    const applied = await recurringExpenseService.applyForMonth(1, new Date('2026-07-15T00:00:00.000Z'));
    assert(applied === 0, 'applyForMonth applies nothing when everything active was already applied this month (idempotent re-run)');
    restore();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Test run crashed:', e); process.exit(1); });
