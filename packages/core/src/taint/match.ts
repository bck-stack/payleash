/**
 * Matching helpers for the provenance registry. Everything here is deterministic string work.
 * Untrusted text is normalised first, so common obfuscations do not hide a value:
 * full-width digits, zero-width characters, "[at]" / "(dot)" emails, thousands separators, number words.
 */

// Soft hyphen, zero-width / bidi / invisible formatting characters. Built from a string to keep the source ASCII.
const INVISIBLE = new RegExp("[\\u00ad\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\ufeff]", "g");

export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/\s*[[(<{]\s*at\s*[\])>}]\s*/gi, "@")
    .replace(/\s*[[(<{]\s*dot\s*[\])>}]\s*/gi, ".");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function containsEmail(normalizedText: string, email: string): boolean {
  const e = normalizeText(email).trim().toLowerCase();
  if (!e) return false;
  return new RegExp(`(?<![a-z0-9._%+-])${escapeRe(e)}(?![a-z0-9_-])`, "i").test(normalizedText.toLowerCase());
}

export function extractEmails(normalizedText: string): string[] {
  return [...normalizedText.toLowerCase().matchAll(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g)].map((m) => m[0]);
}

export function containsToken(normalizedText: string, token: string): boolean {
  const t = normalizeText(token).trim();
  if (!t) return false;
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(t)}(?![A-Za-z0-9_-])`).test(normalizedText);
}

/** Interprets "1,299.50", "1.299,50", "12,50", "999" as a number of minor units (2 decimals). */
function tokenToMinor(raw: string): number[] {
  const t = raw.replace(/^[.,\s]+|[.,\s]+$/g, "");
  if (!/\d/.test(t)) return [];
  const out = new Set<number>();
  const add = (intPart: string, frac: string) => {
    const n = Number(intPart.replace(/\D/g, "") || "0") * 100 + Number((frac + "00").slice(0, 2));
    if (Number.isSafeInteger(n)) out.add(n);
  };
  const lastSep = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
  if (lastSep === -1) {
    add(t, "");
  } else {
    const after = t.slice(lastSep + 1);
    if (after.length <= 2) add(t.slice(0, lastSep), after); // decimal separator
    else add(t, ""); // 1,299 / 1.299 -> thousands separator
    if (after.length === 3 && !/[.,]/.test(t.slice(0, lastSep))) add(t.slice(0, lastSep), after); // "1.299" might also be a 3-decimal figure
  }
  return [...out];
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** English number words up to 999,999 ("nine hundred ninety-nine", "one thousand two hundred"). */
export function extractWordAmounts(normalizedText: string): number[] {
  const words = normalizedText.toLowerCase().replace(/-/g, " ").split(/[^a-z]+/).filter(Boolean);
  const results: number[] = [];
  let i = 0;
  while (i < words.length) {
    let total = 0;
    let current = 0;
    let used = 0;
    let j = i;
    for (; j < words.length; j++) {
      const w = words[j]!;
      if (w in UNITS) current += UNITS[w]!;
      else if (w in TENS) current += TENS[w]!;
      else if (w === "hundred" && used > 0) current = Math.max(current, 1) * 100;
      else if (w === "thousand" && used > 0) {
        total += Math.max(current, 1) * 1000;
        current = 0;
      } else if (w === "and" && (words[j - 1] === "hundred" || words[j - 1] === "thousand") && (words[j + 1]! in UNITS || words[j + 1]! in TENS)) {
        continue; // "two hundred and five"; elsewhere "and" separates two numbers
      } else break;
      used++;
    }
    if (used > 0) {
      results.push((total + current) * 100);
      i = j;
    } else i++;
  }
  return results;
}

/**
 * Every amount-like number in the text, in minor units. Bare numbers count too (not only "$999"),
 * because an attacker does not have to write a currency symbol. This errs towards flagging.
 */
export function extractAmountsMinor(normalizedText: string): Set<number> {
  const found = new Set<number>();
  for (const m of normalizedText.matchAll(/\d[\d.,]*\d|\d/g)) for (const n of tokenToMinor(m[0])) found.add(n);
  for (const n of extractWordAmounts(normalizedText)) found.add(n);
  return found;
}
