import { z } from "zod";
import type { PayPalHttp } from "@payleash/core";
import type { ToolkitTool } from "./toolkit.js";

/**
 * Tools that PayLeash adds because the PayPal Agent Toolkit has no equivalent. They are classified here, not in
 * `classification.ts` (which mirrors the toolkit one to one), and go through exactly the same pipeline as a toolkit write tool.
 */
export const NATIVE_CLASSIFICATION = { provide_dispute_evidence: "write" } as const;

const evidence = z.object({
  evidence_type: z
    .enum(["PROOF_OF_FULFILMENT", "PROOF_OF_DELIVERY_SIGNATURE", "PROOF_OF_REFUND", "PROOF_OF_AUTHORISATION", "PROOF_OF_TRANSACTION_RECEIPT", "OTHER"])
    .describe("PROOF_OF_FULFILMENT for shipment / delivery evidence, PROOF_OF_REFUND if the buyer was refunded, OTHER for order details."),
  notes: z.string().max(2000).optional().describe("Plain-language explanation for the PayPal reviewer."),
  evidence_info: z
    .object({
      tracking_info: z
        .array(z.object({ carrier_name: z.string().min(1).max(100), tracking_number: z.string().min(1).max(64) }))
        .max(10)
        .optional(),
    })
    .optional(),
});

export const NATIVE_TOOLS: ToolkitTool[] = [
  {
    method: "provide_dispute_evidence",
    title: "Provide dispute evidence",
    description:
      "Respond to an open PayPal dispute with evidence (delivery tracking, order facts, a refund). Added by PayLeash: the PayPal Agent Toolkit has no tool for this. " +
      "Submitting evidence is final for that dispute round, so the owner approves it first.",
    parameters: z.object({
      dispute_id: z.string().min(1).describe("The dispute to answer, for example PP-D-27803."),
      evidences: z.array(evidence).min(1).max(10).describe("The evidence items. Only state facts that PayPal's own order and shipment records show."),
    }) as unknown as ToolkitTool["parameters"],
    access: "write",
  },
];

/** `POST /v1/customer/disputes/{id}/provide-evidence` (Disputes API v1), through the sandbox-only HTTP client. */
export async function runNativeTool(http: PayPalHttp, method: string, args: Record<string, unknown>): Promise<string> {
  if (method !== "provide_dispute_evidence") throw new Error(`unknown PayLeash tool "${method}"`);
  const id = String(args.dispute_id ?? "");
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(id)) throw new Error("dispute_id is not a valid dispute id");
  const res = await http.request("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, { body: { evidences: args.evidences } });
  if (res.status >= 200 && res.status < 300) return JSON.stringify(res.body ?? { ok: true });
  const b = (res.body ?? {}) as Record<string, unknown>;
  return JSON.stringify({ ok: false, status: res.status, code: "PAYPAL_API_HTTP_ERROR", message: String(b.message ?? b.name ?? `PayPal answered ${res.status}`).slice(0, 300) });
}
