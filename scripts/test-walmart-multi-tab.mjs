#!/usr/bin/env node
/**
 * Live demo: one SEPARATE Chrome WINDOW per Walmart product, tiled so they don't overlap.
 *
 *   node scripts/test-walmart-multi-tab.mjs
 *   node scripts/test-walmart-multi-tab.mjs --seconds 90
 */
import { launchBrowser } from "../src/checkout.js";
import { openChromeWindow, tileChromeWindows, installFastPageRoutes } from "../src/browserUtils.js";
import {
  positionWalmartQueueTab,
  detectWalmartQueueState,
  detectWalmartBuyable,
  needsWalmartHold,
  clearWalmartPxChallenge,
  pollWalmartQueueProgress,
} from "../src/walmart.js";

const seconds = (() => {
  const i = process.argv.indexOf("--seconds");
  const n = i >= 0 ? Number(process.argv[i + 1]) : 45;
  return Number.isFinite(n) && n > 0 ? n : 45;
})();

// Real Walmart.com PDP URLs (verified listing pages — not made-up IDs)
const PRODUCTS = [
  {
    id: "demo-1",
    name: "Window 1 — Azure Legends Xerneas tin",
    url: "https://www.walmart.com/ip/Pokemon-2025-Azure-Legends-Collectors-Tin-XERNEAS-EX-5-Packs-1-Foil/15363420745",
    itemId: "15363420745",
    retailer: "walmart",
  },
  {
    id: "demo-2",
    name: "Window 2 — Mega Charizard Y tin",
    url: "https://www.walmart.com/ip/Pokemon-Mega-Evolution-Spring-2026-Mega-Charizard-Y-ex-Tin-Set-4-Booster-Packs-Promo-Card/19632512887",
    itemId: "19632512887",
    retailer: "walmart",
  },
  {
    id: "demo-3",
    name: "Window 3 — Unova Poster Collection",
    url: "https://www.walmart.com/ip/Pokemon-TCG-Scarlet-Violet-10-5-Unova-Poster-Collection-Box-4-Packs/16517213276",
    itemId: "16517213276",
    retailer: "walmart",
  },
];

const log = (msg) => console.log(`[multi-win] ${msg}`);

async function pageLooksBroken(page) {
  const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 2500)).catch(() => "");
  return /couldn.?t find this page|page not found|we can.?t find|404|robot or human/i.test(text);
}

async function statusLine(page, product) {
  const hold = await needsWalmartHold(page).catch(() => false);
  if (hold) return "PX / Press & Hold";
  if (await pageLooksBroken(page)) return "PAGE ERROR / PX / NOT FOUND";
  const queue = await detectWalmartQueueState(page).catch(() => ({ inQueue: false }));
  if (queue.inQueue) {
    const ticket = queue.ticket ? ` ticket ${queue.ticket}` : "";
    return `IN QUEUE${ticket}${queue.placeholderTimer ? " (timer)" : ""}`;
  }
  const buy = await detectWalmartBuyable(page).catch(() => ({ inStock: false, status: "UNKNOWN" }));
  if (buy.inStock) return `BUYABLE — ${buy.button || "ATC"}`;
  return buy.status || "watching PDP";
}

async function main() {
  log("Launching bot Chrome…");
  const context = await launchBrowser({ headless: false });

  log(`Opening ${PRODUCTS.length} SEPARATE windows (not tabs)…`);
  const windows = [];

  for (const product of PRODUCTS) {
    log(`→ ${product.name}`);
    log(`  ${product.url}`);
    const page = await openChromeWindow(context, { url: "about:blank" });
    await installFastPageRoutes(page);
    page.setDefaultTimeout(45000);

    await positionWalmartQueueTab(page, product, {
      onLog: (_level, msg) => log(`  [${product.id}] ${msg}`),
    }).catch((err) => log(`  [${product.id}] navigate error: ${err.message}`));

    // If slug URL 404s, retry bare /ip/{itemId}
    if (await pageLooksBroken(page)) {
      const bare = `https://www.walmart.com/ip/${product.itemId}`;
      log(`  [${product.id}] page looked broken — retry ${bare}`);
      await page.goto(bare, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    if (await needsWalmartHold(page).catch(() => false)) {
      log(`  [${product.id}] Press & Hold — auto-clearing…`);
      await clearWalmartPxChallenge(page, {
        onLog: (_l, msg) => log(`  [${product.id}] ${msg}`),
        urgent: true,
        maxAttempts: 4,
      });
    }

    const st = await statusLine(page, product);
    log(`  [${product.id}] ready — ${st}`);
    windows.push({ page, product });
  }

  log("Tiling windows into non-overlapping grid…");
  const tile = await tileChromeWindows(
    windows.map((w) => w.page),
    { onLog: (msg) => log(`  ${msg}`) }
  );
  log(`Tile result: ${tile.ok} ok, ${tile.failed} failed (${tile.cols}×${tile.rows} grid, ${tile.cellW}×${tile.cellH} each)`);

  log("");
  log("═══════════════════════════════════════════════════════════");
  log("LOOK AT YOUR DESKTOP — windows auto-arranged");
  log("  • 1–2 products → left / right");
  log("  • 3–4 products → top-left, top-right, bottom-left, bottom-right");
  log("  • You should NOT need to drag them manually");
  log(`  • Polling for ${seconds}s`);
  log("═══════════════════════════════════════════════════════════");
  log("");

  const deadline = Date.now() + seconds * 1000;
  let cycle = 0;
  while (Date.now() < deadline) {
    cycle += 1;
    log(`── poll #${cycle} ──`);
    for (const { page, product } of windows) {
      if (page.isClosed?.()) {
        log(`  ${product.name}: WINDOW CLOSED`);
        continue;
      }
      try {
        if (await needsWalmartHold(page)) {
          await clearWalmartPxChallenge(page, { urgent: true, maxAttempts: 2 });
        }
        const r = await pollWalmartQueueProgress(page, product, { urgent: false });
        const st = r.inQueue
          ? `IN QUEUE${r.queueTicket ? ` #${r.queueTicket}` : ""}`
          : r.inStock
          ? `BUYABLE`
          : await statusLine(page, product);
        log(`  ${product.name}: ${st}`);
      } catch (err) {
        log(`  ${product.name}: error — ${err.message.slice(0, 80)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 4000));
  }

  log("");
  log("Demo done — windows stay open. Close them when you're done looking.");
}

main().catch((err) => {
  console.error("[multi-win] FAILED:", err);
  process.exit(1);
});
