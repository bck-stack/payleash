/** Deterministic seed plan: same inputs, same products / orders / refunds / invoices. No I/O. */

export interface PlannedProduct {
  sku: string;
  name: string;
  description: string;
  type: "PHYSICAL" | "DIGITAL";
  category: string;
  price: string;
}

export const PRODUCTS: readonly PlannedProduct[] = [
  { sku: "PLEASH-MUG", name: "PayLeash Demo Mug", description: "Ceramic mug (demo product)", type: "PHYSICAL", category: "ARTS_AND_CRAFTS", price: "24.00" },
  { sku: "PLEASH-TOTE", name: "PayLeash Demo Tote Bag", description: "Canvas tote bag (demo product)", type: "PHYSICAL", category: "ARTS_AND_CRAFTS", price: "32.00" },
  { sku: "PLEASH-STICKERS", name: "PayLeash Sticker Pack", description: "Pack of 10 stickers (demo product)", type: "PHYSICAL", category: "ARTS_AND_CRAFTS", price: "8.50" },
  { sku: "PLEASH-GUIDE", name: "PayLeash Merchant Guide (PDF)", description: "Digital guide (demo product)", type: "DIGITAL", category: "SOFTWARE", price: "15.00" },
];

export const DEFAULT_BUYERS = ["alice@example.com", "bob@example.com", "carol@example.com"] as const;

/** mulberry32: tiny seeded PRNG so plans and fixtures are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlannedItem {
  sku: string;
  name: string;
  unit: string;
  qty: number;
}

export interface PlannedOrder {
  index: number;
  /** Stable key: also the PayPal-Request-Id seed and the order's custom_id. */
  key: string;
  /** The persona this order is meant for. Only metadata: PayPal decides who the real payer is. */
  buyer: string;
  items: PlannedItem[];
  total: string;
}

const cents = (v: string) => Math.round(Number(v) * 100);
export const fromCents = (c: number) => (c / 100).toFixed(2);
export const orderKey = (i: number) => `payleash-seed-${String(i + 1).padStart(4, "0")}`;

export function planOrders(count: number, buyers: readonly string[] = DEFAULT_BUYERS, seed = 42): PlannedOrder[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: count }, (_, index) => {
    const lines = 1 + Math.floor(rnd() * 3);
    const picked = new Set<number>();
    while (picked.size < Math.min(lines, PRODUCTS.length)) picked.add(Math.floor(rnd() * PRODUCTS.length));
    const items = [...picked].map((p) => {
      const prod = PRODUCTS[p]!;
      return { sku: prod.sku, name: prod.name, unit: prod.price, qty: 1 + Math.floor(rnd() * 2) };
    });
    const total = fromCents(items.reduce((a, i) => a + cents(i.unit) * i.qty, 0));
    return { index, key: orderKey(index), buyer: buyers[index % buyers.length]!, items, total };
  });
}

export interface PlannedRefund {
  orderKey: string;
  key: string;
  value: string;
}

/** A few partial refunds (25% or 50% of the order, rounded to cents) on orders spread through the list. */
export function planRefunds(orders: PlannedOrder[], wanted = [3, 17, 42, 77, 120, 160]): PlannedRefund[] {
  return wanted
    .filter((i) => i < orders.length)
    .map((i, n) => {
      const o = orders[i]!;
      const frac = n % 2 === 0 ? 0.25 : 0.5;
      return { orderKey: o.key, key: `payleash-seed-refund-${String(n + 1).padStart(2, "0")}`, value: fromCents(Math.max(100, Math.round((cents(o.total) * frac) / 100) * 100)) };
    });
}

export interface PlannedInvoice {
  key: string;
  number: string;
  recipient: string;
  amount: string;
  description: string;
  send: boolean;
}

export const INVOICES: readonly PlannedInvoice[] = [
  { key: "payleash-seed-invoice-1", number: "PLEASH-0001", recipient: "alice@example.com", amount: "60.00", description: "Monthly support plan", send: true },
  { key: "payleash-seed-invoice-2", number: "PLEASH-0002", recipient: "bob@example.com", amount: "120.00", description: "Onboarding workshop", send: true },
  { key: "payleash-seed-invoice-3", number: "PLEASH-0003", recipient: "carol@example.com", amount: "450.00", description: "Custom integration (large: exercises approval thresholds)", send: false },
  { key: "payleash-seed-invoice-4", number: "PLEASH-0004", recipient: "alice@example.com", amount: "75.50", description: "Extra seats", send: false },
  { key: "payleash-seed-invoice-5", number: "PLEASH-0005", recipient: "bob@example.com", amount: "1200.00", description: "Annual licence (very large)", send: false },
];
