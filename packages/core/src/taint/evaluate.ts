import { MoneyError, formatMinor, parseDecimal, type Money } from "../money.js";
import type { Decision, OperationFacts, Reason, ToolCall } from "../policy/types.js";
import type { CaptureTruth, DisputeTruth, InvoiceTruth, KnownFigure, OrderTruth, PayPalReader, SubscriptionTruth } from "../paypal/types.js";
import type { ProvenanceRegistry } from "./registry.js";
import { ArgumentError, type ArgRole, type CriticalArg, type ToolDescriptor } from "./tools.js";

export type ArgStatus = "verified" | "tainted" | "unknown";

export interface ArgAssessment {
  path: string;
  role: ArgRole;
  value: string;
  status: ArgStatus;
  detail: string;
  /** Source ids of the untrusted spans that contain this value. */
  sources: string[];
}

export type TaintTruth =
  | { kind: "capture"; capture: CaptureTruth }
  | { kind: "order"; order: OrderTruth }
  | { kind: "dispute"; dispute: DisputeTruth }
  | { kind: "invoice"; invoice: InvoiceTruth }
  | { kind: "subscription"; subscription: SubscriptionTruth };

export interface TaintResult {
  decision: Decision;
  reasons: Reason[];
  args: ArgAssessment[];
  /** Facts derived from PayPal ground truth for the policy evaluator. */
  facts: OperationFacts;
  truth: TaintTruth | null;
}

export interface TaintInput {
  call: ToolCall;
  descriptor: ToolDescriptor;
  reader: PayPalReader;
  registry: ProvenanceRegistry;
}

const ID_ROLE = { capture: "capture_id", order: "order_id", dispute: "dispute_id", invoice: "invoice_id", subscription: "subscription_id" } as const;
const lc = (s: string) => s.trim().toLowerCase();
/** Values from untrusted text end up in messages shown to the owner: keep them short and printable. */
const show = (v: string) => JSON.stringify(v.replace(/[^\x20-\x7e]/g, "?").slice(0, 60));

/**
 * The provenance firewall. Resolves every critical argument against PayPal ground truth and marks it
 * `verified` (matches PayPal), `tainted` (not backed by PayPal and present in untrusted content) or `unknown`.
 * No LLM, no clock, no randomness: the decision is a pure function of the call, PayPal's records and the registry.
 *
 * Rules: unknown id -> deny; payee != original buyer -> deny; refund > captured - refunded -> deny;
 * any tainted argument -> hold.
 */
