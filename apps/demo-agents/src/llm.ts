import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, stepCountIs, tool, type LanguageModel } from "ai";
import type { ProxyClient } from "./mcp.js";

export interface ModelConfig {
  provider: "cloudflare" | "custom";
  baseURL: string;
  apiKey: string;
  model: string;
}

/** Cloudflare Workers AI's free tier (CF_ACCOUNT_ID / CF_API_TOKEN) or any OpenAI-compatible endpoint (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL). Null: use the scripted agents. */
export function modelConfigFromEnv(env: NodeJS.ProcessEnv): ModelConfig | null {
  if (env.LLM_BASE_URL?.trim() && env.LLM_API_KEY?.trim()) {
    return { provider: "custom", baseURL: env.LLM_BASE_URL.trim(), apiKey: env.LLM_API_KEY.trim(), model: env.LLM_MODEL?.trim() || "gpt-4o-mini" };
  }
  if (env.CF_ACCOUNT_ID?.trim() && env.CF_API_TOKEN?.trim()) {
    return {
      provider: "cloudflare",
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID.trim())}/ai/v1`,
      apiKey: env.CF_API_TOKEN.trim(),
      // Needs function calling. Llama 3.3 70B fast is on the free tier (10,000 neurons a day).
      model: env.CF_AGENT_MODEL?.trim() || "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    };
  }
  return null;
}

export const describeModel = (c: ModelConfig) => `${c.model} via ${c.provider === "cloudflare" ? "Cloudflare Workers AI" : new URL(c.baseURL).host}`;

export function languageModel(c: ModelConfig, fetchImpl?: typeof fetch): LanguageModel {
  return createOpenAICompatible({ name: c.provider, baseURL: c.baseURL, apiKey: c.apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) })(c.model);
}

/** A tool the model may call. `run` is ours: it talks to the PayLeash proxy (or does a local lookup) and returns JSON for the model. */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

/** Proxy tools, by name, as model tools. Every call goes through the PayLeash proxy; the model never sees PayPal. */
export function proxyTool(proxy: ProxyClient, name: string, onCall?: (name: string, args: Record<string, unknown>, result: unknown) => void): AgentTool {
  const def = proxy.toolDefs.find((t) => t.name === name);
  if (!def) throw new Error(`the proxy does not offer "${name}"`);
  return {
    name,
    description: (def.description ?? name).slice(0, 600),
    parameters: def.inputSchema as Record<string, unknown>,
    async run(args) {
      const r = await proxy.call(name, args);
      onCall?.(name, args, r);
      return r.body;
    },
  };
}

export interface LoopResult {
  text: string;
  steps: number;
}

/** The agent loop of the Vercel AI SDK (generateText with tools), capped at `maxSteps` model calls. */
export async function runToolLoop(o: { model: LanguageModel; system: string; prompt: string; tools: AgentTool[]; maxSteps?: number }): Promise<LoopResult> {
  const tools = Object.fromEntries(
    o.tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(t.parameters as never),
        execute: async (args: unknown) => {
          try {
            return await t.run((args ?? {}) as Record<string, unknown>);
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        },
      }),
    ]),
  );
  const r = await generateText({ model: o.model, system: o.system, prompt: o.prompt, tools, stopWhen: stepCountIs(o.maxSteps ?? 8) });
  return { text: r.text.trim(), steps: r.steps.length };
}
