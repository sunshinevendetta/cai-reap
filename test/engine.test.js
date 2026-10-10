// Acceptance tests: CAI spec §18 + mastersheet workflow + GAAP ledger + SOX controls. No network needed.
process.env.CAI_STATE_FILE = 'test-state.json';
process.env.REAP_BASE_URL = 'https://sg.sandbox.api.reap.global';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { reset, load } = await import('../src/store.js');
const E = await import('../src/engine.js');
const L = await import('../src/ledger.js');
const { splitByBps, toCents } = await import('../src/money.js');
const { restrictedReason, VENDORS } = await import('../src/vendors.js');

const EVERLANE = '45720483266646', SATECHI = '44267709005912', DEATHWISH = '42380283346999', PIXIO = '52521820094596';
const monthEnd = () => { E.advanceDays(31); load().reapQueue = []; const p = (load().eclProposals || []).find(x => x.status === 'PENDING_APPROVAL'); if (p) E.approveECL(p.id, 'controller'); }; // Reap calls need network; queue is drained by the server

test('books open with the AR report and agents collect on day one', () => {
  reset();
  const s = load();
  assert.equal(L.balance(s, '1100', '2026-09-30'), 133434200); // sum of AR report buckets
  assert.equal(L.balance(s, '1000', '2026-09-30'), 25000000);
  assert.ok(s.payments.length > 0, 'collections happen on open');
  const p = E.portfolio();
  assert.equal(p.invoices.find(i => i.customerId === EVERLANE).eligibility.eligible, false);
  assert.ok(p.invoices.find(i => i.customerId === SATECHI).eligibility.reasons.includes('NO_DEBIT_AUTHORIZATION'));
  for (const i of p.invoices) if (i.daysUntilDue > 0) assert.equal(i.outstandingCents, i.originalCents, `not-due ${i.id} untouched`);
});

test('partial payment, failure, one debit per day, never over-collects', () => {
  reset();
  const s = load();
  const dw = s.invoices.find(i => i.customerId === DEATHWISH && i.sourceBucket === 'd31_60');
  assert.equal(dw.status, 'PARTIALLY_PAID');
  assert.equal(dw.outstandingCents, 1614600 - 1000000);
  assert.equal(E.runCollectionCycle().filter(r => r.confirmedCents).length, 0, 'second run same day collects nothing');
  assert.equal(s.collections.find(c => c.customerId === PIXIO).status, 'COLLECTION_FAILED');
  E.advanceDays(1);
  assert.equal(dw.status, 'PAID');
  for (const i of s.invoices) assert.ok(s.applications.filter(a => a.invoiceId === i.id).reduce((x, a) => x + a.appliedCents, 0) <= i.originalCents);
});

test('allocation arithmetic 40/25/20/15 with deterministic residual', () => {
  assert.deepEqual(splitByBps(20000000, [{ bps: 4000 }, { bps: 2500 }, { bps: 2000 }, { bps: 1500 }]).map(p => p.cents), [8000000, 5000000, 4000000, 3000000]);
  assert.equal(splitByBps(101, [{ bps: 4000 }, { bps: 2500 }, { bps: 2000 }, { bps: 1500 }]).reduce((a, p) => a + p.cents, 0), 101);
});

test('full month: mastersheet formulas tie to the GL, statements balance, close locks the period', () => {
  reset();
  monthEnd();
  const s = load();
  assert.equal(s.asOf, '2026-10-31');
  assert.ok(s.orders.every(o => o.status === 'BILLED'));
  const row = E.mastersheetRow('2026-10');
  assert.equal(row.beginningAR, 133434200);
  assert.equal(row.endingAR, row.beginningAR + row.billed - row.collections - row.credits);
  assert.ok(row.tieOut.arOk && row.tieOut.cashOk);
  const st = E.statements('2026-10');
  assert.ok(st.trial.balanced, 'trial balance');
  assert.ok(st.balance.balanced, 'A = L + E');
  assert.ok(st.cashFlow.ties && st.cashFlow.indirectTies, 'cash flow direct = indirect = Δcash');
  const rr = E.revenueRecon();
  assert.ok(rr.revenueTies && rr.deferredTies, 'ASC 606 revenue + deferred tie');
  assert.ok(rr.gl.deferred > 0, 'service billed upfront creates a contract liability');
  for (const c of E.reconcile().checks) assert.ok(c.ok, c.id);
  const closed = E.closeMonth('test');
  assert.equal(closed.status, 'CLOSED');
  assert.equal(load().openMonth, '2026-11');
  assert.equal(E.mastersheetRow('2026-11').beginningAR, closed.endingAR);
  assert.equal(E.mastersheetRow('2026-11').beginningCash, closed.endingCash);
  assert.throws(() => L.postJE(load(), { date: '2026-10-15', type: 'TEST', memo: 'late', lines: [{ account: '1000', debit: 1 }, { account: '3000', credit: 1 }] }), /closed/);
});

