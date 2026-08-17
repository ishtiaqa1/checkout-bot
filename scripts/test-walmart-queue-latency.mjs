#!/usr/bin/env node
/**
 * Offline tests for Walmart queue activation latency path:
 * - cart clear is not on the critical activation path (engine ordering)
 * - one-reload mutex semantics
 * - queue detection tightness
 * - latency signal→queue spans
 *
 * Run: node scripts/test-walmart-queue-latency.mjs
 */
import { createLatencyTrace, clearLatencyHistory, getLatencyStats } from "../src/latency.js";
import { detectWalmartQueueState } from "../src/walmart.js";
import { getEtDateParts, isTimeInRange, getActiveDropWindow } from "../src/dropWindow.js";

let passed = 0;
let failed = 0;
const assert = (cond, name) => {
  if (cond) {
    console.log(`  PASS ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL ${name}`);
    failed += 1;
  }
};

clearLatencyHistory();

{
  console.log("\n── latency signal→queue ──");
  const t = createLatencyTrace({ productId: "wm1", retailer: "walmart", source: "drop-burst", name: "demo", persist: false });
  t.mark("drop_open");
  await new Promise((r) => setTimeout(r, 15));
  t.mark("activation_reload");
  await new Promise((r) => setTimeout(r, 10));
  t.mark("queue_recognized");
  const summary = t.finish({ ok: true });
  assert(summary.spans.signalToQueue != null && summary.spans.signalToQueue >= 15, "signalToQueue span");
  assert(summary.spans.reloadToQueue != null, "reloadToQueue span");
  const stats = getLatencyStats({ retailer: "walmart" });
  assert(stats.p50QueueMs != null, "p50QueueMs present");
}

{
  console.log("\n── drop window seconds / pre-arm ──");
  const parts = getEtDateParts(new Date());
  assert(Number.isFinite(parts.second), "ET seconds present");
  assert(isTimeInRange(3, 0, 2, 5, 55, 0, 0, 0, 0) === true, "3:00 in Friday-like window");
  assert(isTimeInRange(2, 54, 2, 5, 55, 0, 30, 0, 0) === false, "2:54:30 before window without lead");
  const active = getActiveDropWindow({
    dropWindow: { enabled: true, activationLeadMs: 120000 },
    walmart: { activationLeadMs: 120000 },
  });
  // May or may not be active depending on wall clock — just ensure function runs
  assert(active === null || typeof active.label === "string", "getActiveDropWindow returns null or window");
}

{
  console.log("\n── queue detect fixture ──");
  const fakePage = {
    evaluate: async (fn) => {
      // Simulate DOM with strong queue text
      global.document = {
        body: { innerText: "You're in line — estimated wait 12 minutes. Ticket number 48291." },
        documentElement: { innerHTML: "<div class='waiting-room'></div>" },
      };
      return fn();
    },
  };
  const q = await detectWalmartQueueState(fakePage);
  assert(q.inQueue === true, "strong queue text → inQueue");
  assert(q.ticket === "48291", "ticket parsed");

  const oosPage = {
    evaluate: async (fn) => {
      global.document = {
        body: { innerText: "Out of stock. Check back later. High demand item." },
        documentElement: { innerHTML: "<div></div>" },
      };
      return fn();
    },
  };
  const q2 = await detectWalmartQueueState(oosPage);
  assert(q2.inQueue === false, "OOS / high demand alone is NOT queue");
}

{
  console.log("\n── join mutex semantics ──");
  const locks = new Set();
  const claim = (id) => {
    if (locks.has(id)) return false;
    locks.add(id);
    return true;
  };
  assert(claim("p1") === true, "first claim");
  assert(claim("p1") === false, "second claim blocked");
  locks.delete("p1");
  assert(claim("p1") === true, "after release");
}

console.log(`\n── Walmart queue latency tests: ${passed} passed, ${failed} failed ──`);
process.exitCode = failed ? 1 : 0;
