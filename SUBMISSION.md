# CAI — Buildathon submission

Reap x AIBM Agentic Buildathon · Theme: **Gasto empresarial**

---

## Project name
**CAI — Collection and Application Intelligence**

## Tagline (one line)
AI agents that spend only the cash your customers have already paid, through Reap Agentic, with every purchase traced to the invoice that funded it.

## Short description (≈50 words)
CAI runs a company's full order-to-cash and record-to-report cycle with finance agents. When customers pay, a treasury agent turns that collected cash into cost-center budgets. Procurement agents then buy through Reap Agentic within those budgets, and every checkout posts to a double-entry general ledger that closes the month on its own.

---

## Project description

### The problem
Company spending and company cash live in different systems. Corporate cards and procurement tools let teams spend against a credit limit, not against money the business has actually collected. Finance then spends the month-end close matching card charges to invoices, receipts and budgets by hand. Giving AI agents a card makes this worse: an agent can spend fast, but nobody can show which customer payment paid for what it bought.

### What CAI does
CAI ties every agent purchase to real cash in the bank. It covers nine stages, from order entry to month-end close:

```
Order entry → Rev-rec trigger → Revenue recognition → Billing → Collections
→ Cash application → Treasury → Expenses / AP (+ Reap purchases) → Month-end close
```

1. **Collect.** A collections agent works the AR aging report: it collects due invoices and handles partial payments, failed debits, disputes and missing debit authorizations. It never debits a customer more than once a day and never collects more than is owed.
2. **Fund.** Each confirmed receipt is applied to its invoice. The treasury agent then splits the cash into spend authority by policy (Operations 40%, IT 25%, Facilities 20%, Marketing 15%).
3. **Spend.** Procurement agents buy through the **Reap Agentic API**: product search, live quote, then checkout. They handle recurring standing orders (office coffee, cleaning supplies, new-hire keyboards) and ad-hoc requests such as "buy 2 keyboards for IT". A purchase can only draw on cash that has been collected, and each one is traced to the invoice that funded it.
4. **Control.** Deterministic rules, not the model, enforce the limits. Purchases over $1,000 go to a human approver, with a different person approving than the one who prepared the request. Every purchase has a hard cap of $10,000. Travel and restricted categories are blocked. Completed purchases are allowed only at supported merchants.
5. **Book and close.** Every event posts a balanced journal entry under US GAAP. Revenue follows ASC 606, the credit-loss allowance follows ASC 326, and the cash flow statement follows ASC 230 (direct and indirect methods). At close, an agent re-reads each Reap checkout (`GET /agentic/checkouts/:id`) and matches it to the general ledger. Close stays blocked until the reconciliations and approvals are done. The period then locks, and balances carry into the next month.

### The CFO Decision Center
- Answers the CFO's five questions from the ledger: what did we earn, how much cash do we have, who owes us, are the books right, and what needs a decision now.
- **20 certified KPIs**, including DSO, CEI, DPO, cash conversion cycle, EBITDA, forecast accuracy and close cycle time. Each KPI shows its owner, data source and formula.
- A **13-week liquidity forecast** built from AR collection probabilities, the AP calendar, and Reap standing orders priced from live Reap quotes.
- **Financial statements** built from the general ledger: income statement, balance sheet (checks A = L + E), cash flow statement and trial balance.
- A **SOX control matrix** of 20 automated controls with evidence, plus hash-chained, tamper-evident audit logs.
- Bilingual **English and Spanish** in one click. Every label and agent answer switches language, and the numbers stay identical.

### How it uses Reap Agentic
Reap is used at every stage, not only at checkout:

| Stage | Reap usage |
|---|---|
| Card setup | `POST /agentic/enrollments`. The card is entered only on Reap's hosted page and never reaches CAI or a model. |
| Order delivery | A fulfillment purchase is made through Reap and posted to COGS (matching principle). |
| Purchasing | `products/search`, then `products/details`, then `quotes`, then `checkouts`, with idempotency keys and retries on network drops. |
| Treasury | Recurring standing orders are priced from Reap quotes and included in the 13-week forecast. |
| Close | Every checkout is re-read from Reap and reconciled to the GL. |

