#!/usr/bin/env node
/**
 * Fast dry-run: known Target item → add to cart → checkout review (no purchase).
 * Run: npm run test-instock
 */
import "dotenv/config";
import { launchBrowser, checkTargetSession, openLogin, clearCartForDrop } from "../src/checkout.js";
import { batchCheckStockViaPageApi } from "../src/monitor.js";
import { engine } from "../src/engine.js";
import { log } from "../src/logger.js";

const TEST_PRODUCT = {
  tcin: "94960637",
  name: "up&up paper towels + toilet paper bundle",
  url: "https://www.target.com/p/-/A-94960637",
  price: 29.81,
};

async function main() {
  log.title("In-stock dry-run checkout test (no purchase)");

  if (engine.running) {
    log.err("Stop the bot in the dashboard first, then re-run.");
    process.exitCode = 1;
    return;
  }

  engine.on("event", (e) => {
    if (e.kind === "log") {
      const fns = { ok: log.ok, warn: log.warn, err: log.err, hit: log.hit, info: log.info };
      (fns[e.level] || log.info)(e.message);
    }
  });

  const browser = await launchBrowser({ headless: false });
  const page = await browser.newPage();
  try {
    const session = await checkTargetSession(page);
    if (!session.signedIn) {
      log.warn("Not signed in — opening Target login. Sign in, then re-run: npm run test-instock");
      await browser.close().catch(() => {});
      await openLogin();
      process.exitCode = 1;
      return;
    }
    log.ok("Target login verified — signed in.");

    log.info("Clearing cart…");
    await clearCartForDrop(page, { fastMode: true });

    const stock = await batchCheckStockViaPageApi(page, [TEST_PRODUCT]);
    if (!stock?.[0]?.inStock) {
      log.warn(`Test product OOS (${stock?.[0]?.status || "unknown"}) — trying anyway.`);
    } else {
      log.hit(`In stock: ${TEST_PRODUCT.name} (TCIN ${TEST_PRODUCT.tcin})`);
    }

    log.info("Hype-path dry run (same as Pokémon drops) — target ~8–14s…");
    const out = await engine.testCheckout({ ...TEST_PRODUCT, maxQuantity: 2 });

    if (out.ok && (out.result?.dryRun || out.result?.manual)) {
      log.ok(`SUCCESS in ${(out.totalMs / 1000).toFixed(1)}s — reached checkout, no order placed.`);
      return;
    }

    log.err(`Test failed: ${out.error || "unknown error"}`);
    process.exitCode = 1;
  } finally {
    await page.close().catch(() => {});
    await engine.stop().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  log.err(err.message);
  process.exitCode = 1;
});
