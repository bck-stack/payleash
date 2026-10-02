import { describe, expect, it } from "vitest";
import { diffLines, fieldChanges, prettyMandate } from "./diff";
import { money, timeAgo, timeLeft } from "./format";

const current = { agentId: "support-agent", allowedTools: ["create_refund", "get_order"], constraints: { create_refund: { currency: "USD", maxAmountPerOp: "100.00", autoApproveThreshold: "45.00", payeeMustBeOriginalBuyer: true } } };
const proposed = { agentId: "support-agent", allowedTools: ["create_refund"], constraints: { create_refund: { currency: "USD", maxAmountPerOp: "100.00", autoApproveThreshold: "25.00", orderAgeDays: 60 } } };

describe("mandate diff", () => {
  it("prints mandates with sorted keys so the same mandate always reads the same", () => {
    expect(prettyMandate({ b: 1, a: { d: 1, c: 2 } })).toBe('{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}');
  });

  it("aligns unchanged lines, pairs a changed value, and marks added and removed lines", () => {
    const rows = diffLines(prettyMandate(current), prettyMandate(proposed));
    const kinds = (k: string) => rows.filter((r) => r.kind === k);
    expect(kinds("changed").map((r) => [r.left?.trim(), r.right?.trim()])).toContainEqual(['"autoApproveThreshold": "45.00",', '"autoApproveThreshold": "25.00",']);
    expect(kinds("removed").some((r) => r.left?.includes("get_order"))).toBe(true);
    // the dropped payee rule and the new age window sit side by side, so they are shown as one changed row
    expect(rows.some((r) => r.left?.includes("payeeMustBeOriginalBuyer") && r.kind !== "same")).toBe(true);
    expect(rows.some((r) => r.right?.includes("orderAgeDays") && r.kind !== "same")).toBe(true);
    expect(kinds("added").length + kinds("removed").length).toBeGreaterThan(0);
    // every row is either on both sides (same/changed) or on one side only
    for (const r of rows) expect(r.left === null && r.right === null).toBe(false);
    expect(rows.filter((r) => r.kind === "same").every((r) => r.left === r.right)).toBe(true);
  });

  it("shows everything as added when there is no current mandate, and nothing when they are equal", () => {
    expect(diffLines("", prettyMandate(proposed)).every((r) => r.kind === "added" && r.left === null)).toBe(true);
    expect(diffLines(prettyMandate(proposed), prettyMandate(proposed)).every((r) => r.kind === "same")).toBe(true);
  });

  it("describes the same change in words", () => {
    const c = fieldChanges(current, proposed);
    expect(c).toContainEqual({ scope: "Tools", field: "get_order", before: "allowed", after: "not allowed" });
    expect(c).toContainEqual({ scope: "create_refund", field: "Runs alone up to", before: "45.00", after: "25.00" });
    expect(c).toContainEqual({ scope: "create_refund", field: "Order age (days)", before: "not set", after: "60" });
    expect(c).toContainEqual({ scope: "create_refund", field: "Payee must be the original buyer", before: "yes", after: "not set" });
    expect(fieldChanges(proposed, proposed)).toEqual([]);
    expect(fieldChanges(null, proposed).find((x) => x.field === "create_refund")?.before).toBe("no mandate yet");
  });
});

describe("formatting", () => {
  it("formats money and relative times", () => {
    expect(money("60", "USD")).toBe("$60.00");
    expect(money(1234.5, "EUR")).toMatch(/^€1.?234[.,]50$/);
    expect(money("5", "CHF")).toMatch(/^5[.,]00 CHF$/);
    const now = Date.parse("2026-10-02T12:00:00Z");
    expect(timeAgo("2026-10-02T11:59:58Z", now)).toBe("just now");
    expect(timeAgo("2026-10-02T11:30:00Z", now)).toBe("30 min ago");
    expect(timeAgo("2026-09-30T12:00:00Z", now)).toBe("2 days ago");
    expect(timeLeft("2026-10-02T12:30:00Z", now)).toBe("30 min left");
    expect(timeLeft("2026-10-02T11:00:00Z", now)).toBe("expired");
  });
});
