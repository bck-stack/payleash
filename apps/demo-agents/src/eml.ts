import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Email {
  file: string;
  from: string;
  fromName: string;
  subject: string;
  messageId: string;
  body: string;
  /** The whole message exactly as received: this is what gets registered as untrusted. */
  raw: string;
}

/** A small RFC 5322 reader: enough for plain-text customer mail (unfolds headers, splits at the first blank line). */
export function parseEml(file: string, raw: string): Email {
  const text = raw.replace(/\r\n/g, "\n");
  const cut = text.indexOf("\n\n");
  const head = (cut < 0 ? text : text.slice(0, cut)).replace(/\n[ \t]+/g, " ");
  const body = cut < 0 ? "" : text.slice(cut + 2).trim();
  const header = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "im").exec(head)?.[1]?.trim() ?? "";
  const from = header("From");
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? from;
  return { file, from: addr.trim().toLowerCase(), fromName: from.replace(/<[^>]+>/, "").trim() || addr, subject: header("Subject"), messageId: header("Message-ID"), body, raw };
}

export function readInbox(dir: string): Email[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .map((f) => parseEml(f, readFileSync(join(dir, f), "utf8")));
}
