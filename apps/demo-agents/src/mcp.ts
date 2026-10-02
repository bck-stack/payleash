import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface ToolResult {
  isError: boolean;
  /** Parsed JSON when the tool returned JSON, else the text. */
  body: any;
  text: string;
}

/** An agent's only connection to PayPal: the PayLeash MCP proxy, with the agent's mandate as its credential. */
export class ProxyClient {
  private constructor(
    readonly agentId: string,
    private readonly client: Client,
    readonly toolNames: string[],
    readonly toolDefs: { name: string; description?: string; inputSchema: unknown }[],
  ) {}

  static async connect(url: string, mandate: string, agentId: string): Promise<ProxyClient> {
    const client = new Client({ name: `payleash-demo-${agentId}`, version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url.replace(/\/+$/, "")}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mandate}` } } }));
    const { tools } = await client.listTools();
    return new ProxyClient(agentId, client, tools.map((t) => t.name), tools);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const r = await this.client.callTool({ name, arguments: args });
    const text = (r.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { isError: !!r.isError, body, text };
  }

  close(): Promise<void> {
    return this.client.close().catch(() => {});
  }
}

/** What happened to a write call, in one of four words. */
export type Outcome = { kind: "executed"; id?: string; status?: string } | { kind: "held"; approvalId: string; explanation: string } | { kind: "denied"; codes: string[]; explanation: string } | { kind: "error"; message: string };

export function outcomeOf(r: ToolResult): Outcome {
  const b = r.body;
  if (b && typeof b === "object") {
    if (b.status === "pending_approval") return { kind: "held", approvalId: String(b.approvalId), explanation: String(b.explanation ?? "") };
    if (b.status === "denied") return { kind: "denied", codes: [...new Set<string>((b.reasons ?? []).map((x: { code: string }) => x.code))], explanation: String(b.explanation ?? "") };
    if (!r.isError) return { kind: "executed", id: typeof b.id === "string" ? b.id : undefined, status: typeof b.status === "string" ? b.status : undefined };
    return { kind: "error", message: String(b.message ?? b.error?.message ?? b.error ?? r.text).slice(0, 200) };
  }
  return r.isError ? { kind: "error", message: String(r.text).slice(0, 200) } : { kind: "executed" };
}
