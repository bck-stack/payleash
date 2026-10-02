import { randomUUID } from "node:crypto";
import { exponent } from "../money.js";
import { containsEmail, containsToken, extractAmountsMinor, normalizeText } from "./match.js";

/** A piece of untrusted content (customer email, ticket, web text) with the id of where it came from. */
export interface Span {
  id: string;
  sourceId: string;
  text: string;
  registeredAt: Date;
}

export interface RegistryLimits {
  maxSpans: number;
  maxTextLength: number;
}

interface Indexed extends Span {
  normalized: string;
  amounts: Set<number>; // minor units at exponent 2
}

/**
 * Provenance registry: everything an agent read from an untrusted channel gets registered here.
 * A critical argument whose value shows up in a span but is not backed by PayPal ground truth is "tainted".
 * Spans are kept in memory per agent session; the oldest are evicted past `maxSpans`.
 */
export class ProvenanceRegistry {
  private readonly items: Indexed[] = [];
  private readonly limits: RegistryLimits;

  constructor(limits: Partial<RegistryLimits> = {}) {
    this.limits = { maxSpans: limits.maxSpans ?? 500, maxTextLength: limits.maxTextLength ?? 200_000 };
  }

  register(sourceId: string, text: string, now: Date = new Date()): Span {
    const clipped = text.slice(0, this.limits.maxTextLength);
    const normalized = normalizeText(clipped);
    const span: Indexed = { id: `span_${randomUUID()}`, sourceId, text: clipped, registeredAt: now, normalized, amounts: extractAmountsMinor(normalized) };
    this.items.push(span);
    while (this.items.length > this.limits.maxSpans) this.items.shift();
    return span;
  }

  get size(): number {
    return this.items.length;
  }

  spans(): readonly Span[] {
    return this.items;
  }

  clear(): void {
    this.items.length = 0;
  }

  /** Source ids of the spans that contain this email address. */
  sourcesWithEmail(email: string): string[] {
    return this.unique(this.items.filter((s) => containsEmail(s.normalized, email)));
  }

  /** Source ids of the spans that contain this amount (in minor units of `currency`). */
  sourcesWithAmount(minor: number, currency: string): string[] {
    // Spans are indexed at 2 decimals; zero-decimal currencies are compared in whole units.
    const key = exponent(currency) === 0 ? minor * 100 : minor;
    return this.unique(this.items.filter((s) => s.amounts.has(key)));
  }

  /** Source ids of the spans that contain this identifier (order id, capture id, ...). */
  sourcesWithToken(token: string): string[] {
    return this.unique(this.items.filter((s) => containsToken(s.normalized, token)));
  }

  private unique(spans: Indexed[]): string[] {
    return [...new Set(spans.map((s) => s.sourceId))];
  }
}

/** One registry per agent id, so one agent's untrusted text never vouches for or taints another's calls. */
export class RegistryBook {
  private readonly byAgent = new Map<string, ProvenanceRegistry>();
  constructor(private readonly limits: Partial<RegistryLimits> = {}) {}
  /** Forgets everything every agent registered (the nightly demo reset). */
  clear(): void {
    this.byAgent.clear();
  }
  forAgent(agentId: string): ProvenanceRegistry {
    let r = this.byAgent.get(agentId);
    if (!r) this.byAgent.set(agentId, (r = new ProvenanceRegistry(this.limits)));
    return r;
  }
}
