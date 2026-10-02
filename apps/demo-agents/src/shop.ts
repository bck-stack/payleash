import { DEMO_IDS, expandOrderFixtures, type FixtureResponses, type OrderFixtureSpec } from "@payleash/core";

/** The shop's own order book: its order numbers (#1001) mapped to PayPal ids. A real shop has this in its database. */
export interface ShopOrder {
  number: string;
  orderId: string;
  captureId: string;
  total: string;
  buyer: string | null;
}

export class ShopBook {
  constructor(readonly orders: ShopOrder[]) {}
  byNumber(n: string): ShopOrder | undefined {
    return this.orders.find((o) => o.number === n);
  }
  byCapture(id: string): ShopOrder | undefined {
    return this.orders.find((o) => o.captureId === id);
  }
}

const day = 86_400_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The orders the demo inbox talks about, as recorded PayPal responses (demo mode only). */
export function demoOrders(now: Date): { specs: OrderFixtureSpec[]; book: ShopBook } {
  const at = (days: number) => iso(new Date(now.getTime() - days * day));
  const specs: OrderFixtureSpec[] = [
    { orderId: "8DM1001AA2200001B", captureId: "4CP1001AA2200001B", buyer: "alice@example.com", total: "19.00", createdAt: at(6), items: [{ name: "Handmade mug", unit: "19.00", qty: 1 }] },
    { orderId: "8DM1002AA2200002C", captureId: "4CP1002AA2200002C", buyer: "bob@example.com", total: "120.00", createdAt: at(9), items: [{ name: "Mug set", unit: "60.00", qty: 1 }, { name: "Canvas tote bag", unit: "30.00", qty: 2 }] },
    { orderId: "8DM1003AA2200003D", captureId: "4CP1003AA2200003D", buyer: "carol@example.com", total: "34.50", createdAt: at(4), items: [{ name: "Sticker pack", unit: "8.50", qty: 1 }, { name: "Handmade mug", unit: "26.00", qty: 1 }] },
    { orderId: "8DM1004AA2200004E", captureId: "4CP1004AA2200004E", buyer: "dan@example.com", total: "45.00", createdAt: at(12), items: [{ name: "Mug set", unit: "45.00", qty: 1 }] },
    { orderId: "8DM1005AA2200005F", captureId: "4CP1005AA2200005F", buyer: "erin@example.com", total: "53.00", createdAt: at(3), shipping: "12.00", items: [{ name: "Mug set", unit: "41.00", qty: 1 }] },
  ];
  const book = new ShopBook(specs.map((s, i) => ({ number: String(1001 + i), orderId: s.orderId, captureId: s.captureId, total: s.total, buyer: s.buyer })));
  return { specs, book };
}

/**
 * Recorded PayPal responses for the demo scenario: the five inbox orders, the recorded disputes
 * (`scripts/seed-sandbox/fixtures/disputes.json` with their orders) and a shipment tracker for each.
 */
export function demoWorld(now: Date, recorded: { history: { orders: OrderFixtureSpec[] }; disputes: FixtureResponses }): { responses: FixtureResponses; book: ShopBook } {
  const { specs, book } = demoOrders(now);
  const responses: FixtureResponses = { ...expandOrderFixtures(specs) };
  const tracker = (captureId: string, orderId: string, carrier: string, number: string, deliveredAt: string, status = "DELIVERED") => ({
    [`/v1/shipping/trackers/${captureId}`]: { transaction_id: captureId, order_id: orderId, tracking_number: number, carrier, status, last_event_time: deliveredAt, events: [{ time: deliveredAt, description: status === "DELIVERED" ? "Delivered, left with resident" : "In transit" }] },
  });

  // The dispute PayLeash's own demo already contains (PP-D-27803, alice, capture42) plus the three recorded ones.
  const disputes = recorded.disputes as Record<string, any>;
  const wanted = new Set<string>();
  for (const d of Object.values(disputes)) wanted.add(d.disputed_transactions[0].seller_transaction_id);
  const orderSpecs = recorded.history.orders.filter((o) => wanted.has(o.captureId));
  Object.assign(responses, expandOrderFixtures(orderSpecs), disputes);
  const deliveredAfter = (createdAt: string, days: number) => iso(new Date(new Date(createdAt).getTime() + days * day));
  orderSpecs.forEach((o, i) => Object.assign(responses, tracker(o.captureId, o.orderId, ["UPS", "DHL", "USPS"][i % 3]!, `1Z${o.captureId.slice(0, 10)}`, deliveredAfter(o.createdAt, 3 + i))));
  Object.assign(responses, tracker(DEMO_IDS.capture42, DEMO_IDS.order42, "UPS", "1Z999AA10123456784", deliveredAfter(new Date(now.getTime() - 10 * day).toISOString(), 3)));
  return { responses, book: new ShopBook([...book.orders, ...orderSpecs.map((o, i) => ({ number: String(2001 + i), orderId: o.orderId, captureId: o.captureId, total: o.total, buyer: o.buyer })), { number: "2000", orderId: DEMO_IDS.order42, captureId: DEMO_IDS.capture42, total: "42.00", buyer: "alice@example.com" }]) };
}
