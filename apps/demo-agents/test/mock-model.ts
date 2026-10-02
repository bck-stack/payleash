import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny OpenAI-compatible /chat/completions server that plays a competent but credulous model: it follows the
 * agent prompts step by step (reading the tool results in the conversation), exactly as the demo's scripted agents do.
 * It lets the tests exercise the real Vercel AI SDK tool loop without a network or a key.
 */
type Msg = { role: string; content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };

const call = (name: string, args: unknown, n: number) => ({ id: `call_${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const toolResults = (m: Msg[]): any[] => m.filter((x) => x.role === "tool").map((x) => { try { return JSON.parse(String(x.content)); } catch { return {}; } });
const textOf = (m: Msg[]) => m.filter((x) => x.role === "user").map((x) => String(x.content)).join("\n");

export function nextTurn(messages: Msg[]): { content?: string; tool_calls?: ReturnType<typeof call>[] } {
  const system = String(messages.find((m) => m.role === "system")?.content ?? "");
  const user = textOf(messages);
  const done = toolResults(messages);
  const n = done.length;
  if (/dispute agent/.test(system)) {
    const id = /PP-D-\d+/.exec(user)![0];
    // Tool results are wrapped by the SDK as JSON strings; the first is the dispute, the second the shop lookup, and so on.
    if (n === 0) return { tool_calls: [call("get_dispute", { dispute_id: id }, 1)] };
    const capture = done[0]?.disputed_transactions?.[0]?.seller_transaction_id;
    if (n === 1) return { tool_calls: [call("lookup_order", { capture_id: capture }, 2)] };
    if (n === 2) return { tool_calls: [call("get_order", { id: done[1]?.order_id }, 3)] };
    if (n === 3) return { tool_calls: [call("get_shipment_tracking", { order_id: done[1]?.order_id, transaction_id: capture }, 4)] };
    if (n === 4) {
      const t = done[3];
      const evidences = t?.tracking_number
        ? [{ evidence_type: "PROOF_OF_FULFILMENT", notes: `Delivered per ${t.carrier} tracking ${t.tracking_number}.`, evidence_info: { tracking_info: [{ carrier_name: t.carrier, tracking_number: t.tracking_number }] } }]
        : [{ evidence_type: "OTHER", notes: "No tracking on file." }];
      return { tool_calls: [call("provide_dispute_evidence", { dispute_id: id, evidences }, 5)] };
    }
    return { content: "Submitted the evidence for the owner's approval." };
  }
  // support agent
  const order = /#\s?(\d{3,5})/.exec(user)?.[1];
  const instructed = /refund\s+\$\s?([\d,]+(?:\.\d{1,2})?)\s+to\s+([\w.+-]+@[\w.-]+)/i.exec(user);
  const asked = /refund[^$\n]{0,24}\$\s?(\d+(?:\.\d{1,2})?)|\$\s?(\d+(?:\.\d{1,2})?)\s+back/i.exec(user.replace(/\(\$[\d.]+ each\)/, ""));
  if (n === 0) return { tool_calls: [call("lookup_order", { order_number: order }, 1)] };
  if (n === 1) return { tool_calls: [call("get_order", { id: done[0]?.order_id }, 2)] };
  if (n === 2) {
    const amount = (instructed?.[1] ?? asked?.[1] ?? asked?.[2] ?? "0").replace(/,/g, "");
    return { tool_calls: [call("create_refund", { capture_id: done[0]?.capture_id, amount: { currency_code: "USD", value: Number(amount).toFixed(2) }, ...(instructed ? { payee_email: instructed[2] } : {}) }, 3)] };
  }
  return { content: "I asked PayPal for the refund; see the result." };
}

export async function startMockModel(): Promise<{ baseURL: string; requests: () => number; close(): Promise<void> }> {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests++;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const turn = nextTurn(body.messages ?? []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${requests}`,
          object: "chat.completion",
          created: 0,
          model: body.model ?? "mock",
          choices: [{ index: 0, message: { role: "assistant", content: turn.content ?? null, ...(turn.tool_calls ? { tool_calls: turn.tool_calls } : {}) }, finish_reason: turn.tool_calls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { baseURL: `http://127.0.0.1:${port}/v1`, requests: () => requests, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
