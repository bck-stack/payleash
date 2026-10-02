import { z } from "zod";
import { MoneyError, parseDecimal } from "../money.js";

const amount = z.string().regex(/^\d+(\.\d+)?$/, 'amount must be a decimal string such as "50.00"');
const currency = z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code such as USD");

/**
 * Constraints for one tool. Amount limits are decimal strings in `currency`.
 * All members are optional; a missing limit is not enforced (but see policy for the
 * auto-approve default: no `autoApproveThreshold` means money-moving calls need a human).
 */
export const ToolConstraintsSchema = z
  .object({
    /** Max amount for a single operation. Above it the call is denied. */
    maxAmountPerOp: amount.optional(),
    /** Rolling 24h total across executed operations of this tool by this agent. */
    dailyTotal: amount.optional(),
    currency: currency.optional(),
    /** The refund/payment destination must equal the original buyer of the order. */
    payeeMustBeOriginalBuyer: z.boolean().optional(),
    /** Order/capture must be at most this many days old. */
    orderAgeDays: z.number().int().positive().optional(),
    /** At or below this amount the call runs without a human. Above it the call is held. */
    autoApproveThreshold: amount.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const hasAmount = c.maxAmountPerOp !== undefined || c.dailyTotal !== undefined || c.autoApproveThreshold !== undefined;
    if (hasAmount && !c.currency) {
      ctx.addIssue({ code: "custom", message: "amount constraints require `currency`", path: ["currency"] });
      return;
    }
    const cur = c.currency ?? "USD";
    const minor: Record<string, number> = {};
    for (const key of ["maxAmountPerOp", "dailyTotal", "autoApproveThreshold"] as const) {
      const v = c[key];
      if (v === undefined) continue;
      try {
        minor[key] = parseDecimal(v, cur);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: e instanceof MoneyError ? e.message : String(e), path: [key] });
      }
    }
    const { maxAmountPerOp: max, autoApproveThreshold: thr, dailyTotal: day } = minor;
    if (max !== undefined && thr !== undefined && thr > max) {
      ctx.addIssue({ code: "custom", message: "autoApproveThreshold must be <= maxAmountPerOp", path: ["autoApproveThreshold"] });
    }
    if (max !== undefined && day !== undefined && max > day) {
      ctx.addIssue({ code: "custom", message: "maxAmountPerOp must be <= dailyTotal", path: ["maxAmountPerOp"] });
    }
  });
export type ToolConstraints = z.infer<typeof ToolConstraintsSchema>;

/** What the owner writes (JSON file for `payleash mandate issue`). */
export const MandateInputSchema = z.object({
  agentId: z.string().min(1).max(128),
  allowedTools: z.array(z.string().min(1)).min(1),
  constraints: z.record(ToolConstraintsSchema).default({}),
});
export type MandateInput = z.input<typeof MandateInputSchema>;

/** A verified operation mandate (the claims of the signed JWS). */
export const MandateSchema = MandateInputSchema.extend({
  id: z.string().min(1),
  issuer: z.string().min(1),
  /** Unix seconds. */
  notBefore: z.number().int(),
  expiresAt: z.number().int(),
}).superRefine((m, ctx) => {
  for (const tool of Object.keys(m.constraints)) {
    if (!m.allowedTools.includes(tool)) {
      ctx.addIssue({ code: "custom", message: `constraints for "${tool}" but it is not in allowedTools`, path: ["constraints", tool] });
    }
  }
  if (m.expiresAt <= m.notBefore) ctx.addIssue({ code: "custom", message: "expiresAt must be after notBefore", path: ["expiresAt"] });
});
export type Mandate = z.infer<typeof MandateSchema>;
