// Thin client for the Reap Agentic module. https://docs.reap.global/agentic-payments/overview
import { randomUUID } from 'node:crypto';

const BASE = process.env.REAP_BASE_URL || 'https://sg.sandbox.api.reap.global';
const VERSION = process.env.REAP_VERSION || '2025-02-14';

export class ReapError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Reap HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.detail = body?.error?.detail;
  }
}

async function call(method, path, { body, idempotencyKey, headers = {} } = {}) {
  if (!process.env.REAP_API_KEY) throw new Error('REAP_API_KEY missing (.env)');
  const h = {
    Authorization: `Bearer ${process.env.REAP_API_KEY}`,
    'Reap-Version': VERSION,
    ...headers,
  };
  if (body) h['Content-Type'] = 'application/json';
  if (method === 'POST') h['Idempotency-Key'] = idempotencyKey || randomUUID();
  const send = () => fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  // Network blips: retry once with the SAME Idempotency-Key, so Reap replays instead of double-charging.
  const res = await send().catch(() => send());
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { if (res.ok) throw new Error(`Reap returned non-JSON (${res.status})`); }
  if (!res.ok) throw new ReapError(res.status, json);
  return json;
}

export const reap = {
  // Setup (once per card)
  createEnrollment: ({ ownerId, email, returnUrl, idempotencyKey }) =>
    call('POST', '/agentic/enrollments', {
      idempotencyKey,
      body: { source: 'EXTERNAL', owner: { type: 'CLIENT_REFERENCE', id: ownerId, email }, presentation: { type: 'REDIRECT', returnUrl } },
    }),
  getEnrollment: id => call('GET', `/agentic/enrollments/${id}`),
  listEnrollments: ownerId => call('GET', `/agentic/enrollments?ownerType=CLIENT_REFERENCE&ownerId=${encodeURIComponent(ownerId)}&limit=50`),

  // Discovery
  searchProducts: ({ query, maxPrice, limit = 8 }) =>
    call('POST', '/agentic/products/search', {
      body: {
        query,
        context: { country: 'US', currency: 'USD' },
        filters: { availability: 'AVAILABLE_ONLY', ...(maxPrice ? { price: { max: maxPrice } } : {}) },
        pagination: { limit },
      },
    }),
  productDetails: productIds => call('POST', '/agentic/products/details', { body: { productIds } }),

  // Pricing
  // Either items (Reap catalog variants) or externalCheckout { merchantDomain, checkoutUrl } (supported merchant cart link).
  createQuote: ({ items, externalCheckout, email, shippingAddress, idempotencyKey }) =>
    call('POST', '/agentic/quotes', { idempotencyKey, body: { ...(items ? { items } : { externalCheckout }), email, shippingAddress } }),
  getQuote: id => call('GET', `/agentic/quotes/${id}`),
  selectShipping: (id, shippingOptionId) =>
    call('POST', `/agentic/quotes/${id}/shipping-option`, { body: { shippingOptionId } }),

  // Charge
  createCheckout: ({ quoteId, enrollmentId, returnUrl, idempotencyKey, simulate }) =>
    call('POST', '/agentic/checkouts', {
      idempotencyKey,
      headers: simulate ? { 'X-Simulate-Checkout': 'COMPLETED' } : {},
      body: { quoteId, enrollmentId, presentation: { type: 'REDIRECT', returnUrl } },
    }),
  getCheckout: id => call('GET', `/agentic/checkouts/${id}`),
};
