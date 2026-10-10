// Seed data: TOTAL AR Report - US11 (as of 2026-10-07). Amounts in USD, whole dollars.
// Each aging bucket becomes one invoice with a due date consistent with that bucket.

export const AS_OF = '2026-10-07';

// Customers = organizer-supported merchants (name + ID from the merchant sheet),
// carrying the full row structure of the AR report PDF (rank, aging buckets, analyst, sales rep, credit hold).
const CUSTOMERS = [
  { top: 1,  id: '44554000957529', name: 'KEYCHRON.COM',        category: 'Computers & Electronics', rep: 'Jennifer Spicer', b: { notDue: 188873, d1_30: 248560 } },
  { top: 2,  id: '39725702709310', name: 'HYPERSHOP.COM',       category: 'Computers & Electronics', rep: 'Shakil Vyas',     b: { notDue: 116542, d1_30: 211222 } },
  { top: 3,  id: '52269931266279', name: 'PLUGABLE.COM',        category: 'Computers & Electronics', rep: 'Jennifer Spicer', b: { d1_30: 72766 } },
  { top: 4,  id: '45798527860819', name: 'BARONFIG.COM',        category: 'Books & Stationery',      rep: 'Jennifer Spicer', b: { notDue: 65874, d1_30: 65874 } },
  { top: 5,  id: '42950127452250', name: 'BROOKLINEN.COM',      category: 'Home & Living',           rep: 'Bardia D.',       b: { notDue: 153401, d1_30: 48298 } },
  { top: 6,  id: '45720483266646', name: 'EVERLANE.COM',        category: 'Fashion & Apparel',       rep: 'Morgan Hahn',     b: { d91_180: 37731 } },
  { top: 7,  id: '42380283346999', name: 'DEATHWISHCOFFEE.COM', category: 'Coffee & Tea',            rep: 'Morgan Hahn',     b: { d1_30: 18153, d31_60: 16146 } },
  { top: 8,  id: '52521820094596', name: 'PIXIOGAMING.COM',     category: 'Computers & Electronics', rep: 'Chris Pondy',     b: { d61_90: 19699 } },
  { top: 9,  id: '44267709005912', name: 'SATECHI.NET',         category: 'Computers & Electronics', rep: 'Rob Coopman',     b: { d1_30: 8569 } },
  { top: 10, id: '43940711923906', name: 'FROMOURPLACE.COM',    category: 'Kitchen & Dining',        rep: 'Payton Ponzer',   b: { notDue: 53558, d31_60: 6794 } },
  { top: 11, id: '46441190424633', name: 'TWELVESOUTH.COM',     category: 'Computers & Electronics', rep: 'Payton Ponzer',   b: { d1_30: 2282 } },
].map(c => ({ ...c, email: `ap@${c.name.toLowerCase()}` }));

// Days offset from AS_OF for each bucket (negative = already past due).
const BUCKET_OFFSET = { notDue: 12, d1_30: -15, d31_60: -45, d61_90: -75, d91_180: -120 };

// Demo scenarios so every control path shows up in the demo.
// - funding: what the (simulated) customer funding account does when debited
// - status: invoice status override
const SCENARIOS = {
  '45720483266646:d91_180': { status: 'DISPUTED' },                                // Everlane: disputed -> ineligible
  '52521820094596:d61_90':  { funding: { result: 'FAILED', code: 'INSUFFICIENT_FUNDS' } }, // Pixio: debit fails
  '42380283346999:d31_60':  { funding: { result: 'PARTIAL', cents: 1000000 } },    // Death Wish pays 10,000 of 16,146
  '44267709005912:d1_30':   { authorization: 'MISSING' },                          // Satechi: no debit authorization
};

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildSeed() {
  const customers = [];
  const invoices = [];
  let n = 1;
  for (const c of CUSTOMERS) {
    customers.push({ id: c.id, top: c.top, legalName: c.name, category: c.category, salesRep: c.rep, email: c.email, analyst: 'FRANK', creditHold: false });
    for (const [bucket, dollars] of Object.entries(c.b)) {
      const key = `${c.id}:${bucket}`;
      const sc = SCENARIOS[key] || {};
      const issue = addDays(AS_OF, BUCKET_OFFSET[bucket] - 30);
      invoices.push({
        id: `INV-${String(n++).padStart(4, '0')}`,
        customerId: c.id,
        legalEntity: 'US11',
        currency: 'USD',
        originalCents: dollars * 100,
        outstandingCents: dollars * 100,
        issueDate: issue,
        dueDate: addDays(AS_OF, BUCKET_OFFSET[bucket]),
        terms: 'NET30',
        status: sc.status || 'OPEN',
        authorization: sc.authorization || 'VALID',
        funding: sc.funding || { result: 'OK' },
        sourceBucket: bucket,
      });
    }
  }
  return { customers, invoices };
}

// Opening cash on 2026-10-01. Treasury keeps it as the liquidity reserve: agents can't spend it.
export const OPENING_CASH_CENTS = 25000000;     // $250,000
export const FIRST_MONTH = '2026-10';

