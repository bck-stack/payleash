import lighthouse from "lighthouse";
import { launch } from "./browser.js";
import { DEMO, PAGES, startDemo } from "./harness.js";

// Lighthouse accessibility score for the login page and every dashboard page, phone and desktop: `pnpm --filter @payleash/e2e lighthouse`.
// Exit code 1 if any score is below 100. Needs Chromium and the built dashboard.
const PORT = 9339;
const proxy = await startDemo();
const base = proxy.http!.url;
const browser = await launch([`--remote-debugging-port=${PORT}`]);

// A read-only demo session cookie, so Lighthouse sees the pages behind the login.
const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: DEMO }) });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;

const me = (await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json()) as { authenticated?: boolean };
if (!me.authenticated) throw new Error("the demo session cookie was not accepted: Lighthouse would only see the login page");

let failed = false;
try {
  const targets = [{ name: "Login", path: "/", cookie: "" }, ...PAGES.map((p) => ({ name: p.name, path: p.path, cookie }))];
  for (const form of ["mobile", "desktop"] as const) {
    for (const t of targets) {
      const flags = { port: PORT, output: "json" as const, logLevel: "error" as const, onlyCategories: ["accessibility"], formFactor: form, screenEmulation: form === "mobile" ? { mobile: true, width: 375, height: 760, deviceScaleFactor: 2, disabled: false } : { mobile: false, width: 1280, height: 860, deviceScaleFactor: 1, disabled: false }, extraHeaders: t.cookie ? { Cookie: t.cookie } : {} };
      const r = await lighthouse(`${base}${t.path}`, flags);
      const score = Math.round((r?.lhr.categories.accessibility?.score ?? 0) * 100);
      const bad = Object.values(r?.lhr.audits ?? {}).filter((a) => a.score !== null && a.score < 1 && a.scoreDisplayMode !== "notApplicable" && a.scoreDisplayMode !== "informative" && a.scoreDisplayMode !== "manual");
      console.log(`${String(score).padStart(3)}  ${form.padEnd(7)} ${t.name}${bad.length ? `   failing: ${bad.map((a) => a.id).join(", ")}` : ""}`);
      if (score < 100) failed = true;
    }
  }
} finally {
  await browser.close();
  await proxy.close();
}
process.exit(failed ? 1 : 0);
