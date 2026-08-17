#!/usr/bin/env node
/**
 * Offline unit tests for Walmart helpers (no browser).
 * Run: node scripts/test-walmart.mjs
 */
import { walmartItemId, walmartProductUrl, passesPriceGuard } from "../src/walmart.js";
import { loadConfig } from "../src/config.js";

let passed = 0;
let failed = 0;

function assert(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}${detail ? `: ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

// walmartItemId
assert(
  "itemId from /ip/slug/id URL",
  walmartItemId({ url: "https://www.walmart.com/ip/Pokemon-ETB/14273871252" }) === "14273871252"
);
assert(
  "explicit itemId field",
  walmartItemId({ itemId: "99988877" }) === "99988877"
);
assert(
  "short walmart URL",
  walmartItemId({ url: "https://www.walmart.com/ip/14273871252" }) === "14273871252"
);
assert("missing id returns null", walmartItemId({ url: "https://www.walmart.com/browse/pokemon" }) === null);

// walmartProductUrl
assert(
  "builds URL from itemId",
  walmartProductUrl({ itemId: "12345678" }) === "https://www.walmart.com/ip/12345678"
);
assert(
  "preserves full walmart URL",
  walmartProductUrl({ url: "https://www.walmart.com/ip/foo/14273871252?selected=true" }) ===
    "https://www.walmart.com/ip/foo/14273871252?selected=true"
);

// config retailer switch
const cfg = loadConfig();
assert("config loads retailer", ["target", "walmart", "both"].includes(cfg.retailer), `retailer=${cfg.retailer}`);
assert("price guard allows under max", passesPriceGuard({ maxPrice: 50 }, 49.99).ok);
assert("price guard blocks over max", !passesPriceGuard({ maxPrice: 50 }, 79.99).ok);
assert("price guard skips when no max", passesPriceGuard({}, 999).ok);
const wm = (cfg.products || []).find((p) => p.retailer === "walmart" || /walmart\.com/i.test(p.url || ""));
if (wm) {
  assert("walmart product normalized", !!wm.itemId || !!wm.url, wm.name || wm.id);
} else {
  console.log("  INFO no walmart products in config — add one via dashboard to test live monitor");
}

console.log(`\n── Walmart unit tests: ${passed} passed, ${failed} failed ──`);
process.exitCode = failed ? 1 : 0;
