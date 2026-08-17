#!/usr/bin/env node
/**
 * Real Target browser dry-run benchmark.
 * Calls the dashboard's /api/test endpoint sequentially. That endpoint forcibly
 * sets dryRun:true and autoPlaceOrder:false, so this script cannot submit an order.
 *
 * Usage:
 *   npm run ui
 *   npm run bench-target -- --loops 30 --tcin 94960637
 */

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const loops = Math.max(1, Number(value("--loops", "30")) || 30);
const tcin = String(value("--tcin", "94960637"));
const baseUrl = String(value("--base-url", "http://localhost:5273")).replace(/\/$/, "");
const delayMs = Math.max(0, Number(value("--delay-ms", "1500")) || 0);

async function request(path, options) {
  const res = await fetch(`${baseUrl}${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

try {
  const state = await request("/api/state");
  if (state.running) throw new Error("Stop monitoring before the benchmark.");
  console.log(`Target browser dry-run benchmark: ${loops} run(s), TCIN ${tcin}`);
  console.log("Safety: /api/test forces dryRun=true and autoPlaceOrder=false.\n");

  let succeeded = 0;
  for (let i = 1; i <= loops; i++) {
    const started = Date.now();
    try {
      const out = await request("/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: `bench-target-${tcin}-${Date.now()}-${i}`,
          name: `Target benchmark ${tcin}`,
          retailer: "target",
          tcin,
          maxQuantity: 1,
          clearCart: true,
        }),
      });
      const ms = out.latencySummary?.spans?.signalToCheckout ?? out.totalMs ?? Date.now() - started;
      const ok = !!(out.ok && (out.result?.dryRun || out.result?.manual || out.latencySummary?.ok));
      if (ok) succeeded += 1;
      console.log(`  ${ok ? "PASS" : "FAIL"} ${i}/${loops} · ${(ms / 1000).toFixed(2)}s${out.error ? ` · ${out.error}` : ""}`);
    } catch (err) {
      console.log(`  FAIL ${i}/${loops} · ${err.message}`);
    }
    if (i < loops && delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const stats = await request("/api/latency");
  const gate = stats.readinessGate || {};
  console.log(
    `\nCompleted ${succeeded}/${loops} this run · persisted measured samples ${gate.measuredSamples || 0}/${gate.requiredSamples || 30}`
  );
  console.log(
    `p50 ${gate.p50Ms == null ? "—" : `${(gate.p50Ms / 1000).toFixed(2)}s`} (≤4s) · ` +
      `p95 ${gate.p95Ms == null ? "—" : `${(gate.p95Ms / 1000).toFixed(2)}s`} (≤10s)`
  );
  console.log(gate.ready ? "READINESS GATE PASSED" : "READINESS GATE NOT YET PASSED");
  process.exit(gate.ready ? 0 : 1);
} catch (err) {
  console.error(`Benchmark could not start: ${err.message}`);
  console.error(`Start the dashboard first: npm run ui`);
  process.exit(1);
}
