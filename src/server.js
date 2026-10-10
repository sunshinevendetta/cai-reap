import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import * as E from './engine.js';
import { reset, load } from './store.js';
import { chat } from './agent.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = new URL('../public/', import.meta.url);

async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e6) throw Object.assign(new Error('Payload too large'), { status: 413 }); }
  try { return s ? JSON.parse(s) : {}; } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

const routes = {
  'GET /api/state': async () => { E.refreshAllInBackground(); return E.snapshot(); },
  'POST /api/reset': async () => { reset(); return E.snapshot(); },
  'POST /api/collect': async () => ({ results: E.runCollectionCycle('operator'), state: E.snapshot() }),
  // Day processing is synchronous; Reap purchases it queued (recurring, fulfillment) run in the background.
  'POST /api/advance': async b => { const r = E.advanceDays(Number(b.days) || 1, b.actor || 'operator'); E.drainReapQueue(); return r; },
  'POST /api/close': async b => { await E.verifyReapCheckouts(); return E.closeMonth(b.summary || null, 'controller'); },
  'POST /api/verify-reap': async () => E.verifyReapCheckouts(),
  'POST /api/orders': async b => E.createOrder(b, 'operator'),
  'POST /api/orders/revalidate': async b => E.revalidateOrder(b.id),
  'POST /api/credit-hold': async b => E.setCreditHold(b.customerId, b.hold),
  'POST /api/promise': async b => E.recordPromise(b.invoiceId, b.date),
  'POST /api/credit-note': async b => E.issueCreditNote(b.invoiceId, b.cents, b.reason),
  'POST /api/exceptions/resolve': async b => E.resolveException(b.id, b.note),
  'POST /api/statements': async b => E.statements(b.month),
  'POST /api/rollforward': async b => E.arRollforward(b.month),
  'POST /api/customer-statement': async b => E.customerStatement(b.customerId),
  'POST /api/recurring/toggle': async b => E.setRecurringActive(b.id, b.active),
  'POST /api/recurring/run': async b => { await E.runRecurringNow(b.id); return E.snapshot().recurring.find(r => r.id === b.id); },
  'POST /api/enrollment': async () => E.startEnrollment(),
  'POST /api/enrollment/use': async b => E.useExistingEnrollment(b.enrollmentId),
  'POST /api/enrollment/refresh': async () => E.refreshEnrollment(),
  'POST /api/search': async b => E.searchProducts(b.query, b.maxUnitCents),
  'POST /api/purchases': async b => E.proposePurchase({ ...b, actor: 'operator' }),
  'POST /api/purchases/approve': async b => E.approvePurchase(b.id, b.approver || 'finance-approver'),
  'POST /api/purchases/reject': async b => E.rejectPurchase(b.id, b.approver || 'finance-approver'),
  'POST /api/purchases/retry': async b => E.retryCheckout(b.id),
  'POST /api/purchases/refresh': async b => E.refreshPurchase(b.id),
  'POST /api/ecl/propose': async () => E.proposeECL('accounting-agent'),
  'POST /api/ecl/approve': async b => E.approveECL(b.id, 'controller'),
  'POST /api/kpis': async b => E.cfoKpis(b.month),
  'POST /api/agent': async b => chat(b.messages || [], b.lang || 'en'),
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) return send(res, 200, await handler(req.method === 'POST' ? await body(req) : {}));

    if (url.pathname === '/return') {
      if (url.searchParams.get('kind') === 'enrollment') await E.refreshEnrollment().catch(() => {});
      const pid = url.searchParams.get('purchase');
      if (pid) await E.refreshPurchase(pid).catch(() => {});
      res.writeHead(302, { Location: '/#' + (pid ? 'ap' : 'setup') });
      return res.end();
    }

    // Security: %2e%2e is decoded as a dot-segment by the URL parser — confine every read to /public.
    const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)).split('\\').join('/');
    const target = new URL(file, PUBLIC);
    if (file.includes('..') || !target.href.startsWith(PUBLIC.href)) return send(res, 400, { error: 'bad path' });
    const data = await readFile(target);
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, { error: 'not found' });
    if (!e.status || e.status >= 500) console.error(e);
    send(res, e.status && e.status < 500 ? e.status : 500, { error: e.message, code: e.code, detail: e.detail });
  }
}).listen(PORT, process.env.HOST || '127.0.0.1', () => { // localhost only: no auth layer in this demo
  load();
  console.log(`CAI running on http://localhost:${PORT}  (Reap: ${process.env.REAP_BASE_URL}, sandbox, simulated checkout)`);
});
