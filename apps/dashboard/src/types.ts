// Shapes returned by the proxy's owner API (packages/proxy/src/owner-api.ts).

export type Role = "owner" | "demo";
export type Decision = "allow" | "hold" | "deny";

export interface Me {
  authenticated: boolean;
  role: Role | null;
  mode: "sandbox" | "fixtures";
  demo: boolean;
  loginEnabled: boolean;
  demoLoginAvailable: boolean;
  demoPasscode?: string;
  canApprove: boolean;
  canSign: boolean;
  canFreeze: boolean;
  llm: { configured: boolean; provider: string | null };
  push: { enabled: boolean; publicKey: string | null; subscriptions: number };
  email: boolean;
  backtest: { fixtures: boolean; live: boolean };
}

export interface ToolConstraints {
  maxAmountPerOp?: string;
  dailyTotal?: string;
  currency?: string;
  payeeMustBeOriginalBuyer?: boolean;
  orderAgeDays?: number;
  autoApproveThreshold?: string;
}
export interface MandateInput {
  agentId: string;
  allowedTools: string[];
  constraints?: Record<string, ToolConstraints>;
}

export interface Budget {
  tool: string;
  currency: string;
  limit: string;
  used: string;
  remaining: string;
  percent: number;
}
export interface AgentCard {
  agentId: string;
  mandate: null | {
    id: string;
    state: "valid" | "expired" | "not_yet_valid";
    source: "issued" | "seen";
    notBefore: string;
    expiresAt: string;
    daysLeft: number;
    allowedTools: string[];
    constraints: Record<string, ToolConstraints>;
  };
  budgets: Budget[];
  today: { allow: number; hold: number; deny: number };
  frozen: boolean;
  frozenScope: "global" | "agent" | null;
  frozenReason: string | null;
  pending: number;
}
export interface Overview {
  now: string;
  mode: "sandbox" | "fixtures";
  frozen: { global: null | { reason: string | null; since: string }; agents: { agentId: string; reason: string | null; since: string }[] };
  agents: AgentCard[];
  pendingTotal: number;
  audit: { seq: number; hash: string };
}

export interface Reason {
  code: string;
  message: string;
}
export interface OwnerReason extends Reason {
  count: number;
  details: string[];
  title: string;
  meaning: string;
  action: string;
}
export interface ProvenanceEntry {
  path: string;
  role: string;
  roleLabel: string;
  value: string;
  status: "verified" | "tainted" | "unknown";
  origin: "paypal" | "customer_email" | "support_ticket" | "dispute_message" | "web_page" | "untrusted_text" | "unknown";
  label: string;
  detail: string;
  sources: string[];
}
export interface Approval {
  approvalId: string;
  status: "pending_approval" | "approving" | "executed" | "failed" | "denied" | "expired";
  agentId: string;
  tool: string;
  args: Record<string, unknown>;
  reasons: OwnerReason[];
  explanation: string;
  createdAt: string;
  decidedAt?: string;
  expiresAt: string;
  result?: unknown;
  error?: string;
  context?: { summary: string; facts: { label: string; value: string }[]; provenance: ProvenanceEntry[]; amount?: { currency: string; minor: number; text: string } };
}

export interface AuditRow {
  seq: number;
  ts: string;
  agent: string;
  tool: string;
  decision: string;
  summary: string;
  args: Record<string, unknown>;
  reasons: Reason[];
  reasonsGrouped: (Reason & { count: number; details: string[]; title: string })[];
  mandateId: string | null;
  paypalResultId: string | null;
  hash: string;
  prevHash: string;
}
export interface VerifyResult {
  ok: boolean;
  entries: number;
  headSeq: number;
  headHash: string;
  problems: { seq: number; problem: string; message: string }[];
}

export interface PolicyDraft {
  proposed: MandateInput;
  current: MandateInput | null;
  source: "llm" | "template";
  ttl: string;
  notes: string[];
  warnings: string[];
  signed: false;
}
export interface PoliciesInfo {
  agents: { agentId: string; current: MandateInput; mandateId: string; expiresAt: string }[];
  tools: { tool: string; access: "read" | "write" }[];
  canSign: boolean;
  llm: { configured: boolean; provider: string | null };
  example: string;
}

export interface DecisionCounts {
  actions: number;
  allow: number;
  hold: number;
  deny: number;
}
export interface BacktestReport {
  totals: DecisionCounts;
  money: Record<string, { allowedMinor: number; heldMinor: number; deniedMinor: number; allowed: string; held: string; denied: string }>;
  byOrigin: Record<string, DecisionCounts>;
  ruleHits: { code: string; title: string; actions: number; deny: number; hold: number }[];
  adversarial: {
    total: number;
    caught: number;
    missed: { id: string; label: string }[];
    injections: { total: number; caught: number };
    byKind: Record<string, { total: number; caught: number }>;
  };
  timeline: { date: string; allow: number; hold: number; deny: number }[];
  sizes: { bucket: string; allow: number; hold: number; deny: number }[];
}
export interface BacktestRow {
  id: string;
  at: string;
  origin: string;
  label: string;
  tool: string;
  orderId: string;
  amount: number | null;
  currency: string;
  decision: Decision;
  rules: string;
  attack: string;
  caught: boolean | null;
  explanation: string;
}
export interface BacktestRun {
  id: string;
  source: "fixtures" | "paypal";
  anchor: string;
  days: number;
  dryRun: true;
  report: BacktestReport;
  rows: BacktestRow[];
  mandateInput: MandateInput;
  thresholdDefault: string | null;
  maxPerOp: string | null;
}
export interface WhatIf {
  runId: string;
  report: BacktestReport;
  decisions: Record<string, { decision: Decision; rules: string }>;
}
