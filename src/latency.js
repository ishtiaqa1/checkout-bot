/**
 * Checkout latency telemetry — timestamps from stock/queue signal → order confirmation.
 * Used to measure Target/Walmart detection-to-checkout and signal-to-queue speed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_PATH = path.join(ROOT, "data", "latency-history.json");

const PHASES = [
  "external_signal",
  "drop_open",
  "activation_reload",
  "queue_recognized",
  "queue_cleared",
  "stock_signal",
  "stock_confirmed",
  "atc_start",
  "atc_ok",
  "cart_confirmed",
  "checkout_nav",
  "checkout_ready",
  "place_order",
  "order_confirmed",
  "done",
  "failed",
];

/** Restart-safe run history. Tests can opt out with persist:false. */
const history = [];
const MAX_HISTORY = 250;

function loadHistory() {
  try {
    const rows = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    if (Array.isArray(rows)) history.push(...rows.slice(0, MAX_HISTORY));
  } catch {
    /* first run / malformed telemetry: start clean */
  }
}

function persistHistory() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    const tmp = `${HISTORY_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history.slice(0, MAX_HISTORY), null, 2), "utf8");
    fs.renameSync(tmp, HISTORY_PATH);
  } catch {
    /* telemetry must never interrupt checkout */
  }
}

loadHistory();

/** Create a new latency trace for one checkout / queue attempt. */
export function createLatencyTrace({ productId, retailer, source, name, accountId = null, persist = true } = {}) {
  const t0 = Date.now();
  const marks = Object.create(null);
  marks.start = t0;

  const mark = (phase) => {
    if (!PHASES.includes(phase) && phase !== "start") return;
    if (marks[phase] == null) marks[phase] = Date.now();
  };

  const elapsed = (phase) => {
    const t = marks[phase];
    return t != null ? t - t0 : null;
  };

  const span = (from, to) => {
    if (marks[from] == null || marks[to] == null) return null;
    return marks[to] - marks[from];
  };

  const finish = ({ ok = false, error = null } = {}) => {
    mark(ok ? "done" : "failed");
    const signalMark =
      marks.stock_signal != null
        ? "stock_signal"
        : marks.external_signal != null
          ? "external_signal"
          : marks.drop_open != null
            ? "drop_open"
            : "start";
    const summary = {
      productId: productId || null,
      retailer: retailer || null,
      source: source || null,
      name: name || null,
      accountId,
      ok: !!ok,
      error: error ? String(error).slice(0, 160) : null,
      startedAt: t0,
      finishedAt: Date.now(),
      totalMs: Date.now() - t0,
      marks: { ...marks },
      spans: {
        signalToQueue:
          span("external_signal", "queue_recognized") ??
          span("drop_open", "queue_recognized") ??
          span("stock_signal", "queue_recognized"),
        reloadToQueue: span("activation_reload", "queue_recognized"),
        queueToCleared: span("queue_recognized", "queue_cleared"),
        clearedToAtc: span("queue_cleared", "atc_start"),
        signalToAtc: span(signalMark, "atc_start") ?? span("start", "atc_start"),
        atcMs: span("atc_start", "atc_ok"),
        atcToCheckout: span("atc_ok", "checkout_ready") ?? span("atc_ok", "checkout_nav"),
        checkoutToPlace: span("checkout_ready", "place_order"),
        placeToConfirm: span("place_order", "order_confirmed"),
        signalToCheckout: span(signalMark, "checkout_ready") ?? span("start", "checkout_ready"),
        signalToDone: Date.now() - t0,
      },
    };
    history.unshift(summary);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    if (persist) persistHistory();
    return summary;
  };

  return { mark, elapsed, span, finish, marks, t0 };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Aggregate recent runs for dashboard / benchmarks. */
export function getLatencyStats({ retailer, limit = 20 } = {}) {
  const allRows = retailer ? history.filter((r) => r.retailer === retailer) : history;
  let rows = allRows;
  rows = rows.slice(0, limit);

  const totals = rows.filter((r) => r.ok && Number.isFinite(r.totalMs)).map((r) => r.totalMs).sort((a, b) => a - b);
  const toCheckout = rows
    .map((r) => r.spans?.signalToCheckout)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const toQueue = rows
    .map((r) => r.spans?.signalToQueue)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  return {
    count: rows.length,
    okCount: rows.filter((r) => r.ok).length,
    p50TotalMs: percentile(totals, 50),
    p95TotalMs: percentile(totals, 95),
    p50CheckoutMs: percentile(toCheckout, 50),
    p95CheckoutMs: percentile(toCheckout, 95),
    p50QueueMs: percentile(toQueue, 50),
    p95QueueMs: percentile(toQueue, 95),
    readinessGate:
      retailer === "target" || !retailer
        ? buildReadinessGate(allRows.filter((r) => !retailer || r.retailer === "target"))
        : null,
    recent: rows.slice(0, 10).map((r) => ({
      name: r.name,
      retailer: r.retailer,
      source: r.source,
      accountId: r.accountId || null,
      ok: r.ok,
      totalMs: r.totalMs,
      signalToCheckout: r.spans?.signalToCheckout ?? null,
      signalToQueue: r.spans?.signalToQueue ?? null,
      atcMs: r.spans?.atcMs ?? null,
      error: r.error,
      finishedAt: r.finishedAt,
    })),
  };
}

function buildReadinessGate(rows) {
  const measured = rows.filter(
    (r) => r.retailer === "target" && r.ok && Number.isFinite(r.spans?.signalToCheckout)
  );
  const values = measured.map((r) => r.spans.signalToCheckout).sort((a, b) => a - b);
  const p50Ms = percentile(values, 50);
  const p95Ms = percentile(values, 95);
  const checks = {
    samples: measured.length >= 30,
    p50: p50Ms != null && p50Ms <= 4000,
    p95: p95Ms != null && p95Ms <= 10000,
  };
  return {
    ready: checks.samples && checks.p50 && checks.p95,
    measuredSamples: measured.length,
    requiredSamples: 30,
    p50Ms,
    p95Ms,
    thresholds: { p50Ms: 4000, p95Ms: 10000 },
    checks,
  };
}

export function getReadinessGate({ retailer = "target" } = {}) {
  const rows = history.filter((r) => r.retailer === retailer);
  return retailer === "target" ? buildReadinessGate(rows) : null;
}

export function clearLatencyHistory({ persist = false } = {}) {
  history.length = 0;
  if (persist) persistHistory();
}

export { PHASES as LATENCY_PHASES };