test('SOX controls effective and hash chains intact after a month', () => {
  reset();
  monthEnd();
  const failing = E.soxControls().filter(c => !c.ok);
  assert.deepEqual(failing.map(c => c.id), []);
  const s = load();
  assert.ok(L.verifyChain(s.journal).ok && L.verifyChain(s.audit).ok && L.verifyChain(s.oplog).ok);
  s.journal[3].memo = 'tampered';
  assert.equal(L.verifyChain(s.journal).ok, false, 'tampering is detected');
});

test('every operation is logged with AR and cash after it', () => {
  reset();
  E.advanceDays(3);
  const s = load();
  assert.ok(s.oplog.some(o => o.action === 'DUE_DATE_MONITORING'));
  assert.ok(s.oplog.some(o => o.action === 'INVOICE_ISSUED'));
  for (const o of s.oplog) assert.equal(typeof o.arAfter, 'number');
});

test('aging subledger ties to GL; customer statement balance = open invoices', () => {
  reset();
  E.advanceDays(10);
  const a = E.arAging();
  assert.ok(a.ties);
  const st = E.customerStatement(DEATHWISH);
  assert.equal(st.balance, st.open.reduce((x, i) => x + i.outstandingCents, 0));
});

test('close is blocked before month end; credit hold blocks new orders', () => {
  reset();
  assert.throws(() => E.closeMonth(), /AT_MONTH_END/);
  E.setCreditHold(PIXIO, true);
  const o = E.createOrder({ customerId: PIXIO, description: 'Monitors', type: 'GOODS', amountCents: 100000, deliveryDate: '2026-10-20' });
  assert.ok(o.validation.includes('CUSTOMER_ON_CREDIT_HOLD'));
});

test('restricted categories are blocked; supported list is clean; recurring rules queue Reap purchases', () => {
  assert.ok(restrictedReason('book a flight to Cancun'));
  assert.ok(restrictedReason('hotel in CDMX'));
  assert.ok(restrictedReason('bottle of tequila'));
  assert.equal(restrictedReason('Leak-Proof Beverage Tumblers'), null);
  for (const v of VENDORS) assert.equal(restrictedReason(v.product), null, v.product);
  reset();
  E.advanceDays(7);
  assert.ok((load().reapQueue || []).some(q => q.kind === 'RECURRING'));
  assert.ok((load().reapQueue || []).some(q => q.kind === 'FULFILLMENT'));
});

test('CFO layer: 20 KPIs, ECL approval with SoD, 13-week forecast', () => {
  reset();
  E.advanceDays(31);
  const p = load().eclProposals.find(x => x.status === 'PENDING_APPROVAL');
  assert.ok(p && p.required > 0, 'ECL proposed at month end');
  assert.throws(() => E.approveECL(p.id, 'accounting-agent'), /Segregation/);
  assert.equal(E.closeChecklist().items.find(i => i.id === 'ECL_ESTIMATE_APPROVED').ok, false);
  E.approveECL(p.id, 'controller');
  assert.equal(L.balance(load(), '1190'), p.required);
  const st = E.statements();
  assert.ok(st.balance.balanced && st.cashFlow.indirectTies, 'allowance keeps A = L + E and indirect CF tying');
  const k = E.cfoKpis();
  assert.equal(k.kpis.length, 20);
  assert.ok(k.kpis.find(x => x.n === 10).value > 0, 'ECL coverage');
  assert.equal(E.forecast13w().weeks.length, 13);
  assert.ok(E.cfoQuestions().decisions.length >= 1);
});

test('decimal parsing never uses floats', () => {
  assert.equal(toCents(840.95), 84095);
  assert.equal(toCents('0.1'), 10);
});
