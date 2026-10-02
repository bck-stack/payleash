import { readFileSync } from "node:fs";
import { ShopBook, type ShopOrder } from "./shop.js";

interface ManifestOrder {
  orderId?: string;
  captureId?: string;
  total?: string;
  buyerEmail?: string | null;
  stage?: string;
}

/**
 * Live sandbox: the inbox talks about order numbers #1001..#1005; this picks real sandbox orders from the seed manifest
 * (`pnpm seed` writes it) that fit each email, so the same six emails work against PayPal's sandbox.
 * Sandbox orders do not have the demo's line items, so the refunds are for the whole order and the emails' amounts are
 * rewritten to match (`adaptEmailForLive`). PayLeash then sees amounts that PayPal's own record confirms.
 *   #1001  total from $10 to $25: refunded in full, automatically; the second email asks again and is denied (balance)
 *   #1002  total above $25 and up to $100: refunded in full, but held for the owner
 *   #1003, #1005  total up to $25: refunded in full, automatically
 *   #1004  any captured order (the injection asks for $999 to an attacker; the order never matters)
 */
export function shopFromManifest(path: string): { book: ShopBook; problems: string[] } {
  const m = JSON.parse(readFileSync(path, "utf8")) as { orders?: ManifestOrder[] };
  const captured = (m.orders ?? []).filter((o) => o.orderId && o.captureId && o.total && (o.stage === undefined || o.stage === "captured"));
  const used = new Set<string>();
  const pick = (ok: (total: number) => boolean): ManifestOrder | undefined => {
    const o = captured.find((x) => !used.has(x.captureId!) && ok(Number(x.total)));
    if (o) used.add(o.captureId!);
    return o;
  };
  const wants: [string, (t: number) => boolean, string][] = [
    ["1001", (t) => t >= 10 && t <= 25, "an order of $10.00 to $25.00 (refunded in full, then asked for again)"],
    ["1002", (t) => t > 25 && t <= 100, "an order above $25.00 and up to $100.00 (refunded in full after approval)"],
    ["1003", (t) => t >= 5 && t <= 25, "an order of $5.00 to $25.00"],
    ["1004", () => true, "any captured order"],
    ["1005", (t) => t >= 5 && t <= 25, "an order of $5.00 to $25.00"],
  ];
  const orders: ShopOrder[] = [];
  const problems: string[] = [];
  for (const [number, ok, what] of wants) {
    const o = pick(ok);
    if (o) orders.push({ number, orderId: o.orderId!, captureId: o.captureId!, total: o.total!, buyer: o.buyerEmail ?? null });
    else problems.push(`#${number}: no captured order in ${path} matches ${what}. Run \`pnpm seed -- --count 20\` (card mode) or capture more orders.`);
  }
  // Everything else is available to the dispute agent's lookups.
  captured.filter((o) => !used.has(o.captureId!)).forEach((o, i) => orders.push({ number: String(3000 + i), orderId: o.orderId!, captureId: o.captureId!, total: o.total!, buyer: o.buyerEmail ?? null }));
  return { book: new ShopBook(orders), problems };
}

/** The amounts the demo inbox asks for, by shop order number. */
const DEMO_AMOUNT: Record<string, string> = { "1001": "19.00", "1002": "60.00", "1003": "8.50", "1005": "12.00" };

/** Rewrites the demo amounts in an email to the real order's total, so a sandbox run asks for what PayPal's record supports. */
export function adaptEmailForLive<E extends { body: string; raw: string; subject: string }>(email: E, book: ShopBook): E {
  const number = /#\s?(\d{3,5})\b/.exec(`${email.subject}\n${email.body}`)?.[1];
  const demo = number ? DEMO_AMOUNT[number] : undefined;
  const real = number ? book.byNumber(number)?.total : undefined;
  if (!demo || !real) return email;
  const re = new RegExp(`\\$${demo.replace(".", "\\.").replace(/\\\.00$/, "(?:\\.00)?")}(?!\\d)`, "g");
  const to = `$${Number(real).toFixed(2)}`;
  return { ...email, body: email.body.replace(re, () => to), raw: email.raw.replace(re, () => to) };
}
