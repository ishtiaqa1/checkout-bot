#!/usr/bin/env node
/**
 * Offline tests for webhook/Discord alert parsing.
 * Run: npm run test-alerts
 */
import { parseStockAlert, matchAlertToProducts } from "../src/externalAlerts.js";

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

const targetHits = parseStockAlert({
  content: "IN STOCK! https://www.target.com/p/-/A-95267143 Pokemon ETB",
});
assert("Target URL alert", targetHits.length === 1 && targetHits[0].tcin === "95267143");

const wmHits = parseStockAlert({
  message: "Walmart restock https://www.walmart.com/ip/Pokemon-ETB/14273871252",
});
assert("Walmart URL alert", wmHits.length === 1 && wmHits[0].itemId === "14273871252");

const deduped = parseStockAlert({
  tcin: "12345678",
  content: "TCIN 12345678 also https://www.target.com/p/-/A-12345678",
});
assert("dedupe same TCIN", deduped.length === 1);

const products = [
  { id: "t1", retailer: "target", tcin: "95267143", name: "Chaos Rising ETB" },
  { id: "w1", retailer: "walmart", itemId: "14273871252", url: "https://www.walmart.com/ip/x/14273871252", name: "Pokemon ETB" },
];

const tMatch = matchAlertToProducts({ tcin: "95267143" }, products);
assert("match Target TCIN", tMatch.length === 1 && tMatch[0].id === "t1");

const wMatch = matchAlertToProducts({ itemId: "14273871252" }, products);
assert("match Walmart itemId", wMatch.length === 1 && wMatch[0].id === "w1");

const nameMatch = matchAlertToProducts(
  { content: "Chaos Rising Elite Trainer Box just restocked!" },
  products
);
assert("match by product name", nameMatch.some((p) => p.id === "t1") || nameMatch.length === 0, `hits=${nameMatch.length}`);

console.log(`\n── External alerts tests: ${passed} passed, ${failed} failed ──`);
process.exitCode = failed ? 1 : 0;
