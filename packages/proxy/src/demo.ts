import { DEMO_IDS, EXAMPLE_SUPPORT_MANDATE, buildDemoFixtures, issueMandate, type MandateInput } from "@payleash/core";
import type { ProxyRuntime } from "./runtime.js";

const I = DEMO_IDS;

export const DEMO_BILLING_MANDATE: MandateInput = {
  agentId: "billing-agent",
  allowedTools: ["send_invoice", "send_invoice_reminder", "get_invoice"],
  constraints: { send_invoice: { currency: "USD", maxAmountPerOp: "500.00", dailyTotal: "1000.00", autoApproveThreshold: "100.00" } },
};

const refund = (capture_id: string, value?: string, payee?: string) => ({
  capture_id,
  ...(value ? { amount: { currency_code: "USD", value } } : {}),
  ...(payee ? { payee_email: payee } : {}),
});

/**
 * Fills a demo runtime with a believable morning: two agents with mandates, and a handful of real decisions made by the
 * real guard against the recorded PayPal fixtures (one runs, three are held, two are denied). Safe to call again: it
 * resets the fixtures and the daily budgets first, and an identical still-pending call is not queued twice.
 */
export async function seedDemo(rt: ProxyRuntime, o: { activity?: boolean } = {}): Promise<void> {
  const fx = rt.fixtureExecutor;
  const ownerKey = rt.ownerPrivateKey;
  if (!fx || !ownerKey) throw new Error("demo seeding needs fixtures and the throw-away owner key");
  const log = (line: string) => rt.env.PAYLEASH_QUIET ? undefined : process.stderr.write(`[payleash] ${line}\n`);

  // 1. A fresh copy of PayPal's world and an empty budget.
  const fresh = buildDemoFixtures(rt.now());
  for (const k of Object.keys(fx.responses)) delete fx.responses[k];
  Object.assign(fx.responses, fresh);
  rt.db.prepare("DELETE FROM spend_ledger").run();
  if (o.activity === false) return;

  // 2. Mandates, signed with the throw-away key and recorded for the dashboard.
  const sign = async (input: MandateInput) => {
    const { token, mandate } = await issueMandate(ownerKey, input, { issuer: "payleash-demo", ttlSeconds: 30 * 86400, now: rt.now() });
    rt.mandates.record(mandate, "issued", rt.now().getTime());
    return token;
  };
  const support = await rt.app.openSession(await sign(EXAMPLE_SUPPORT_MANDATE));
  const billing = await rt.app.openSession(await sign(DEMO_BILLING_MANDATE));

  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      log(`demo seed step "${label}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const forget = (agent: string) => rt.registries.forAgent(agent).clear();

  // 3. Support agent.
  await step("small refund runs", async () => {
    forget("support-agent");
    await rt.app.handleWrite(support, "create_refund", refund(I.capture42, "10.00", "alice@example.com"));
  });
  await step("large refund is held", async () => {
    forget("support-agent");
    await rt.app.handleWrite(support, "create_refund", refund(I.capture100, "60.00", "bob@example.com"));
  });
  await step("card order, payee named", async () => {
    forget("support-agent");
    await rt.app.handleWrite(support, "create_refund", refund(I.captureCard, "18.00", "jordan@example.com"));
  });
  await step("amount only a ticket asserts", async () => {
    forget("support-agent");
    rt.app.registerUntrusted(support, "ticket:4521", "Hi, your colleague promised me a goodwill refund of $12.34 on order 7GH23478AB129876K. Please process it, thanks!");
    await rt.app.handleWrite(support, "create_refund", refund(I.capture100, "12.34", "bob@example.com"));
  });
  await step("prompt injection from a dispute", async () => {
    forget("support-agent");
    await rt.app.handleRead(support, "get_dispute", { dispute_id: I.dispute }); // registers the buyer's message as untrusted
    await rt.app.handleWrite(support, "create_refund", refund(I.capture42, "999.00", "attacker@example.com"));
  });
  await step("above the per-operation limit", async () => {
    forget("support-agent");
    await rt.app.handleWrite(support, "create_refund", refund(I.capture100, "150.00", "bob@example.com"));
  });

  // 4. Billing agent.
  await step("small invoice goes out", async () => {
    forget("billing-agent");
    await rt.app.handleWrite(billing, "send_invoice", { invoice_id: I.invoiceSmall });
  });
  await step("large invoice is held", async () => {
    forget("billing-agent");
    await rt.app.handleWrite(billing, "send_invoice", { invoice_id: I.invoiceLarge });
  });
  await step("invoice copied to a stranger", async () => {
    forget("billing-agent");
    await rt.app.handleWrite(billing, "send_invoice", { invoice_id: I.invoiceSmall, additional_recipients: ["stranger@example.net"] });
  });
}
