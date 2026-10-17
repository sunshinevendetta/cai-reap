// CAI agent — deterministic, bilingual command agent. No LLM: it parses intent and calls the same
// engine + Reap Agentic tools the dashboard uses, so every action is policy-checked and logged.
import * as E from './engine.js';
import { fmt } from './money.js';
import { restrictedReason } from './vendors.js';

const CC_WORDS = [
  [/\b(it|ti|tech|tecnolog\w*|computo|cómputo|sistemas)\b/i, 'IT'],
  [/\b(facilities|instalaciones|oficina|office|fac)\b/i, 'FAC'],
  [/\b(marketing|mkt|mercadotecnia|swag)\b/i, 'MKT'],
  [/\b(ops|operations|operaciones)\b/i, 'OPS'],
];
const STOP = new Set('buy compra comprar compre purchase order ordena a an un una unos unas the el la los las de del for para from con with por of please porfa me nos 1 2 3 4 5 6 7 8 9 10 it ti facilities instalaciones marketing ops operations operaciones supported soportado comercio merchant team equipo office oficina new nuevo nuevos nueva'.split(' '));

export async function chat(messages, lang = 'en') {
  const text = String(messages.at(-1)?.content || '').trim();
  const t = text.toLowerCase();
  const es = lang === 'es';
  const m = c => fmt(c, lang);
  const steps = [];
  const step = (tool, ok = true) => steps.push({ tool, ok });
  try {
    // Restricted spend first (travel etc.) — the agent refuses before touching Reap.
    if (/\b(buy|compra|comprar|book|reserva|reservar|purchase|order|ordena)\b/i.test(t)) {
      const blocked = restrictedReason(text);
      if (blocked) {
        step('policy:restricted_category', false);
        try { await E.proposePurchase({ costCenter: 'OPS', query: text, reason: text, actor: 'cai-agent' }); } catch { /* logged by engine */ }
        return { text: es ? `⛔ No puedo hacer eso: ${blocked}. Viajes y categorías restringidas están fuera de los límites del hackathon y de la política de gasto. Quedó registrado en la bitácora (C-SPD-03).` : `⛔ I can't do that: ${blocked}. Travel and restricted categories are off-limits under the hackathon rules and spend policy. Logged in the operations log (C-SPD-03).`, steps };
      }
    }

    // Advance days
    const adv = t.match(/(?:advance|avanza|avanzar|adelanta|run|corre)\s*(\d+)?\s*(?:day|days|d[ií]a|d[ií]as)?/) || (/(next day|siguiente d[ií]a|mañana|tomorrow)/.test(t) ? [null, '1'] : null);
    if (adv && /(advance|avanza|avanzar|adelanta|next day|siguiente|mañana|tomorrow|day|d[ií]a)/.test(t) && !/close|cierr/.test(t)) {
      const n = Math.min(31, Number(adv[1] || (/(month end|fin de mes)/.test(t) ? 31 : 1)));
      const r = E.advanceDays(n, 'cai-agent'); step('advance_days');
      E.drainReapQueue(); if (r.reapQueued) step('reap:quote+checkout (queued)');
      const c = r.days.reduce((a, d) => a + d.collectedCents, 0), b = r.days.flatMap(d => d.billed), p = r.days.flatMap(d => d.paid);
      const last = r.days.at(-1);
      return { text: es
        ? `📅 Avancé ${r.days.length} día(s) → ${r.asOf}.\n• Facturado: ${b.length ? b.join(', ') : 'nada nuevo'}\n• Cobrado: ${m(c)} (${r.days.reduce((a, d) => a + d.collected, 0)} movimientos, ${r.days.reduce((a, d) => a + d.failed, 0)} fallidos)\n• CxP pagadas: ${p.length}\n• Compras Reap en cola: ${r.reapQueued}\n• CxC ${m(r.days[0]?.arBefore ?? 0)} → ${m(last?.arAfter ?? 0)} · Caja ${m(r.days[0]?.cashBefore ?? 0)} → ${m(last?.cashAfter ?? 0)}${r.atMonthEnd ? '\n🔒 Fin de mes: ya puedes cerrar.' : ''}`
        : `📅 Advanced ${r.days.length} day(s) → ${r.asOf}.\n• Billed: ${b.length ? b.join(', ') : 'nothing new'}\n• Collected: ${m(c)} (${r.days.reduce((a, d) => a + d.collected, 0)} events, ${r.days.reduce((a, d) => a + d.failed, 0)} failed)\n• AP paid: ${p.length}\n• Reap purchases queued: ${r.reapQueued}\n• AR ${m(r.days[0]?.arBefore ?? 0)} → ${m(last?.arAfter ?? 0)} · Cash ${m(r.days[0]?.cashBefore ?? 0)} → ${m(last?.cashAfter ?? 0)}${r.atMonthEnd ? '\n🔒 Month end reached: you can close.' : ''}`, steps };
    }

    // Close month
    if (/(close|cierra|cerrar|cierre)/.test(t)) {
      const v = await E.verifyReapCheckouts(); step('reap:get_checkout ×' + v.length);
      const cl = E.closeChecklist(); step('close_checklist');
      if (!cl.canClose || /\?|can we|podemos|puedo/.test(t)) {
        const items = cl.items.map(i => `${i.ok ? '✅' : i.warn ? '⚠️' : '⛔'} ${i.id}${i.detail ? ` (${i.detail})` : ''}`).join('\n');
        return { text: (es ? `Checklist de cierre ${cl.month} — ${cl.canClose ? 'listo para cerrar' : 'bloqueado'}:\n` : `Close checklist ${cl.month} — ${cl.canClose ? 'ready to close' : 'blocked'}:\n`) + items + (cl.canClose ? (es ? '\n\nDi "cierra el mes" para ejecutar.' : '\n\nSay "close the month" to execute.') : ''), steps };
      }
      const row = E.closeMonth('Closed by CAI agent', 'controller'); step('close_month');
      return { text: es ? `🔒 Mes ${row.month} cerrado. CxC final ${m(row.endingAR)}, caja final ${m(row.endingCash)}. Periodo bloqueado; estados financieros congelados.` : `🔒 Month ${row.month} closed. Ending AR ${m(row.endingAR)}, ending cash ${m(row.endingCash)}. Period locked; statements frozen.`, steps };
    }

    // Buy
    if (/\b(buy|compra|comprar|purchase|order|ordena|restock|reabastece)\b/.test(t)) {
      const cc = (CC_WORDS.find(([re]) => re.test(text)) || [])[1];
      const qty = Number((t.match(/\b(\d{1,3})\b/) || [])[1] || 1);
      const words = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
      const ALIAS = { teclado: 'keyboard', teclados: 'keyboard', monitor: 'monitor', café: 'coffee', cafe: 'coffee', botanas: 'chocolate', limpieza: 'cleaning', gorras: 'hat', gorra: 'hat', audífonos: 'headphones', audifonos: 'headphones', toallas: 'towels', cuchillos: 'knife', cargador: 'power', hub: 'hub' };
      const stem = w => (w.length > 4 ? w.replace(/(es|s)$/, '') : w);
      const terms = words.map(w => ALIAS[w] || ALIAS[stem(w)] || stem(w));
      const all = E.listVendors(cc); step('list_vendors');
      const scored = all.map(v => ({ v, score: terms.filter(w => `${v.product} ${v.category} ${v.domain}`.toLowerCase().includes(w)).length })).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.v.unitCents - b.v.unitCents);
      if (!scored.length) {
        const q = terms.join(' ') || text;
        const found = await E.searchProducts(q).catch(() => []); step('reap:search_products');
        return { text: es ? `No encontré "${q}" en los comercios soportados${cc ? ` para ${cc}` : ''}. En el catálogo Reap hay ${found.length} opciones (solo cotización, no checkout):\n${found.slice(0, 4).map(f => `• ${f.name} — ${m(f.unitCents)} (${f.merchant})`).join('\n')}` : `"${q}" isn't on the supported merchant list${cc ? ` for ${cc}` : ''}. The Reap catalog has ${found.length} options (quote only, no checkout):\n${found.slice(0, 4).map(f => `• ${f.name} — ${m(f.unitCents)} (${f.merchant})`).join('\n')}`, steps };
      }
      const v = scored[0].v;
      const p = await E.proposePurchase({ costCenter: cc || v.costCenter, vendorSku: v.sku, quantity: qty, reason: `Agent request: ${text}`, actor: 'cai-agent' }); step('reap:create_quote'); if (p.checkoutId) step('reap:create_checkout');
      const trace = (p.fundingTrace || []).map(x => x.invoiceId);
      const statusTxt = {
        COMPLETED: es ? `✅ Compra completada (checkout simulado sandbox). Cargo ${m(p.chargedCents)}. Financiado por: ${[...new Set(trace)].join(', ')}. Asiento ${p.je}.` : `✅ Purchase completed (sandbox simulated checkout). Charged ${m(p.chargedCents)}. Funded by: ${[...new Set(trace)].join(', ')}. Journal ${p.je}.`,
        NEEDS_APPROVAL: es ? `⏳ ${m(p.totalCents)} supera el límite de auto-aprobación — espera aprobación humana (pestaña Gastos / CxP). Efectivo reservado.` : `⏳ ${m(p.totalCents)} is over the auto-approve limit — waiting for a human approver (Expenses / AP tab). Cash reserved.`,
        APPROVED: p.blocked ? (es ? `🟡 Aprobada por ${m(p.totalCents)}, pero falta activar la tarjeta Reap (pestaña Tarjeta Reap). Se enviará sola al activarse.` : `🟡 Approved at ${m(p.totalCents)}, but the Reap card isn't active yet (Reap card tab). It will submit automatically once active.`) : (es ? `🟡 Aprobada: ${p.lastError || ''}` : `🟡 Approved: ${p.lastError || ''}`),
        REJECTED: es ? `⛔ Rechazada: ${p.rejectReason}` : `⛔ Rejected: ${p.rejectReason}`,
      }[p.status] || p.status;
      return { text: `${v.product} ×${qty} — ${v.domain} → ${cc || v.costCenter}\n${es ? 'Cotización Reap' : 'Reap quote'}: ${m(p.totalCents || 0)}\n${statusTxt}`, steps };
    }

    // Collections
    if (/(collect|cobra|cobrar|run collection|ejecuta la cobranza)/.test(t) && !/(who|quién|quien|prior)/.test(t)) {
      const r = E.runCollectionCycle('cai-agent'); step('run_collection_cycle');
      const ok = r.filter(x => x.confirmedCents), bad = r.filter(x => x.failed);
      const next = E.prioritizeCollections().filter(p => p.daysUntilDue > 0).sort((a, b) => a.daysUntilDue - b.daysUntilDue)[0];
      return { text: es ? `💰 Cobranza: ${ok.length} cobradas (${m(ok.reduce((a, x) => a + x.confirmedCents, 0))}), ${bad.length} fallidas.${!ok.length && !bad.length ? ` Nada vence hoy.${next ? ` Próximo: ${next.invoiceId} el ${next.dueDate} (${m(next.outstandingCents)}).` : ''}` : ''}` : `💰 Collections: ${ok.length} collected (${m(ok.reduce((a, x) => a + x.confirmedCents, 0))}), ${bad.length} failed.${!ok.length && !bad.length ? ` Nothing due today.${next ? ` Next: ${next.invoiceId} on ${next.dueDate} (${m(next.outstandingCents)}).` : ''}` : ''}`, steps };
    }

    // Prioritization
    if (/(who|chase|priorit|quién|quien|prioridad|perseguir|cobramos primero)/.test(t)) {
      const p = E.prioritizeCollections().slice(0, 6); step('prioritize_collections');
      return { text: (es ? 'Prioridad de cobranza (riesgo × antigüedad × intentos):\n' : 'Collections priority (risk × aging × attempts):\n') + p.map((x, i) => `${i + 1}. ${x.customer} ${x.invoiceId} ${m(x.outstandingCents)} · ${x.daysPastDue}d · ${x.action}`).join('\n'), steps };
    }

    // Statements
    if (/(statement|estado|income|resultados|balance sheet|balance general|cash flow|flujo|p&l|pyl)/.test(t)) {
      const st = E.statements(); step('statements');
      const i = st.income, b = st.balance, c = st.cashFlow;
      return { text: es
        ? `Estados financieros ${st.period} (al ${st.asOf}):\n• Ingreso neto ${m(i.netRevenue)} − costo de ventas ${m(i.cogs)} = utilidad bruta ${m(i.grossProfit)}; gastos ${m(i.totalOpex)} → utilidad neta ${m(i.netIncome)}\n• Activos ${m(b.totalAssets)} = Pasivos ${m(b.totalLiabilities)} + Capital ${m(b.totalEquity)} ${b.balanced ? '✓' : '✗'}\n• Flujo operativo ${m(c.operating)} (directo) = ${m(c.indirect.operating)} (indirecto) ${c.indirectTies ? '✓' : '✗'}; caja ${m(c.beginning)} → ${m(c.ending)}`
        : `Financial statements ${st.period} (as of ${st.asOf}):\n• Net revenue ${m(i.netRevenue)} − COGS ${m(i.cogs)} = gross profit ${m(i.grossProfit)}; opex ${m(i.totalOpex)} → net income ${m(i.netIncome)}\n• Assets ${m(b.totalAssets)} = Liabilities ${m(b.totalLiabilities)} + Equity ${m(b.totalEquity)} ${b.balanced ? '✓' : '✗'}\n• Operating cash flow ${m(c.operating)} (direct) = ${m(c.indirect.operating)} (indirect) ${c.indirectTies ? '✓' : '✗'}; cash ${m(c.beginning)} → ${m(c.ending)}`, steps };
    }

    // SOX
    if (/(sox|control|auditor|audit)/.test(t)) {
      const c = E.soxControls(); step('sox_controls');
      return { text: (es ? `Matriz SOX: ${c.filter(x => x.ok).length}/${c.length} controles efectivos.\n` : `SOX matrix: ${c.filter(x => x.ok).length}/${c.length} controls effective.\n`) + c.map(x => `${x.ok ? '✅' : '⛔'} ${x.id} — ${x.evidence}`).join('\n'), steps };
    }

    // Aging
    if (/(aging|antig|cartera|ar report|reporte)/.test(t)) {
      const a = E.arAging(); step('ar_aging');
      return { text: (es ? `Antigüedad de saldos al ${a.asOf} — total ${m(a.totals.total)}, vencido ${m(a.totals.pastDue)}:\n` : `AR aging as of ${a.asOf} — total ${m(a.totals.total)}, past due ${m(a.totals.pastDue)}:\n`) + a.rows.filter(r => r.total).map(r => `• ${r.name}: ${m(r.total)} (${r.pctPastDue}% ${es ? 'vencido' : 'past due'})`).join('\n'), steps };
    }

    // Recurring
    if (/(recurr|standing|recurrente|suscrip|subscription)/.test(t)) {
      const s = E.snapshot(); step('recurring_rules');
      return { text: (es ? 'Órdenes recurrentes Reap (aprobadas con tope):\n' : 'Reap standing orders (pre-approved with caps):\n') + s.recurring.map(r => `• ${r.id} ${r.name[lang]} — ${r.frequency} · ${r.costCenter} · cap ${m(r.capCents)} · ${r.runs.length} run(s) · ${r.active ? 'ACTIVE' : 'PAUSED'}`).join('\n'), steps };
    }

    // Card status
    if (/(card|tarjeta|enroll|registro)/.test(t)) {
      const s = E.snapshot(); step('reap:get_enrollment');
      const e = s.enrollment;
      const hint = !e || e.status === 'ACTIVE' ? ''
        : e.pending ? (es ? ' — completa el registro en la pestaña Tarjeta Reap.' : ' — finish enrollment in the Reap card tab.')
        : (es ? ' — la sesión terminó sin tarjeta; inicia un registro nuevo en la pestaña Tarjeta Reap.' : ' — the session ended without a card; start a new enrollment in the Reap card tab.');
      return { text: e ? `Reap enrollment ${e.id}: ${e.status}${hint}` : (es ? 'Sin tarjeta registrada. Ve a la pestaña Tarjeta Reap.' : 'No card enrolled yet. Go to the Reap card tab.'), steps };
    }

    // Default: summary
    const s = E.snapshot(); step('mastersheet'); step('cash_forecast');
    const r = s.mastersheet.at(-1), f = s.forecast;
    const sox = s.sox.filter(c => c.ok).length;
    return { text: es
      ? `Resumen ${r.month} al ${s.asOf}:\n• CxC ${m(r.beginningAR)} + facturado ${m(r.billed)} − cobrado ${m(r.collections)} − notas ${m(r.credits)} = ${m(r.endingAR)} ${r.tieOut.arOk ? '✓ cuadra con mayor' : '✗'}\n• Ingreso reconocido ${m(r.revenue)} · gastos ${m(r.expenses)} (Reap ${m(r.reapExpenses)})\n• Caja ${m(r.beginningCash)} → ${m(r.endingCash)} · pronóstico 30d ${m(f.projectedCents)}${f.liquidityGap ? ' ⚠️ brecha' : ''}\n• SOX ${sox}/${s.sox.length} · excepciones abiertas ${s.reconciliation.exceptions.filter(e => e.status === 'OPEN').length}\nPrueba: "avanza 7 días", "compra 2 teclados para TI", "¿a quién cobramos primero?", "estados financieros", "controles SOX", "¿podemos cerrar?"`
      : `Summary ${r.month} as of ${s.asOf}:\n• AR ${m(r.beginningAR)} + billed ${m(r.billed)} − collected ${m(r.collections)} − credits ${m(r.credits)} = ${m(r.endingAR)} ${r.tieOut.arOk ? '✓ ties to GL' : '✗'}\n• Revenue recognized ${m(r.revenue)} · expenses ${m(r.expenses)} (Reap ${m(r.reapExpenses)})\n• Cash ${m(r.beginningCash)} → ${m(r.endingCash)} · 30-day forecast ${m(f.projectedCents)}${f.liquidityGap ? ' ⚠️ gap' : ''}\n• SOX ${sox}/${s.sox.length} · open exceptions ${s.reconciliation.exceptions.filter(e => e.status === 'OPEN').length}\nTry: "advance 7 days", "buy 2 keyboards for IT", "who should we chase first?", "financial statements", "SOX controls", "can we close?"`, steps };
  } catch (e) {
    step('error', false);
    return { text: `⚠ ${e.message}`, steps };
  }
}
