import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.js";

const out = (f: string) => fileURLToPath(new URL(`../../../apps/dashboard/public/icons/${f}`, import.meta.url));
const glyph = `<path d="M148 150h132c52 0 88 30 88 78s-36 78-88 78h-60v66h-72z" fill="none" stroke="#fff" stroke-width="40" stroke-linejoin="round"/><circle cx="352" cy="360" r="26" fill="#fab219"/>`;
const svg = (size: number, maskable: boolean) =>
  maskable
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0f6b5c"/><g transform="translate(102 102) scale(.6)">${glyph}</g></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0f6b5c"/>${glyph}</svg>`;

const browser = await launch();
for (const [file, size, maskable] of [["icon-192.png", 192, false], ["icon-512.png", 512, false], ["icon-maskable-512.png", 512, true]] as const) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;background:transparent">${svg(size, maskable)}</body>`);
  writeFileSync(out(file), await page.screenshot({ omitBackground: !maskable, type: "png" }));
  await page.close();
}
await browser.close();
console.log("icons written to apps/dashboard/public/icons");
