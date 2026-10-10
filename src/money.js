// All authoritative money is integer cents. Never use floats for balances.

export function toCents(amount) {
  // Reap returns decimal numbers like 840.95; parse via string to avoid float drift.
  const [i, f = ''] = String(amount).split('.');
  const sign = i.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(parseInt(i, 10)) * 100 + parseInt((f + '00').slice(0, 2), 10));
}

export function fmt(cents, lang = 'en', currency = 'USD') {
  return new Intl.NumberFormat(lang === 'es' ? 'es-MX' : 'en-US', { style: 'currency', currency }).format(cents / 100);
}

// Split `cents` by basis points; residual from rounding goes to the first (largest) bucket.
export function splitByBps(cents, parts) {
  const out = parts.map(p => ({ ...p, cents: Math.floor((cents * p.bps) / 10000) }));
  const residual = cents - out.reduce((s, p) => s + p.cents, 0);
  out[0].cents += residual;
  return out;
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86400000);
}
