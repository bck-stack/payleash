import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface OrderState {
  orderId?: string;
  status?: string;
  /** "awaiting_approval": a buyer has to approve this order in the sandbox before it can be captured. */
  stage: "created" | "awaiting_approval" | "captured" | "failed";
  approveUrl?: string;
  captureId?: string;
  buyerEmail?: string;
  capturedAt?: string;
  error?: string;
}

export interface SeedState {
  version: 1;
  products: Record<string, string>;
  orders: Record<string, OrderState>;
  refunds: Record<string, { refundId: string; captureId: string; value: string }>;
  invoices: Record<string, { invoiceId: string; sent: boolean }>;
  disputes: { id: string; status?: string; amount?: string }[];
  /** Decided on the first run (card probe), then kept: a re-run must not re-probe or exceed the wallet cap. */
  orderMode?: "card" | "paypal";
  notes: string[];
}

export const emptyState = (): SeedState => ({ version: 1, products: {}, orders: {}, refunds: {}, invoices: {}, disputes: [], notes: [] });

/** Resume file so a re-run never creates anything twice. */
export class StateFile {
  readonly path: string;
  constructor(dir: string) {
    this.path = join(dir, "state.json");
  }
  load(): SeedState {
    if (!existsSync(this.path)) return emptyState();
    return { ...emptyState(), ...JSON.parse(readFileSync(this.path, "utf8")) };
  }
  save(s: SeedState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.path);
  }
}
