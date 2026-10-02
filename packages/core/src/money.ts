/** Amounts are handled as integer minor units so budget arithmetic is exact. */
export interface Money {
  currency: string;
  minor: number;
}

export class MoneyError extends Error {}

// PayPal does not support decimals for these currencies.
const ZERO_DECIMAL = new Set(["HUF", "JPY", "TWD"]);

export function exponent(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** "42.50" + "USD" -> 4250. Rejects negatives, exponents, and too many decimals. */
export function parseDecimal(value: string | number, currency: string): number {
  const s = typeof value === "number" ? String(value) : value.trim();
  const exp = exponent(currency);
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(s);
  if (!m) throw new MoneyError(`invalid amount "${s}"`);
  const frac = m[2] ?? "";
  if (frac.length > exp) throw new MoneyError(`amount "${s}" has too many decimals for ${currency}`);
  const minor = Number(m[1]) * 10 ** exp + (frac ? Number(frac.padEnd(exp, "0")) : 0);
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`amount "${s}" is too large`);
  return minor;
}

export function formatMinor(minor: number, currency: string): string {
  const exp = exponent(currency);
  if (exp === 0) return String(minor);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(m: Money): string {
  return `${formatMinor(m.minor, m.currency)} ${m.currency}`;
}

export function money(value: string | number, currency: string): Money {
  const cur = currency.toUpperCase();
  return { currency: cur, minor: parseDecimal(value, cur) };
}
