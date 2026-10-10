// CAI engine — deterministic Order-to-Cash + Record-to-Report, US GAAP ledger, SOX controls.
// 1 Order entry → 2 Rev-rec trigger → 3 Revenue recognition → 4 Billing → 5 Collections → 6 Cash application
// → 7 Treasury → 8 Expenses/AP → 9 Month-end close. Reap Agentic is the payment rail for every spend.
import { load, save, audit, id, apBillsFor, onFresh } from './store.js';
import { reap, ReapError } from './reap.js';
import { toCents, splitByBps, daysBetween, fmt } from './money.js';
import { ALLOCATION_POLICY, SPEND_POLICY, SHIP_TO, BUYER_EMAIL, RECURRING_RULES } from './seed.js';
import { VENDORS, vendorBySku, cartUrl, restrictedReason } from './vendors.js';
import { postJE, balance, op, verifyChain, periodNet, trialBalance, incomeStatement, balanceSheet, cashFlow, AP_ACCOUNT, CAPITALIZATION_THRESHOLD_CENTS, COA } from './ledger.js';

// Reap requires an https return URL. Locally we fall back to a placeholder and the dashboard polls status.
const PUBLIC_URL = () => {
  const u = process.env.PUBLIC_URL || '';
  return u.startsWith('https://') ? u.replace(/\/$/, '') : 'https://example.com/cai';
};
// Sandbox only: charges are simulated with X-Simulate-Checkout: COMPLETED — no real money moves.
const SIMULATE = () => process.env.REAP_SIMULATE_CHECKOUT !== 'false';

// ---------- dates & helpers ----------
export const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monthStart = m => `${m}-01`;
const monthEnd = m => addDays(addDays(monthStart(m), 32).slice(0, 8) + '01', -1);
const nextMonth = m => addDays(monthEnd(m), 1).slice(0, 7);
const inMonth = (iso, m) => !!iso && iso.slice(0, 7) === m;
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const weekday = iso => new Date(iso + 'T00:00:00Z').getUTCDay();
const $en = c => fmt(c, 'en'), $es = c => fmt(c, 'es');
const custName = (s, cid) => s.customers.find(c => c.id === cid)?.legalName || cid;
const bizErr = (msg, code) => Object.assign(new Error(msg), { status: 400, code });

// ---------- state machines ----------
const LEGAL = {
  collection: {
    ELIGIBLE: ['COLLECTION_REQUESTED'],
    COLLECTION_REQUESTED: ['COLLECTION_PENDING', 'COLLECTION_FAILED'],
    COLLECTION_PENDING: ['COLLECTION_CONFIRMED', 'COLLECTION_FAILED', 'COLLECTION_REVIEW_REQUIRED'],
    COLLECTION_CONFIRMED: ['COLLECTION_REVERSED'],
  },
  purchase: {
    PROPOSED: ['NEEDS_APPROVAL', 'APPROVED', 'REJECTED'],
    NEEDS_APPROVAL: ['APPROVED', 'REJECTED'],
    APPROVED: ['REQUIRES_ACTION', 'PROCESSING', 'COMPLETED', 'FAILED'],
    REQUIRES_ACTION: ['PROCESSING', 'COMPLETED', 'FAILED', 'EXPIRED'],
    PROCESSING: ['COMPLETED', 'FAILED'],
  },
  order: {
    BOOKED: ['VALIDATED', 'VALIDATION_FAILED'],
    VALIDATION_FAILED: ['VALIDATED'],
    VALIDATED: ['DELIVERED', 'IN_SERVICE'],
    DELIVERED: ['BILLED'],
    IN_SERVICE: ['BILLED'],
  },
};

function transition(kind, obj, to, actor, payload = {}) {
  const from = obj.status;
  if (!(LEGAL[kind][from] || []).includes(to)) throw new Error(`Illegal ${kind} transition ${from} -> ${to}`);
  obj.status = to;
  obj.updatedAt = new Date().toISOString();
  audit({ entityType: kind, entityId: obj.id, event: 'STATE_CHANGED', actor, from, to, payload });
}

function exception(entityType, entityId, reason, severity = 'MEDIUM', detail = {}) {
  const s = load();
  const dup = s.exceptions.find(e => e.entityId === entityId && e.reason === reason && e.status === 'OPEN');
  if (dup) return dup;
  const ex = { id: id('exc'), entityType, entityId, reason, severity, detail, status: 'OPEN', date: s.asOf, createdAt: new Date().toISOString() };
  s.exceptions.push(ex);
  audit({ entityType: 'exception', entityId: ex.id, event: 'EXCEPTION_CREATED', payload: { entityType, entityId, reason } });
  return ex;
}

export function resolveException(excId, note = '', actor = 'controller') {
  const ex = load().exceptions.find(e => e.id === excId);
  if (!ex) throw bizErr('Exception not found');
  ex.status = 'RESOLVED'; ex.resolution = note; ex.resolvedBy = actor;
  audit({ entityType: 'exception', entityId: ex.id, event: 'EXCEPTION_RESOLVED', actor, payload: { note } });
  save();
  return ex;
}

// =====================================================================
// OPEN THE BOOKS (runs on every fresh state)
// =====================================================================
onFresh(s => {
  const ar = sum(s.invoices, i => i.outstandingCents);
  const je = postJE(s, {
    date: '2026-09-30', type: 'OPENING', step: 0, preparer: 'controller',
    memo: 'Opening balances — AR report US11 (aging snapshot) and operating cash',
    lines: [{ account: '1000', debit: s.openingCashCents }, { account: '1100', debit: ar }, { account: '3000', credit: s.openingCashCents + ar }],
  });
  op(s, { step: 0, action: 'BOOKS_OPENED', date: '2026-09-30', je, amountCents: ar, actor: 'controller',
    en: `Books opened: AR ${$en(ar)} from the AR report (${s.invoices.length} invoices, ${s.customers.length} customers), cash ${$en(s.openingCashCents)} kept as liquidity reserve.`,
    es: `Libros abiertos: CxC ${$es(ar)} del reporte de cartera (${s.invoices.length} facturas, ${s.customers.length} clientes), caja ${$es(s.openingCashCents)} como reserva de liquidez.` });
  accrueBills(s, s.apBills);
  s.recurring = RECURRING_RULES.map(r => ({ ...r, active: true, approvedBy: 'controller', approvedOn: '2026-10-01', runs: [] }));
  op(s, { step: 8, action: 'RECURRING_RULES_APPROVED', actor: 'controller', date: '2026-10-01', controls: ['C-SPD-01'],
    en: `${s.recurring.length} recurring Reap standing orders approved by the controller (per-run caps). The spend agent executes them on schedule.`,
    es: `${s.recurring.length} órdenes recurrentes Reap aprobadas por el contralor (tope por ejecución). El agente de gasto las ejecuta según calendario.` });
  // Agents start the business day: monitor due dates and collect what is due today.
  dailyMonitoring(s);
  runCollectionCycle('collection-agent');
  snapshotForecast(s);
});

function accrueBills(s, bills) {
  for (const b of bills) {
    const dup = s.apBills.find(x => x !== b && x.vendor === b.vendor && x.cents === b.cents && x.dueDate === b.dueDate);
    if (dup) { b.status = 'HELD'; exception('apBill', b.id, 'POSSIBLE_DUPLICATE_SUPPLIER_INVOICE', 'HIGH', { duplicateOf: dup.id }); continue; }
    const date = b.dueDate.slice(0, 8) + '01';
    const je = postJE(s, { date, type: 'AP_ACCRUAL', step: 8, preparer: 'ap-agent', memo: `Accrue ${b.vendor} (${b.id})`, source: { type: 'apBill', id: b.id },
      lines: [{ account: AP_ACCOUNT[b.category], debit: b.cents, costCenter: b.costCenter }, { account: '2000', credit: b.cents }] });
    b.accrualJE = je.id;
    op(s, { step: 8, action: 'AP_ACCRUED', ref: b.id, je, amountCents: b.cents, actor: 'ap-agent', date,
      en: `Bill accrued: ${b.vendor} ${$en(b.cents)} due ${b.dueDate} (Dr ${AP_ACCOUNT[b.category]} / Cr 2000 AP).`,
      es: `Factura de proveedor provisionada: ${b.vendor} ${$es(b.cents)} vence ${b.dueDate} (Cargo ${AP_ACCOUNT[b.category]} / Abono 2000 CxP).` });
  }
}

// =====================================================================
// 1. ORDER ENTRY
// =====================================================================
export function validateOrder(o, s = load()) {
  const issues = [];
  const cust = s.customers.find(c => c.id === o.customerId);
  if (!cust) issues.push('UNKNOWN_CUSTOMER');
  if (cust?.creditHold) issues.push('CUSTOMER_ON_CREDIT_HOLD');
  if (!o.description) issues.push('MISSING_DESCRIPTION');
  if (!(o.amountCents > 0)) issues.push('INVALID_PRICE');
  if (!o.terms) issues.push('MISSING_PAYMENT_TERMS');
  if (o.type === 'GOODS' && !o.deliveryDate) issues.push('MISSING_DELIVERY_DATE');
  if (o.type === 'SERVICE' && !(o.serviceStart && o.serviceEnd && o.serviceEnd >= o.serviceStart)) issues.push('INVALID_SERVICE_PERIOD');
  if (!['GOODS', 'SERVICE'].includes(o.type)) issues.push('INVALID_TYPE');
  if (cust) {
    const open = sum(s.invoices.filter(i => i.customerId === cust.id), i => i.outstandingCents);
    const pastDue = sum(s.invoices.filter(i => i.customerId === cust.id && i.dueDate < s.asOf), i => i.outstandingCents);
    if (open > 0 && pastDue / open > 0.9) issues.push('CUSTOMER_MOSTLY_PAST_DUE');
  }
  return issues;
}

export function createOrder(input, actor = 'operator') {
  const s = load();
  const o = {
    id: `SO-${1001 + s.orders.length}`, terms: 'NET30', currency: 'USD', bookedDate: s.asOf, status: 'BOOKED', validation: null,
    customerId: input.customerId, description: input.description, type: input.type || 'GOODS',
    amountCents: Math.round(Number(input.amountCents)), deliveryDate: input.deliveryDate || null,
    serviceStart: input.serviceStart || null, serviceEnd: input.serviceEnd || null,
    fulfillment: input.type === 'SERVICE' ? { vendorSku: 'baronfig.com:45798527860819', quantity: 1, reason: 'Field kit for service engagement' } : { vendorSku: 'packagefreeshop.com:43868446261345', quantity: 3, reason: 'Packing & cleaning supplies for shipment' },
  };
  s.orders.push(o);
  audit({ entityType: 'order', entityId: o.id, event: 'ORDER_BOOKED', actor, payload: { customer: o.customerId, amount: o.amountCents } });
  op(s, { step: 1, action: 'ORDER_BOOKED', ref: o.id, amountCents: o.amountCents, actor,
    en: `Order ${o.id} booked for ${custName(s, o.customerId)}: ${o.description} — ${$en(o.amountCents)} (${o.type}).`,
    es: `Pedido ${o.id} registrado para ${custName(s, o.customerId)}: ${o.description} — ${$es(o.amountCents)} (${o.type}).` });
  runOrderValidation(o, 'order-agent');
  save();
  return o;
}

function runOrderValidation(o, actor = 'order-agent') {
  const s = load();
  const issues = validateOrder(o);
  o.validation = issues;
  transition('order', o, issues.length ? 'VALIDATION_FAILED' : 'VALIDATED', actor, { issues });
  if (issues.length) exception('order', o.id, issues.join(','), 'MEDIUM');
  op(s, { step: 1, action: issues.length ? 'ORDER_HELD' : 'ORDER_VALIDATED', ref: o.id, actor, controls: ['C-OTC-01'], level: issues.length ? 'WARN' : 'INFO',
    en: issues.length ? `Order ${o.id} held by order agent: ${issues.join(', ')}.` : `Order ${o.id} validated (customer, credit, price, terms, dates).`,
    es: issues.length ? `Pedido ${o.id} retenido por el agente de pedidos: ${issues.join(', ')}.` : `Pedido ${o.id} validado (cliente, crédito, precio, términos, fechas).` });
}

export function revalidateOrder(orderId, actor = 'operator') {
  const s = load();
  const o = s.orders.find(x => x.id === orderId);
  if (!o || o.status !== 'VALIDATION_FAILED') throw bizErr('Only held orders can be revalidated');
  const issues = validateOrder(o);
  o.validation = issues;
  if (!issues.length) {
    transition('order', o, 'VALIDATED', actor);
    op(s, { step: 1, action: 'ORDER_VALIDATED', ref: o.id, actor, en: `Order ${o.id} released after revalidation.`, es: `Pedido ${o.id} liberado tras revalidación.` });
  }
  save();
  return o;
}

// =====================================================================
// 2/3. REVENUE RECOGNITION (ASC 606) — goods at a point in time, services ratably over time.
// =====================================================================
export function recognizedThrough(o, upTo) {
  if (!['DELIVERED', 'IN_SERVICE', 'BILLED'].includes(o.status)) return 0;
  if (o.type === 'GOODS') return o.deliveryDate <= upTo ? o.amountCents : 0;
  const total = daysBetween(o.serviceStart, o.serviceEnd) + 1;
  const elapsed = Math.min(total, Math.max(0, daysBetween(o.serviceStart, upTo) + 1));
  return Math.floor((o.amountCents * elapsed) / total);
}

