import { PayPalAPI, PayPalMCPToolkit } from "@paypal/agent-toolkit/mcp";
import { ALL_TOOLS_ENABLED } from "@paypal/agent-toolkit/ai-sdk";
import type { z } from "zod";
import { accessOf, type ToolAccess } from "./classification.js";

export interface ToolkitTool {
  method: string;
  title: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
  access: ToolAccess;
}

export interface ToolSet {
  tools: ToolkitTool[];
  /** Toolkit tools missing from the classification table. They are not exposed. */
  unclassified: string[];
}

/** Every tool of the installed toolkit, split into classified ones (exposed) and unclassified ones (withheld). */
export function loadToolkitTools(): ToolSet {
  const toolkit = new PayPalMCPToolkit({
    accessToken: "unused-only-metadata-is-read",
    configuration: { actions: ALL_TOOLS_ENABLED as never, context: { sandbox: true } },
  });
  const tools: ToolkitTool[] = [];
  const unclassified: string[] = [];
  for (const t of toolkit.getTools()) {
    const access = accessOf(t.method);
    if (!access) {
      unclassified.push(t.method);
      continue;
    }
    tools.push({ method: t.method, title: t.name, description: t.description, parameters: t.parameters as z.ZodObject<z.ZodRawShape>, access });
  }
  return { tools, unclassified };
}

/** Names of all toolkit tools, for the classification test. */
export function allToolkitToolNames(): string[] {
  return [...new Set(loadToolkitTools().tools.map((t) => t.method).concat(loadToolkitTools().unclassified))];
}

export { PayPalAPI };
