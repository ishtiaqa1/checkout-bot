#!/usr/bin/env node
/**
 * Unit tests: latency telemetry, circuit breaker, order guard, task bus.
 * Run: node scripts/test-aio-speed.mjs
 */
import { createLatencyTrace, getLatencyStats, clearLatencyHistory } from "../src/latency.js";
import { createCircuitBreaker, createOrderGuard } from "../src/circuitBreaker.js";
import { loadAccountProfiles, TaskBus } from "../src/taskBus.js";
import { WATCHDOG_ALLOWED_ACTIONS } from "../src/watchdog.js";

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
  console.log("\n── latency ──");
  const t = createLatencyTrace({ productId: "p1", retailer: "target", source: "test", name: "demo", persist: false });
  t.mark("stock_signal");
  await new Promise((r) => setTimeout(r, 20));
  t.mark("atc_start");
  t.mark("atc_ok");
  t.mark("checkout_ready");
  const summary = t.finish({ ok: true });
  assert(summary.ok === true, "finish ok");
  assert(summary.totalMs >= 20, "totalMs recorded");
  assert(summary.spans.atcMs != null || summary.spans.signalToCheckout != null, "spans present");
  const stats = getLatencyStats({ retailer: "target" });
  assert(stats.count >= 1, "history has run");
  assert(stats.okCount >= 1, "okCount");
}

{
  console.log("\n── circuit breaker ──");
  const cb = createCircuitBreaker({ name: "t", failureThreshold: 2, cooldownMs: 50, halfOpenMax: 1 });
  assert(cb.allow() === true, "starts closed");
  cb.failure();
  assert(cb.allow() === true, "still closed after 1 fail");
  cb.failure();
  assert(cb.state === "open", "opens after threshold");
  assert(cb.allow() === false, "blocks while open");
  await new Promise((r) => setTimeout(r, 60));
  assert(cb.allow() === true, "half-open after cooldown");
  cb.success();
  assert(cb.state === "closed", "success closes");
}

{
  console.log("\n── order guard ──");
  const g = createOrderGuard({ ttlMs: 5000 });
  assert(g.tryAcquire("a:1") === true, "first acquire");
  assert(g.tryAcquire("a:1") === false, "duplicate blocked");
  g.release("a:1");
  assert(g.tryAcquire("a:1") === true, "after release");
}

{
  console.log("\n── task bus / accounts ──");
  const accounts = loadAccountProfiles({ accounts: [{ id: "a1", retailer: "target", maxOrders: 1 }] });
  assert(accounts.length === 1 && accounts[0].id === "a1", "loadAccountProfiles");
  const local = loadAccountProfiles({});
  assert(local[0].id === "local", "default local account");

  const bus = new TaskBus();
  let got = null;
  bus.on("stock", (e) => {
    got = e;
  });
  bus.publishStock({ retailer: "target", productKey: "123", source: "test" });
  assert(got?.productKey === "123", "publish stock");
  assert(bus.canCheckout("a1", { maxOrders: 1 }) === true, "can checkout");
  assert(bus.beginCheckout("a1", "123") === true, "begin");
  assert(bus.canCheckout("a1", { maxOrders: 1 }) === false, "busy");
  bus.endCheckout("a1", { ordered: true });
  assert(bus.canCheckout("a1", { maxOrders: 1 }) === false, "max orders hit");
  assert(WATCHDOG_ALLOWED_ACTIONS.has("notify"), "watchdog allowlist");
}

console.log(`\n── AIO speed unit tests: ${passed} passed, ${failed} failed ──`);
process.exitCode = failed ? 1 : 0;
