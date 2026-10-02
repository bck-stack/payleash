/** A timed, readable log for screen recordings: `[00:07.4] support  ...` with one colour per actor. */

const COLORS: Record<string, string> = { proxy: "90", support: "36", dispute: "35", owner: "33", result: "32", warn: "31", llm: "34" };

export interface Logger {
  (actor: string, line: string): void;
  section(title: string): void;
  /** Waits `ms` (the pace of the recording) unless the pace is zero. */
  beat(ms?: number): Promise<void>;
  elapsed(): string;
}

export function createLogger(opts: { out?: (s: string) => void; color?: boolean; paceMs?: number; now?: () => number } = {}): Logger {
  const out = opts.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const color = opts.color ?? (process.stdout.isTTY === true && !process.env.NO_COLOR);
  const pace = opts.paceMs ?? 0;
  const now = opts.now ?? Date.now;
  const t0 = now();
  const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const elapsed = () => {
    const ms = now() - t0;
    const m = Math.floor(ms / 60000);
    const s = (ms % 60000) / 1000;
    return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
  };
  const log = ((actor: string, line: string) => {
    const tag = actor.padEnd(8);
    const lines = line.split("\n");
    lines.forEach((l, i) => out(`${paint("2", `[${elapsed()}]`)} ${paint(COLORS[actor] ?? "0", i === 0 ? tag : " ".repeat(8))} ${l}`));
  }) as Logger;
  log.section = (title) => {
    out("");
    out(paint("1", `${"─".repeat(3)} ${title} ${"─".repeat(Math.max(3, 66 - title.length))}`));
  };
  log.beat = async (ms) => {
    const d = ms ?? pace;
    if (d > 0) await new Promise((r) => setTimeout(r, d));
  };
  log.elapsed = elapsed;
  return log;
}
