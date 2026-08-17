#!/usr/bin/env node
/**
 * Live test: Walmart PerimeterX Press & Hold auto-clear.
 * Run: node scripts/test-walmart-px-hold.mjs
 *      node scripts/test-walmart-px-hold.mjs --fresh   (isolated profile, more likely to trigger PX)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { launchBrowser } from "../src/checkout.js";
import {
  isWalmartBlocked,
  clearWalmartPxChallenge,
  warmWalmartSession,
} from "../src/walmart.js";

const log = (msg) => console.log(`[px-test] ${msg}`);
const fresh = process.argv.includes("--fresh");

async function getContext() {
  if (!fresh) {
    log("Using bot Chrome profile (shared with dashboard)…");
    return launchBrowser({ headless: false });
  }
  const tmp = path.join(os.tmpdir(), `walmart-px-test-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  log(`Using fresh isolated profile: ${tmp}`);
  return chromium.launchPersistentContext(tmp, {
    headless: false,
    viewport: null,
    locale: "en-US",
    args: ["--start-maximized"],
  });
}

const TEST_URLS = [
  "https://www.walmart.com",
  "https://www.walmart.com/ip/14273871252",
  "https://www.walmart.com/browse/pokemon/4171_4191_6163033",
];

async function probePage(page, label) {
  const blocked = await isWalmartBlocked(page);
  log(`${label}: blocked=${blocked} url=${page.url().slice(0, 80)}`);
  if (!blocked) return { blocked: false, cleared: true };

  log(`${label}: attempting clearWalmartPxChallenge…`);
  const cleared = await clearWalmartPxChallenge(page, {
    onLog: (_level, msg) => log(`  ${msg}`),
    maxAttempts: 5,
  });
  const stillBlocked = await isWalmartBlocked(page);
  log(`${label}: cleared=${cleared} stillBlocked=${stillBlocked}`);
  return { blocked: true, cleared: cleared && !stillBlocked, stillBlocked };
}

async function main() {
  log("Launching Chrome…");
  const context = await getContext();
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(45000);

  const results = [];

  for (const url of TEST_URLS) {
    log(`Navigating → ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => {
      log(`  goto error: ${e.message}`);
    });
    await page.waitForTimeout(2000);
    results.push(await probePage(page, url));
    if (!results.at(-1).stillBlocked) {
      log("PX cleared or not shown — trying warmWalmartSession + product reload to re-trigger…");
      await warmWalmartSession(page).catch(() => {});
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(1500);
      results.push(await probePage(page, `${url} (reload)`));
    }
  }

  // Aggressive: rapid reloads often trigger PX during drops
  log("Rapid reload burst (drop simulation)…");
  for (let i = 0; i < 12; i++) {
    await page.goto(TEST_URLS[1], { waitUntil: "commit", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(250);
    if (await isWalmartBlocked(page)) {
      log(`  PX triggered on burst reload #${i + 1}`);
      results.push(await probePage(page, `burst-${i + 1}`));
      break;
    }
  }
  if (!results.some((r) => r.blocked)) {
    results.push(await probePage(page, "burst-reload"));
  }

  const pxSeen = results.some((r) => r.blocked);
  const pxCleared = results.some((r) => r.cleared);

  console.log("\n── Walmart PX Press & Hold test ──");
  console.log(`  PX challenge seen:     ${pxSeen ? "YES" : "NO"}`);
  console.log(`  Auto-clear succeeded:  ${pxCleared ? "YES" : pxSeen ? "NO (manual may be needed)" : "N/A"}`);
  console.log(`  Pages probed:          ${results.length}`);

  if (!pxSeen) {
    console.log("\n  Note: Real Walmart PX did not appear (session may be trusted).");
    console.log("  Running mock PX page to verify hold mechanics…");
    const mockPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "px-mock.html");
    const mockUrl = "file:///" + mockPath.replace(/\\/g, "/");
    await page.goto(mockUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const mockBlocked = await isWalmartBlocked(page);
    log(`mock page blocked=${mockBlocked}`);
    if (mockBlocked) {
      const mockCleared = await clearWalmartPxChallenge(page, {
        onLog: (_l, m) => log(`  mock: ${m}`),
        maxAttempts: 3,
      });
      const mockStill = await isWalmartBlocked(page);
      console.log(`  Mock PX auto-clear:    ${mockCleared && !mockStill ? "PASS" : "FAIL"}`);
      if (!mockCleared || mockStill) process.exitCode = 1;
    }
  }

  await context.close().catch(() => {});
  process.exitCode = pxSeen && !pxCleared ? 1 : 0;
}

main().catch((err) => {
  console.error("[px-test] FATAL:", err.message);
  process.exitCode = 1;
});