// 4. BILLING + revenue postings for the day.
function processOrdersForDay(day) {
  const s = load();
  const log = [];
  for (const o of s.orders.filter(o => o.status === 'BOOKED')) runOrderValidation(o);
  for (const o of s.orders.filter(o => o.status === 'VALIDATION_FAILED')) {
    if (validateOrder(o).length) continue;
    o.validation = [];
    transition('order', o, 'VALIDATED', 'order-agent', { recheck: day });
    for (const e of s.exceptions.filter(e => e.entityId === o.id && e.status === 'OPEN')) { e.status = 'RESOLVED'; e.resolution = 'Revalidated by order agent'; }
    op(s, { step: 1, action: 'ORDER_VALIDATED', ref: o.id, actor: 'order-agent', en: `Order ${o.id} auto-released: customer cleared past-due balance.`, es: `Pedido ${o.id} liberado: el cliente liquidó su saldo vencido.` });
  }
  for (const o of s.orders.filter(o => o.status === 'VALIDATED')) {
    const trigger = o.type === 'GOODS' ? o.deliveryDate : o.serviceStart;
    if (!trigger || trigger > day) continue;
    transition('order', o, o.type === 'GOODS' ? 'DELIVERED' : 'IN_SERVICE', 'order-agent', { date: trigger });
    op(s, { step: 2, action: o.type === 'GOODS' ? 'DELIVERED' : 'SERVICE_STARTED', ref: o.id, actor: 'order-agent',
      en: o.type === 'GOODS' ? `${o.id} delivered to ${custName(s, o.customerId)} — control transferred, revenue trigger fired.` : `${o.id} service period started (${o.serviceStart} → ${o.serviceEnd}) — performance obligation satisfied over time.`,
      es: o.type === 'GOODS' ? `${o.id} entregado a ${custName(s, o.customerId)} — se transfirió el control, se dispara el reconocimiento.` : `${o.id} inicia periodo de servicio (${o.serviceStart} → ${o.serviceEnd}) — obligación satisfecha a lo largo del tiempo.` });
    const inv = {
      id: `INV-${String(s.invoices.length + 1).padStart(4, '0')}`, customerId: o.customerId, legalEntity: 'US11', currency: 'USD',
      originalCents: o.amountCents, outstandingCents: o.amountCents, issueDate: trigger, dueDate: addDays(trigger, 30),
      terms: o.terms, status: 'OPEN', authorization: 'VALID', funding: { result: 'OK' }, source: 'ORDER', orderId: o.id,
    };
    s.invoices.push(inv);
    o.invoiceId = inv.id;
    transition('order', o, 'BILLED', 'billing-agent', { invoiceId: inv.id });
    const goods = o.type === 'GOODS';
    const je = postJE(s, { date: day, type: goods ? 'INVOICE_REVENUE' : 'INVOICE_DEFERRED', step: 4, preparer: 'billing-agent', source: { type: 'invoice', id: inv.id, order: o.id },
      memo: goods ? `Invoice ${inv.id} — revenue recognized at delivery (ASC 606 point in time)` : `Invoice ${inv.id} — billed in advance, contract liability (ASC 606 over time)`,
      lines: [{ account: '1100', debit: inv.originalCents, customerId: o.customerId }, { account: goods ? '4000' : '2100', credit: inv.originalCents }] });
    if (goods) o.recognizedPosted = o.amountCents;
    audit({ entityType: 'invoice', entityId: inv.id, event: 'INVOICE_ISSUED', actor: 'billing-agent', payload: { order: o.id, amount: inv.originalCents, due: inv.dueDate } });
    op(s, { step: goods ? 3 : 4, action: 'INVOICE_ISSUED', ref: inv.id, je, amountCents: inv.originalCents, actor: 'billing-agent', controls: ['C-BIL-01', 'C-REV-01'],
      en: goods ? `Invoice ${inv.id} issued ${$en(inv.originalCents)}, due ${inv.dueDate}. Revenue recognized (Dr 1100 AR / Cr 4000 Revenue).` : `Invoice ${inv.id} issued ${$en(inv.originalCents)} in advance, due ${inv.dueDate} (Dr 1100 AR / Cr 2100 Deferred revenue).`,
      es: goods ? `Factura ${inv.id} emitida ${$es(inv.originalCents)}, vence ${inv.dueDate}. Ingreso reconocido (Cargo 1100 CxC / Abono 4000 Ingreso).` : `Factura ${inv.id} emitida ${$es(inv.originalCents)} por adelantado, vence ${inv.dueDate} (Cargo 1100 CxC / Abono 2100 Ingreso diferido).` });
    if (o.fulfillment) queueReap(s, { kind: 'FULFILLMENT', costCenter: 'OPS', ...o.fulfillment, orderId: o.id, reason: `${o.fulfillment.reason} (${o.id})` });
    log.push(`${o.id} → ${inv.id}`);
  }
  // Ratable recognition for services: release deferred revenue day by day.
  let recognizedToday = 0, contracts = 0;
  for (const o of s.orders.filter(o => o.type === 'SERVICE' && o.status === 'BILLED')) {
    const delta = recognizedThrough(o, day) - (o.recognizedPosted || 0);
    if (delta <= 0) continue;
    postJE(s, { date: day, type: 'REVENUE_RATABLE', step: 3, preparer: 'revenue-agent', source: { type: 'order', id: o.id },
      memo: `Ratable revenue ${o.id} (${day})`, lines: [{ account: '2100', debit: delta }, { account: '4010', credit: delta }] });
    o.recognizedPosted = (o.recognizedPosted || 0) + delta;
    recognizedToday += delta; contracts++;
  }
  if (recognizedToday) op(s, { step: 3, action: 'REVENUE_RECOGNIZED', amountCents: recognizedToday, actor: 'revenue-agent', controls: ['C-REV-01', 'C-REV-02'],
    en: `Service revenue recognized ratably: ${$en(recognizedToday)} across ${contracts} contract(s) (Dr 2100 Deferred / Cr 4010 Revenue).`,
    es: `Ingreso por servicios reconocido prorrateado: ${$es(recognizedToday)} en ${contracts} contrato(s) (Cargo 2100 Diferido / Abono 4010 Ingreso).` });
  return log;
}

// =====================================================================
// 5. COLLECTIONS
// =====================================================================
export function invoiceView(inv, s = load()) {
  const dpd = daysBetween(inv.dueDate, s.asOf);
  return { ...inv, daysPastDue: Math.max(0, dpd), daysUntilDue: Math.max(0, -dpd), eligibility: evaluateEligibility(inv, s) };
}

export function evaluateEligibility(inv, s = load()) {
  const reasons = [];
  if (!s.customers.some(c => c.id === inv.customerId)) reasons.push('CUSTOMER_NOT_FOUND');
  if (!['OPEN', 'PARTIALLY_PAID'].includes(inv.status)) reasons.push(`STATUS_${inv.status}`);
  if (inv.outstandingCents <= 0) reasons.push('NO_BALANCE');
  if (daysBetween(inv.dueDate, s.asOf) < 0) reasons.push('NOT_DUE');
  if (inv.authorization !== 'VALID') reasons.push('NO_DEBIT_AUTHORIZATION');
  const cols = s.collections.filter(c => c.invoiceId === inv.id);
  if (cols.some(c => ['COLLECTION_REQUESTED', 'COLLECTION_PENDING'].includes(c.status))) reasons.push('COLLECTION_IN_FLIGHT');
  if (cols.filter(c => c.status === 'COLLECTION_FAILED').length >= 3) reasons.push('MAX_ATTEMPTS');
  if (cols.some(c => c.date === s.asOf)) reasons.push('ONE_DEBIT_PER_DAY');
  return { eligible: reasons.length === 0, reasons };
}

export function portfolio() {
  const s = load();
  const invoices = s.invoices.map(i => invoiceView(i, s));
  const tot = f => sum(invoices.filter(f), i => i.outstandingCents);
  return { asOf: s.asOf, customers: s.customers, invoices,
    totals: { outstandingCents: tot(() => true), pastDueCents: tot(i => i.daysPastDue > 0), notDueCents: tot(i => i.daysPastDue === 0), eligibleCents: tot(i => i.eligibility.eligible) } };
}

export function prioritizeCollections() {
  const s = load();
  return s.invoices.filter(i => i.outstandingCents > 0).map(i => {
    const v = invoiceView(i, s);
    const cust = s.customers.find(c => c.id === i.customerId);
    const failed = s.collections.filter(c => c.invoiceId === i.id && c.status === 'COLLECTION_FAILED').length;
    const ptp = (s.promises || []).filter(p => p.invoiceId === i.id).at(-1);
    let action = 'MONITOR';
    if (i.status === 'DISPUTED') action = 'RESOLVE_DISPUTE';
    else if (v.eligibility.eligible) action = 'AUTO_DEBIT';
    else if (i.authorization !== 'VALID' && v.daysPastDue > 0) action = 'DUNNING_REQUEST_AUTHORIZATION';
    if (failed > 0) action = 'DUNNING_CALL';
    if ((v.daysPastDue > 60 || failed >= 2) && !cust.creditHold) action = 'CREDIT_HOLD';
    if (ptp && ptp.date >= s.asOf) action = 'AWAIT_PROMISE_TO_PAY';
    if (v.daysPastDue === 0 && action === 'MONITOR' && v.daysUntilDue <= 5) action = 'PRE_DUE_REMINDER';
    const score = Math.round((i.outstandingCents / 100) * (1 + v.daysPastDue / 30) * (1 + failed) * (i.status === 'DISPUTED' ? 0.3 : 1));
    return { invoiceId: i.id, customerId: i.customerId, customer: cust?.legalName, outstandingCents: i.outstandingCents, dueDate: i.dueDate, daysPastDue: v.daysPastDue, daysUntilDue: v.daysUntilDue, failedAttempts: failed, status: i.status, creditHold: !!cust?.creditHold, promise: ptp || null, action, score };
  }).sort((a, b) => b.score - a.score);
}

export function setCreditHold(customerId, hold, actor = 'operator') {
  const s = load();
  const c = s.customers.find(x => x.id === customerId);
  if (!c) throw bizErr('Customer not found');
  c.creditHold = !!hold;
  audit({ entityType: 'customer', entityId: c.id, event: hold ? 'CREDIT_HOLD_ON' : 'CREDIT_HOLD_OFF', actor });
  op(s, { step: 5, action: hold ? 'CREDIT_HOLD_ON' : 'CREDIT_HOLD_OFF', ref: c.id, actor, controls: ['C-OTC-02'],
    en: `${c.legalName} ${hold ? 'placed on' : 'released from'} credit hold.`, es: `${c.legalName} ${hold ? 'en bloqueo de crédito' : 'liberado del bloqueo de crédito'}.` });
  save();
  return c;
}

export function recordPromise(invoiceId, date, actor = 'operator') {
  const s = load();
  s.promises = s.promises || [];
  const p = { id: id('ptp'), invoiceId, date, recordedOn: s.asOf };
  s.promises.push(p);
  audit({ entityType: 'invoice', entityId: invoiceId, event: 'PROMISE_TO_PAY', actor, payload: { date } });
  op(s, { step: 5, action: 'PROMISE_TO_PAY', ref: invoiceId, actor, en: `Promise to pay recorded for ${invoiceId} by ${date}.`, es: `Promesa de pago registrada para ${invoiceId} al ${date}.` });
  save();
  return p;
}

export function issueCreditNote(invoiceId, cents, reason, actor = 'collections-agent', approver = 'controller') {
  if (actor === approver) throw bizErr('Segregation of duties: preparer cannot approve their own credit note', 'SOD_VIOLATION');
  const s = load();
  const inv = s.invoices.find(i => i.id === invoiceId);
  if (!inv) throw bizErr('Invoice not found');
  const amount = Math.min(Math.round(cents ?? inv.outstandingCents), inv.outstandingCents);
  if (amount <= 0) throw bizErr('Nothing to credit');
  const je = postJE(s, { date: s.asOf, type: 'CREDIT_NOTE', step: 5, preparer: actor, approver, source: { type: 'invoice', id: inv.id },
    memo: `Credit note on ${inv.id}: ${reason || 'allowance'}`, lines: [{ account: '4900', debit: amount }, { account: '1100', credit: amount, customerId: inv.customerId }] });
  const cn = { id: id('cn'), invoiceId, cents: amount, reason: reason || 'Credit note', date: s.asOf, je: je.id };
  s.creditNotes.push(cn);
  const before = inv.status;
  inv.outstandingCents -= amount;
  if (inv.outstandingCents === 0) inv.status = before === 'DISPUTED' ? 'CANCELED' : 'PAID';
  audit({ entityType: 'invoice', entityId: inv.id, event: 'CREDIT_NOTE', actor, from: before, to: inv.status, payload: { amount, reason } });
  op(s, { step: 5, action: 'CREDIT_NOTE', ref: inv.id, je, amountCents: amount, actor,
    en: `Credit note ${$en(amount)} on ${inv.id} (${reason || 'allowance'}) — Dr 4900 Returns & allowances / Cr 1100 AR.`,
    es: `Nota de crédito ${$es(amount)} sobre ${inv.id} (${reason || 'bonificación'}) — Cargo 4900 Devoluciones / Abono 1100 CxC.` });
  save();
  return cn;
}

function simulateDebit(inv, amount) {
  const f = inv.funding || { result: 'OK' };
  if (f.result === 'FAILED') return { status: 'FAILED', code: f.code };
  if (f.result === 'PARTIAL') { inv.funding = { result: 'OK' }; return { status: 'SETTLED', cents: Math.min(f.cents, amount) }; }
  return { status: 'SETTLED', cents: amount };
}

function dailyMonitoring(s) {
  const due = s.invoices.filter(i => i.outstandingCents > 0 && i.dueDate === s.asOf);
  const upcoming = s.invoices.filter(i => i.outstandingCents > 0 && i.dueDate > s.asOf).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const nextDate = upcoming[0]?.dueDate;
  const nextAmt = sum(upcoming.filter(i => i.dueDate === nextDate), i => i.outstandingCents);
  const pastDue = s.invoices.filter(i => i.outstandingCents > 0 && i.dueDate < s.asOf);
  op(s, { step: 5, action: 'DUE_DATE_MONITORING', actor: 'monitoring-agent', amountCents: sum(due, i => i.outstandingCents),
    en: `Due-date monitoring: ${due.length} invoice(s) reach D0 today (${$en(sum(due, i => i.outstandingCents))}); ${pastDue.length} past due (${$en(sum(pastDue, i => i.outstandingCents))}).${nextDate ? ` Next due: ${nextDate} (${$en(nextAmt)}).` : ''}`,
    es: `Monitoreo de vencimientos: ${due.length} factura(s) llegan a D0 hoy (${$es(sum(due, i => i.outstandingCents))}); ${pastDue.length} vencidas (${$es(sum(pastDue, i => i.outstandingCents))}).${nextDate ? ` Próximo vencimiento: ${nextDate} (${$es(nextAmt)}).` : ''}` });
}

export function runCollectionCycle(actor = 'collection-agent') {
  const s = load();
  const results = [];
  for (const inv of s.invoices) {
    const el = evaluateEligibility(inv, s);
    if (!el.eligible) { results.push({ invoiceId: inv.id, skipped: el.reasons }); continue; }
    const attempt = s.collections.filter(c => c.invoiceId === inv.id).length + 1;
    const key = `col:${inv.id}:${inv.outstandingCents}:${attempt}`;
    if (s.collections.some(c => c.idempotencyKey === key)) continue;
    const col = {
      id: id('col'), invoiceId: inv.id, customerId: inv.customerId, requestedCents: inv.outstandingCents, confirmedCents: 0,
      currency: inv.currency, idempotencyKey: key, attempt, provider: 'SIM-BANK', providerTxId: id('btx'),
      status: 'ELIGIBLE', date: s.asOf, createdAt: new Date().toISOString(),
    };
    s.collections.push(col);
    transition('collection', col, 'COLLECTION_REQUESTED', actor, { amount: col.requestedCents });
    const r = simulateDebit(inv, col.requestedCents);
    if (r.status === 'FAILED') {
      transition('collection', col, 'COLLECTION_FAILED', 'SIM-BANK', { code: r.code });
      col.failureCode = r.code;
      exception('collection', inv.id, r.code, 'HIGH', { collectionId: col.id });
      op(s, { step: 5, action: 'COLLECTION_FAILED', ref: inv.id, amountCents: col.requestedCents, actor, level: 'WARN', controls: ['C-COL-01'],
        en: `Debit failed for ${inv.id} (${custName(s, inv.customerId)}) ${$en(col.requestedCents)}: ${r.code}. Attempt ${attempt}/3 — invoice stays open, retry tomorrow.`,
        es: `Cargo fallido para ${inv.id} (${custName(s, inv.customerId)}) ${$es(col.requestedCents)}: ${r.code}. Intento ${attempt}/3 — la factura sigue abierta, reintento mañana.` });
      results.push({ invoiceId: inv.id, collectionId: col.id, failed: r.code });
      continue;
    }
    transition('collection', col, 'COLLECTION_PENDING', 'SIM-BANK');
    transition('collection', col, 'COLLECTION_CONFIRMED', 'SIM-BANK', { settled: r.cents });
    col.confirmedCents = r.cents;
    const pay = receivePayment(col, inv);
    applyPayment(pay, inv);
    allocate(pay);
    results.push({ invoiceId: inv.id, collectionId: col.id, confirmedCents: r.cents, paymentId: pay.id });
  }
  save();
  return results;
}

