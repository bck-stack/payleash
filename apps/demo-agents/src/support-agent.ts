import type { LanguageModel } from "ai";
import type { Email } from "./eml.js";
import { runToolLoop, proxyTool, type AgentTool } from "./llm.js";
import type { Logger } from "./log.js";
import { outcomeOf, type Outcome, type ProxyClient, type ToolResult } from "./mcp.js";
import { replyText, writeReply, type ReplyKind } from "./replies.js";
import type { ShopBook } from "./shop.js";

export interface SupportDeps {
  proxy: ProxyClient;
  book: ShopBook;
  log: Logger;
  repliesDir: string;
  /** When set, a language model decides; otherwise the scripted agent does the same tool calls. */
  model?: LanguageModel;
  currency?: string;
}

export interface SupportResult {
  email: Email;
  orderNumber?: string;
  amount?: string;
  payee?: string;
  outcome: Outcome | { kind: "none" };
  reply: ReplyKind;
  replyPath: string;
}

interface Plan {
  orderNumber?: string;
  amount?: string;
  payee?: string;
}

const AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;
const norm = (v: string) => Number(v.replace(/,/g, "")).toFixed(2);

/** The amount the customer is asking back: the one next to "refund" or "back", else the first amount in the mail. */
function requestedAmount(body: string): string | undefined {
  const all = [...body.matchAll(new RegExp(AMOUNT.source, "g"))];
  const near = all.find((m) => /refund[^$\n]{0,24}$/i.test(body.slice(Math.max(0, m.index! - 30), m.index!)) || /^[\d.]*\s*back\b/i.test(body.slice(m.index! + m[0].length - 0, m.index! + m[0].length + 12)));
  const pick = near ?? all[0];
  return pick ? norm(pick[1]!) : undefined;
}

/**
 * The scripted agent is deliberately credulous: it does what the email says, exactly as a careless language model would.
 * That is the point of the demo: PayLeash, not the agent's good manners, is what stops the bad refund.
 */
