import { PayPalAPI } from "@paypal/agent-toolkit/mcp";
import type { PayPalHttp } from "@payleash/core";

/** Runs a toolkit tool against PayPal and returns the toolkit's JSON string result. */
export interface ToolExecutor {
  run(method: string, args: Record<string, unknown>): Promise<string>;
}

/**
 * The real thing: the PayPal Agent Toolkit running locally with sandbox credentials.
 * The toolkit takes an access token, so tokens are fetched (and refreshed) through `PayPalHttp`.
 */
export class ToolkitExecutor implements ToolExecutor {
  private cached?: { token: string; api: PayPalAPI };

  constructor(
    private readonly http: PayPalHttp,
    private readonly sandbox: boolean,
  ) {}

  async run(method: string, args: Record<string, unknown>): Promise<string> {
    const token = await this.http.accessToken();
    if (this.cached?.token !== token) {
      this.cached = { token, api: new PayPalAPI(token, { sandbox: this.sandbox, source: "PayLeash" }) };
    }
    const out = (await this.cached.api.run(method, args)) as string | undefined;
    // Some toolkit calls return no body (JSON.stringify(undefined) is undefined): that is a success without data.
    return typeof out === "string" ? out : JSON.stringify({ ok: true });
  }
}

/**
 * Parses a toolkit result and reports whether PayPal accepted the call, plus a result id when there is one.
 * The toolkit reports failures in three shapes, all of which must count as failures:
 *   {"ok":false,"status":422,"code":"PAYPAL_API_HTTP_ERROR","message":"..."}   (LlmError, HTTP errors)
 *   {"error":{"message":"...","type":"paypal_error"}}                           (anything else that threw)
 *   {"name":"...","message":"...","debug_id":"..."}                             (a raw PayPal error body)
 */
export function interpretResult(text: string): { ok: boolean; resultId?: string; error?: string; json?: unknown } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: true };
  }
  if (json && typeof json === "object") {
    const o = json as Record<string, any>;
    if (o.ok === false) return { ok: false, error: String(o.message ?? o.code ?? "PayPal error").slice(0, 300), json };
    if (o.error) return { ok: false, error: (typeof o.error === "string" ? o.error : String(o.error?.message ?? "PayPal error")).slice(0, 300), json };
    if (o.name && o.message && o.debug_id) return { ok: false, error: `${o.name}: ${o.message}`.slice(0, 300), json };
    const id = typeof o.id === "string" ? o.id : typeof o.refund_id === "string" ? o.refund_id : undefined;
    return { ok: true, resultId: id, json };
  }
  return { ok: true, json };
}
