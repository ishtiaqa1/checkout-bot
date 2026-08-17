#!/usr/bin/env node
/**
 * Safe self-test — verifies monitor, session, and checkout pipeline without purchasing.
 * Run: node scripts/self-test.mjs
 */
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { launchBrowser, isLoggedOut } from "../src/checkout.js";
import { batchCheckStockViaPageApi } from "../src/monitor.js";
import { engine } from "../src/engine.js";
import { log } from "../src/logger.js";

const results = [];

function pass(name, detail) {
  results.push({ name, ok: true, detail });
  log.ok(`PASS — ${name}: ${detail}`);
}

function fail(name, detail) {
  results.push({ name, ok: false, detail });
  log.err(`FAIL — ${name}: ${detail}`);
}

function warn(name, detail) {
  results.push({ name, ok: true, warn: true, detail });
  log.warn(`WARN — ${name}: ${detail}`);
}

async function testFastApi(browser, products) {
  const page = await browser.newPage();
  try {
    const targets = products.filter((p) => p.tcin);
    const rows = await batchCheckStockViaPageApi(page, targets);
    if (!rows?.length) {
      fail("Fast API monitor", "No stock data returned — RedSky may be blocked or keys missing.");
      return null;
    }
    const inStock = rows.filter((r) => r.inStock);
    pass(
      "Fast API monitor",
      `${rows.length}/${targets.length} products checked via RedSky (${inStock.length} in stock right now).`
    );
    return rows;
  } finally {
    await page.close().catch(() => {});
  }
}

async function testSession(browser) {
  const page = await browser.newPage();
  try {
    await page.goto("https://www.target.com/account", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    if (await isLoggedOut(page)) {
      fail("Target login", "Not signed in — run the dashboard Login button or `npm run login` before drops.");
      return false;
    }
    pass("Target login", "Signed in — saved address/card should be available at checkout.");
    return true;
  } finally {
    await page.close().catch(() => {});
  }
}

async function testPdpNavigation(browser, product) {
  const page = await browser.newPage();
  try {
    const url = product.url || `https://www.target.com/p/-/A-${product.tcin}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const buyBox = page
      .locator(
        '[data-test="shippingButton"], [data-test^="addToCartButton"], [data-test="buyNowButton"], button:has-text("Add to cart"), button:has-text("Sold out")'
      )
      .first();
    await buyBox.waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
    const visible = await buyBox.isVisible().catch(() => false);
    if (!visible) {
      fail("Product page", `Could not load buy box for ${product.name || product.tcin}.`);
      return false;
    }
    const text = (await buyBox.innerText().catch(() => "")) || "";
    pass("Product page", `PDP loads for ${product.tcin} — buy control: "${text.trim().slice(0, 40)}"`);
    return true;
  } finally {
    await page.close().catch(() => {});
  }
}

async function testDryRunCheckout(product) {
  engine.on("event", (e) => {
    if (e.kind === "log") {
      const fns = { ok: log.ok, warn: log.warn, err: log.err, hit: log.hit, info: log.info };
      (fns[e.level] || log.info)(e.message);
    }
  });

  const out = await engine.testCheckout({
    tcin: product.tcin,
    name: product.name,
    url: product.url,
    maxQuantity: 1,
  });

  if (out.ok && out.result?.dryRun) {
    pass("Dry-run checkout", `Reached checkout review in ${(out.totalMs / 1000).toFixed(1)}s — no purchase made.`);
    return true;
  }

  if (out.ok && out.result?.manual) {
    pass("Dry-run checkout", "Cart/checkout reached — stopped before place order (as expected).");
    return true;
  }

  const err = out.error || "";
  if (/add to cart|not verified|sold out|out of stock|could not add/i.test(err)) {
    warn(
      "Dry-run checkout",
      `Product is out of stock — add-to-cart step blocked (expected for Pokémon). Pipeline OK up to stock gate. (${err})`
    );
    return true;
  }

  if (/not signed in/i.test(err)) {
    fail("Dry-run checkout", err);
    return false;
  }

  fail("Dry-run checkout", err || "Unknown failure — see log above.");
  return false;
}

async function main() {
  log.title("Checkout Bot Self-Test (no purchase)");

  const config = loadConfig();
  const products = (config.products || []).filter((p) => p.tcin);
  if (!products.length) {
    fail("Config", "No products with TCINs in config.json.");
    printSummary();
    process.exitCode = 1;
    return;
  }

  if (engine.running) {
    fail("Engine", "Stop the bot in the dashboard before running self-test.");
    process.exitCode = 1;
    return;
  }

  const browser = await launchBrowser({ headless: false });
  try {
    const rows = await testFastApi(browser, products);
    const loggedIn = await testSession(browser);
    const sample = products[0];
    await testPdpNavigation(browser, sample);

    const inStockProduct = rows?.find((r) => r.inStock)
      ? products.find((p) => rows.find((r) => r.inStock && String(r.tcin) === String(p.tcin)))
      : null;

    if (inStockProduct) {
      log.hit(`Found in-stock item: ${inStockProduct.name} — running full dry-run checkout test.`);
      await testDryRunCheckout(inStockProduct);
    } else {
      log.info("All watchlist items out of stock — running dry-run on first product (will stop at add-to-cart).");
      await testDryRunCheckout(sample);
    }

    if (!loggedIn) {
      log.warn("Fix login before a real drop — checkout will fail at place-order.");
    }
  } finally {
    await engine.stop().catch(() => {});
    await browser.close().catch(() => {});
  }

  printSummary();
}

function printSummary() {
  console.log("\n── Self-test summary ──");
  const hardFails = results.filter((r) => !r.ok);
  const warns = results.filter((r) => r.warn);
  for (const r of results) {
    const tag = r.ok ? (r.warn ? "WARN" : "PASS") : "FAIL";
    console.log(`  [${tag}] ${r.name}: ${r.detail}`);
  }
  console.log("");
  if (hardFails.length) {
    console.log(`  ${hardFails.length} failure(s) — fix before relying on this for drops.`);
    process.exitCode = 1;
  } else if (warns.length) {
    console.log("  Core systems OK. Dry-run could not finish add-to-cart because items are OOS (normal).");
    console.log("  On a real drop, in-stock detection → checkout will run automatically.");
  } else {
    console.log("  All checks passed — bot is ready for drops.");
  }
}

main().catch((err) => {
  log.err(err.message);
  process.exitCode = 1;
});