// Sales orders booked in October (Order Entry). GOODS: revenue + invoice at delivery.
// SERVICE: billed upfront at service start, revenue recognized ratably by day.
export function buildOrders() {
  return [
    { customerId: '44554000957529', description: 'Wholesale keyboard switches — 4,000 units', type: 'GOODS',   amountCents: 12000000, bookedDate: '2026-10-02', deliveryDate: '2026-10-09' },
    { customerId: '39725702709310', description: 'USB-C hub components — bulk',              type: 'GOODS',   amountCents: 8500000,  bookedDate: '2026-10-03', deliveryDate: '2026-10-14' },
    { customerId: '52269931266279', description: 'Firmware QA program Q4',                   type: 'SERVICE', amountCents: 6000000,  bookedDate: '2026-10-05', serviceStart: '2026-10-15', serviceEnd: '2027-01-14' },
    { customerId: '42950127452250', description: 'Turkish cotton — 2 containers',            type: 'GOODS',   amountCents: 4500000,  bookedDate: '2026-10-06', deliveryDate: '2026-10-21' },
    { customerId: '42380283346999', description: 'Green coffee beans — 12 pallets',          type: 'GOODS',   amountCents: 2200000,  bookedDate: '2026-10-07', deliveryDate: '2026-10-28' },
  ].map((o, i) => ({ id: `SO-${1001 + i}`, terms: 'NET30', currency: 'USD', fulfillment: FULFILLMENT[o.type], ...o }));
}

// At delivery the procurement agent buys fulfillment supplies through Reap (posted to COGS — matching principle).
const FULFILLMENT = {
  GOODS:   { vendorSku: 'packagefreeshop.com:43868446261345', quantity: 3, reason: 'Packing & cleaning supplies for shipment' },
  SERVICE: { vendorSku: 'baronfig.com:45798527860819',        quantity: 1, reason: 'Field kit for service engagement' },
};

// Recurring spend that someone does by hand today → standing orders the agent executes through Reap.
// Pre-approved by the controller up to capCents per run (Reap mandates are "coming soon"; CAI enforces the cap itself).
export const RECURRING_RULES = [
  { id: 'RR-1', name: { en: 'Office coffee restock', es: 'Reabasto de café de oficina' },    costCenter: 'FAC', vendorSku: 'deathwishcoffee.com:42380283346999', quantity: 6,  frequency: 'WEEKLY',  weekday: 1, capCents: 15000 },
  { id: 'RR-2', name: { en: 'Team snacks',            es: 'Botanas del equipo' },             costCenter: 'FAC', vendorSku: 'partakefoods.com:43267581870178',    quantity: 2,  frequency: 'WEEKLY',  weekday: 3, capCents: 12000 },
  { id: 'RR-3', name: { en: 'Cleaning supplies',      es: 'Artículos de limpieza' },          costCenter: 'FAC', vendorSku: 'packagefreeshop.com:43868446261345', quantity: 8,  frequency: 'MONTHLY', day: 5,     capCents: 20000 },
  { id: 'RR-4', name: { en: 'New-hire keyboards',     es: 'Teclados para nuevos ingresos' },  costCenter: 'IT',  vendorSku: 'keychron.com:44554000957529',        quantity: 2,  frequency: 'MONTHLY', day: 12,    capCents: 15000 },
  { id: 'RR-5', name: { en: 'Marketing swag (hats)',  es: 'Artículos promocionales (gorras)' }, costCenter: 'MKT', vendorSku: 'coinbaseshop.com:50600348877106',  quantity: 10, frequency: 'MONTHLY', day: 20,    capCents: 40000 },
];

// Recurring monthly operating bills (Expenses / AP). day = due day of month.
export const AP_TEMPLATES = [
  { vendor: 'Rent — Houston plant',      costCenter: 'FAC', category: 'Rent',        cents: 2500000,  day: 10 },
  { vendor: 'Payroll',                   costCenter: 'OPS', category: 'Payroll',     cents: 18000000, day: 15 },
  { vendor: 'AWS — compute',             costCenter: 'IT',  category: 'Cloud',       cents: 1850000,  day: 20 },
  { vendor: 'Freight & logistics',       costCenter: 'OPS', category: 'Logistics',   cents: 4200000,  day: 25 },
  { vendor: 'Marketing agency retainer', costCenter: 'MKT', category: 'Marketing',   cents: 1500000,  day: 28 },
];

// Treasury policy: confirmed cash -> cost-center budgets the agents can spend.
export const ALLOCATION_POLICY = {
  version: 'TP-2026-10-v1',
  effectiveDate: '2026-10-01',
  centers: [
    { id: 'OPS',  name: { en: 'Operations',  es: 'Operaciones' },   bps: 4000 },
    { id: 'IT',   name: { en: 'IT & Compute', es: 'TI y Cómputo' }, bps: 2500 },
    { id: 'FAC',  name: { en: 'Facilities',  es: 'Instalaciones' }, bps: 2000 },
    { id: 'MKT',  name: { en: 'Marketing',   es: 'Marketing' },     bps: 1500 },
  ],
};

// Spend policy for the agents (deterministic, enforced in code — never by the model).
export const SPEND_POLICY = {
  version: 'SP-2026-10-v1',
  autoApproveMaxCents: 100000,     // > $1,000 needs an internal approver before Reap checkout
  perPurchaseMaxCents: 1000000,    // hard cap $10,000 per purchase
};

// Default ship-to used for quotes (merchant requires addressLine2 + valid phone).
export const SHIP_TO = {
  firstName: 'Paco', lastName: 'CAI', phone: '+12125550123',
  addressLine1: '350 5th Ave', addressLine2: 'Suite 3300',
  city: 'New York', region: 'NY', postalCode: '10118', country: 'US',
};
export const BUYER_EMAIL = 'ops@caidemo.com';