export async function evaluateTaint({ call, descriptor, reader, registry }: TaintInput): Promise<TaintResult> {
  const denies: Reason[] = [];
  const holds: Reason[] = [];
  const args: ArgAssessment[] = [];
  const facts: OperationFacts = {};
  let truth: TaintTruth | null = null;
  const deny = (code: string, message: string) => denies.push({ code, message });
  const hold = (code: string, message: string) => holds.push({ code, message });
  const done = (): TaintResult => {
    // Every tainted argument is its own hold reason, with the explanation of where it came from.
    for (const a of args) {
      if (a.status === "tainted") {
        hold("tainted_argument", `${a.path} = ${show(a.value)} appears only in untrusted content (${a.sources.join(", ")}) and PayPal's records do not confirm it.`);
      }
    }
    const decision: Decision = denies.length ? "deny" : holds.length ? "hold" : "allow";
    return { decision, reasons: [...denies, ...holds], args, facts, truth };
  };

  const sourcesOf = (c: CriticalArg, money?: Money): string[] => {
    switch (c.role) {
      case "payee_email":
      case "recipient_email":
        return registry.sourcesWithEmail(c.value);
      case "amount":
        return money ? registry.sourcesWithAmount(money.minor, money.currency) : [];
      case "currency":
        return [];
      default:
        return registry.sourcesWithToken(c.value);
    }
  };
  /** verified if PayPal confirms it; otherwise tainted when untrusted content contains it, else unknown. */
  const assess = (c: CriticalArg, confirmed: string | null, money?: Money): ArgAssessment => {
    const sources = sourcesOf(c, money);
    const a: ArgAssessment = confirmed
      ? { ...c, status: "verified", detail: confirmed, sources }
      : sources.length
        ? { ...c, status: "tainted", detail: "not in PayPal records; present in untrusted content", sources }
        : { ...c, status: "unknown", detail: "not in PayPal records", sources };
    args.push(a);
    return a;
  };

  // ---- extract critical arguments ----------------------------------------
  let critical: CriticalArg[];
  try {
    critical = descriptor.critical(call.args);
  } catch (e) {
    if (e instanceof ArgumentError) {
      deny("invalid_arguments", e.message);
      return done();
    }
    throw e;
  }
  const byRole = (role: ArgRole) => critical.filter((c) => c.role === role);

  // ---- amount (+ currency) -------------------------------------------------
  let argAmount: { arg: CriticalArg; money: Money } | undefined;
  const amountArg = byRole("amount")[0];
  if (amountArg) {
    const currency = byRole("currency")[0]?.value.toUpperCase();
    if (!currency) {
      deny("invalid_arguments", "An amount was given without a currency.");
      return done();
    }
    try {
      const minor = parseDecimal(amountArg.value, currency);
      if (minor <= 0) throw new MoneyError("amount must be greater than zero");
      argAmount = { arg: amountArg, money: { currency, minor } };
    } catch (e) {
      deny("invalid_amount", `${amountArg.path} = ${show(amountArg.value)} is not a valid positive amount in ${currency}${e instanceof MoneyError ? ` (${e.message})` : ""}.`);
      return done();
    }
  }
  const emails = (role: "payee_email" | "recipient_email") => byRole(role);

  /** Compare an amount argument with what PayPal shows; returns the assessment. */
  const checkAmountAgainst = (figures: KnownFigure[], truthCurrency: string | undefined): ArgAssessment | undefined => {
    if (!argAmount) return undefined;
    const { arg, money } = argAmount;
    if (truthCurrency && money.currency !== truthCurrency) {
      deny("currency_mismatch_truth", `The operation is in ${money.currency} but PayPal shows ${truthCurrency}.`);
    }
    const hit = truthCurrency && money.currency === truthCurrency ? figures.find((f) => f.money.currency === money.currency && f.money.minor === money.minor) : undefined;
    return assess(arg, hit ? `matches PayPal's ${hit.label}` : null, money);
  };

  // ---- kinds with a PayPal object behind them ----------------------------
  if (descriptor.kind !== "none") {
    const idArg = byRole(ID_ROLE[descriptor.kind])[0];
    if (!idArg) {
      deny("missing_argument", `${ID_ROLE[descriptor.kind]} is required.`);
      return done();
    }
    try {
      switch (descriptor.kind) {
        case "capture": {
          const cap = await reader.getCapture(idArg.value);
          truth = cap ? { kind: "capture", capture: cap } : null;
          break;
        }
        case "order": {
          const order = await reader.getOrder(idArg.value);
          truth = order ? { kind: "order", order } : null;
          break;
        }
        case "dispute": {
          const dispute = await reader.getDispute(idArg.value);
          truth = dispute ? { kind: "dispute", dispute } : null;
          break;
        }
        case "invoice": {
          const invoice = await reader.getInvoice(idArg.value);
          truth = invoice ? { kind: "invoice", invoice } : null;
          break;
        }
        case "subscription": {
          const subscription = await reader.getSubscription(idArg.value);
          truth = subscription ? { kind: "subscription", subscription } : null;
          break;
        }
      }
    } catch (e) {
      // Fail closed: if PayPal cannot be consulted, nothing is verified.
      deny("ground_truth_unavailable", `Could not check ${ID_ROLE[descriptor.kind]} ${show(idArg.value)} against PayPal: ${e instanceof Error ? e.message : String(e)}`);
      return done();
    }
    if (!truth) {
      assess(idArg, null);
      deny("unknown_id", `${ID_ROLE[descriptor.kind]} ${show(idArg.value)} does not exist in PayPal.`);
      return done();
    }
    assess(idArg, "exists in PayPal");

    switch (truth.kind) {
      case "capture": {
        const cap = truth.capture;
        facts.transactionTime = cap.createdAt;
        facts.originalBuyerEmail = cap.buyerEmail;
        if (!["COMPLETED", "PARTIALLY_REFUNDED"].includes(cap.status)) {
          deny("capture_not_refundable", `Capture ${cap.id} has status ${cap.status}, which cannot be refunded.`);
        }
        const fmt = (minor: number) => `${formatMinor(minor, cap.amount.currency)} ${cap.amount.currency}`;
        if (argAmount) {
          checkAmountAgainst(cap.figures, cap.amount.currency);
          facts.amount = argAmount.money;
          if (argAmount.money.currency === cap.amount.currency) {
            const limit = cap.remainingMinor ?? cap.amount.minor;
            if (argAmount.money.minor > limit) {
              deny(
                "refund_exceeds_balance",
                cap.remainingMinor !== undefined
                  ? `Refund of ${fmt(argAmount.money.minor)} exceeds what is left to refund: ${fmt(cap.amount.minor)} captured minus ${fmt(cap.refundedMinor ?? 0)} already refunded = ${fmt(cap.remainingMinor)}.`
                  : `Refund of ${fmt(argAmount.money.minor)} exceeds the captured amount of ${fmt(cap.amount.minor)}.`,
              );
            } else if (cap.remainingMinor === undefined) {
              hold("refund_balance_unverifiable", "PayPal does not show how much of this capture was already refunded.");
            }
          }
        } else {
          // Full refund of whatever is left.
          const left = cap.remainingMinor ?? cap.amount.minor;
          facts.amount = { currency: cap.amount.currency, minor: left };
          if (cap.remainingMinor === 0) deny("refund_exceeds_balance", "Nothing is left to refund on this capture.");
          else if (cap.remainingMinor === undefined) hold("refund_balance_unverifiable", "PayPal does not show how much of this capture was already refunded.");
        }
        for (const payee of emails("payee_email")) {
          facts.payeeEmail = payee.value;
          if (cap.buyerEmail === undefined) {
            assess(payee, null);
            hold("payee_unverifiable", `PayPal does not show the buyer of capture ${cap.id}, so payee ${show(payee.value)} cannot be verified.`);
          } else if (lc(payee.value) === cap.buyerEmail) {
            assess(payee, "is the original buyer");
          } else {
            assess(payee, null);
            deny("payee_not_original_buyer", `Payee ${show(payee.value)} is not the original buyer of capture ${cap.id} (${cap.buyerEmail}).`);
          }
        }
        break;
      }
      case "order": {
        const o = truth.order;
        facts.amount = o.amount;
        facts.originalBuyerEmail = o.buyerEmail;
        facts.transactionTime = o.createdAt;
        if (o.status === "COMPLETED" || o.status === "VOIDED") deny("order_not_capturable", `Order ${o.id} has status ${o.status}.`);
        break;
      }
      case "dispute": {
        const dp = truth.dispute;
        facts.amount = dp.amount;
        facts.originalBuyerEmail = dp.buyerEmail;
        facts.transactionTime = dp.createdAt;
        if (dp.status === "RESOLVED") deny("dispute_not_open", `Dispute ${dp.id} is already resolved.`);
        break;
      }
      case "invoice": {
        const inv = truth.invoice;
        facts.transactionTime = inv.createdAt;
        facts.amount = inv.amount;
        if (argAmount) {
          checkAmountAgainst(inv.figures, inv.amount?.currency);
          facts.amount = argAmount.money;
          if (inv.amount && argAmount.money.currency === inv.amount.currency) {
            if (argAmount.money.minor > inv.amount.minor) {
              deny("amount_exceeds_invoice", `${formatMinor(argAmount.money.minor, argAmount.money.currency)} exceeds the invoice total of ${formatMinor(inv.amount.minor, inv.amount.currency)}.`);
            }
            if (call.tool === "record_refund_for_invoice" && inv.paidMinor !== undefined && argAmount.money.minor > inv.paidMinor) {
              deny("refund_exceeds_paid", `Only ${formatMinor(inv.paidMinor, inv.amount.currency)} was paid on this invoice.`);
            }
          }
        }
        for (const r of emails("recipient_email")) {
          if (inv.recipients.includes(lc(r.value))) assess(r, "is a recipient of this invoice");
          else {
            assess(r, null);
            hold("recipient_not_on_invoice", `${show(r.value)} is not a recipient of invoice ${inv.id}; sending would disclose it to a third party.`);
          }
        }
        break;
      }
      case "subscription": {
        facts.transactionTime = truth.subscription.createdAt;
        facts.originalBuyerEmail = truth.subscription.subscriberEmail;
        break;
      }
    }
    return done();
  }

  // ---- kind "none": nothing to resolve against, only provenance ------------
  if (argAmount) {
    assess(argAmount.arg, null, argAmount.money);
    facts.amount = argAmount.money;
  }
  for (const r of emails("recipient_email")) assess(r, null);
  return done();
}