// =====================================================================
// 6. CASH APPLICATION
// =====================================================================
function receivePayment(col, inv) {
  const s = load();
  const pay = {
    id: id('pay'), collectionId: col.id, customerId: col.customerId, invoiceRef: inv.id, receivedCents: col.confirmedCents,
    appliedCents: 0, allocatedCents: 0, currency: col.currency, bankRef: col.providerTxId, settlement: 'SETTLED', date: s.asOf,
  };
  s.payments.push(pay);
  const je = postJE(s, { date: s.asOf, type: 'CASH_RECEIPT', step: 5, preparer: 'collection-agent', source: { type: 'payment', id: pay.id, bankRef: pay.bankRef },
    memo: `Receipt ${pay.bankRef} from ${custName(s, pay.customerId)}`, lines: [{ account: '1000', debit: pay.receivedCents }, { account: '2300', credit: pay.receivedCents }] });
  pay.receiptJE = je.id;
  audit({ entityType: 'payment', entityId: pay.id, event: 'FUNDS_RECEIVED', actor: 'SIM-BANK', payload: { cents: pay.receivedCents, invoice: inv.id } });
  op(s, { step: 5, action: 'FUNDS_RECEIVED', ref: inv.id, je, amountCents: pay.receivedCents, actor: 'collection-agent', controls: ['C-COL-01', 'C-COL-02'],
    en: `Collected ${$en(pay.receivedCents)} from ${custName(s, pay.customerId)} for ${inv.id} — settled, bank ref ${pay.bankRef} (Dr 1000 Cash / Cr 2300 Unapplied).`,
    es: `Cobrados ${$es(pay.receivedCents)} de ${custName(s, pay.customerId)} por ${inv.id} — liquidado, ref. ${pay.bankRef} (Cargo 1000 Caja / Abono 2300 No aplicado).` });
  return pay;
}

function applyPayment(pay, inv) {
  const s = load();
  const amount = Math.min(pay.receivedCents - pay.appliedCents, inv.outstandingCents);
  if (amount <= 0) { exception('payment', pay.id, 'UNAPPLIED_CASH', 'MEDIUM'); return null; }
  const je = postJE(s, { date: s.asOf, type: 'CASH_APPLICATION', step: 6, preparer: 'cash-app-agent', source: { type: 'payment', id: pay.id, invoice: inv.id },
    memo: `Apply ${pay.id} to ${inv.id}`, lines: [{ account: '2300', debit: amount }, { account: '1100', credit: amount, customerId: inv.customerId }] });
  const app = { id: id('app'), paymentId: pay.id, invoiceId: inv.id, appliedCents: amount, status: 'APPLICATION_POSTED', date: s.asOf, je: je.id };
  s.applications.push(app);
  pay.appliedCents += amount;
  const before = inv.status;
  inv.outstandingCents -= amount;
  inv.status = inv.outstandingCents === 0 ? 'PAID' : 'PARTIALLY_PAID';
  audit({ entityType: 'invoice', entityId: inv.id, event: 'PAYMENT_APPLIED', actor: 'cash-app-agent', from: before, to: inv.status, payload: { applied: amount, remaining: inv.outstandingCents, paymentId: pay.id } });
  op(s, { step: 6, action: 'PAYMENT_APPLIED', ref: inv.id, je, amountCents: amount, actor: 'cash-app-agent', controls: ['C-CA-01', 'C-AR-01'],
    en: `Applied ${$en(amount)} to ${inv.id} (exact match on collection reference) → ${inv.status}, remaining ${$en(inv.outstandingCents)} (Dr 2300 / Cr 1100 AR).`,
    es: `Aplicados ${$es(amount)} a ${inv.id} (coincidencia exacta por referencia) → ${inv.status}, saldo ${$es(inv.outstandingCents)} (Cargo 2300 / Abono 1100 CxC).` });
  return app;
}

// =====================================================================
// 7. TREASURY — collected cash funds cost-center budgets (Reap spend authority). Opening cash = reserve.
// =====================================================================
function allocate(pay) {
  const s = load();
  const amount = pay.receivedCents - pay.allocatedCents;
  if (amount <= 0) return;
  const parts = splitByBps(amount, ALLOCATION_POLICY.centers);
  for (const part of parts) {
    s.allocations.push({ id: id('alc'), paymentId: pay.id, invoiceId: pay.invoiceRef, costCenter: part.id, cents: part.cents, consumedCents: 0,
      policyVersion: ALLOCATION_POLICY.version, type: 'BUDGET_ALLOCATION', status: 'ALLOCATION_POSTED', date: s.asOf });
  }
  pay.allocatedCents += amount;
  audit({ entityType: 'payment', entityId: pay.id, event: 'TREASURY_ALLOCATED', actor: 'treasury-agent', payload: { cents: amount, policy: ALLOCATION_POLICY.version } });
  op(s, { step: 7, action: 'BUDGET_FUNDED', ref: pay.invoiceRef, amountCents: amount, actor: 'treasury-agent', controls: ['C-SPD-02'],
    en: `Treasury funded Reap spend authority with ${$en(amount)}: ${parts.map(p => `${p.id} ${$en(p.cents)}`).join(', ')} (policy ${ALLOCATION_POLICY.version}, memo — no GL entry).`,
    es: `Tesorería fondeó la autoridad de gasto Reap con ${$es(amount)}: ${parts.map(p => `${p.id} ${$es(p.cents)}`).join(', ')} (política ${ALLOCATION_POLICY.version}, memo — sin asiento).` });
}

export function budgets() {
  const s = load();
  return ALLOCATION_POLICY.centers.map(c => {
    const al = s.allocations.filter(a => a.costCenter === c.id);
    const allocated = sum(al, a => a.cents), spent = sum(al, a => a.consumedCents);
    const reserved = sum(s.purchases.filter(p => p.costCenter === c.id && p.reservedCents > 0), p => p.reservedCents);
    return { id: c.id, name: c.name, bps: c.bps, allocatedCents: allocated, spentCents: spent, reservedCents: reserved, availableCents: allocated - spent - reserved };
  });
}

function consume(costCenter, cents) {
  const s = load();
  const trace = [];
  let left = cents;
  for (const a of s.allocations.filter(a => a.costCenter === costCenter)) {
    if (left === 0) break;
    const take = Math.min(a.cents - a.consumedCents, left);
    if (take <= 0) continue;
    a.consumedCents += take;
    left -= take;
    trace.push({ allocationId: a.id, paymentId: a.paymentId, invoiceId: a.invoiceId, cents: take });
  }
  return { trace, shortfall: left };
}

export function cashPosition() {
  const s = load();
  const collected = sum(s.payments, p => p.receivedCents);
  const apPaid = sum(s.apBills.filter(b => b.status === 'PAID'), b => b.cents);
  const reapPaid = sum(s.purchases.filter(p => p.status === 'COMPLETED'), p => p.chargedCents || 0);
  return { openingCents: s.openingCashCents, collectedCents: collected, apPaidCents: apPaid, reapPaidCents: reapPaid, expensesCents: apPaid + reapPaid,
    cashCents: balance(s, '1000'), bankLedgerCents: s.openingCashCents + collected - apPaid - reapPaid, reserveCents: s.openingCashCents };
}

export function cashForecast(days = 30, horizonOverride = null) {
  const s = load();
  const horizon = horizonOverride || addDays(s.asOf, days);
  const prob = i => {
    if (i.status === 'DISPUTED') return 0;
    if (i.authorization !== 'VALID') return 0.5;
    const dpd = daysBetween(i.dueDate, s.asOf);
    return dpd <= 0 ? 0.95 : dpd <= 30 ? 0.85 : dpd <= 60 ? 0.6 : dpd <= 90 ? 0.4 : 0.1;
  };
  const inflow = Math.round(sum(s.invoices.filter(i => i.outstandingCents > 0 && i.dueDate <= horizon), i => i.outstandingCents * prob(i)));
  const apOut = sum(s.apBills.filter(b => b.status !== 'PAID' && b.dueDate <= horizon), b => b.cents)
    + (monthEnd(s.openMonth) < horizon ? sum(apBillsFor(nextMonth(s.openMonth)).filter(b => b.dueDate <= horizon), b => b.cents) : 0);
  // Committed Reap spend: recurring standing orders inside the horizon, priced from the latest Reap quote (or list price).
  let reapCommitted = 0;
  for (const r of s.recurring.filter(r => r.active)) {
    let d = addDays(s.asOf, 1), n = 0;
    while (d <= horizon) { if (ruleDueOn(r, d)) n++; d = addDays(d, 1); }
    const v = vendorBySku(r.vendorSku);
    reapCommitted += n * (r.lastQuoteCents || v.unitCents * r.quantity);
  }
  const now = balance(s, '1000');
  const projected = now + inflow - apOut - reapCommitted;
  return { days, horizon, startCents: now, expectedInflowCents: inflow, scheduledApCents: apOut, reapCommittedCents: reapCommitted, scheduledOutflowCents: apOut + reapCommitted, projectedCents: projected, liquidityGap: projected < s.openingCashCents };
}

// =====================================================================
// 8. EXPENSES / AP
// =====================================================================
function payBillsForDay(day) {
  const s = load();
  const log = [];
  for (const b of s.apBills.filter(b => b.status !== 'PAID' && b.dueDate <= day)) {
    const avail = budgets().find(x => x.id === b.costCenter).availableCents;
    if (avail < b.cents) {
      if (b.status !== 'HELD') {
        audit({ entityType: 'apBill', entityId: b.id, event: 'STATE_CHANGED', actor: 'ap-agent', from: b.status, to: 'HELD', payload: { avail } });
        op(s, { step: 8, action: 'AP_HELD', ref: b.id, amountCents: b.cents, actor: 'ap-agent', level: 'WARN', controls: ['C-SPD-02'],
          en: `${b.vendor} ${$en(b.cents)} HELD: ${b.costCenter} has only ${$en(avail)} of collected cash. Will pay when collections arrive.`,
          es: `${b.vendor} ${$es(b.cents)} RETENIDA: ${b.costCenter} solo tiene ${$es(avail)} de efectivo cobrado. Se paga cuando entre la cobranza.` });
      }
      b.status = 'HELD';
      exception('apBill', b.id, 'INSUFFICIENT_COLLECTED_CASH', 'HIGH', { needed: b.cents, available: avail });
      continue;
    }
    const { trace } = consume(b.costCenter, b.cents);
    const je = postJE(s, { date: day, type: 'AP_PAYMENT', step: 8, preparer: 'ap-agent', approver: 'controller', source: { type: 'apBill', id: b.id },
      memo: `Pay ${b.vendor} (${b.id})`, lines: [{ account: '2000', debit: b.cents }, { account: '1000', credit: b.cents }] });
    const from = b.status;
    Object.assign(b, { status: 'PAID', paidDate: day, fundingTrace: trace, paymentJE: je.id });
    audit({ entityType: 'apBill', entityId: b.id, event: 'STATE_CHANGED', actor: 'ap-agent', from, to: 'PAID', payload: { cents: b.cents } });
    for (const e of s.exceptions.filter(e => e.entityId === b.id && e.status === 'OPEN')) { e.status = 'RESOLVED'; e.resolution = 'Paid after cash arrived'; }
    op(s, { step: 8, action: 'AP_PAID', ref: b.id, je, amountCents: b.cents, actor: 'ap-agent', controls: ['C-AP-01', 'C-SPD-02'],
      en: `Paid ${b.vendor} ${$en(b.cents)} from ${b.costCenter} collected cash (funded by ${trace.map(t => t.invoiceId).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(', ')}) — Dr 2000 AP / Cr 1000 Cash.`,
      es: `Pagado ${b.vendor} ${$es(b.cents)} con efectivo cobrado de ${b.costCenter} (fondeado por ${trace.map(t => t.invoiceId).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(', ')}) — Cargo 2000 CxP / Abono 1000 Caja.` });
    log.push(`${b.id} paid`);
  }
  return log;
}

// Recurring Reap standing orders
function ruleDueOn(r, day) {
  if (r.frequency === 'WEEKLY') return weekday(day) === r.weekday;
  if (r.frequency === 'MONTHLY') return Number(day.slice(8, 10)) === r.day;
  return false;
}

export function setRecurringActive(ruleId, active, actor = 'controller') {
  const s = load();
  const r = s.recurring.find(x => x.id === ruleId);
  if (!r) throw bizErr('Rule not found');
  r.active = !!active;
  audit({ entityType: 'recurring', entityId: r.id, event: active ? 'RULE_RESUMED' : 'RULE_PAUSED', actor });
  op(s, { step: 8, action: active ? 'RULE_RESUMED' : 'RULE_PAUSED', ref: r.id, actor, en: `Standing order ${r.id} ${active ? 'resumed' : 'paused'}.`, es: `Orden recurrente ${r.id} ${active ? 'reanudada' : 'pausada'}.` });
  save();
  return r;
}

export function runRecurringNow(ruleId) {
  const s = load();
  const r = s.recurring.find(x => x.id === ruleId);
  if (!r) throw bizErr('Rule not found');
  queueReap(s, { kind: 'RECURRING', ruleId: r.id, costCenter: r.costCenter, vendorSku: r.vendorSku, quantity: r.quantity, reason: `${r.name.en} (${r.id}, manual run)` });
  save();
  return drainReapQueue();
}

// Async queue: Reap API calls run after the (synchronous) day processing.
function queueReap(s, item) {
  s.reapQueue = s.reapQueue || [];
  s.reapQueue.push({ ...item, queuedOn: s.asOf, qid: id('rq') });
}

let draining = null;
export function drainReapQueue() {
  if (draining) return draining;
  draining = (async () => {
    const s = load();
    while ((s.reapQueue || []).length) {
      const item = s.reapQueue.shift();
      save();
      try {
        const p = await proposePurchase({ costCenter: item.costCenter, vendorSku: item.vendorSku, quantity: item.quantity, reason: item.reason, actor: item.kind === 'RECURRING' ? 'recurring-agent' : 'procurement-agent', kind: item.kind, ruleId: item.ruleId, orderId: item.orderId });
        if (item.ruleId) { const r = s.recurring.find(x => x.id === item.ruleId); r.runs.push({ date: item.queuedOn, purchaseId: p.id, status: p.status }); if (p.totalCents) r.lastQuoteCents = p.totalCents; }
      } catch (e) {
        op(s, { step: 8, action: 'REAP_QUEUE_ERROR', ref: item.ruleId || item.orderId, actor: 'spend-agent', level: 'WARN', en: `Reap purchase not placed: ${e.message}`, es: `Compra Reap no colocada: ${e.message}` });
      }
      save();
    }
  })().finally(() => { draining = null; });
  return draining;
}
export const reapQueueStatus = () => ({ pending: (load().reapQueue || []).length, running: !!draining });

