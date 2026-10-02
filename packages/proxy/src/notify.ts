import type { Db, VapidKeys } from "@payleash/core";
import type { OwnerApprovalView } from "./app.js";

/** One browser's Web Push subscription (what `PushManager.subscribe()` returns, as JSON). */
export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  /** Path to open when the notification is tapped. */
  url: string;
  tag?: string;
}

export interface PushSender {
  send(sub: PushSubscriptionJson, payload: PushPayload): Promise<void>;
}

/** Error carrying the push service's HTTP status: 404 / 410 mean the subscription is gone. */
export class PushError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

export function webPushSender(vapid: VapidKeys): PushSender {
  return {
    async send(sub, payload) {
      const { default: webpush } = await import("web-push");
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), { vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 3600, urgency: "high" });
      } catch (e) {
        throw new PushError(e instanceof Error ? e.message : String(e), (e as { statusCode?: number }).statusCode);
      }
    },
  };
}

export interface EmailConfig {
  apiKey: string;
  to: string;
  from: string;
  /** Send an email for every held call, even when push worked. Default: only when there is no working push subscription. */
  always?: boolean;
}

export interface NotifierOptions {
  db: Db;
  vapid: VapidKeys | null;
  /** Where the dashboard is served, for links in emails and notifications. */
  publicUrl?: string;
  email?: EmailConfig | null;
  sender?: PushSender;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * Tells the owner a call is waiting: Web Push to every subscribed browser, and, optionally, an email with a link
 * (Resend). Failures never affect the held call. Dead push subscriptions (404 / 410) are dropped.
 */
export class Notifier {
  private readonly sender: PushSender | null;

  constructor(private readonly o: NotifierOptions) {
    o.db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY, subscription_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, label TEXT)`);
    this.sender = o.sender ?? (o.vapid ? webPushSender(o.vapid) : null);
  }

  get pushEnabled(): boolean {
    return this.sender !== null;
  }
  get emailEnabled(): boolean {
    return !!this.o.email;
  }
  get publicKey(): string | undefined {
    return this.o.vapid?.publicKey;
  }

  subscriptions(): PushSubscriptionJson[] {
    return (this.o.db.prepare("SELECT subscription_json FROM push_subscriptions ORDER BY created_at_ms").all() as { subscription_json: string }[]).map((r) => JSON.parse(r.subscription_json));
  }

  subscribe(sub: PushSubscriptionJson, label?: string): void {
    if (!/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("not a valid push subscription");
    this.o.db
      .prepare("INSERT INTO push_subscriptions (endpoint, subscription_json, created_at_ms, label) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json")
      .run(sub.endpoint, JSON.stringify(sub), Date.now(), label?.slice(0, 80) ?? null);
  }

  unsubscribe(endpoint: string): boolean {
    return this.o.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes > 0;
  }

  private link(path: string): string | undefined {
    return this.o.publicUrl ? `${this.o.publicUrl.replace(/\/+$/, "")}${path}` : undefined;
  }

  /** Returns how many browsers were reached. */
  async pushAll(payload: PushPayload): Promise<number> {
    if (!this.sender) return 0;
    let reached = 0;
    for (const sub of this.subscriptions()) {
      try {
        await this.sender.send(sub, payload);
        reached++;
      } catch (e) {
        if (e instanceof PushError && (e.statusCode === 404 || e.statusCode === 410)) this.unsubscribe(sub.endpoint);
        else this.o.log?.(`push failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return reached;
  }

  async sendEmail(subject: string, text: string): Promise<boolean> {
    const e = this.o.email;
    if (!e) return false;
    try {
      const res = await (this.o.fetch ?? fetch)("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${e.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: e.from, to: [e.to], subject, text }),
      });
      if (!res.ok) throw new Error(`Resend answered ${res.status}`);
      return true;
    } catch (err) {
      this.o.log?.(`email failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** A new held call. Never throws. */
  async notifyHeld(v: OwnerApprovalView): Promise<{ push: number; email: boolean }> {
    const summary = v.context?.summary ?? v.explanation;
    const path = `/approvals?focus=${encodeURIComponent(v.approvalId)}`;
    const payload: PushPayload = { title: "PayLeash: approval needed", body: `${v.agentId}: ${summary}`.slice(0, 180), url: path, tag: v.approvalId };
    const push = await this.pushAll(payload).catch(() => 0);
    let email = false;
    if (this.o.email && (this.o.email.always || push === 0)) {
      const link = this.link(path);
      email = await this.sendEmail(`PayLeash: ${v.agentId} needs your approval`, [`${v.agentId} wants to: ${summary}`, "", `Why it was held: ${v.explanation}`, "", link ? `Review and approve or deny: ${link}` : "Open the PayLeash dashboard to review it."].join("\n"));
    }
    return { push, email };
  }

  async sendTest(): Promise<{ push: number; email: boolean }> {
    const push = await this.pushAll({ title: "PayLeash", body: "Notifications work. You will be told when an agent needs your approval.", url: "/approvals", tag: "payleash-test" });
    const email = this.o.email ? await this.sendEmail("PayLeash test email", `Notifications work.${this.link("/approvals") ? `\n${this.link("/approvals")}` : ""}`) : false;
    return { push, email };
  }
}

export function emailConfigFromEnv(env: NodeJS.ProcessEnv): EmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const to = env.NOTIFY_EMAIL_TO?.trim();
  if (!apiKey || !to) return null;
  return { apiKey, to, from: env.NOTIFY_EMAIL_FROM?.trim() || "PayLeash <onboarding@resend.dev>", always: env.NOTIFY_EMAIL_ALWAYS === "1" };
}
