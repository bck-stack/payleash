import { describe, expect, it, vi } from "vitest";
import { PayPalHttp } from "@payleash/core";
import { runNativeTool } from "../src/native-tools.js";
import { I, connect, makeRuntime, mandateToken } from "./helpers.js";

const DISPUTE_AGENT = {
  agentId: "dispute-agent",
  allowedTools: ["get_dispute", "list_disputes", "provide_dispute_evidence"],
  constraints: { provide_dispute_evidence: { currency: "USD", maxAmountPerOp: "500.00" } },
};
const evidences = [{ evidence_type: "PROOF_OF_FULFILMENT", notes: "Delivered 2026-09-30", evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z999" }] } }];

describe("provide_dispute_evidence (PayLeash's own write tool)", () => {
  it("is listed, held for the owner (no auto-approve threshold), and runs only after approval", async () => {
    const rt = makeRuntime();
    const { call, client } = await connect(rt, await mandateToken(DISPUTE_AGENT));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("provide_dispute_evidence");

    const held = await call("provide_dispute_evidence", { dispute_id: I.dispute, evidences });
    expect(held.body.status).toBe("pending_approval");
    expect(held.body.reasons.map((r: { code: string }) => r.code)).toContain("no_auto_approve_threshold");
    expect(rt.fixtureExecutor!.calls.map((c) => c.method)).not.toContain("provide_dispute_evidence"); // nothing reached PayPal

    const owner = rt.app.listOwnerApprovals("pending")[0]!;
    expect(owner.context?.summary).toMatch(/^Send 1 evidence item on dispute PP-D-27803 \(\$42\.00 at stake\)/);
    const done = await rt.app.decide(held.body.approvalId, "approve");
    expect(done.status).toBe("executed");
    expect(rt.fixtureExecutor!.calls.map((c) => c.method)).toContain("provide_dispute_evidence");
    expect((await call("get_dispute", { dispute_id: I.dispute })).body.status).toBe("UNDER_REVIEW");
  });

  it("is denied for an unknown dispute, without the mandate, and while frozen", async () => {
    const rt = makeRuntime();
    const { call } = await connect(rt, await mandateToken(DISPUTE_AGENT));
    expect((await call("provide_dispute_evidence", { dispute_id: "PP-D-0", evidences })).body.status).toBe("denied");
    rt.app.freeze(undefined, "test");
    const frozen = await call("provide_dispute_evidence", { dispute_id: I.dispute, evidences });
    expect(frozen.body.reasons[0].code).toBe("frozen_global");

    const rt2 = makeRuntime();
    const other = await connect(rt2); // the support mandate does not list the tool
    const r = await other.call("provide_dispute_evidence", { dispute_id: I.dispute, evidences });
    expect(r.body.status).toBe("denied");
    expect(r.body.reasons.map((x: { code: string }) => x.code)).toContain("tool_not_allowed");
  });

  it("posts the evidence to PayPal's provide-evidence endpoint, sandbox client only", async () => {
    const request = vi.fn(async () => ({ status: 200, body: { links: [] } }));
    const out = await runNativeTool({ request } as unknown as PayPalHttp, "provide_dispute_evidence", { dispute_id: "PP-D-1234", evidences });
    expect(JSON.parse(out)).toEqual({ links: [] });
    expect(request).toHaveBeenCalledWith("POST", "/v1/customer/disputes/PP-D-1234/provide-evidence", { body: { evidences } });
    await expect(runNativeTool({ request } as unknown as PayPalHttp, "provide_dispute_evidence", { dispute_id: "../../x?y", evidences })).rejects.toThrow(/valid dispute id/);
    const failing = vi.fn(async () => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "no" } }));
    expect(JSON.parse(await runNativeTool({ request: failing } as unknown as PayPalHttp, "provide_dispute_evidence", { dispute_id: "PP-D-1234", evidences }))).toMatchObject({ ok: false, status: 422 });
  });
});