// =====================================================================
// CLOCK — agents run every business day
// =====================================================================
export function advanceDays(n = 1, actor = 'scheduler') {
  const s = load();
  const days = [];
  const stopAt = monthEnd(s.openMonth);
  for (let i = 0; i < n; i++) {
    if (s.asOf >= stopAt) break;
    s.asOf = addDays(s.asOf, 1);
    const arBefore = balance(s, '1100'), cashBefore = balance(s, '1000');
    op(s, { step: 0, action: 'DAY_OPENED', actor, en: `── Business day ${s.asOf} opened ──`, es: `── Día operativo ${s.asOf} abierto ──` });
    const billed = processOrdersForDay(s.asOf);
    for (const r of s.recurring.filter(r => r.active && ruleDueOn(r, s.asOf))) {
      queueReap(s, { kind: 'RECURRING', ruleId: r.id, costCenter: r.costCenter, vendorSku: r.vendorSku, quantity: r.quantity, reason: `${r.name.en} (${r.id})` });
      op(s, { step: 8, action: 'RECURRING_DUE', ref: r.id, actor: 'recurring-agent', en: `Standing order due: ${r.name.en} — queued for Reap checkout.`, es: `Orden recurrente vence: ${r.name.es} — en cola para checkout Reap.` });
    }
    dailyMonitoring(s);
    const collected = runCollectionCycle(actor).filter(r => r.confirmedCents || r.failed);
    const paid = payBillsForDay(s.asOf);
    if (s.asOf === stopAt) proposeECL('accounting-agent');
    days.push({ date: s.asOf, billed, collected: collected.length, collectedCents: sum(collected, r => r.confirmedCents || 0), failed: collected.filter(r => r.failed).length, paid,
      arBefore, arAfter: balance(s, '1100'), cashBefore, cashAfter: balance(s, '1000') });
  }
  audit({ entityType: 'clock', entityId: s.asOf, event: 'DAYS_ADVANCED', actor, payload: { n: days.length } });
  save();
  return { asOf: s.asOf, days, atMonthEnd: s.asOf >= stopAt, reapQueued: (s.reapQueue || []).length };
}

// =====================================================================
// MASTERSHEET + 9. MONTH-END CLOSE
// =====================================================================
export function mastersheetRow(m) {
  const s = load();
  const closed = s.closedMonths.find(c => c.month === m);
  if (closed) return closed.row;
  const prevEnd = addDays(monthStart(m), -1);
  const upTo = monthEnd(m) < s.asOf ? monthEnd(m) : s.asOf;
  const beginningAR = balance(s, '1100', prevEnd);
  const ordersBooked = sum(s.orders.filter(o => inMonth(o.bookedDate, m) && o.status !== 'VALIDATION_FAILED'), o => o.amountCents);
  const revenue = periodNet(s, m, ['4000', '4010']);
  const billed = sum(s.invoices.filter(i => inMonth(i.issueDate, m)), i => i.originalCents);
  const collections = sum(s.payments.filter(p => inMonth(p.date, m)), p => p.receivedCents);
  const credits = sum(s.creditNotes.filter(c => inMonth(c.date, m)), c => c.cents);
  const endingAR = beginningAR + billed - collections - credits;
  const reapExp = periodNet(s, m, ['5000', '6500']);
  const expenses = periodNet(s, m, ['5000', '6000', '6100', '6200', '6300', '6400', '6500', '6900']);
  const beginningCash = balance(s, '1000', prevEnd);
  const cashPaid = sum(s.apBills.filter(b => b.status === 'PAID' && inMonth(b.paidDate, m)), b => b.cents) + sum(s.purchases.filter(p => p.status === 'COMPLETED' && inMonth(p.settledDate, m)), p => p.chargedCents || 0);
  const endingCash = beginningCash + collections - cashPaid;
  return {
    month: m, beginningAR, ordersBooked, revenue, billed, collections, credits, endingAR,
    expenses, apExpenses: expenses - reapExp, reapExpenses: reapExp, cashPaid, beginningCash, treasuryOutflows: 0, endingCash,
    tieOut: { arGL: balance(s, '1100', upTo), arOk: balance(s, '1100', upTo) === endingAR, cashGL: balance(s, '1000', upTo), cashOk: balance(s, '1000', upTo) === endingCash },
    status: 'OPEN',
  };
}

export function mastersheet() {
  const s = load();
  return [...s.closedMonths.map(c => c.row), ...(s.closedMonths.some(c => c.month === s.openMonth) ? [] : [mastersheetRow(s.openMonth)])];
}

export function closeChecklist() {
  const s = load();
  const m = s.openMonth;
  const row = mastersheetRow(m);
  const r = reconcile();
  const completed = s.purchases.filter(p => p.status === 'COMPLETED' && inMonth(p.settledDate, m));
  const items = [
    { id: 'AT_MONTH_END', ok: s.asOf >= monthEnd(m), detail: `${s.asOf} / ${monthEnd(m)}` },
    { id: 'AR_ROLLFORWARD_TIES_TO_GL', ok: row.tieOut.arOk },
    { id: 'CASH_TIES_TO_GL', ok: row.tieOut.cashOk },
    { id: 'TRIAL_BALANCE_BALANCED', ok: trialBalance(s).balanced },
    { id: 'RECONCILIATION_CHECKS', ok: r.checks.every(c => c.ok) },
    { id: 'ECL_ESTIMATE_APPROVED', ok: (s.eclProposals || []).some(p => p.period === m && p.status === 'APPROVED') && !(s.eclProposals || []).some(p => p.period === m && p.status === 'PENDING_APPROVAL'), detail: 'ASC 326' },
    { id: 'NO_UNBILLED_DELIVERIES', ok: !s.orders.some(o => ['DELIVERED', 'IN_SERVICE'].includes(o.status)) },
    { id: 'REAP_QUEUE_EMPTY', ok: !(s.reapQueue || []).length && !draining },
    { id: 'NO_PENDING_CHECKOUTS', ok: !s.purchases.some(p => ['REQUIRES_ACTION', 'PROCESSING'].includes(p.status)) },
    { id: 'REAP_CHECKOUTS_VERIFIED', ok: completed.every(p => p.reapVerified?.ok), detail: `${completed.filter(p => p.reapVerified?.ok).length}/${completed.length}`, warn: true },
    { id: 'AP_DUE_PAID', ok: !s.apBills.some(b => b.status !== 'PAID' && b.dueDate <= monthEnd(m)), warn: true },
    { id: 'HIGH_EXCEPTIONS_REVIEWED', ok: !s.exceptions.some(e => e.status === 'OPEN' && e.severity === 'HIGH'), warn: true },
  ];
  return { month: m, items, canClose: items.filter(i => !i.warn).every(i => i.ok) };
}

// Re-reads every completed checkout from Reap and compares the charged amount to the GL entry.
export async function verifyReapCheckouts() {
  const s = load();
  const out = [];
  for (const p of s.purchases.filter(p => p.status === 'COMPLETED' && p.checkoutId && !p.reapVerified?.ok)) {
    try {
      const c = await reap.getCheckout(p.checkoutId);
      const charged = c.finalAmount ? toCents(c.finalAmount.amount) : p.chargedCents;
      const je = s.journal.find(j => j.id === p.je);
      const glAmt = je ? sum(je.lines, l => l.debit || 0) : null;
      p.reapVerified = { ok: c.status === 'COMPLETED' && charged === glAmt, reapStatus: c.status, reapCents: charged, glCents: glAmt, at: new Date().toISOString() };
      if (!p.reapVerified.ok) exception('purchase', p.id, 'REAP_GL_MISMATCH', 'HIGH', p.reapVerified);
      out.push({ id: p.id, ...p.reapVerified });
    } catch (e) { out.push({ id: p.id, ok: false, error: e.message }); }
  }
  if (out.length) op(s, { step: 9, action: 'REAP_CHECKOUTS_VERIFIED', actor: 'close-agent', controls: ['C-SPD-04'],
    en: `Close agent re-read ${out.length} checkout(s) from Reap: ${out.filter(x => x.ok).length} match the GL, ${out.filter(x => !x.ok).length} exception(s).`,
    es: `El agente de cierre releyó ${out.length} checkout(s) en Reap: ${out.filter(x => x.ok).length} cuadran con el mayor, ${out.filter(x => !x.ok).length} excepción(es).` });
  save();
  return out;
}

export function closeMonth(summary = null, actor = 'controller') {
  const s = load();
  const cl = closeChecklist();
  if (!cl.canClose) throw bizErr('Close blocked: ' + cl.items.filter(i => !i.ok && !i.warn).map(i => i.id).join(', '), 'CLOSE_BLOCKED');
  const m = s.openMonth;
  const row = { ...mastersheetRow(m), status: 'CLOSED' };
  row.notes = [row.endingAR < row.beginningAR ? 'AR_DOWN' : 'AR_UP', row.collections > row.cashPaid ? 'CASH_POSITIVE' : 'CASH_BURN', ...(row.billed > row.revenue ? ['DEFERRED_REVENUE_BUILT'] : [])];
  const statements = { income: incomeStatement(s, m), balance: balanceSheet(s, monthEnd(m)), cashFlow: cashFlow(s, m), trial: trialBalance(s, monthEnd(m)) };
  s.closedMonths.push({ month: m, row, closedAt: new Date().toISOString(), closedBy: actor, checklist: cl.items, summary, warnings: cl.items.filter(i => !i.ok).map(i => i.id), statements, sox: soxControls() });
  s.closedPeriods.push(m);
  audit({ entityType: 'close', entityId: m, event: 'MONTH_CLOSED', actor, payload: { endingAR: row.endingAR, endingCash: row.endingCash } });
  op(s, { step: 9, action: 'MONTH_CLOSED', ref: m, actor, controls: ['C-CLS-01', 'C-GL-02'],
    en: `Month ${m} closed by ${actor}: ending AR ${$en(row.endingAR)}, ending cash ${$en(row.endingCash)}, net income ${$en(statements.income.netIncome)}. Period locked — no further postings.`,
    es: `Mes ${m} cerrado por ${actor}: CxC final ${$es(row.endingAR)}, caja final ${$es(row.endingCash)}, utilidad neta ${$es(statements.income.netIncome)}. Periodo bloqueado — sin más asientos.` });
  const nm = nextMonth(m);
  s.openMonth = nm;
  s.asOf = monthStart(nm);
  const bills = apBillsFor(nm);
  s.apBills.push(...bills);
  accrueBills(s, bills);
  op(s, { step: 0, action: 'DAY_OPENED', actor: 'scheduler', en: `── Business day ${s.asOf} opened (new period ${nm}) ──`, es: `── Día operativo ${s.asOf} abierto (nuevo periodo ${nm}) ──` });
  processOrdersForDay(s.asOf);
  dailyMonitoring(s);
  runCollectionCycle('scheduler');
  payBillsForDay(s.asOf);
  snapshotForecast(s);
  save();
  return row;
}

// =====================================================================
// Reap enrollment (company card, once)
// =====================================================================
export async function startEnrollment() {
  const s = load();
  const e = await reap.createEnrollment({ ownerId: 'cai-company-us11', email: BUYER_EMAIL, returnUrl: `${PUBLIC_URL()}/return?kind=enrollment` });
  s.enrollment = { id: e.id, status: e.status, nextAction: e.nextAction, createdAt: new Date().toISOString() };
  audit({ entityType: 'enrollment', entityId: e.id, event: 'ENROLLMENT_CREATED', payload: { status: e.status } });
  op(s, { step: 8, action: 'REAP_ENROLLMENT_CREATED', ref: e.id, actor: 'operator', en: `Reap enrollment created (${e.status}). Card is entered on Reap's hosted page only.`, es: `Registro Reap creado (${e.status}). La tarjeta se captura solo en la página de Reap.` });
  save();
  return s.enrollment;
}

export async function refreshEnrollment() {
  const s = load();
  if (!s.enrollment) return null;
  const e = await reap.getEnrollment(s.enrollment.id);
  if (e.status !== s.enrollment.status) {
    audit({ entityType: 'enrollment', entityId: e.id, event: 'STATE_CHANGED', from: s.enrollment.status, to: e.status });
    op(s, { step: 8, action: 'REAP_ENROLLMENT_' + e.status, ref: e.id, actor: 'reap', en: `Reap enrollment is now ${e.status}.`, es: `El registro Reap ahora está ${e.status}.` });
  }
  Object.assign(s.enrollment, { status: e.status, nextAction: e.nextAction });
  save();
  return s.enrollment;
}

export function useExistingEnrollment(enrollmentId) {
  const s = load();
  s.enrollment = { id: enrollmentId, status: 'UNKNOWN', nextAction: null, createdAt: new Date().toISOString() };
  save();
  return refreshEnrollment();
}

// =====================================================================
// Spend through Reap Agentic
// =====================================================================
export function listVendors(costCenter, q) {
  const needle = (q || '').toLowerCase();
  return VENDORS.filter(v => (!costCenter || v.costCenter === costCenter) && (!needle || `${v.product} ${v.category} ${v.domain}`.toLowerCase().includes(needle)));
}

export async function searchProducts(query, maxUnitCents) {
  const blocked = restrictedReason(query);
  if (blocked) throw bizErr(blocked, 'RESTRICTED_CATEGORY');
  const r = await reap.searchProducts({ query, maxPrice: maxUnitCents ? maxUnitCents / 100 : undefined });
  return (r.products || []).filter(p => p.available && p.previewVariant?.available && !restrictedReason(p.name)).map(p => ({
    productId: p.id, variantId: p.previewVariant.id, name: p.name, merchant: p.merchant?.name,
    imageUrl: p.imageUrl, unitCents: toCents(p.previewVariant.price.amount), currency: p.previewVariant.price.currency,
  }));
}

