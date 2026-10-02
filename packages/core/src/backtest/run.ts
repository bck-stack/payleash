import { generateKeyPairSync, randomUUID } from "node:crypto";
import { AuditLog } from "../audit/log.js";
import { openDb } from "../db.js";
import { Guard, type Authorization } from "../guard.js";
import { MandateInputSchema, type Mandate, type MandateInput } from "../mandate/schema.js";
import { issueMandate } from "../mandate/sign.js";
import { orderFixtures, type FixtureResponses } from "../paypal/fixtures.js";
import { RestPayPalReader, type PayPalTransport } from "../paypal/rest-reader.js";
import { SqlitePolicyStore, SqliteReplayGuard } from "../policy/store.js";
import { groupReasons } from "../reasons.js";
import { RegistryBook } from "../taint/registry.js";
import { orderAsOf, synthesizeActions, type BacktestAction, type SynthesisOptions } from "./actions.js";
import type { History } from "./history.js";
import { summarize, toRows, type ActionResult, type BacktestReport, type ReportRow } from "./report.js";

const DAY = 86_400_000;

export interface BacktestInput {
  history: History;
  mandate: MandateInput;
  options?: SynthesisOptions;
}

export interface BacktestRun {
  id: string;
  createdAt: string;
  source: History["source"];
  anchor: string;
  days: number;
  /** The mandate the history was replayed against (claims of the ephemeral dry-run signature). */
  mandate: Mandate;
  options: Required<SynthesisOptions>;
  /** Always true: the replay reads recorded history only and has no way to call PayPal. */
  dryRun: true;
  results: ActionResult[];
  report: BacktestReport;
  rows: ReportRow[];
}

/** A PayPal "server" that only knows the order as it stood at the moment of the action being replayed. */
class ReplayTransport implements PayPalTransport {
  responses: FixtureResponses = {};
  async get(path: string) {
    const body = this.responses[path];
    return body === undefined ? { status: 404, body: { name: "RESOURCE_NOT_FOUND" } } : { status: 200, body };
  }
}

/**
 * Replays synthesised agent actions through the real guard (mandate -> kill switch -> provenance firewall -> policy -> budget)
 * in dry-run mode: an in-memory database, an ephemeral signing key and a PayPal reader fed from recorded history.
 * No executor exists in this path, so no PayPal write API can be called, and no network is used at all.
 */
export async function runBacktest(input: BacktestInput): Promise<BacktestRun> {
  const { history } = input;
  const mandateInput = MandateInputSchema.parse(input.mandate);
  const options: Required<SynthesisOptions> = { sampleOrders: input.options?.sampleOrders ?? 40, seed: input.options?.seed ?? 11, adversarial: input.options?.adversarial ?? true };
  const actions = synthesizeActions(history, mandateInput, options);
  const anchorMs = Date.parse(history.anchor);
  const first = actions.length ? Date.parse(actions[0]!.at) : anchorMs;

  const keys = generateKeyPairSync("ed25519");
  const { token, mandate } = await issueMandate(keys.privateKey, mandateInput, {
    issuer: "payleash-backtest",
    ttlSeconds: Math.ceil((anchorMs - first) / 1000) + 400 * 86_400,
    now: new Date(first - DAY),
  });

  const db = openDb(":memory:");
  try {
    const transport = new ReplayTransport();
    const registries = new RegistryBook();
    let clock = new Date(first);
    const guard = new Guard({
      policy: new SqlitePolicyStore(db),
      audit: new AuditLog(db),
      replay: new SqliteReplayGuard(db),
      reader: new RestPayPalReader(transport),
      registries,
      ownerPublicKey: keys.publicKey,
      stepUpPublicKey: keys.publicKey,
      now: () => clock,
    });
    const orders = new Map(history.orders.map((o) => [o.captureId, o]));
    const disputeResponses: FixtureResponses = Object.fromEntries(Object.entries(history.disputes).map(([id, body]) => [`/v1/customer/disputes/${id}`, body]));

    const results: ActionResult[] = [];
    for (const action of actions) {
      clock = new Date(action.at);
      const order = action.captureId ? orders.get(action.captureId) : undefined;
      transport.responses = { ...disputeResponses, ...(order ? orderFixtures(orderAsOf(order, clock.getTime(), anchorMs, action.hideRefundIds)) : {}) };
      // A fresh agent context per action: what it read before is what this action's `untrusted` says, nothing else.
      const registry = registries.forAgent(mandate.agentId);
      registry.clear();
      for (const u of action.untrusted) registry.register(u.sourceId, u.text, clock);

      const auth = await guard.authorize({ mandateToken: token, tool: action.tool, args: action.args });
      // Dry run: an allowed call is "executed" only in this throwaway in-memory ledger, so the rolling daily budget
      // behaves as it would for a real agent. Nothing is sent anywhere.
      if (auth.reservation) guard.complete(auth, action.tool, action.args, { ok: true, resultId: `dry-run:${action.id}` });
      results.push(toResult(action, auth));
    }
    const report = summarize(results);
    return {
      id: `bt_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      source: history.source,
      anchor: history.anchor,
      days: history.days,
      mandate,
      options,
      dryRun: true,
      results,
      report,
      rows: toRows(results),
    };
  } finally {
    db.close();
  }
}

function toResult(action: BacktestAction, a: Authorization): ActionResult {
  const f = a.facts;
  return {
    action,
    decision: a.decision,
    reasons: groupReasons(a.reasons),
    rawReasons: a.reasons,
    facts: {
      amount: f.amount,
      payeeEmail: f.payeeEmail,
      originalBuyerEmail: f.originalBuyerEmail,
      transactionTime: f.transactionTime?.toISOString(),
    },
    taint: a.parts?.taint ?? { decision: a.decision, reasons: [] },
    policy: a.parts?.policy ?? { decision: a.decision, reasons: [] },
    ...(action.attack ? { caught: a.decision !== "allow" } : {}),
  };
}
