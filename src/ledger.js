// General ledger (US GAAP, accrual basis) + operations log + financial statements.
// Every business event posts a balanced journal entry. Entries are hash-chained (tamper-evident, SOX ITGC).
import { createHash } from 'node:crypto';
import { load } from './store.js';

// ---------- Chart of accounts ----------
export const COA = {
  '1000': { name: { en: 'Cash — operating', es: 'Efectivo — operativo' }, type: 'ASSET' },
  '1100': { name: { en: 'Accounts receivable', es: 'Cuentas por cobrar' }, type: 'ASSET' },
  '1190': { name: { en: 'Allowance for credit losses (ASC 326)', es: 'Estimación para pérdidas crediticias (ASC 326)' }, type: 'CONTRA_ASSET' },
  '1500': { name: { en: 'Equipment (capitalized)', es: 'Equipo (capitalizado)' }, type: 'ASSET' },
  '2000': { name: { en: 'Accounts payable', es: 'Cuentas por pagar' }, type: 'LIABILITY' },
  '2100': { name: { en: 'Deferred revenue (contract liability)', es: 'Ingreso diferido (pasivo contractual)' }, type: 'LIABILITY' },
  '2300': { name: { en: 'Unapplied cash', es: 'Efectivo no aplicado' }, type: 'LIABILITY' },
  '3000': { name: { en: 'Opening equity', es: 'Capital inicial' }, type: 'EQUITY' },
  '4000': { name: { en: 'Revenue — goods (point in time)', es: 'Ingreso — bienes (punto en el tiempo)' }, type: 'REVENUE' },
  '4010': { name: { en: 'Revenue — services (over time)', es: 'Ingreso — servicios (a lo largo del tiempo)' }, type: 'REVENUE' },
  '4900': { name: { en: 'Sales returns & allowances (credit notes)', es: 'Devoluciones y bonificaciones (notas de crédito)' }, type: 'CONTRA_REVENUE' },
  '5000': { name: { en: 'Cost of goods sold — fulfillment supplies (Reap)', es: 'Costo de ventas — insumos de surtido (Reap)' }, type: 'EXPENSE' },
  '6000': { name: { en: 'Payroll expense', es: 'Gasto de nómina' }, type: 'EXPENSE' },
  '6100': { name: { en: 'Rent expense', es: 'Gasto de renta' }, type: 'EXPENSE' },
  '6200': { name: { en: 'Cloud & IT expense', es: 'Gasto de nube y TI' }, type: 'EXPENSE' },
  '6300': { name: { en: 'Freight & logistics expense', es: 'Gasto de fletes y logística' }, type: 'EXPENSE' },
  '6400': { name: { en: 'Marketing expense', es: 'Gasto de marketing' }, type: 'EXPENSE' },
  '6500': { name: { en: 'Supplies & equipment expense (Reap)', es: 'Gasto de insumos y equipo (Reap)' }, type: 'EXPENSE' },
  '6900': { name: { en: 'Credit loss expense (ASC 326)', es: 'Gasto por pérdidas crediticias (ASC 326)' }, type: 'EXPENSE' },
};
export const AP_ACCOUNT = { Payroll: '6000', Rent: '6100', Cloud: '6200', Logistics: '6300', Marketing: '6400' };
export const CAPITALIZATION_THRESHOLD_CENTS = 250000; // de minimis: purchases >= $2,500 are capitalized

const DEBIT_NORMAL = new Set(['ASSET', 'EXPENSE', 'CONTRA_REVENUE']);
const sha = s => createHash('sha256').update(s).digest('hex');
const periodOf = d => d.slice(0, 7);

// ---------- Posting ----------
export function postJE(s, { date, type, memo, lines, source = {}, preparer = 'system', approver = null, step = null }) {
  if (!s.journal) s.journal = [];
  if (!s.gl) s.gl = {};
  const dr = lines.reduce((a, l) => a + (l.debit || 0), 0);
  const cr = lines.reduce((a, l) => a + (l.credit || 0), 0);
  if (dr !== cr) throw new Error(`Unbalanced journal entry (${type}): Dr ${dr} ≠ Cr ${cr}`);
  if (dr === 0) return null;
  for (const l of lines) if (!COA[l.account]) throw new Error(`Unknown account ${l.account}`);
  if ((s.closedPeriods || []).includes(periodOf(date))) throw new Error(`Period ${periodOf(date)} is closed — posting rejected (SOX period lock)`);
  const prev = s.journal.at(-1)?.hash || 'GENESIS';
  const je = {
    id: `JE-${String(s.journal.length + 1).padStart(6, '0')}`, date, period: periodOf(date), type, memo, step,
    lines: lines.filter(l => l.debit || l.credit), source, preparer, approver, postedAt: new Date().toISOString(), prevHash: prev,
  };
  je.hash = sha(prev + JSON.stringify({ ...je, hash: undefined }));
  s.journal.push(je);
  for (const l of je.lines) s.gl[l.account] = (s.gl[l.account] || 0) + (l.debit || 0) - (l.credit || 0);
  return je;
}