async function quoteFor(p, key) {
  const body = { email: BUYER_EMAIL, shippingAddress: SHIP_TO, idempotencyKey: key };
  if (p.vendorSku) { const v = vendorBySku(p.vendorSku); body.externalCheckout = { merchantDomain: v.domain, checkoutUrl: cartUrl(v, p.quantity) }; }
  else body.items = [{ variantId: p.variantId, quantity: p.quantity }];
  // Reap sandbox occasionally answers QUOTE_TEMPORARILY_UNAVAILABLE / 503: back off and retry with a fresh key
  // (reusing the key would replay the cached error).
  let q;
  for (let attempt = 0; ; attempt++) {
    try { q = await reap.createQuote({ ...body, idempotencyKey: attempt ? `${key}:r${attempt}` : key }); break; } catch (e) {
      const transient = e instanceof ReapError && (e.code === 'QUOTE_TEMPORARILY_UNAVAILABLE' || e.status === 503 || e.code === 'AGENTIC_SERVICE_UNAVAILABLE');
      if (!transient || attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  const cheapest = [...(q.shippingOptions || [])].sort((a, b) => toCents(a.price.amount) - toCents(b.price.amount))[0];
  if (cheapest && !cheapest.selected) q = await reap.selectShipping(q.id, cheapest.id);
  return q;
}

export async function proposePurchase({ costCenter, vendorSku, query, variantId, productName, merchant, quantity = 1, reason = '', actor = 'spend-agent', kind = 'ADHOC', ruleId = null, orderId = null }) {
  const s = load();
  if (!ALLOCATION_POLICY.centers.some(c => c.id === costCenter)) throw bizErr(`Unknown cost center ${costCenter}`);
  const budget = budgets().find(b => b.id === costCenter);
  quantity = Math.max(1, Math.floor(quantity));
  const blocked = restrictedReason(`${query || ''} ${productName || ''} ${reason || ''}`);
  if (blocked) {
    op(s, { step: 8, action: 'SPEND_BLOCKED', actor, level: 'WARN', controls: ['C-SPD-03'], en: `Spend request blocked — ${blocked}: "${query || productName || reason}".`, es: `Solicitud de gasto bloqueada — ${blocked}: "${query || productName || reason}".` });
    save();
    throw bizErr(blocked, 'RESTRICTED_CATEGORY');
  }

  let pick;
  if (vendorSku) {
    const v = vendorBySku(vendorSku);
    if (!v) throw bizErr(`Vendor SKU not on supported list: ${vendorSku}`);
    pick = { vendorSku, name: v.product, merchant: v.domain };
  } else if (variantId) {
    pick = { variantId, name: productName || variantId, merchant };
  } else {
    const approved = listVendors(null, query).filter(v => v.unitCents * quantity <= budget.availableCents).sort((a, b) => a.unitCents - b.unitCents)[0];
    if (approved) pick = { vendorSku: approved.sku, name: approved.product, merchant: approved.domain };
    else {
      const r = (await searchProducts(query)).filter(r => r.unitCents * quantity <= budget.availableCents).sort((a, b) => a.unitCents - b.unitCents)[0];
      if (!r) throw bizErr(`No affordable product for "${query}" within ${costCenter} budget`);
      pick = { variantId: r.variantId, name: r.name, merchant: r.merchant, imageUrl: r.imageUrl };
    }
  }

  const p = {
    id: id('pur'), kind, ruleId, orderId, costCenter, query: query || null, reason, quantity, actor,
    vendorSku: pick.vendorSku || null, variantId: pick.variantId || null, productName: pick.name, merchant: pick.merchant || null,
    imageUrl: pick.imageUrl || null, approvedVendor: !!pick.vendorSku, status: 'PROPOSED', reservedCents: 0, date: s.asOf, createdAt: new Date().toISOString(),
  };
  let q;
  try { q = await quoteFor(p, `quote:${p.id}`); } catch (e) {
    p.status = 'REJECTED';
    p.rejectReason = e instanceof ReapError ? `${e.code}: ${JSON.stringify(e.detail)}` : e.message;
    s.purchases.push(p);
    audit({ entityType: 'purchase', entityId: p.id, event: 'QUOTE_FAILED', actor, payload: { error: p.rejectReason } });
    op(s, { step: 8, action: 'REAP_QUOTE_FAILED', ref: p.id, actor, level: 'WARN', en: `Reap quote failed for ${p.productName}: ${p.rejectReason}`, es: `Falló la cotización Reap para ${p.productName}: ${p.rejectReason}` });
    save();
    return p;
  }
  Object.assign(p, { quoteId: q.id, quoteExpiresAt: q.expiresAt, breakdown: q.amountBreakdown, totalCents: toCents(q.amountBreakdown.finalAmount.amount) });
  s.purchases.push(p);
  audit({ entityType: 'purchase', entityId: p.id, event: 'PURCHASE_PROPOSED', actor, payload: { costCenter, total: p.totalCents, vendor: p.merchant, reason, kind } });
  op(s, { step: 8, action: 'REAP_QUOTED', ref: p.id, amountCents: p.totalCents, actor,
    en: `Reap quote ${q.id.slice(0, 8)}… for ${p.productName} ×${quantity} (${p.merchant}): items ${$en(toCents(q.amountBreakdown.itemsSubtotal.amount))} + shipping ${$en(toCents(q.amountBreakdown.shipping?.amount || 0))} + tax ${$en(toCents(q.amountBreakdown.tax?.amount?.amount || 0))} = ${$en(p.totalCents)} [${kind}, ${costCenter}].`,
    es: `Cotización Reap ${q.id.slice(0, 8)}… para ${p.productName} ×${quantity} (${p.merchant}): artículos ${$es(toCents(q.amountBreakdown.itemsSubtotal.amount))} + envío ${$es(toCents(q.amountBreakdown.shipping?.amount || 0))} + impuesto ${$es(toCents(q.amountBreakdown.tax?.amount?.amount || 0))} = ${$es(p.totalCents)} [${kind}, ${costCenter}].` });

  const fail = r => {
    transition('purchase', p, 'REJECTED', 'policy-engine', { reason: r }); p.rejectReason = r;
    op(s, { step: 8, action: 'SPEND_REJECTED', ref: p.id, amountCents: p.totalCents, actor: 'policy-engine', level: 'WARN', controls: ['C-SPD-02', 'C-SPD-03'], en: `Purchase ${p.id} rejected by policy: ${r}.`, es: `Compra ${p.id} rechazada por política: ${r}.` });
    save(); return p;
  };
  if (!p.approvedVendor) return fail('QUOTE_ONLY_MERCHANT_NOT_SUPPORTED');
  if (p.totalCents > SPEND_POLICY.perPurchaseMaxCents) return fail('EXCEEDS_PER_PURCHASE_CAP');
  if (p.totalCents > budget.availableCents) return fail('INSUFFICIENT_COLLECTED_CASH');
  const rule = ruleId ? s.recurring.find(r => r.id === ruleId) : null;
  if (rule && p.totalCents > rule.capCents) return fail(`EXCEEDS_STANDING_ORDER_CAP (${$en(rule.capCents)})`);

  p.reservedCents = p.totalCents;
  const needsHuman = !rule && kind !== 'FULFILLMENT' && p.totalCents > SPEND_POLICY.autoApproveMaxCents;
  if (needsHuman) {
    transition('purchase', p, 'NEEDS_APPROVAL', 'policy-engine', { reason: 'OVER_AUTO_APPROVE_LIMIT' });
    op(s, { step: 8, action: 'SPEND_NEEDS_APPROVAL', ref: p.id, amountCents: p.totalCents, actor: 'policy-engine', controls: ['C-SPD-01'], en: `${p.id} ${$en(p.totalCents)} > ${$en(SPEND_POLICY.autoApproveMaxCents)} — waiting for a human approver (segregation of duties). Cash reserved.`, es: `${p.id} ${$es(p.totalCents)} > ${$es(SPEND_POLICY.autoApproveMaxCents)} — espera aprobación humana (segregación de funciones). Efectivo reservado.` });
    save();
    return p;
  }
  transition('purchase', p, 'APPROVED', rule ? `standing-order:${rule.id}` : 'policy-engine', { auto: true });
  p.approver = rule ? `controller (standing order ${rule.id})` : 'policy-engine (≤ auto-approve limit)';
  await checkout(p);
  return p;
}

export async function approvePurchase(purchaseId, approver = 'finance-approver') {
  const s = load();
  const p = s.purchases.find(x => x.id === purchaseId);
  if (!p) throw bizErr('Purchase not found');
  if (approver === p.actor) throw bizErr('Segregation of duties: requester cannot approve their own purchase', 'SOD_VIOLATION');
  transition('purchase', p, 'APPROVED', approver);
  p.approver = approver;
  op(s, { step: 8, action: 'SPEND_APPROVED', ref: p.id, amountCents: p.totalCents, actor: approver, controls: ['C-SPD-01'], en: `${p.id} approved by ${approver} (requested by ${p.actor}).`, es: `${p.id} aprobada por ${approver} (solicitada por ${p.actor}).` });
  await checkout(p);
  return p;
}

export function rejectPurchase(purchaseId, approver = 'finance-approver') {
  const s = load();
  const p = s.purchases.find(x => x.id === purchaseId);
  if (!p) throw bizErr('Purchase not found');
  transition('purchase', p, 'REJECTED', approver);
  p.reservedCents = 0;
  op(s, { step: 8, action: 'SPEND_REJECTED', ref: p.id, actor: approver, en: `${p.id} rejected by ${approver}; reserved cash released.`, es: `${p.id} rechazada por ${approver}; se liberó el efectivo reservado.` });
  save();
  return p;
}

async function checkout(p) {
  const s = load();
  if (!p.vendorSku || !vendorBySku(p.vendorSku)) { p.lastError = 'QUOTE_ONLY_MERCHANT_NOT_SUPPORTED'; save(); return p; }
  if (s.enrollment?.status !== 'ACTIVE') {
    if (p.blocked !== 'ENROLLMENT_NOT_ACTIVE') op(s, { step: 8, action: 'CHECKOUT_WAITING_CARD', ref: p.id, actor: 'spend-agent', level: 'WARN', en: `${p.id} approved — waiting for the Reap card enrollment to be ACTIVE before checkout.`, es: `${p.id} aprobada — esperando que el registro de tarjeta Reap esté ACTIVO para el checkout.` });
    p.blocked = 'ENROLLMENT_NOT_ACTIVE'; save(); return p;
  }
  if (!p.quoteExpiresAt || Date.parse(p.quoteExpiresAt) - Date.now() < 30000) {
    try {
      const q = await quoteFor(p, `quote:${p.id}:${Date.now()}`);
      const total = toCents(q.amountBreakdown.finalAmount.amount);
      const avail = budgets().find(b => b.id === p.costCenter).availableCents + p.reservedCents;
      if (total > avail) { p.lastError = 'INSUFFICIENT_COLLECTED_CASH after re-quote'; save(); return p; }
      Object.assign(p, { quoteId: q.id, quoteExpiresAt: q.expiresAt, breakdown: q.amountBreakdown, totalCents: total, reservedCents: total });
      audit({ entityType: 'purchase', entityId: p.id, event: 'REQUOTED', payload: { total } });
    } catch (e) { p.lastError = e instanceof ReapError ? `${e.code}: ${JSON.stringify(e.detail)}` : e.message; save(); return p; }
  }
  try {
    const c = await reap.createCheckout({ quoteId: p.quoteId, enrollmentId: s.enrollment.id, returnUrl: `${PUBLIC_URL()}/return?kind=checkout&purchase=${p.id}`, idempotencyKey: `checkout:${p.id}:${p.quoteId}`, simulate: SIMULATE() });
    delete p.blocked; delete p.lastError;
    p.checkoutId = c.id;
    p.approvalUrl = c.nextAction?.url || null;
    transition('purchase', p, c.status, 'reap', { checkoutId: c.id });
    op(s, { step: 8, action: 'REAP_CHECKOUT_' + c.status, ref: p.id, amountCents: p.totalCents, actor: 'reap',
      en: `Reap checkout ${c.id.slice(0, 8)}… → ${c.status}${SIMULATE() ? ' (sandbox simulated charge, no real money)' : ''}.`, es: `Checkout Reap ${c.id.slice(0, 8)}… → ${c.status}${SIMULATE() ? ' (cargo simulado en sandbox, sin dinero real)' : ''}.` });
    if (c.status === 'COMPLETED') settle(p, c);
  } catch (e) {
    p.lastError = e instanceof ReapError ? `${e.code}: ${e.message}` : e.message;
    exception('purchase', p.id, 'CHECKOUT_ERROR', 'HIGH', { error: p.lastError });
    op(s, { step: 8, action: 'REAP_CHECKOUT_ERROR', ref: p.id, actor: 'reap', level: 'WARN', en: `Reap checkout error for ${p.id}: ${p.lastError}`, es: `Error de checkout Reap para ${p.id}: ${p.lastError}` });
  }
  save();
  return p;
}

export async function retryCheckout(purchaseId) {
  const p = load().purchases.find(x => x.id === purchaseId);
  if (!p || p.status !== 'APPROVED') throw bizErr('Only APPROVED purchases can be (re)submitted');
  return checkout(p);
}

export async function refreshPurchase(purchaseId) {
  const s = load();
  const p = s.purchases.find(x => x.id === purchaseId);
  if (!p?.checkoutId || ['COMPLETED', 'FAILED', 'EXPIRED', 'REJECTED'].includes(p.status)) return p;
  const c = await reap.getCheckout(p.checkoutId);
  if (c.status !== p.status) {
    transition('purchase', p, c.status, 'reap');
    if (c.status === 'COMPLETED') settle(p, c);
    if (['FAILED', 'EXPIRED'].includes(c.status)) p.reservedCents = 0;
  }
  save();
  return p;
}

function settle(p, c) {
  const s = load();
  const charged = c.finalAmount ? toCents(c.finalAmount.amount) : c.amount ? toCents(c.amount.amount) : p.totalCents;
  Object.assign(p, { orderId: p.orderId, merchantOrderId: c.orderId || null, chargedCents: charged, reservedCents: 0, settledDate: s.asOf });
  const { trace, shortfall } = consume(p.costCenter, charged);
  p.fundingTrace = trace;
  const account = p.kind === 'FULFILLMENT' ? '5000' : charged >= CAPITALIZATION_THRESHOLD_CENTS ? '1500' : '6500';
  const je = postJE(s, { date: s.asOf, type: 'REAP_PURCHASE', step: 8, preparer: p.actor, approver: p.approver || null, source: { type: 'purchase', id: p.id, reapCheckout: c.id, merchantOrder: c.orderId || null },
    memo: `Reap ${p.kind.toLowerCase()} purchase — ${p.productName} ×${p.quantity} (${p.merchant})`, lines: [{ account, debit: charged, costCenter: p.costCenter }, { account: '1000', credit: charged }] });
  p.je = je.id;
  if (charged !== p.totalCents) exception('purchase', p.id, 'CHARGED_DIFFERS_FROM_QUOTE', 'MEDIUM', { quoted: p.totalCents, charged });
  const peers = s.purchases.filter(x => x !== p && x.status === 'COMPLETED' && x.costCenter === p.costCenter);
  const avg = peers.length >= 3 ? sum(peers, x => x.chargedCents || 0) / peers.length : 0;
  if (avg && charged > 3 * avg) exception('purchase', p.id, 'UNUSUAL_SPEND', 'MEDIUM', { charged, peerAverage: Math.round(avg) });
  if (shortfall > 0) exception('purchase', p.id, 'SPEND_EXCEEDS_COLLECTED_CASH', 'HIGH', { shortfall });
  audit({ entityType: 'purchase', entityId: p.id, event: 'SPEND_POSTED', actor: 'reap', payload: { charged, orderId: c.orderId, trace } });
  op(s, { step: 8, action: 'REAP_SPEND_POSTED', ref: p.id, je, amountCents: charged, actor: 'reap', controls: ['C-SPD-02', 'C-SPD-04'],
    en: `Reap charge settled ${$en(charged)} for ${p.productName}${c.orderId ? `, merchant order ${c.orderId}` : ''} — Dr ${account} ${COA[account].name.en} / Cr 1000 Cash. Funded by ${[...new Set(trace.map(t => t.invoiceId))].slice(0, 3).join(', ')}.`,
    es: `Cargo Reap liquidado ${$es(charged)} por ${p.productName}${c.orderId ? `, orden ${c.orderId}` : ''} — Cargo ${account} ${COA[account].name.es} / Abono 1000 Caja. Fondeado por ${[...new Set(trace.map(t => t.invoiceId))].slice(0, 3).join(', ')}.` });
}

let refreshing = null, lastRefresh = 0;
export function refreshAllInBackground() {
  if (refreshing || Date.now() - lastRefresh < 4000) return;
  lastRefresh = Date.now();
  refreshing = (async () => {
    const s = load();
    if (s.enrollment && s.enrollment.status !== 'ACTIVE') await refreshEnrollment().catch(() => {});
    if (s.enrollment?.status === 'ACTIVE') for (const p of s.purchases.filter(p => p.status === 'APPROVED' && p.blocked === 'ENROLLMENT_NOT_ACTIVE')) await checkout(p).catch(() => {});
    for (const p of s.purchases.filter(p => ['REQUIRES_ACTION', 'PROCESSING'].includes(p.status))) await refreshPurchase(p.id).catch(() => {});
    if ((s.reapQueue || []).length) drainReapQueue();
  })().finally(() => { refreshing = null; });
}

// =====================================================================
// REPORTS
// =====================================================================
export function arAging() {
  const s = load();
  const B = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd91_180', 'd180p'];
  const bucket = dpd => dpd <= 0 ? 'notDue' : dpd <= 30 ? 'd1_30' : dpd <= 60 ? 'd31_60' : dpd <= 90 ? 'd61_90' : dpd <= 180 ? 'd91_180' : 'd180p';
  const rows = s.customers.map(c => {
    const r = { customerId: c.id, top: c.top, name: c.legalName, analyst: c.analyst, rep: c.salesRep, creditHold: c.creditHold, total: 0, pastDue: 0 };
    for (const b of B) r[b] = 0;
    for (const i of s.invoices.filter(i => i.customerId === c.id && i.outstandingCents > 0)) {
      const dpd = daysBetween(i.dueDate, s.asOf);
      r[bucket(dpd)] += i.outstandingCents; r.total += i.outstandingCents; if (dpd > 0) r.pastDue += i.outstandingCents;
    }
    r.pctPastDue = r.total ? Math.round((r.pastDue / r.total) * 100) : 0;
    return r;
  }).sort((a, b) => b.total - a.total || a.top - b.top);
  const totals = { total: sum(rows, r => r.total), pastDue: sum(rows, r => r.pastDue) };
  for (const b of B) totals[b] = sum(rows, r => r[b]);
  return { asOf: s.asOf, buckets: B, rows, totals, glAR: balance(s, '1100'), ties: totals.total === balance(s, '1100') };
}

export function arRollforward(m) {
  const s = load();
  m = m || s.openMonth;
  const upTo = monthEnd(m) < s.asOf ? monthEnd(m) : s.asOf;
  const rows = [];
  let bal = balance(s, '1100', addDays(monthStart(m), -1));
  for (let d = monthStart(m); d <= upTo; d = addDays(d, 1)) {
    const lines = s.journal.filter(j => j.date === d && j.type !== 'OPENING').flatMap(j => j.lines.filter(l => l.account === '1100').map(l => ({ ...l, type: j.type })));
    const billed = sum(lines.filter(l => l.debit), l => l.debit);
    const collected = sum(lines.filter(l => l.credit && l.type === 'CASH_APPLICATION'), l => l.credit);
    const credits = sum(lines.filter(l => l.credit && l.type === 'CREDIT_NOTE'), l => l.credit);
    const begin = bal; bal = begin + billed - collected - credits;
    rows.push({ date: d, begin, billed, collected, credits, end: bal, moved: billed || collected || credits });
  }
  return { month: m, rows };
}

export function customerStatement(customerId) {
  const s = load();
  const c = s.customers.find(x => x.id === customerId);
  if (!c) throw bizErr('Customer not found');
  const tx = [];
  for (const i of s.invoices.filter(i => i.customerId === customerId)) {
    tx.push({ date: i.source === 'AR_REPORT' ? '2026-09-30' : i.issueDate, type: i.source === 'AR_REPORT' ? 'OPENING_INVOICE' : 'INVOICE', ref: i.id, due: i.dueDate, debit: i.originalCents, credit: 0 });
    for (const a of s.applications.filter(a => a.invoiceId === i.id)) tx.push({ date: a.date, type: 'PAYMENT', ref: `${a.paymentId} → ${i.id}`, debit: 0, credit: a.appliedCents });
    for (const n of s.creditNotes.filter(n => n.invoiceId === i.id)) tx.push({ date: n.date, type: 'CREDIT_NOTE', ref: `${n.id} → ${i.id}`, debit: 0, credit: n.cents });
  }
  tx.sort((a, b) => a.date.localeCompare(b.date) || (a.debit ? -1 : 1));
  let bal = 0;
  for (const t of tx) { bal += t.debit - t.credit; t.balance = bal; }
  return { customer: c, asOf: s.asOf, tx, balance: bal, open: s.invoices.filter(i => i.customerId === customerId && i.outstandingCents > 0).map(i => invoiceView(i, s)) };
}

export function revenueRecon() {
  const s = load();
  const rows = s.orders.map(o => {
    const inv = s.invoices.find(i => i.id === o.invoiceId);
    const billed = inv ? inv.originalCents : 0;
    const recognized = o.recognizedPosted || 0;
    return { orderId: o.id, customer: custName(s, o.customerId), type: o.type, contract: o.amountCents, status: o.status, billed, recognized, deferred: Math.max(0, billed - recognized), unbilled: Math.max(0, recognized - billed), schedule: o.type === 'SERVICE' ? `${o.serviceStart} → ${o.serviceEnd}` : o.deliveryDate };
  });
  const totRecognized = sum(rows, r => r.recognized), totDeferred = sum(rows, r => r.deferred);
  const glRevenue = s.journal.filter(j => j.type !== 'OPENING').flatMap(j => j.lines).filter(l => ['4000', '4010'].includes(l.account)).reduce((a, l) => a + (l.credit || 0) - (l.debit || 0), 0);
  const glDeferred = balance(s, '2100');
  return { rows, totals: { contract: sum(rows, r => r.contract), billed: sum(rows, r => r.billed), recognized: totRecognized, deferred: totDeferred },
    gl: { revenue: glRevenue, deferred: glDeferred }, revenueTies: glRevenue === totRecognized, deferredTies: glDeferred === totDeferred };
}

export function statements(m) {
  const s = load();
  m = m || s.openMonth;
  const asOf = monthEnd(m) < s.asOf ? monthEnd(m) : s.asOf;
  return { period: m, asOf, income: incomeStatement(s, m), balance: balanceSheet(s, asOf), cashFlow: cashFlow(s, m), trial: trialBalance(s, asOf) };
}

export function journal(limit = 300) { return load().journal.slice(-limit).reverse(); }

// =====================================================================
// SOX CONTROL MATRIX — automated tests with evidence
// =====================================================================
export function soxControls() {
  const s = load();
  const R = revenueRecon(), aging = arAging(), cash = cashPosition(), tb = trialBalance(s), bs = balanceSheet(s, s.asOf);
  const billedOrders = s.orders.filter(o => o.invoiceId);
  const validatedFirst = billedOrders.filter(o => s.audit.some(a => a.entityId === o.id && a.to === 'VALIDATED'));
  const badCols = s.collections.filter(c => { const i = s.invoices.find(x => x.id === c.invoiceId); return i && (i.authorization !== 'VALID' || i.status === 'DISPUTED'); });
  const keys = s.collections.map(c => c.idempotencyKey);
  const overCollected = s.invoices.filter(i => sum(s.applications.filter(a => a.invoiceId === i.id), a => a.appliedCents) > i.originalCents);
  const bigBuys = s.purchases.filter(p => ['APPROVED', 'REQUIRES_ACTION', 'PROCESSING', 'COMPLETED'].includes(p.status) && p.totalCents > SPEND_POLICY.autoApproveMaxCents && !p.ruleId && p.kind !== 'FULFILLMENT');
  const sodOk = bigBuys.filter(p => p.approver && p.approver !== p.actor && !String(p.approver).startsWith('policy-engine'));
  const completed = s.purchases.filter(p => p.status === 'COMPLETED');
  const paidBills = s.apBills.filter(b => b.status === 'PAID');
  const chains = { audit: verifyChain(s.audit), journal: verifyChain(s.journal), oplog: verifyChain(s.oplog) };
  const lateClosedPosts = s.journal.filter(j => s.closedMonths.some(c => c.month === j.period && j.postedAt > c.closedAt));
  const C = (id, area, objective, type, nature, frequency, owner, ok, evidence) => ({ id, area, objective, type, nature, frequency, owner, ok, evidence });
  return [
    C('C-OTC-01', 'Order-to-Cash', 'Orders are validated (customer, credit, price, terms, dates) before billing', 'Preventive', 'Automated', 'Per order', 'Order agent / AR manager', validatedFirst.length === billedOrders.length, `${validatedFirst.length}/${billedOrders.length} billed orders validated first`),
    C('C-OTC-02', 'Order-to-Cash', 'Customers on credit hold cannot be billed for new orders', 'Preventive', 'Automated', 'Per order', 'Credit analyst (FRANK)', !s.orders.some(o => o.invoiceId && s.audit.some(a => a.entityId === o.id && a.payload?.issues?.includes('CUSTOMER_ON_CREDIT_HOLD')) && !s.audit.some(a => a.entityId === o.id && a.to === 'VALIDATED')), `${s.customers.filter(c => c.creditHold).length} customer(s) on hold`),
    C('C-REV-01', 'Revenue (ASC 606)', 'GL revenue equals revenue earned per contract (point in time / over time)', 'Detective', 'Automated', 'Daily', 'Revenue accountant', R.revenueTies, `GL ${$en(R.gl.revenue)} vs contracts ${$en(R.totals.recognized)}`),
    C('C-REV-02', 'Revenue (ASC 606)', 'Deferred revenue (contract liability) equals billed-not-earned', 'Detective', 'Automated', 'Daily', 'Revenue accountant', R.deferredTies, `GL 2100 ${$en(R.gl.deferred)} vs schedule ${$en(R.totals.deferred)}`),
    C('C-BIL-01', 'Billing', 'Every delivery / service start is invoiced the same day (completeness)', 'Detective', 'Automated', 'Daily', 'Billing agent', !s.orders.some(o => ['DELIVERED', 'IN_SERVICE'].includes(o.status)), `${billedOrders.length} invoices from orders`),
    C('C-COL-01', 'Collections', 'Debits only on authorized, undisputed, due invoices', 'Preventive', 'Automated', 'Per debit', 'Collections lead', badCols.length === 0, `${s.collections.length} debit attempts, ${badCols.length} unauthorized`),
    C('C-COL-02', 'Collections', 'No duplicate debits or over-collection (idempotency)', 'Preventive', 'Automated', 'Per debit', 'Collections lead', new Set(keys).size === keys.length && overCollected.length === 0, `${keys.length} unique keys, ${overCollected.length} over-collected invoices`),
    C('C-CA-01', 'Cash application', 'All receipts applied; unapplied cash is zero or under exception', 'Detective', 'Automated', 'Daily', 'Cash-app agent', balance(s, '2300') === 0, `Unapplied cash ${$en(balance(s, '2300'))}`),
    C('C-AR-01', 'AR', 'AR subledger (aging) reconciles to GL 1100', 'Detective', 'Automated', 'Daily', 'AR manager', aging.ties, `Aging ${$en(aging.totals.total)} vs GL ${$en(aging.glAR)}`),
    C('C-CASH-01', 'Treasury', 'GL cash reconciles to bank + Reap settlement ledger', 'Detective', 'Automated', 'Daily', 'Treasurer', cash.cashCents === cash.bankLedgerCents, `GL ${$en(cash.cashCents)} vs bank/Reap ${$en(cash.bankLedgerCents)}`),
    C('C-SPD-01', 'Spend (Reap)', 'Purchases > $1,000 approved by someone other than the requester; standing orders pre-approved with caps', 'Preventive', 'Automated', 'Per purchase', 'Controller', sodOk.length === bigBuys.length, `${sodOk.length}/${bigBuys.length} large purchases with independent approval; ${s.recurring.length} capped standing orders`),
    C('C-SPD-02', 'Spend (Reap)', 'Spend never exceeds collected cash per cost center (reserve untouched)', 'Preventive', 'Automated', 'Per purchase', 'Treasurer', budgets().every(b => b.availableCents >= 0) && !s.exceptions.some(e => e.reason === 'SPEND_EXCEEDS_COLLECTED_CASH') && cash.cashCents >= cash.reserveCents, `Cash ${$en(cash.cashCents)} ≥ reserve ${$en(cash.reserveCents)}`),
    C('C-SPD-03', 'Spend (Reap)', 'Completed purchases only from supported merchants; travel/restricted categories blocked', 'Preventive', 'Automated', 'Per purchase', 'Controller', completed.every(p => p.vendorSku && vendorBySku(p.vendorSku) && !restrictedReason(p.productName)), `${completed.length} completed, all supported; ${s.oplog.filter(o => o.action === 'SPEND_BLOCKED').length} restricted requests blocked`),
    C('C-SPD-04', 'Spend (Reap)', 'Reap charged amount equals GL expense (re-read at close)', 'Detective', 'Automated', 'Monthly', 'Close agent', completed.every(p => !p.reapVerified || p.reapVerified.ok), `${completed.filter(p => p.reapVerified?.ok).length}/${completed.length} verified against Reap API`),
    C('C-AP-01', 'Expenses / AP', 'Every AP payment matches an accrued bill; no duplicates', 'Preventive', 'Automated', 'Per payment', 'AP lead', paidBills.every(b => b.accrualJE && b.paymentJE) && new Set(paidBills.map(b => b.id)).size === paidBills.length, `${paidBills.length} bills paid, all accrued`),
    C('C-ECL-01', 'Credit loss (ASC 326)', 'Allowance for credit losses estimated with a documented matrix and approved by someone other than the preparer', 'Detective', 'Automated + manual approval', 'Monthly', 'Controller', (s.eclProposals || []).filter(p => p.status === 'APPROVED').every(p => p.approver && p.approver !== p.preparer), `${(s.eclProposals || []).filter(p => p.status === 'APPROVED').length} approved estimate(s); allowance ${$en(balance(s, '1190'))}`),
    C('C-AP-02', 'Expenses / AP', 'Possible duplicate supplier invoices are held before payment', 'Preventive', 'Automated', 'Per bill', 'AP lead', !s.apBills.some(b => b.status === 'PAID' && s.exceptions.some(e => e.entityId === b.id && e.reason === 'POSSIBLE_DUPLICATE_SUPPLIER_INVOICE')), `${s.exceptions.filter(e => e.reason === 'POSSIBLE_DUPLICATE_SUPPLIER_INVOICE').length} duplicate(s) held`),
    C('C-GL-01', 'General ledger', 'Journal entries balanced; trial balance and balance sheet balance', 'Preventive', 'Automated', 'Per entry', 'Controller', tb.balanced && bs.balanced, `${s.journal.length} entries · TB Dr ${$en(tb.totalDebit)} = Cr ${$en(tb.totalCredit)} · A = L + E ${bs.balanced ? '✓' : '✗'}`),
    C('C-GL-02', 'General ledger', 'Closed periods are locked — no postings after close', 'Preventive', 'Automated', 'Per entry', 'Controller', lateClosedPosts.length === 0, `Locked: ${s.closedPeriods.join(', ') || '—'} · late postings ${lateClosedPosts.length}`),
    C('C-ITGC-01', 'IT general controls', 'Audit trail, journal and operations log are append-only and hash-chained (tamper-evident)', 'Detective', 'Automated', 'Continuous', 'IT / Internal audit', chains.audit.ok && chains.journal.ok && chains.oplog.ok, `audit ${chains.audit.count} · journal ${chains.journal.count} · ops ${chains.oplog.count} — chains ${chains.audit.ok && chains.journal.ok && chains.oplog.ok ? 'intact' : 'BROKEN'}`),
    C('C-ITGC-02', 'IT general controls', 'Card data never reaches CAI/agents (hosted Reap enrollment); sandbox-only simulated checkout', 'Preventive', 'Automated', 'Continuous', 'IT security', SIMULATE() && String(process.env.REAP_BASE_URL || '').includes('sandbox'), `Reap ${String(process.env.REAP_BASE_URL || '').replace('https://', '')} · simulate ${SIMULATE()}`),
    C('C-CLS-01', 'Close', 'Month-end close checklist executed and signed off before period lock', 'Detective', 'Manual + automated', 'Monthly', 'Controller', s.closedMonths.every(c => c.checklist?.length && c.closedBy), `${s.closedMonths.length} period(s) closed with checklist`),
  ];
}

// =====================================================================
// Reconciliation summary
// =====================================================================
export function reconcile() {
  const s = load();
  const confirmed = sum(s.collections.filter(c => c.status === 'COLLECTION_CONFIRMED'), c => c.confirmedCents);
  const received = sum(s.payments, p => p.receivedCents);
  const applied = sum(s.applications, a => a.appliedCents);
  const allocated = sum(s.allocations, a => a.cents);
  const spent = sum(s.allocations, a => a.consumedCents);
  const charged = sum(s.purchases.filter(p => p.status === 'COMPLETED'), p => p.chargedCents || 0);
  const apPaid = sum(s.apBills.filter(b => b.status === 'PAID'), b => b.cents);
  const outstanding = sum(s.invoices, i => i.outstandingCents);
  const R = revenueRecon();
  const checks = [
    { id: 'COLLECTIONS_EQ_RECEIPTS', ok: confirmed === received, a: confirmed, b: received },
    { id: 'RECEIPTS_EQ_APPLIED', ok: received === applied, a: received, b: applied },
    { id: 'RECEIPTS_EQ_ALLOCATED', ok: received === allocated, a: received, b: allocated },
    { id: 'SPEND_LE_ALLOCATED', ok: spent <= allocated, a: spent, b: allocated },
    { id: 'REAP_PLUS_AP_EQ_SPEND', ok: charged + apPaid === spent, a: charged + apPaid, b: spent },
    { id: 'AR_SUBLEDGER_EQ_GL', ok: outstanding === balance(s, '1100'), a: outstanding, b: balance(s, '1100') },
    { id: 'CASH_GL_EQ_BANK_REAP', ok: balance(s, '1000') === cashPosition().bankLedgerCents, a: balance(s, '1000'), b: cashPosition().bankLedgerCents },
    { id: 'REVENUE_GL_EQ_CONTRACTS', ok: R.revenueTies, a: R.gl.revenue, b: R.totals.recognized },
    { id: 'DEFERRED_GL_EQ_SCHEDULE', ok: R.deferredTies, a: R.gl.deferred, b: R.totals.deferred },
    { id: 'TRIAL_BALANCE', ok: trialBalance(s).balanced, a: trialBalance(s).totalDebit, b: trialBalance(s).totalCredit },
    { id: 'CASH_ABOVE_RESERVE', ok: balance(s, '1000') >= s.openingCashCents, a: balance(s, '1000'), b: s.openingCashCents },
    { id: 'EVERY_SPEND_TRACED', ok: s.purchases.filter(p => p.status === 'COMPLETED').every(p => p.fundingTrace?.length) && s.apBills.filter(b => b.status === 'PAID').every(b => b.fundingTrace?.length), a: null, b: null },
  ];
  return { checks, totals: { confirmed, received, applied, allocated, spent, charged, apPaid }, exceptions: s.exceptions };
}

export function snapshot() {
  const s = load();
  return {
    asOf: s.asOf, openMonth: s.openMonth,
    portfolio: portfolio(), priorities: prioritizeCollections(),
    orders: s.orders.map(o => ({ ...o, recognizedCents: o.recognizedPosted || 0 })),
    collections: s.collections, payments: s.payments, applications: s.applications, allocations: s.allocations,
    creditNotes: s.creditNotes, apBills: s.apBills, recurring: s.recurring, reapQueue: reapQueueStatus(),
    budgets: budgets(), cash: cashPosition(), forecast: cashForecast(30),
    purchases: s.purchases, enrollment: s.enrollment,
    mastersheet: mastersheet(), closeChecklist: closeChecklist(), closedMonths: s.closedMonths.map(c => ({ ...c, statements: undefined, sox: undefined })),
    reconciliation: reconcile(), sox: soxControls(),
    aging: arAging(), rollforward: arRollforward(), revenue: revenueRecon(), statements: statements(),
    oplog: s.oplog.slice(-600).reverse(), journal: journal(400), coa: COA,
    audit: s.audit.slice(-250).reverse(),
    vendors: VENDORS, policy: { allocation: ALLOCATION_POLICY, spend: SPEND_POLICY },
    cfo: { questions: cfoQuestions(), kpis: cfoKpis(), narrative: { en: cfoNarrative('en'), es: cfoNarrative('es') }, forecast13w: forecast13w(), reports: reportCatalog(), agents: financeAgents(), ecl: { calc: eclRequired(), proposals: (s.eclProposals || []).slice(-5).reverse() } },
    simulateCheckout: SIMULATE(), sandbox: String(process.env.REAP_BASE_URL || 'sandbox').includes('sandbox'),
  };
}

// =====================================================================
// ASC 326 — expected credit losses (aging matrix). Agent prepares, controller approves, system posts.
// =====================================================================
export const ECL_MATRIX = { version: 'ECL-2026-10-v1', rates: { notDue: 50, d1_30: 200, d31_60: 500, d61_90: 1500, d91_180: 4000, d180p: 7500, disputed: 5000 } };
export function eclRequired() {
  const s = load();
  const rows = {};
  for (const k of Object.keys(ECL_MATRIX.rates)) rows[k] = { gross: 0, rateBps: ECL_MATRIX.rates[k], required: 0 };
  for (const i of s.invoices.filter(i => i.outstandingCents > 0)) {
    const dpd = daysBetween(i.dueDate, s.asOf);
    const k = i.status === 'DISPUTED' ? 'disputed' : dpd <= 0 ? 'notDue' : dpd <= 30 ? 'd1_30' : dpd <= 60 ? 'd31_60' : dpd <= 90 ? 'd61_90' : dpd <= 180 ? 'd91_180' : 'd180p';
    rows[k].gross += i.outstandingCents;
  }
  for (const r of Object.values(rows)) r.required = Math.round((r.gross * r.rateBps) / 10000);
  const required = sum(Object.values(rows), r => r.required);
  const current = balance(s, '1190');
  return { asOf: s.asOf, matrix: ECL_MATRIX.version, rows, required, current, adjustment: required - current, grossAR: balance(s, '1100') };
}

export function proposeECL(actor = 'accounting-agent') {
  const s = load();
  s.eclProposals = s.eclProposals || [];
  for (const p of s.eclProposals.filter(p => p.status === 'PENDING_APPROVAL')) p.status = 'SUPERSEDED';
  const p = { id: id('ecl'), period: s.openMonth, date: s.asOf, preparer: actor, status: 'PENDING_APPROVAL', ...eclRequired() };
  s.eclProposals.push(p);
  audit({ entityType: 'ecl', entityId: p.id, event: 'ECL_PROPOSED', actor, payload: { required: p.required, adjustment: p.adjustment } });
  op(s, { step: 9, action: 'ECL_PROPOSED', ref: p.id, amountCents: p.adjustment, actor, controls: ['C-ECL-01'],
    en: `ASC 326 allowance proposed: required ${$en(p.required)} on gross AR ${$en(p.grossAR)} (${ECL_MATRIX.version}); adjustment ${$en(p.adjustment)} — needs controller approval.`,
    es: `Estimación ASC 326 propuesta: requerida ${$es(p.required)} sobre CxC bruta ${$es(p.grossAR)} (${ECL_MATRIX.version}); ajuste ${$es(p.adjustment)} — requiere aprobación del contralor.` });
  save();
  return p;
}

export function approveECL(proposalId, approver = 'controller') {
  const s = load();
  const p = (s.eclProposals || []).find(x => x.id === proposalId);
  if (!p || p.status !== 'PENDING_APPROVAL') throw bizErr('No pending ECL proposal with that id');
  if (approver === p.preparer) throw bizErr('Segregation of duties: preparer cannot approve their own estimate', 'SOD_VIOLATION');
  const adj = p.adjustment;
  const je = adj === 0 ? null : postJE(s, { date: s.asOf, type: 'ECL_ADJUSTMENT', step: 9, preparer: p.preparer, approver, source: { type: 'ecl', id: p.id },
    memo: `ASC 326 allowance ${adj > 0 ? 'increase' : 'release'} (${p.matrix})`,
    lines: adj > 0 ? [{ account: '6900', debit: adj }, { account: '1190', credit: adj }] : [{ account: '1190', debit: -adj }, { account: '6900', credit: -adj }] });
  Object.assign(p, { status: 'APPROVED', approver, approvedOn: s.asOf, je: je?.id || null });
  audit({ entityType: 'ecl', entityId: p.id, event: 'ECL_APPROVED', actor: approver, payload: { adjustment: adj } });
  op(s, { step: 9, action: 'ECL_APPROVED', ref: p.id, je, amountCents: adj, actor: approver, controls: ['C-ECL-01'],
    en: `ASC 326 allowance approved by ${approver}: ${adj ? `${$en(Math.abs(adj))} ${adj > 0 ? '(Dr 6900 / Cr 1190)' : '(Dr 1190 / Cr 6900)'}` : 'no change'}. Allowance ${$en(balance(s, '1190'))}.`,
    es: `Estimación ASC 326 aprobada por ${approver}: ${adj ? `${$es(Math.abs(adj))} ${adj > 0 ? '(Cargo 6900 / Abono 1190)' : '(Cargo 1190 / Abono 6900)'}` : 'sin cambio'}. Estimación ${$es(balance(s, '1190'))}.` });
  save();
  return p;
}

function snapshotForecast(s) {
  s.forecastSnapshots = s.forecastSnapshots || {};
  if (s.forecastSnapshots[s.openMonth]) return;
  const f = cashForecast(0, monthEnd(s.openMonth));
  s.forecastSnapshots[s.openMonth] = { madeOn: s.asOf, horizon: f.horizon, projectedCents: f.projectedCents };
}

export function forecast13w() {
  const s = load();
  const prob = i => { if (i.status === 'DISPUTED') return 0; if (i.authorization !== 'VALID') return 0.5; const d = daysBetween(i.dueDate, s.asOf); return d <= 0 ? 0.95 : d <= 30 ? 0.85 : d <= 60 ? 0.6 : d <= 90 ? 0.4 : 0.1; };
  const horizon = addDays(s.asOf, 91);
  const bills = s.apBills.filter(b => b.status !== 'PAID');
  for (let m = nextMonth(s.openMonth); monthStart(m) <= horizon; m = nextMonth(m)) bills.push(...apBillsFor(m));
  let bal = balance(s, '1000');
  const weeks = [];
  for (let w = 0; w < 13; w++) {
    const start = addDays(s.asOf, 1 + 7 * w), end = addDays(start, 6);
    const inWeek = d => (w === 0 ? d <= end : d >= start && d <= end);
    const inflow = Math.round(sum(s.invoices.filter(i => i.outstandingCents > 0 && inWeek(i.dueDate)), i => i.outstandingCents * prob(i)));
    const ap = sum(bills.filter(b => inWeek(b.dueDate)), b => b.cents);
    let reapOut = 0;
    for (const r of s.recurring.filter(r => r.active)) for (let d = start; d <= end; d = addDays(d, 1)) if (ruleDueOn(r, d)) reapOut += r.lastQuoteCents || vendorBySku(r.vendorSku).unitCents * r.quantity;
    const begin = bal; bal = begin + inflow - ap - reapOut;
    weeks.push({ week: w + 1, start, end, begin, inflow, ap, reap: reapOut, ending: bal, belowReserve: bal < s.openingCashCents });
  }
  return { asOf: s.asOf, reserveCents: s.openingCashCents, weeks };
}

// CFO decision center — 20 KPIs, each with owner, source and the formula with real numbers.
export function cfoKpis(m) {
  const s = load();
  m = m || s.openMonth;
  const closed = s.closedMonths.find(c => c.month === m);
  const prev = s.closedMonths.find(c => c.month === addDays(monthStart(m), -1).slice(0, 7));
  const I = closed?.statements?.income || incomeStatement(s, m);
  const CF = closed?.statements?.cashFlow || cashFlow(s, m);
  const row = mastersheetRow(m);
  const upTo = monthEnd(m) < s.asOf ? monthEnd(m) : s.asOf;
  const days = daysBetween(monthStart(m), upTo) + 1;
  const rev = I.netRevenue;
  const pct = (a, b) => (b ? Math.round((a / b) * 10000) / 100 : null);
  const ag = arAging();
  const grossAR = balance(s, '1100', upTo), pastDue = ag.totals.total - ag.totals.notDue, ar90 = ag.totals.d91_180 + ag.totals.d180p, allowance = balance(s, '1190', upTo);
  const invs = s.invoices.filter(i => i.source === 'ORDER');
  const accurate = invs.filter(i => !s.creditNotes.some(c => c.invoiceId === i.id) && i.status !== 'DISPUTED');
  const receipts = sum(s.payments, p => p.receivedCents);
  const dso = row.billed ? Math.round((((row.beginningAR + row.endingAR) / 2) / row.billed) * days * 10) / 10 : null;
  const ceiDen = row.beginningAR + row.billed - ag.totals.notDue;
  const apPrev = balance(s, '2000', addDays(monthStart(m), -1)), apNow = balance(s, '2000', upTo);
  const credPurch = s.journal.filter(j => j.period === m && j.type === 'AP_ACCRUAL').reduce((a, j) => a + sum(j.lines, l => l.credit || 0), 0);
  const dpo = credPurch ? Math.round((((apPrev + apNow) / 2) / credPurch) * days * 10) / 10 : null;
  const snap = (s.forecastSnapshots || {})[m];
  const flow = row.endingCash - row.beginningCash;
  const fca = closed && snap && flow ? Math.max(0, Math.round((1 - Math.abs(snap.projectedCents - row.endingCash) / Math.abs(flow)) * 10000) / 100) : null;
  const recon = reconcile().checks, sox = soxControls();
  const reserved = sum(s.purchases.filter(p => p.reservedCents > 0), p => p.reservedCents);
  const K = (n, fn, name, def, value, unit, owner, source, formula) => ({ n, function: fn, name, definition: def, value, unit, owner, source, formula });
  return { period: m, asOf: upTo, status: closed ? 'CLOSED — certified' : 'OPEN — preliminary', refreshedAt: new Date().toISOString(), kpis: [
    K(1, 'Revenue', 'Net revenue', 'Recognized revenue net of reductions', rev, '$', 'Controller', 'GL 4000+4010−4900', `${$en(I.goods)} + ${$en(I.services)} − ${$en(I.returns)}`),
    K(2, 'Revenue', 'Revenue growth', 'Current / prior period − 1', prev ? pct(rev - prev.statements.income.netRevenue, prev.statements.income.netRevenue) : null, '%', 'CFO', 'Income statements', prev ? `${$en(rev)} / ${$en(prev.statements.income.netRevenue)} − 1` : 'needs a prior closed period'),
    K(3, 'Profitability', 'Gross margin', '(Revenue − COGS) / revenue', pct(I.grossProfit, rev), '%', 'Controller', 'GL 4xxx, 5000', `${$en(I.grossProfit)} / ${$en(rev)}`),
    K(4, 'Profitability', 'EBITDA margin (non-GAAP)', 'EBITDA / revenue; no D&A, interest or tax in scope', pct(I.netIncome, rev), '%', 'CFO', 'Income statement', `${$en(I.netIncome)} / ${$en(rev)}`),
    K(5, 'Profitability', 'OPEX ratio', 'Operating expenses / revenue', pct(I.totalOpex, rev), '%', 'FP&A', 'GL 6000–6900', `${$en(I.totalOpex)} / ${$en(rev)}`),
    K(6, 'O2C', 'DSO', 'Average trade AR / credit sales × days', dso, 'days', 'O2C manager', 'GL 1100, billings', `avg(${$en(row.beginningAR)}, ${$en(row.endingAR)}) / ${$en(row.billed)} × ${days}`),
    K(7, 'O2C', 'CEI', '(Beg AR + sales − end AR) / (Beg AR + sales − end current AR)', ceiDen ? pct(row.beginningAR + row.billed - row.endingAR, ceiDen) : null, '%', 'Collections', 'Mastersheet + aging', `(${$en(row.beginningAR)} + ${$en(row.billed)} − ${$en(row.endingAR)}) / (… − ${$en(ag.totals.notDue)})`),
    K(8, 'O2C', 'Past-due AR', 'Overdue AR / total AR', pct(pastDue, ag.totals.total), '%', 'AR / Credit', 'Aging subledger', `${$en(pastDue)} / ${$en(ag.totals.total)}`),
    K(9, 'O2C', 'AR 90+ days', '> 90 days overdue / total AR', pct(ar90, ag.totals.total), '%', 'AR / Credit', 'Aging subledger', `${$en(ar90)} / ${$en(ag.totals.total)}`),
    K(10, 'Credit', 'ECL coverage', 'Allowance / gross receivables (ASC 326)', pct(allowance, grossAR), '%', 'Controller', 'GL 1190 / 1100', `${$en(allowance)} / ${$en(grossAR)}`),
    K(11, 'Billing', 'Invoice accuracy', 'Correct invoices / all invoices', invs.length ? pct(accurate.length, invs.length) : null, '%', 'Billing', 'Invoices, credit notes', `${accurate.length} / ${invs.length}`),
    K(12, 'Cash application', 'Unapplied receipts', 'Unapplied / total receipts', pct(balance(s, '2300'), receipts), '%', 'Cash app', 'GL 2300', `${$en(balance(s, '2300'))} / ${$en(receipts)}`),
    K(13, 'Treasury', 'Available cash', 'Cash less unavailable (reserved Reap purchases); designated reserve shown in formula', balance(s, '1000') - reserved, '$', 'Treasurer', 'GL 1000', `${$en(balance(s, '1000'))} − ${$en(reserved)} · reserve ${$en(s.openingCashCents)}`),
    K(14, 'Treasury', 'Cash forecast accuracy', '1 − |forecast error| / actual flow', fca, '%', 'Treasurer', 'Forecast snapshot vs close', snap ? `forecast ${$en(snap.projectedCents)} (${snap.madeOn}) vs ${closed ? $en(row.endingCash) : 'measured at close'}` : '—'),
    K(15, 'Treasury', 'Operating cash flow', 'Cash from operating activities', CF.operating, '$', 'Treasurer', 'Cash flow (direct = indirect)', `direct ${$en(CF.operating)} · indirect ${$en(CF.indirect.operating)}`),
    K(16, 'AP', 'DPO', 'Average AP / credit purchases × days', dpo, 'days', 'AP', 'GL 2000, accruals', `avg(${$en(apPrev)}, ${$en(apNow)}) / ${$en(credPurch)} × ${days}`),
    K(17, 'Working capital', 'Cash conversion cycle', 'DSO + DIO (0, no inventory) − DPO', dso != null && dpo != null ? Math.round((dso - dpo) * 10) / 10 : null, 'days', 'CFO / FP&A', 'KPI 06, 16', `${dso ?? '—'} + 0 − ${dpo ?? '—'}`),
    K(18, 'Accounting', 'Reconciliation completion', 'Reconciliations tying / due', pct(recon.filter(c => c.ok).length, recon.length), '%', 'Accounting', 'Reconciliation engine', `${recon.filter(c => c.ok).length} / ${recon.length}`),
    K(19, 'Accounting', 'Close cycle time', 'Business days from period end to approved close', closed ? 0 : null, 'days', 'Controller', 'Close event', closed ? `closed by ${closed.closedBy} at period end (T+0)` : 'period open'),
    K(20, 'Compliance', 'Key control effectiveness', 'Key controls passing / tested', pct(sox.filter(c => c.ok).length, sox.length), '%', 'Internal controls', 'SOX matrix', `${sox.filter(c => c.ok).length} / ${sox.length}`),
  ] };
}

export function cfoQuestions() {
  const s = load();
  const st = statements(), ag = arAging(), sox = soxControls(), rec = reconcile(), f = cashForecast(30);
  const decisions = [
    ...s.purchases.filter(p => p.status === 'NEEDS_APPROVAL').map(p => ({ type: 'SPEND_APPROVAL', ref: p.id, cents: p.totalCents, en: `Approve Reap purchase: ${p.productName} (${p.costCenter})`, es: `Aprobar compra Reap: ${p.productName} (${p.costCenter})` })),
    ...(s.eclProposals || []).filter(p => p.status === 'PENDING_APPROVAL').map(p => ({ type: 'ECL_APPROVAL', ref: p.id, cents: p.adjustment, en: 'Approve ASC 326 allowance adjustment', es: 'Aprobar ajuste de estimación ASC 326' })),
    ...prioritizeCollections().filter(p => p.action === 'CREDIT_HOLD').map(p => ({ type: 'CREDIT_HOLD', ref: p.customerId, cents: p.outstandingCents, en: `Credit hold recommended: ${p.customer} (${p.daysPastDue}d)`, es: `Bloqueo de crédito recomendado: ${p.customer} (${p.daysPastDue}d)` })),
    ...s.invoices.filter(i => i.status === 'DISPUTED' && i.outstandingCents > 0).map(i => ({ type: 'DISPUTE', ref: i.id, cents: i.outstandingCents, en: `Resolve dispute ${i.id} (${custName(s, i.customerId)})`, es: `Resolver disputa ${i.id} (${custName(s, i.customerId)})` })),
    ...s.orders.filter(o => o.status === 'VALIDATION_FAILED').map(o => ({ type: 'ORDER_HELD', ref: o.id, cents: o.amountCents, en: `Order ${o.id} held: ${(o.validation || []).join(', ')}`, es: `Pedido ${o.id} retenido: ${(o.validation || []).join(', ')}` })),
    ...s.exceptions.filter(e => e.status === 'OPEN' && e.severity === 'HIGH').map(e => ({ type: 'EXCEPTION', ref: e.id, cents: null, en: `High exception: ${e.reason} (${e.entityId})`, es: `Excepción alta: ${e.reason} (${e.entityId})` })),
    ...(s.enrollment?.status !== 'ACTIVE' ? [{ type: 'REAP_CARD', ref: s.enrollment?.id || '—', cents: null, en: 'Activate the Reap card so approved purchases complete', es: 'Activar la tarjeta Reap para completar compras' }] : []),
  ];
  return {
    earned: { netRevenue: st.income.netRevenue, grossProfit: st.income.grossProfit, netIncome: st.income.netIncome, period: st.period },
    cash: { cash: balance(s, '1000'), reserve: s.openingCashCents, forecast30: f.projectedCents, gap: f.liquidityGap },
    owed: { total: ag.totals.total, pastDue: ag.totals.total - ag.totals.notDue, allowance: balance(s, '1190'), top: ag.rows.filter(r => r.total).slice(0, 3).map(r => ({ name: r.name, total: r.total, pctPastDue: r.pctPastDue })) },
    accurate: { trialBalance: st.trial.balanced, balanceSheet: st.balance.balanced, recon: `${rec.checks.filter(c => c.ok).length}/${rec.checks.length}`, sox: `${sox.filter(c => c.ok).length}/${sox.length}`, chains: verifyChain(s.journal).ok && verifyChain(s.audit).ok && verifyChain(s.oplog).ok },
    decisions,
  };
}

export function cfoNarrative(lang = 'en') {
  const s = load();
  const cur = mastersheetRow(s.openMonth), prev = s.closedMonths.at(-1)?.row;
  const f = c => fmt(c, lang), es = lang === 'es';
  const ch = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
  const out = [];
  if (prev) {
    const r = ch(cur.revenue, prev.revenue), c = ch(cur.collections, prev.collections), a = ch(cur.endingAR, prev.endingAR);
    out.push(es ? `Ingreso ${r >= 0 ? 'aumentó' : 'disminuyó'} ${Math.abs(r)}% vs ${prev.month}. Cobranza ${c >= 0 ? 'aumentó' : 'disminuyó'} ${Math.abs(c)}%. CxC final ${a >= 0 ? 'subió' : 'bajó'} ${Math.abs(a)}% a ${f(cur.endingAR)}. Caja ${f(prev.endingCash)} → ${f(cur.endingCash)}.`
      : `Revenue ${r >= 0 ? 'increased' : 'declined'} ${Math.abs(r)}% against ${prev.month}. Collections ${c >= 0 ? 'increased' : 'decreased'} ${Math.abs(c)}%. Ending AR ${a >= 0 ? 'increased' : 'decreased'} ${Math.abs(a)}% to ${f(cur.endingAR)}. Cash ${f(prev.endingCash)} → ${f(cur.endingCash)}.`);
    if (r < -10) out.push(es ? 'Investigar la caída de ingresos y si la cobranza es repetible.' : 'Investigate the revenue decline and test whether collection strength is repeatable.');
  } else {
    const a = ch(cur.endingAR, cur.beginningAR);
    out.push(es ? `${cur.month} preliminar al ${s.asOf}: CxC ${a >= 0 ? 'subió' : 'bajó'} ${Math.abs(a)}% (${f(cur.beginningAR)} → ${f(cur.endingAR)}); cobranza ${f(cur.collections)} vs facturación ${f(cur.billed)}. Caja ${f(cur.beginningCash)} → ${f(cur.endingCash)}.`
      : `${cur.month} preliminary as of ${s.asOf}: AR ${a >= 0 ? 'rose' : 'fell'} ${Math.abs(a)}% (${f(cur.beginningAR)} → ${f(cur.endingAR)}); collections ${f(cur.collections)} vs billings ${f(cur.billed)}. Cash ${f(cur.beginningCash)} → ${f(cur.endingCash)}.`);
  }
  if (cur.billed > cur.revenue) out.push(es ? `Facturación supera ingreso por ${f(cur.billed - cur.revenue)}: servicios facturados por adelantado (ingreso diferido, ASC 606).` : `Billings exceed revenue by ${f(cur.billed - cur.revenue)}: services billed in advance (deferred revenue, ASC 606).`);
  const top = prioritizeCollections()[0];
  if (top) out.push(es ? `Mayor riesgo: ${top.customer} ${top.invoiceId} ${f(top.outstandingCents)} (${top.daysPastDue}d) → ${top.action}.` : `Top collections risk: ${top.customer} ${top.invoiceId} ${f(top.outstandingCents)} (${top.daysPastDue}d) → ${top.action}.`);
  return out;
}

export function reportCatalog() {
  const s = load();
  const ok = reconcile().checks.every(c => c.ok), now = new Date().toISOString();
  const R = (name, cadence, owner, tab, source) => ({ name, cadence, owner, tab, source, period: s.openMonth, asOf: s.asOf, refreshedAt: now, reconciliation: ok ? 'RECONCILED' : 'BREAKS' });
  return [
    R('CFO executive scorecard', 'Daily / monthly', 'CFO', 'cfo', 'GL + subledgers'),
    R('Revenue recognition and cutoff', 'Monthly', 'Controller', 'orders', 'Orders, invoices, GL 4000/4010/2100'),
    R('Order-to-cash performance', 'Weekly', 'O2C manager', 'process', 'Ops log, orders, invoices'),
    R('AR aging and credit exposure', 'Daily', 'AR / Credit', 'arr', 'Aging ↔ GL 1100, ECL 1190'),
    R('Collections forecast', 'Weekly', 'Collections', 'ar', 'Prioritization, aging probabilities'),
    R('Billing and dispute exceptions', 'Weekly', 'Billing', 'sox', 'Exceptions, credit notes'),
    R('Cash app and bank reconciliation', 'Daily', 'Cash app', 'cashapp', 'Receipts ↔ GL 1000/2300, Reap charges'),
    R('Liquidity and 13-week cash forecast', 'Daily / weekly', 'Treasurer', 'cfo', 'GL 1000, AR, AP, Reap standing orders'),
    R('AP aging and payment calendar', 'Weekly', 'AP', 'ap', 'AP bills ↔ GL 2000'),
    R('OPEX and budget variances', 'Monthly', 'FP&A', 'treasury', 'GL 6xxx, spend authority'),
    R('Working capital report', 'Monthly', 'CFO / FP&A', 'cfo', 'KPIs 06, 16, 17'),
    R('P&L, balance sheet, cash flow', 'Monthly', 'Controller', 'fs', 'GL'),
    R('GL and balance reconciliations', 'Monthly', 'Accounting', 'sox', 'Reconciliation engine'),
    R('SOX control exceptions', 'Weekly / monthly', 'Internal controls', 'sox', 'Control matrix'),
    R('Manual journals and access review', 'Monthly', 'Controller / IT', 'journal', 'Journal preparer/approver, audit trail'),
    R('Close and audit evidence pack', 'Monthly', 'Controller', 'master', 'Checklist, frozen statements, hash chains'),
  ];
}

export function financeAgents() {
  const s = load();
  const A = (name, fn, actors, autonomy) => { const ops = s.oplog.filter(o => actors.includes(o.actor)); return { name, function: fn, autonomy, actions: ops.length, last: ops.at(-1) || null }; };
  return [
    A('Revenue and billing', 'Validate orders, ASC 606 treatment, billing gaps', ['order-agent', 'billing-agent', 'revenue-agent'], 'Automated postings within policy'),
    A('Collections and credit', 'Risk segmentation, overdue flags, credit-hold recommendations', ['monitoring-agent', 'collection-agent', 'collections-agent'], 'Debits only authorized due invoices; credit notes need controller'),
    A('Cash application and treasury', 'Exact-match receipts, spend authority, 30-day / 13-week forecasts', ['cash-app-agent', 'treasury-agent'], 'Exact matches only; others → unapplied-cash exception'),
    A('AP and expenses (Reap)', 'Accrue/pay bills, duplicates, unusual spend, Reap purchasing', ['ap-agent', 'spend-agent', 'recurring-agent', 'procurement-agent', 'policy-engine', 'reap'], '> $1,000 human approval; standing orders capped'),
    A('Accounting and SOX', 'Reconciliations, ECL estimate, close checklist, evidence', ['accounting-agent', 'close-agent'], 'Prepares estimates; controller approves'),
    A('CFO intelligence', 'KPIs, narratives, decision queue', ['cai-agent'], 'Recommends; actions pass the same controls'),
  ];
}
