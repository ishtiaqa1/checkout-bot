#!/usr/bin/env node
/**
 * Drop-speed test: hype checkout path on a known in-stock item (dry run).
 * Run: npm run test-blitz
 */
import "dotenv/config";
import { launchBrowser, checkTargetSession, clearCartForDrop, runCheckout } from "../src/checkout.js";
import { log } from "../src/logger.js";

const TEST_PRODUCT = {
  tcin: "94960637",
  name: "up&up paper towels + toilet paper bundle",
  url: "https://www.target.com/p/-/A-94960637",
  maxQuantity: 1,
};

async function main() {
  log.title("Blitz speed test (hype path, dry run)");

  const browser = await launchBrowser({ headless: false });
  const page = await browser.newPage();
  const t0 = Date.now();

  try {
    if (!(await checkTargetSession(page)).signedIn) {
      log.err("Not signed in — run npm run login first.");
      process.exitCode = 1;
      return;
    }

    await clearCartForDrop(page, { fastMode: true });
    await page.goto("https://www.target.com/", { waitUntil: "commit", timeout: 15000 }).catch(() => {});

    const result = await runCheckout(browser, TEST_PRODUCT, {
      checkout: {
        dryRun: true,
        autoPlaceOrder: false,
        dropMode: true,
        hypeMode: true,
        apiCheckout: true,
        checkoutRetries: 3,
        checkoutTimeoutMs: 60000,
      },
    }, {
      page,
      skipNavigation: true,
      fastMode: true,
      hypeMode: true,
      dropWindowActive: true,
      onPhase: () => {},
      shouldCancel: () => false,
    });

    const ms = Date.now() - t0;
    if (result?.dryRun || result?.manual) {
      log.ok(`BLITZ SUCCESS in ${(ms / 1000).toFixed(2)}s — reached checkout, no purchase.`);
      return;
    }
    log.err(`Blitz failed after ${(ms / 1000).toFixed(1)}s`);
    process.exitCode = 1;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  log.err(err.message);
  process.exitCode = 1;
});
