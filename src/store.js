// Tiny durable store: one JSON file, atomic writes. Good enough for a hackathon;
// swap for Postgres later without touching the engine (it only uses load/save/audit).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { buildSeed, buildOrders, AS_OF, ALLOCATION_POLICY, OPENING_CASH_CENTS, FIRST_MONTH, AP_TEMPLATES } from './seed.js';

const DIR = new URL('../data/', import.meta.url);
const FILE = new URL(process.env.CAI_STATE_FILE || 'state.json', DIR);

export function apBillsFor(month) {
  return AP_TEMPLATES.map((t, i) => ({
    id: `AP-${month.replace('-', '')}-${i + 1}`, vendor: t.vendor, costCenter: t.costCenter, category: t.category,
    cents: t.cents, dueDate: `${month}-${String(t.day).padStart(2, '0')}`, status: 'OPEN', paidDate: null,
  }));
}

const SCHEMA = 3;
const freshHooks = [];
export const onFresh = fn => freshHooks.push(fn); // engine opens the books (opening balances, accruals)

function fresh() {
  const { customers, invoices } = buildSeed();
  const s = {
    schema: SCHEMA,
    asOf: AS_OF,
    journal: [], gl: {}, oplog: [], closedPeriods: [], recurring: [],
    openMonth: FIRST_MONTH,
    openingCashCents: OPENING_CASH_CENTS,
    closedMonths: [],
    orders: buildOrders().map(o => ({ ...o, status: 'BOOKED', validation: null })),
    creditNotes: [],
    apBills: apBillsFor(FIRST_MONTH),
    customers,
    invoices: invoices.map(i => ({ ...i, source: 'AR_REPORT' })),
    collections: [],
    payments: [],
    applications: [],
    allocations: [],      // treasury: confirmed cash -> cost center budget slices
    purchases: [],        // agent spend through Reap
    exceptions: [],
    enrollment: null,     // Reap agentic enrollment (the company card)
    audit: [],
    centers: ALLOCATION_POLICY.centers.map(c => c.id),
  };
  return s;
}

let state = null;

function freshWithHooks(keep = {}) {
  state = fresh();
  Object.assign(state, keep);
  for (const fn of freshHooks) fn(state);
}

export function load() {
  if (state) return state;
  mkdirSync(DIR, { recursive: true });
  const disk = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;
  if (disk?.schema === SCHEMA && disk.journal?.length) state = disk;
  else freshWithHooks({ enrollment: disk?.enrollment || null });
  save();
  return state;
}

export function save() {
  mkdirSync(DIR, { recursive: true });
  const tmp = new URL(FILE.pathname.split('/').pop() + '.tmp', DIR);
  const data = JSON.stringify(state, null, 2);
  writeFileSync(tmp, data);
  // OneDrive/antivirus can briefly lock the target on Windows (EPERM/EBUSY). Retry, then fall back to a direct write.
  for (let i = 0; i < 5; i++) {
    try { renameSync(tmp, FILE); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 20 * (i + 1); while (Date.now() < until) { /* brief spin */ }
    }
  }
  writeFileSync(FILE, data);
}

export function reset() {
  const enrollment = state?.enrollment || null; // keep the enrolled Reap card across demo resets
  freshWithHooks({ enrollment });
  save();
  return state;
}

export const id = prefix => `${prefix}_${randomUUID().slice(0, 8)}`;

// Append-only, hash-chained audit log (each event commits to the previous one). Corrections are new events.
export function audit({ entityType, entityId, event, actor = 'system', from = null, to = null, payload = {} }) {
  const s = state || load();
  const prevHash = s.audit.at(-1)?.hash || 'GENESIS';
  const e = { id: id('evt'), ts: new Date().toISOString(), date: s.asOf, entityType, entityId, event, actor, from, to, payload, prevHash };
  e.hash = createHash('sha256').update(prevHash + JSON.stringify({ ...e, hash: undefined })).digest('hex');
  s.audit.push(e);
  return e;
}
