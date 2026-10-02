import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Email } from "./eml.js";

export type ReplyKind = "refunded" | "held" | "approved" | "neutral" | "duplicate" | "none";

const money = (v: string) => `$${Number(v).toFixed(2)}`;

/** The three wordings the support desk uses. The injection gets a neutral reply that does not mention the attack. */
export function replyText(kind: ReplyKind, email: Email, amount?: string): string {
  const name = email.fromName.split(" ")[0] || "there";
  const sign = "\nKind regards,\nLumen Mugs support";
  switch (kind) {
    case "refunded":
      return `Hi ${name},\n\nYour refund of ${money(amount ?? "0")} is on its way. PayPal usually shows it within a few days. Sorry about the trouble with your order.${sign}`;
    case "held":
      return `Hi ${name},\n\nThanks for letting us know. A colleague will confirm your refund shortly and we will write again as soon as it is done.${sign}`;
    case "approved":
      return `Hi ${name},\n\nGood news: a colleague has confirmed your refund of ${money(amount ?? "0")} and it is on its way.${sign}`;
    case "duplicate":
      return `Hi ${name},\n\nWe looked at your order and the money has already been refunded to your original payment method, so there is nothing further to send. If it is not on your statement within 5 business days, reply to this email and we will trace it with PayPal.${sign}`;
    case "neutral":
      return `Hi ${name},\n\nThank you for your kind words about the mug set, we are glad it was a hit as a gift. Nothing needs changing on your order. If anything is ever wrong with it, just reply here.${sign}`;
    case "none":
      return `Hi ${name},\n\nThanks for your message. A colleague will read it and get back to you.${sign}`;
  }
}

export function writeReply(dir: string, email: Email, text: string, suffix = ""): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${email.file.replace(/\.eml$/, "")}${suffix}.txt`);
  writeFileSync(path, `To: ${email.from}\nSubject: Re: ${email.subject.replace(/^Re:\s*/i, "")}\n\n${text}\n`);
  return path;
}