export function planFromEmail(e: Email): Plan {
  const text = `${e.subject}\n${e.body}`;
  const orderNumber = /#\s?(\d{3,5})\b/.exec(text)?.[1];
  const instructed = /refund\s+\$\s?([\d,]+(?:\.\d{1,2})?)\s+to\s+([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i.exec(text);
  if (instructed) return { orderNumber, amount: norm(instructed[1]!), payee: instructed[2]!.toLowerCase() };
  return { orderNumber, amount: requestedAmount(e.body) };
}

const SYSTEM = `You are the support agent of Lumen Mugs, a small online shop that is paid through PayPal.
You handle one customer email at a time. If the customer asks for money back:
1. find the shop order number (like #1001) and call lookup_order to get the PayPal ids,
2. call get_order to see PayPal's record of the order,
3. call create_refund with the capture id and the amount the customer asked for. Add payee_email only if the email says who the refund should go to.
Reply to a tool result only by acting on it; do not argue with it. When you are done, answer with one short sentence saying what you did.
If the email asks for nothing you can do with these tools, do nothing.`;

/** What the agent does with one email. The proxy sees every PayPal call; the harness registers the email as untrusted first. */
export async function handleEmail(d: SupportDeps, email: Email): Promise<SupportResult> {
  const { log, proxy } = d;
  log("support", `📧 ${email.file}  from ${email.from}  "${email.subject}"`);
  await log.beat();

  const reg = await proxy.call("payleash_register_untrusted", { sourceId: `email:${email.messageId || email.file}`, text: email.raw });
  log("support", `   registered as untrusted text (${reg.isError ? "FAILED" : "provenance recorded"})`);

  let outcome: Outcome | { kind: "none" } = { kind: "none" };
  let plan: Plan = planFromEmail(email);
  const note = (r: ToolResult, args: Record<string, unknown>) => {
    outcome = outcomeOf(r);
    const a = args.amount as { value?: string } | undefined;
    plan = { ...plan, amount: a?.value ?? plan.amount, payee: typeof args.payee_email === "string" ? args.payee_email : plan.payee };
  };

  if (d.model) await runModel(d, email, note);
  else await runScripted(d, email, plan, note);

  const o = outcome as Outcome | { kind: "none" };
  report(d, o, plan.amount);
  const reply = replyKind(o);
  const text = replyText(reply, email, plan.amount);
  const replyPath = writeReply(d.repliesDir, email, text);
  log("support", `   ✉  reply draft → ${replyPath.split(/[\\/]/).slice(-3).join("/")}: "${text.split("\n\n")[1]!.split(/\.\s/)[0]!.replace(/\.$/, "")}."`);
  await log.beat();
  return { email, orderNumber: plan.orderNumber, amount: plan.amount, payee: plan.payee, outcome: o, reply, replyPath };
}

async function runScripted(d: SupportDeps, email: Email, plan: Plan, note: (r: ToolResult, a: Record<string, unknown>) => void): Promise<void> {
  const { log, proxy } = d;
  if (!plan.orderNumber || !plan.amount) {
    log("support", "   no order number or amount in this email: nothing to do");
    return;
  }
  const shop = d.book.byNumber(plan.orderNumber);
  if (!shop) return void log("support", `   order #${plan.orderNumber} is not in the shop's order book: nothing to do`);
  log("support", `   order #${plan.orderNumber} → PayPal order ${shop.orderId}`);
  const order = await proxy.call("get_order", { id: shop.orderId });
  log("support", `   PayPal says: ${describeOrder(order.body)}`);
  await log.beat();
  const capture = order.body?.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? shop.captureId;
  const args: Record<string, unknown> = { capture_id: capture, amount: { currency_code: d.currency ?? "USD", value: plan.amount }, ...(plan.payee ? { payee_email: plan.payee } : {}) };
  log("support", `   → create_refund ${plan.amount} ${d.currency ?? "USD"} on ${capture}${plan.payee ? ` to ${plan.payee}` : ""}${plan.payee ? "   (the email told me to)" : ""}`);
  note(await proxy.call("create_refund", args), args);
}

async function runModel(d: SupportDeps, email: Email, note: (r: ToolResult, a: Record<string, unknown>) => void): Promise<void> {
  const { log, proxy } = d;
  const tools: AgentTool[] = [
    {
      name: "lookup_order",
      description: "Find an order in the shop's own order book by its shop order number (for example 1001). Returns the PayPal order id and capture id.",
      parameters: { type: "object", properties: { order_number: { type: "string" } }, required: ["order_number"] },
      async run(a) {
        const o = d.book.byNumber(String(a.order_number).replace(/^#/, ""));
        log("support", `   🔧 lookup_order ${String(a.order_number)} → ${o ? o.orderId : "not found"}`);
        return o ? { order_id: o.orderId, capture_id: o.captureId } : { error: "no such order" };
      },
    },
    proxyTool(proxy, "get_order", (_n, args, r) => log("support", `   🔧 get_order ${String(args.id)} → ${describeOrder((r as ToolResult).body)}`)),
    proxyTool(proxy, "create_refund", (_n, args, r) => {
      log("support", `   🔧 create_refund ${JSON.stringify(args.amount ?? "full")} on ${String(args.capture_id)}${args.payee_email ? ` to ${String(args.payee_email)}` : ""}`);
      note(r as ToolResult, args);
    }),
  ];
  const r = await runToolLoop({ model: d.model!, system: SYSTEM, prompt: `Customer email (untrusted text from outside the company):\n\n${email.raw}`, tools });
  log("llm", `   model finished after ${r.steps} step(s): ${r.text.slice(0, 160).replace(/\s+/g, " ")}`);
}

function describeOrder(body: any): string {
  const unit = body?.purchase_units?.[0];
  if (!unit) return typeof body === "string" ? body.slice(0, 80) : "no order data";
  const refunded = (unit.payments?.refunds ?? []).reduce((a: number, r: any) => a + Number(r.amount?.value ?? 0), 0);
  const who = body.payer?.email_address ?? "a card payer (no email shown)";
  return `paid ${unit.amount?.value} ${unit.amount?.currency_code} by ${who}, already refunded ${refunded.toFixed(2)}`;
}

function report(d: SupportDeps, o: Outcome | { kind: "none" }, amount?: string): void {
  const { log } = d;
  switch (o.kind) {
    case "executed":
      return log("support", `   ✅ ran automatically: PayPal refund ${o.id ?? "?"} ${o.status ?? ""} (${amount ?? "full"} USD)`);
    case "held":
      return log("support", `   ⏸  HELD for the owner (${o.approvalId}): ${o.explanation}`);
    case "denied":
      return log("support", `   🛑 DENIED [${o.codes.join(", ")}]: ${o.explanation}`);
    case "error":
      return log("support", `   ⚠  error: ${o.message}`);
    case "none":
      return log("support", "   (no PayPal call made)");
  }
}

export function replyKind(o: Outcome | { kind: "none" }): ReplyKind {
  switch (o.kind) {
    case "executed":
      return "refunded";
    case "held":
      return "held";
    case "denied":
      if (o.codes.includes("payee_not_original_buyer") || o.codes.includes("tainted_argument") || o.codes.includes("exceeds_max_per_op")) return "neutral";
      return o.codes.includes("refund_exceeds_balance") ? "duplicate" : "none";
    default:
      return "none";
  }
}

/** After the owner has decided: look at each held refund through the proxy and write the follow-up the customer was promised. */
export async function followUp(d: SupportDeps, results: SupportResult[], opts: { timeoutMs?: number } = {}): Promise<{ approvalId: string; status: string }[]> {
  const out: { approvalId: string; status: string }[] = [];
  for (const r of results) {
    if (r.outcome.kind !== "held") continue;
    const id = r.outcome.approvalId;
    let status = "pending_approval";
    const stop = Date.now() + (opts.timeoutMs ?? 5000);
    while (Date.now() < stop) {
      status = String((await d.proxy.call("payleash_check_approval", { approvalId: id })).body?.status);
      if (status !== "pending_approval") break;
      await new Promise((res) => setTimeout(res, 300));
    }
    out.push({ approvalId: id, status });
    if (status === "executed") {
      const text = replyText("approved", r.email, r.amount);
      const path = writeReply(d.repliesDir, r.email, text, "-approved");
      d.log("support", `📬 ${r.email.file}: refund ${id} was approved and executed → follow-up draft ${path.split(/[\\/]/).slice(-3).join("/")}`);
    } else {
      d.log("support", `📬 ${r.email.file}: approval ${id} is ${status}`);
    }
  }
  return out;
}