### Hackathon rules, enforced in code
- Completed purchases are allowed only at merchants on the organizers' supported list. Other catalog items can be searched and quoted but not bought (`QUOTE_ONLY_MERCHANT_NOT_SUPPORTED`).
- Sandbox checkouts are simulated with `X-Simulate-Checkout: COMPLETED`.
- Travel, gambling, weapons, tobacco and cannabis, alcohol, gift cards and other restricted categories are blocked (`RESTRICTED_CATEGORY`).
- All purchases go through Reap's API, with no checkout scraping.

### Why it matters
CAI turns agent spending from a risk into an audited process. Every dollar an agent spends comes from a named customer payment, is approved under a written policy, is posted to the ledger, and is reconciled at close. Spend stays within cash the company has already collected, and the month closes with the evidence attached.

---

## How we built it
- **Node.js 20, zero dependencies.** About 3,000 lines of code that run with `npm start`.
- `src/reap.js`: Reap Agentic client with idempotent retries.
- `src/engine.js`: deterministic rules for all nine stages, the mastersheet, reconciliation and close.
- `src/ledger.js`: chart of accounts, double-entry posting, hash chains and financial statements.
- `src/agent.js`: deterministic bilingual command agent. It needs only the Reap API key, with no external LLM key.
- `public/index.html`: single-page dashboard.
- Money is handled in integer cents with no floating point. **11 acceptance tests** cover the GL, financial statements, SOX controls, the ASC 326 allowance, KPIs, hash chains and close (`npm test`).

## Challenges
- Keeping the books balanced to the cent through partial payments, failed debits, deferred revenue and carry-over between periods.
- Making agent autonomy auditable: agents prepare, rules validate, people approve, and the system keeps the evidence.
- Sandbox network drops during quotes, solved with idempotency keys and safe retries.

## What's next
- Connect to a real bank feed and ERP (NetSuite or QuickBooks) instead of seeded data.
- Issue a Reap card per cost center, with limits that refresh from collected cash in real time.
- Multi-entity and multi-currency close (USD and MXN).
- Optional LLM layer for free-form questions. It would answer from the same deterministic tools, so it could never override a control.

## Demo (3 minutes)
1. **Reap card:** enroll the sandbox card on Reap's hosted page. Status shows `ACTIVE`.
2. **Collections:** run a collection cycle. Nine invoices are collected, one debit fails for insufficient funds, the disputed invoice is skipped, and the invoice without debit authorization is skipped.
3. **Agent purchasing:** buy a Keychron keyboard for IT. CAI gets a live quote, completes the checkout (`COMPLETED`), and traces it to the invoice that funded it.
4. **Agent chat:** ask the agent to book a flight, and it is blocked. Ask it to buy 2 monitors, and since that is over $1,000 it goes to approval.
5. **Advance to month end:** orders are billed, invoices collected, and rent, payroll and AWS paid from collected cash.
6. **Mastersheet:** the formulas tie out. Close the month, and November opens with balances carried over.
7. Switch to **ES**. Everything changes language, and the numbers stay the same.

## Team
- **Omar:** Reap integration, accounting engine, agents, dashboard.
- **Paco:** finance policy and demo data, pitch deck, demo script, EN/ES copy, Reap support liaison.

---

## Descripción del proyecto (ES)

**CAI: agentes de IA que solo gastan el dinero que tus clientes ya pagaron, a través de Reap Agentic.**

CAI opera el ciclo completo de una empresa, del pedido al cierre contable, con agentes financieros. El agente de cobranza cobra las facturas vencidas. Tesorería convierte el efectivo cobrado en presupuestos por centro de costos. Los agentes de compras compran a través de la API de Reap Agentic solo dentro de esos presupuestos, y cada compra queda ligada a la factura que la financió. Las reglas deterministas, no el modelo, aplican las políticas. Las compras de más de $1,000 requieren aprobación humana, y la persona que aprueba es distinta de la que prepara la solicitud. Viajes y categorías restringidas están bloqueados, y solo se compra en comercios soportados. Cada evento genera un asiento contable balanceado (US GAAP: ASC 606, ASC 326 y ASC 230), con 20 controles SOX automatizados y bitácoras encadenadas por hash. Al cierre, el agente vuelve a consultar cada checkout en Reap y lo concilia contra el libro mayor. El resultado: el gasto de los agentes se mantiene dentro del efectivo cobrado, queda auditado y el mes cierra con toda la evidencia.
