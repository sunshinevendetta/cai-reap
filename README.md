# CAI — Balance Mastersheet with cash-backed agent spend

**From order entry to month-end close. Agents spend only the cash that customers have actually paid, through Reap Agentic.**
Reap x AIBM Agentic Buildathon · Theme: *Gasto empresarial*

```
1 Order entry → 2 Rev-rec trigger → 3 Revenue recognition → 4 Billing → 5 Collections
→ 6 Cash application → 7 Treasury → 8 Expenses / AP (+ Reap purchases) → 9 Month-end close
```

**Core formula:** Ending AR = Beginning AR + Billings − Collections − Credit notes
**Cash position:** Beginning cash + Collections − Expenses − Treasury outflows

## CFO Decision Center (CFO Finance Intelligence blueprint)
- **The CFO's five questions** answered from the ledger: what we earned, cash, who owes us, whether the books are accurate (TB, A = L + E, reconciliations, SOX, hash chains), and a **decision queue** (spend approvals, ASC 326 estimate, credit holds, disputes, held orders, high exceptions).
- **20 certified KPIs**: net revenue, growth, gross / EBITDA (non-GAAP) / OPEX ratios, DSO, CEI, past-due %, 90+ %, ECL coverage, invoice accuracy, unapplied receipts, available cash, forecast accuracy (snapshot vs close), operating cash flow, DPO, CCC, reconciliation completion, close cycle time, key-control effectiveness. Each shows its owner, source and formula with live numbers. Values are preliminary while the period is open and certified once it closes.
- **ASC 326 allowance** (aging matrix): the accounting agent proposes it at month end, the controller approves (preparer ≠ approver), and it posts Dr 6900 / Cr 1190. The close is blocked until it's approved.
- **13-week liquidity forecast** (AR by aging probability, AP calendar, Reap standing orders), **variance narratives**, **report catalog** with owner, source, period and reconciliation status, and **six finance agents** with an autonomy policy for each.
- Controlled autonomy: agents prepare, deterministic rules validate, people approve estimates, credit notes and large spend, and the system records the evidence. This is a sandbox demo, not a SOX certification.

## Accounting & controls (US GAAP · SOX)
- **General ledger** (`src/ledger.js`): every event posts a balanced double-entry journal entry. Revenue follows ASC 606: goods at delivery (Dr 1100 / Cr 4000), services billed upfront (Dr 1100 / Cr 2100) and released day by day (Dr 2100 / Cr 4010). Receipts go through unapplied cash (Dr 1000 / Cr 2300 → Dr 2300 / Cr 1100). AP is accrued on the 1st (Dr 6xxx / Cr 2000) and paid on the due date. Reap purchases post to Dr 6500 (or 1500 if ≥ $2,500, or 5000 COGS for fulfillment) / Cr 1000.
- **Financial statements** generated from the GL: income statement with gross profit, balance sheet (A = L + E check), cash flow under both ASC 230 methods (direct and indirect, reconciled to each other), and trial balance. Statements are frozen per closed period.
- **AR reports**: aging in the US11 PDF format, a daily AR roll-forward (shows *why* AR moved or didn't), customer statements of account, and an ASC 606 revenue reconciliation (contracts vs GL revenue and deferred revenue).
- **Operations log**: every agent action is logged with the AR, cash and deferred-revenue balance right after it, the JE it posted, and the SOX controls it exercised. Daily due-date monitoring explains quiet days ("0 invoices due today; next due 2026-10-19").
- **SOX control matrix** (20 automated controls with evidence) covering order validation, credit hold, ASC 606, billing completeness, debit authorization, idempotency, cash application, AR/cash reconciliation, spend authorization with segregation of duties, spend within collected cash, merchant/category compliance, Reap-vs-GL verification, AP matching, balanced JEs, **period lock**, **hash-chained tamper-evident logs**, and the close checklist.

## Reap Agentic at every stage
1–3 Order delivery triggers a **procurement agent** fulfillment purchase via Reap, posted to COGS (matching principle) · 4 Invoices carry the funding trace for Reap spend · 5 Collected cash unlocks Reap spend authority · 6 Reap charges are matched to the invoices that funded them · 7 Treasury forecast includes committed Reap standing orders, priced from Reap quotes · 8 **Recurring standing orders** (office coffee, snacks, cleaning, new-hire keyboards, swag), the recurring spend someone does by hand today, plus ad-hoc buys · 9 The close agent re-reads every checkout (`GET /agentic/checkouts/:id`) and matches it to the GL.

**CAI agent**: deterministic, bilingual command agent with **no external AI and no Anthropic key**. It only uses the Reap API key. It runs the same engine tools ("advance 7 days", "buy 2 keyboards for IT", "who should we chase first?", "financial statements", "SOX controls", "can we close?").

## Hackathon rules, enforced in code
- **Completed purchases only from the organizers' supported merchant list** (`src/vendors.js`, quoted with `externalCheckout` and the merchant's cart link). The wider Reap catalog search is available for discovery and quotes only (`QUOTE_ONLY_MERCHANT_NOT_SUPPORTED`).
- **Simulated charge** uses `X-Simulate-Checkout: COMPLETED` (sandbox), on by default (`REAP_SIMULATE_CHECKOUT`).
- **Travel and restricted categories are blocked** (flights, hotels, gambling, weapons, tobacco and cannabis, alcohol, gift cards…), returned as `RESTRICTED_CATEGORY`.
- **No checkout scraping**: everything goes through Reap's API. The card is entered only on Reap's hosted enrollment page and never reaches CAI or the LLM.