// Natural-sign balance (debit-normal accounts positive when debit, credit-normal positive when credit).
export function balance(s, account, upTo = null) {
  let raw;
  if (!upTo) raw = s.gl?.[account] || 0;
  else raw = (s.journal || []).filter(j => j.date <= upTo).flatMap(j => j.lines).filter(l => l.account === account).reduce((a, l) => a + (l.debit || 0) - (l.credit || 0), 0);
  return DEBIT_NORMAL.has(COA[account].type) ? raw : -raw;
}

// ---------- Operations log ----------
const STEPS = ['', 'ORDER_ENTRY', 'REV_REC_TRIGGER', 'REVENUE_RECOGNITION', 'BILLING', 'COLLECTIONS', 'CASH_APPLICATION', 'TREASURY', 'EXPENSES_AP', 'MONTH_END_CLOSE'];
export function op(s, { step, action, ref = null, en, es, amountCents = null, je = null, actor = 'system', controls = [], level = 'INFO', date = null }) {
  if (!s.oplog) s.oplog = [];
  const prev = s.oplog.at(-1)?.hash || 'GENESIS';
  const e = {
    seq: s.oplog.length + 1, date: date || s.asOf, ts: new Date().toISOString(), step, stepKey: STEPS[step] || 'SYSTEM', action, ref, actor, level,
    en, es, amountCents, jeId: je?.id || null, controls,
    arAfter: balance(s, '1100'), cashAfter: balance(s, '1000'), deferredAfter: balance(s, '2100'),
    revenueMTD: periodNet(s, s.asOf.slice(0, 7), ['4000', '4010']), prevHash: prev,
  };
  e.hash = sha(prev + JSON.stringify({ ...e, hash: undefined }));
  s.oplog.push(e);
  return e;
}

export function verifyChain(arr) {
  let prev = 'GENESIS';
  for (const x of arr || []) {
    if (x.prevHash !== prev) return { ok: false, brokenAt: x.id || x.seq };
    if (sha(prev + JSON.stringify({ ...x, hash: undefined })) !== x.hash) return { ok: false, brokenAt: x.id || x.seq };
    prev = x.hash;
  }
  return { ok: true, count: (arr || []).length };
}

// ---------- Period activity helpers ----------
function periodLines(s, m) { return (s.journal || []).filter(j => j.period === m && j.type !== 'OPENING').flatMap(j => j.lines.map(l => ({ ...l, je: j }))); }
export function periodNet(s, m, accounts) {
  return periodLines(s, m).filter(l => accounts.includes(l.account)).reduce((a, l) => {
    const raw = (l.debit || 0) - (l.credit || 0);
    return a + (DEBIT_NORMAL.has(COA[l.account].type) ? raw : -raw);
  }, 0);
}

