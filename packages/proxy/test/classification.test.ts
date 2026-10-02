import { TOOL_DESCRIPTORS } from "@payleash/core";
import { describe, expect, it } from "vitest";
import { NATIVE_CLASSIFICATION } from "../src/native-tools.js";
import { TOOL_CLASSIFICATION, allToolkitToolNames, loadToolkitTools } from "../src/index.js";

describe("toolkit tool classification", () => {
  const toolkitTools = allToolkitToolNames();

  it("sees the installed PayPal Agent Toolkit tools", () => {
    expect(toolkitTools.length).toBeGreaterThanOrEqual(45);
    expect(toolkitTools).toContain("create_refund");
  });

  it("FAILS if the toolkit gains a tool that is not classified", () => {
    const unclassified = toolkitTools.filter((t) => !Object.hasOwn(TOOL_CLASSIFICATION, t));
    expect(unclassified, `classify these in packages/proxy/src/classification.ts: ${unclassified.join(", ")}`).toEqual([]);
    expect(loadToolkitTools().unclassified).toEqual([]);
  });

  it("has no stale entries for tools the toolkit no longer has", () => {
    const stale = Object.keys(TOOL_CLASSIFICATION).filter((t) => !toolkitTools.includes(t));
    expect(stale).toEqual([]);
  });

  it("every write tool has critical-argument rules in core, and nothing else does", () => {
    const writes = Object.entries({ ...TOOL_CLASSIFICATION, ...NATIVE_CLASSIFICATION }).filter(([, a]) => a === "write").map(([t]) => t).sort();
    expect(Object.keys(TOOL_DESCRIPTORS).sort()).toEqual(writes);
  });

  it("classifies the money-moving tools as write", () => {
    for (const t of ["create_refund", "pay_order", "send_invoice", "accept_dispute_claim", "cancel_subscription", "record_refund_for_invoice", "update_subscription", "create_subscription"]) {
      expect(TOOL_CLASSIFICATION[t], t).toBe("write");
    }
    for (const t of ["get_order", "get_dispute", "list_transactions", "get_invoice", "show_subscription_details", "get_refund"]) {
      expect(TOOL_CLASSIFICATION[t], t).toBe("read");
    }
  });

  it("exposes exactly the classified tools", () => {
    expect(loadToolkitTools().tools.map((t) => t.method).sort()).toEqual(Object.keys(TOOL_CLASSIFICATION).sort());
  });
});
