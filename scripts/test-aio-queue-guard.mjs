#!/usr/bin/env node
/**
 * Queue-safety + performance helpers unit checks (no live browser).
 * Run: node scripts/test-aio-queue-guard.mjs
 */
import { createOrderGuard } from "../src/circuitBreaker.js";
import { TaskBus } from "../src/taskBus.js";

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

console.log("\n── duplicate order prevention ──");
const guard = createOrderGuard({ ttlMs: 60000 });
const key = "local:walmart:19632512887";
assert(guard.tryAcquire(key), "acquire checkout lock");
assert(!guard.tryAcquire(key), "second ATC/order blocked");
assert(guard.isLocked(key), "still locked");
guard.release(key);
assert(!guard.isLocked(key), "released");

console.log("\n── one checkout per account ──");
const bus = new TaskBus();
assert(bus.beginCheckout("acct-1", "sku-a"), "acct-1 starts");
assert(!bus.beginCheckout("acct-1", "sku-b"), "same account cannot dual-checkout");
assert(bus.beginCheckout("acct-2", "sku-a"), "different account OK");
bus.endCheckout("acct-1", { ordered: true });
bus.endCheckout("acct-2", { ordered: false });
assert(!bus.canCheckout("acct-1", { maxOrders: 1 }), "order cap");
assert(bus.canCheckout("acct-2", { maxOrders: 1 }), "acct-2 still free");

console.log(`\n── queue/order guards: ${passed} passed, ${failed} failed ──`);
process.exitCode = failed ? 1 : 0;