// ---------- Financial statements ----------
export function trialBalance(s, upTo) {
  const rows = Object.keys(COA).map(a => {
    const lines = (s.journal || []).filter(j => !upTo || j.date <= upTo).flatMap(j => j.lines).filter(l => l.account === a);
    const debit = lines.reduce((x, l) => x + (l.debit || 0), 0), credit = lines.reduce((x, l) => x + (l.credit || 0), 0);
    const net = debit - credit;
    return { account: a, name: COA[a].name, type: COA[a].type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  }).filter(r => r.debit || r.credit);
  const td = rows.reduce((x, r) => x + r.debit, 0), tc = rows.reduce((x, r) => x + r.credit, 0);
  return { rows, totalDebit: td, totalCredit: tc, balanced: td === tc };
}

export function incomeStatement(s, m) {
  const goods = periodNet(s, m, ['4000']), services = periodNet(s, m, ['4010']), returns = periodNet(s, m, ['4900']);
  const netRevenue = goods + services - returns;
  const cogs = periodNet(s, m, ['5000']);
  const grossProfit = netRevenue - cogs;
  const expenses = ['6000', '6100', '6200', '6300', '6400', '6500', '6900'].map(a => ({ account: a, name: COA[a].name, cents: periodNet(s, m, [a]) })).filter(e => e.cents);
  const totalOpex = expenses.reduce((x, e) => x + e.cents, 0);
  return { period: m, goods, services, returns, netRevenue, cogs, grossProfit, expenses, totalOpex, totalExpenses: totalOpex + cogs, netIncome: grossProfit - totalOpex };
}

function cumulativeNetIncome(s, upTo) {
  const lines = (s.journal || []).filter(j => j.date <= upTo && j.type !== 'OPENING').flatMap(j => j.lines);
  const sumT = types => lines.filter(l => types.includes(COA[l.account].type)).reduce((a, l) => a + (l.credit || 0) - (l.debit || 0), 0);
  return sumT(['REVENUE', 'CONTRA_REVENUE', 'EXPENSE']);
}

export function balanceSheet(s, asOf) {
  const b = a => balance(s, a, asOf);
  const assets = ['1000', '1100', '1190', '1500'].map(a => ({ account: a, name: COA[a].name, cents: a === '1190' ? -b(a) : b(a) }));
  const liabilities = ['2000', '2100', '2300'].map(a => ({ account: a, name: COA[a].name, cents: b(a) }));
  const opening = b('3000'), retained = cumulativeNetIncome(s, asOf);
  const totalAssets = assets.reduce((x, r) => x + r.cents, 0);
  const totalLiabilities = liabilities.reduce((x, r) => x + r.cents, 0);
  const totalEquity = opening + retained;
  return { asOf, assets, liabilities, equity: [{ account: '3000', name: COA['3000'].name, cents: opening }, { account: 'RE', name: { en: 'Retained earnings (current year)', es: 'Utilidades retenidas (ejercicio)' }, cents: retained }],
    totalAssets, totalLiabilities, totalEquity, balanced: totalAssets === totalLiabilities + totalEquity };
}

// Direct method from cash lines, with indirect-method reconciliation (ASC 230).
export function cashFlow(s, m) {
  const jes = (s.journal || []).filter(j => j.period === m && j.type !== 'OPENING');
  let fromCustomers = 0, toSuppliersAP = 0, reapPurchases = 0, capex = 0, other = 0;
  for (const j of jes) {
    const cash = j.lines.filter(l => l.account === '1000').reduce((a, l) => a + (l.debit || 0) - (l.credit || 0), 0);
    if (!cash) continue;
    const other_ = j.lines.filter(l => l.account !== '1000').map(l => l.account);
    if (other_.some(a => ['1100', '2300'].includes(a))) fromCustomers += cash;
    else if (other_.includes('2000')) toSuppliersAP += cash;
    else if (other_.includes('1500')) capex += cash;
    else if (other_.includes('6500') || other_.includes('5000')) reapPurchases += cash;
    else other += cash;
  }
  const operating = fromCustomers + toSuppliersAP + reapPurchases + other;
  const investing = capex;
  const start = `${m}-01`, before = new Date(Date.parse(start + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  const end = jes.length ? jes.reduce((a, j) => (j.date > a ? j.date : a), start) : start;
  const beginning = balance(s, '1000', before), ending = balance(s, '1000', `${m}-31`);
  // Indirect: Net income − ΔAR + ΔDeferred revenue + ΔAP + ΔUnapplied cash
  const d = a => balance(s, a, `${m}-31`) - balance(s, a, before);
  const ni = incomeStatement(s, m).netIncome;
  const indirect = { netIncome: ni, creditLoss: d('1190'), deltaAR: -d('1100'), deltaDeferred: d('2100'), deltaAP: d('2000'), deltaUnapplied: d('2300') };
  indirect.operating = indirect.netIncome + indirect.creditLoss + indirect.deltaAR + indirect.deltaDeferred + indirect.deltaAP + indirect.deltaUnapplied;
  return { period: m, through: end, fromCustomers, toSuppliersAP, reapPurchases, other, operating, capex, investing, financing: 0,
    netChange: operating + investing, beginning, ending, ties: beginning + operating + investing === ending, indirect, indirectTies: indirect.operating === operating };
}
