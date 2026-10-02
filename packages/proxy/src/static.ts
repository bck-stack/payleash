import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  // AG Grid injects style elements; everything else is same-origin.
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

/**
 * Serves the built dashboard (a single-page app). Unknown paths without a file extension get index.html so client-side
 * routes survive a reload. Returns false when the request is not for the dashboard.
 */
export function serveDashboard(dir: string, req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const root = resolve(dir);
  let rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
  if (rel === "" || rel === ".") rel = "index.html";
  let file = resolve(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) return false;
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (extname(rel)) return false;
    file = join(root, "index.html");
    if (!existsSync(file)) return false;
  }
  const ext = extname(file);
  const immutable = /[\\/]assets[\\/]/.test(file);
  res.writeHead(200, {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "Content-Length": statSync(file).size,
    ...(file.endsWith("sw.js") ? { "Service-Worker-Allowed": "/" } : {}),
    ...SECURITY_HEADERS,
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
  return true;
}
