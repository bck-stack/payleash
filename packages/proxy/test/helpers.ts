import { generateKeyPairSync } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEMO_IDS, issueMandate, openDb, type MandateInput } from "@payleash/core";
import { buildProxy, createMcpServer, type ProxyOverrides, type ProxyRuntime } from "../src/index.js";

export const I = DEMO_IDS;
const owner = generateKeyPairSync("ed25519");
const stepup = generateKeyPairSync("ed25519");

export const SUPPORT_MANDATE: MandateInput = {
  agentId: "support-agent",
  allowedTools: ["create_refund", "cancel_subscription", "send_invoice", "accept_dispute_claim", "get_order", "get_dispute"],
  constraints: {
    create_refund: { currency: "USD", maxAmountPerOp: "100.00", dailyTotal: "300.00", autoApproveThreshold: "45.00", payeeMustBeOriginalBuyer: true, orderAgeDays: 60 },
    send_invoice: { currency: "USD", maxAmountPerOp: "500.00", autoApproveThreshold: "100.00" },
    accept_dispute_claim: { currency: "USD", maxAmountPerOp: "100.00", autoApproveThreshold: "10.00" },
  },
};

export const keys = { ownerPublic: owner.publicKey, stepUpPrivate: stepup.privateKey, stepUpPublic: stepup.publicKey };

export function makeRuntime(env: NodeJS.ProcessEnv = {}, overrides: ProxyOverrides = {}): ProxyRuntime {
  return buildProxy(
    { transport: "http", host: "127.0.0.1", port: 0, fixtures: true, allowLive: false },
    { PAYLEASH_OWNER_TOKEN: "owner-token-0123456789abcdef", ...env },
    { db: openDb(":memory:"), keys, log: () => {}, ...overrides },
  );
}

export async function mandateToken(input: MandateInput = SUPPORT_MANDATE, ttlSeconds = 86400): Promise<string> {
  return (await issueMandate(owner.privateKey, input, { issuer: "owner", ttlSeconds })).token;
}

export async function connect(rt: ProxyRuntime, token?: string) {
  const session = await rt.app.openSession(token ?? (await mandateToken()));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ app: rt.app, session, tools: rt.tools }).connect(serverT);
  const client = new Client({ name: "test-agent", version: "1" });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]!.text;
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { isError: !!r.isError, body, structured: r.structuredContent as any, raw: r };
  };
  return { client, call, session };
}
