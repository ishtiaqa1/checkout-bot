#!/usr/bin/env node

import { Engine } from "../src/engine.js";
import { createLatencyTrace, clearLatencyHistory, getReadinessGate } from "../src/latency.js";

let passed = 0;
let failed = 0;
const assert = (condition, name) => {
  if (condition) {
    console.log(`  PASS ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL ${name}`);
    failed += 1;
  }
};

console.log("\n── isolated account routing ──");
const engine = new Engine();
engine.config = {
  ...engine.config,
  accountMode: "multi",
  accountFanOut: 2,
  accountStrategy: "first",
  accounts: [
    { id: "acct-a", label: "A", retailer: "both", maxOrders: 2, enabled: true },
    { id: "acct-b", label: "B", retailer: "both", maxOrders: 2, enabled: true },
  ],
};
engine._accounts = [
  { id: "acct-a", label: "A", retailer: "both", maxOrders: 2, enabled: true },
  { id: "acct-b", label: "B", retailer: "both", maxOrders: 2, enabled: true },
];
engine._sessionManager.updateConfig(engine.config);
engine._sessionCvvByAccount.set("acct-a", "111");
engine._sessionCvvByAccount.set("acct-b", "222");

assert(engine._cfgWithCvv(engine.config, "acct-a").checkout.cvv === "111", "account A CVV");
assert(engine._cfgWithCvv(engine.config, "acct-b").checkout.cvv === "222", "account B CVV");
assert(engine._accountsForProduct({ id: "p1", retailer: "target" }).length === 2, "configured fan-out");
assert(
  engine._walmartRuntimeKey({ id: "wm1" }, "acct-a") !== engine._walmartRuntimeKey({ id: "wm1" }, "acct-b"),
  "Walmart queue state keyed per account"
);
assert(engine._breakerFor("target", "acct-a") !== engine._breakerFor("target", "acct-b"), "circuit breakers isolated");

const pages = new Map();
const fakeSessionManager = {
  accountMode: () => "multi",
  ensureSession: async (id) => {
    if (!pages.has(id)) {
      const page = { id, isClosed: () => false };
      pages.set(id, {
        context: { newPage: async () => page },
        pages: { checkout: null },
      });
    }
    return pages.get(id);
  },
};
engine._sessionManager = fakeSessionManager;
engine._ensureBrowser = async () => null;
const pageA = await engine._getCheckoutPage("acct-a");
const pageB = await engine._getCheckoutPage("acct-b");
assert(pageA !== pageB && pageA.id === "acct-a" && pageB.id === "acct-b", "checkout pages isolated");

console.log("\n── measured readiness gate ──");
clearLatencyHistory();
for (let i = 0; i < 30; i++) {
  const trace = createLatencyTrace({
    productId: `p-${i}`,
    retailer: "target",
    source: "routing-test",
    persist: false,
  });
  trace.mark("stock_signal");
  trace.marks.checkout_ready = trace.marks.stock_signal + 3000;
  trace.finish({ ok: true });
}
const gate = getReadinessGate({ retailer: "target" });
assert(gate.measuredSamples === 30, "30 measured samples required");
assert(gate.ready && gate.p50Ms === 3000 && gate.p95Ms === 3000, "p50/p95 thresholds enforced");

console.log(`\n── Account routing tests: ${passed} passed, ${failed} failed ──`);
process.exitCode = failed ? 1 : 0;
