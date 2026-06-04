// Capture real DeepMarket screens from the running dev server for the promo
// video's product-demo scenes. Uses the installed Chrome (channel: 'chrome').
//
//   node scripts/capture.mjs
//
// Output: public/screens/*.png at 2x for crisp downscale in a 1080p comp.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "public", "screens");
mkdirSync(OUT, { recursive: true });

const BASE = "http://localhost:5173";
const PREDICT_OBJECT = "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";
const PREDICT_SERVER = "https://predict-server.testnet.mystenlabs.com";

async function activeOracleId() {
  try {
    const res = await fetch(`${PREDICT_SERVER}/predicts/${PREDICT_OBJECT}/oracles`);
    const all = await res.json();
    const active = all.find((o) => o.status === "active");
    return active?.oracle_id ?? null;
  } catch {
    return null;
  }
}

async function shoot(page, name, ms = 3500) {
  await page.waitForTimeout(ms);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`✓ ${name}.png`);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: "networkidle" }).catch(() => {});
await shoot(page, "landing", 3000);

await page.goto(`${BASE}/predict`, { waitUntil: "networkidle" }).catch(() => {});
await shoot(page, "predict", 6000); // oracle list can take a while to populate

const oid = await activeOracleId();
if (oid) {
  await page.goto(`${BASE}/predict/${oid}`, { waitUntil: "networkidle" }).catch(() => {});
  await shoot(page, "oracle", 5000);
}

await page.goto(`${BASE}/vault`, { waitUntil: "networkidle" }).catch(() => {});
await shoot(page, "vault", 4000);

await page.goto(`${BASE}/agents`, { waitUntil: "networkidle" }).catch(() => {});
await shoot(page, "agents", 4000);

await browser.close();
console.log("done");