## Data
The AR report PDF (US11, as of 2026-10-07) provides the full row: TOP #, aging buckets, analyst, sales rep, and credit hold. Customer **names and IDs come from the organizers' merchant sheet**. Demo scenarios:
- EVERLANE: disputed
- PIXIOGAMING: insufficient funds
- DEATHWISHCOFFEE: partial payment
- SATECHI: no debit authorization

October also includes 5 sales orders and 5 recurring AP bills.

## Run (Windows/PowerShell, Node 20.6+, zero dependencies)
```powershell
npm start        # http://localhost:3000   (npm run dev = auto-restart)
npm test         # 11 acceptance tests (GL, statements, SOX, ECL, KPIs, chains, close)
```
If you get `EADDRINUSE`, something is already on port 3000: `Get-NetTCPConnection -LocalPort 3000 | % { Stop-Process -Id $_.OwningProcess -Force }`

## Demo script
1. **Reap card** → *Enroll card with Reap* → enter the sandbox card on Reap's page → `ACTIVE` (once; *Reset demo* keeps it).
2. **Collections** → *Run collection cycle now*: 9 collected, Pixio fails, Everlane skipped as disputed, Satechi skipped for no authorization.
3. **Agent purchasing** → IT → Keychron keyboard → *Buy*: live quote, then simulated checkout `COMPLETED`, traced to the invoice that funded it.
4. Ask the agent to book a flight → blocked. Buy 2 Pixio monitors → over $1,000, goes to approval.
5. **+7d / → month end**: orders billed, invoices collected, rent, payroll and AWS paid from collected cash.
6. **Mastersheet** → formulas tie out → *Close month* → November opens with carried-over balances.
7. Toggle **ES** at any point. Every label and agent answer switches language, and the numbers stay identical.

## Layout
| File | What |
|---|---|
| `src/seed.js` | AR report rows, orders, AP templates, policies (plain data, easy for Paco to edit) |
| `src/vendors.js` | Supported merchant list and restricted-category rules |
| `src/engine.js` | All deterministic rules for the 9 stages, mastersheet, close, Reap purchase flow, reconciliation |
| `src/reap.js` | Reap Agentic client (idempotent retries) |
| `src/agent.js` | Deterministic bilingual command agent (no external AI) |
| `src/ledger.js` | Chart of accounts, journal posting, hash chains, statements |
| `src/store.js` | JSON state, append-only audit log, OneDrive-safe writes |
| `public/index.html` | Dashboard |

## Team split
**Omar (tech):** Reap integration, engine, agent, dashboard.
**Paco (non-tech):** policy numbers and demo data in `src/seed.js`, pitch deck, demo script rehearsal, EN/ES copy review, Telegram lead with Reap support.
