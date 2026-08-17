import { EventEmitter } from "node:events";
import { loadConfig } from "./config.js";
import { checkStockOnPage, nextInterval, recommendedPollMs, shouldUseLightPoll, batchCheckStockViaPageApi, ensureMonitorPage, confirmFastApiStock, checkStockLight, probeTargetApiHealth } from "./monitor.js";
import { getEffectiveMonitor, getEtDateParts } from "./dropWindow.js";
import { resolveProductByKeywords, fetchFavorites } from "./search.js";
import { launchBrowser, runCheckout as runTargetCheckout, checkTargetSession, humanPause, clearCartForDrop, ensureProductPage, isOnProductPage, scrollToBuyBox, apiPathStats, probeTargetCartApiHealth } from "./checkout.js";
import {
    attemptJoinWalmartQueue,
  activateWalmartQueueReload,
  watchForWalmartQueue,
  installWalmartQueueWatcher,
  installWalmartQueueNetworkTap,
  detectWalmartQueueState,
  checkWalmartStock,
  clearWalmartCart,
  ensureWalmartPage,
  isOnWalmartPage,
  isWalmartLoggedOut,
  pollWalmartQueueProgress,
  positionWalmartQueueTab,
  runWalmartCheckout,
  waitForWalmartCaptchaCleared,
  walmartItemId,
  walmartProductUrl,
  fetchWalmartFavorites,
} from "./walmart.js";
import { installFastPageRoutes, openChromeWindow, tileChromeWindows } from "./browserUtils.js";
import { isFirstPartyOnly } from "./shared.js";
import { notify } from "./notifier.js";
import { matchAlertToProducts, parseStockAlert } from "./externalAlerts.js";
import { startDiscordBridge, stopDiscordBridge } from "./discordBridge.js";
import { recoverStalledCheckout, aiAssistantSettings } from "./aiAssistant.js";
import { createLatencyTrace, getLatencyStats } from "./latency.js";
import { createCircuitBreaker, createOrderGuard } from "./circuitBreaker.js";
import { runReadinessGate } from "./readiness.js";
import { inspectMonitorPage } from "./watchdog.js";
import { loadAccountProfiles, taskBus } from "./taskBus.js";
import { SessionManager } from "./sessionManager.js";
import { selectAccountsForProduct } from "./accountRouter.js";
import { handleChallenge } from "./challenges/registry.js";
import { getSavedCvv, loadLocalSecrets, saveLocalSecrets } from "./localSecrets.js";

const RETRY_COOLDOWN_MS = 30000;
const RETRY_COOLDOWN_DROP_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Map an internal checkout phase to a user-facing status + label. */
const PHASE_TO_STATUS = {
  navigating: ["processing", "Opening product page"],
  joining_queue: ["in_queue", "Joining queue"],
  in_queue: ["in_queue", "In queue — holding spot"],
  adding_to_cart: ["processing", "Adding to cart"],
  in_cart: ["processing", "In cart"],
  checking_out: ["processing", "Checking out"],
  placing_order: ["placing_order", "Placing order"],
  dry_run: ["dry_run", "Dry run — cart filled"],
  needs_review: ["needs_review", "Awaiting your click"],
};

/**
 * The Engine owns the browser, per-product watcher tabs and per-product state.
 * It is an EventEmitter so the CLI and the web UI can both subscribe.
 *
 * Events ("event"):
 *   { kind: "log", level, message, time }
 *   { kind: "product", product }
 *   { kind: "state", running, browserOpen, busy, hasCvv }
 */
export class Engine extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.config = loadConfig(); // keep retailer/theme in sync with config.json from boot
    this.browser = null;
    this.products = new Map();
    this.pages = new Map(); // product.id -> dedicated Playwright page (tab)
    this.watchers = []; // active per-product watch loops
    this.cancelledProducts = new Set(); // product ids whose in-flight checkout to abort
    this.activeTask = null; // a running one-off (test/buy) task
    this.cancelRequested = false; // cancels the active one-off task
    this.sessionCvv = ""; // in-memory; optionally mirrored to data/local-secrets.json
    this._sessionCvvByAccount = new Map();
    {
      const saved = getSavedCvv();
      if (saved) {
        this.sessionCvv = saved;
        this._sessionCvvByAccount.set("local", saved);
      }
    }
    this.utilityPage = null; // persistent tab for login, favorites, search (never auto-closed)
    this._checkSlots = 0; // cap concurrent page reloads (stealth)
    this._checkWaiters = [];
    this._lastDropWindowLabel = null;
    this._dropCartCleared = false;
    this._wakeWatchers = false;
    this._dropBurstStarted = false;
    this._reloadCounters = new Map(); // product.id -> checks since last full reload
    this._discordBridge = null;
    this._checkoutQueue = Promise.resolve();
    this._monitorPage = null;
    this._checkoutPage = null;
    this._fastMonitorTask = null;
    this._lastFastHit = new Map();
    this._targetSignedIn = null;
    this._apiThrottleUntil = 0;
    this._pollCount = 0;
    this._lastHeartbeat = 0;
    this._lastApiStatus = new Map();
    this._sweepPages = [];
    this._sweepTasks = [];
    this._urgentSweepLock = false;
    this._sweepHeartbeats = new Map();
    this._walmartPages = new Map();
    this._walmartMonitorTasks = [];
    this._walmartInQueue = new Set();
    this._walmartEverQueued = new Set(); // runtimeKeys that actually entered the virtual line
    this._walmartQueueAbandoned = new Set(); // runtimeKeys retired only when queue is confirmed gone
    this._walmartQueueSignalAt = new Map(); // runtimeKey -> last real queue signal (UI or issueTicket)
    this._walmartMonitorsRunning = false;
    this._walmartDropReloaded = new Set();
    this._walmartJoinLocks = new Set(); // product ids with join/activation in flight
    this._walmartQueueTraces = new Map(); // product.id -> latency trace for signal→queue
    this._walmartSweepPage = null;
    this._walmartSweepTask = null;
    this._orderGuard = createOrderGuard({ ttlMs: 180000 });
    this._atcBreakers = new Map(); // retailer:accountId -> isolated breaker
    this._watchdogTimer = null;
    this._watchdogNotifyAt = new Map(); // key -> last notify ms (rate-limit desktop spam)
    this._watchdogRecoverAt = new Map(); // page id -> last recover attempt ms
    this._dropWindowTimer = null;
    this._dropWindowTicking = false;
    this._lastReadiness = null;
    this._accounts = loadAccountProfiles(this.config);
    this._sessionManager = new SessionManager({
      config: this.config,
      onLog: (level, msg) => this.log(level, msg),
    });
    this._apiFallbackCount = 0;
    this._apiBlitzCount = 0;
  }

  _usesFastApiMonitor(cfg = this.config) {
    if (cfg?.monitor?.fastApiMonitor?.enabled === false) return false;
    const mode = cfg?.monitor?.mode ?? "fast";
    return mode === "fast" || mode === "hybrid";
  }

  _usesExternalMonitor(cfg = this.config) {
    const mode = cfg?.monitor?.mode ?? "fast";
    return mode === "external" || mode === "hybrid";
  }

  async _getCheckoutPage(accountId = null) {
    await this._ensureBrowser();
    if (this._sessionManager.accountMode() === "multi" && accountId) {
      const session = await this._sessionManager.ensureSession(accountId);
      const existing = session.pages.checkout;
      if (existing) {
        try {
          if (!existing.isClosed()) return existing;
        } catch {
          /* stale */
        }
      }
      session.pages.checkout = await this._claimOrNewPage(session.context);
      return session.pages.checkout;
    }
    if (this._checkoutPage) {
      try {
        if (!this._checkoutPage.isClosed()) return this._checkoutPage;
      } catch {
        /* stale */
      }
    }
    this._checkoutPage = await this._claimOrNewPage(this.browser);
    return this._checkoutPage;
  }

  /** Pre-open a dedicated checkout tab so stock hits skip cold tab startup. */
  async _warmCheckoutTab() {
    const accountIds =
      this._sessionManager.accountMode() === "multi"
        ? this._accounts.filter((a) => a.enabled !== false && (a.retailer === "target" || a.retailer === "both")).map((a) => a.id)
        : [null];
    await Promise.all(
      accountIds.map(async (accountId) => {
        const page = await this._getCheckoutPage(accountId);
        await page
          .goto("https://www.target.com/checkout", { waitUntil: "commit", timeout: 15000 })
          .catch(() => {});
      })
    );
    this.log("ok", `Checkout tab${accountIds.length === 1 ? "" : "s"} pre-warmed on /checkout for ${accountIds.length} account${accountIds.length === 1 ? "" : "s"}.`);
    await this._closeExtraBlankTabs();
  }

  _logReadinessCheck() {
    const cfg = this.config;
    const products = (cfg.products || []).filter((p) => p.enabled !== false && this._hasProductId(p));
    const co = cfg.checkout || {};
    const mon = cfg.monitor || {};
    const hype = this._isHypeMode(cfg);
    const dropMon = this._effectiveMonitor(products.length);

    const active = products.filter((p) => this._retailerActive(p));
    const nWm = active.filter((p) => this._retailer(p) === "walmart").length;
    const nTg = active.length - nWm;
    this.log(
      "ok",
      `Ready: ${nTg} Target + ${nWm} Walmart product${active.length === 1 ? "" : "s"} · ${mon.mode || "fast"} monitor · ${hype ? "hype" : "drop"} checkout${this._performanceMode(cfg) ? " · perf" : ""} · ${co.checkoutRetries ?? 12} retries`
    );

    if (!this.sessionCvv && co.autoPlaceOrder && !co.dryRun) {
      this.log("warn", "No CVV in dashboard — enter it (and optionally Remember) before drops or place-order will fail.");
    }
    const profile = cfg.checkoutProfile || {};
    if (!(profile.fullName || profile.shipping?.line1) && co.autoPlaceOrder && !co.dryRun) {
      this.log("info", "Checkout profile empty — fill name/address in the dashboard Profile section for easier autofill.");
    }
    if (this._targetSignedIn === false) {
      this.log("warn", "Target login not verified — click Login in the dashboard and sign in in the bot Chrome window.");
    }
    if (co.dryRun) {
      this.log("warn", "DRY RUN is ON — switch off to actually purchase.");
    }
    if (!co.autoPlaceOrder) {
      this.log("warn", "AUTO-BUY is OFF — bot will fill cart but won't place order.");
    }
    if (this._usesFastApiMonitor(cfg)) {
      const dropMs = mon.fastApiMonitor?.dropPollIntervalMs ?? 250;
      const offMs = mon.fastApiMonitor?.pollIntervalMs ?? 2500;
      const poll = dropMon.dropWindowActive ? dropMs : offMs;
      this.log(
        "info",
        `Fast API polls armed TCINs every ~${(poll / 1000).toFixed(1)}s${dropMon.dropWindowActive ? ` (${dropMon.dropWindowLabel})` : ""}.`
      );
      if (dropMon.dropWindowActive) {
        this.log("info", "Drop window: PDP sweep tabs reload armed product pages (background tabs stay stale).");
      }
    }
    if (nWm > 0 && this._walmartQueueMode(cfg)) {
      this.log(
        "info",
        "Walmart queue mode: one tab per product at drop · Press & Hold auto-tried · tabs held open while in line (never reload in queue)."
      );
    }
  }

  _targetWatchlist(cfg = this.config) {
    return (cfg?.products || []).filter(
      (p) => p.enabled !== false && this._retailer(p) === "target" && p.tcin && this._retailerActive(p, cfg)
    );
  }

  _walmartWatchlist(cfg = this.config) {
    return (cfg?.products || []).filter(
      (p) => p.enabled !== false && this._retailer(p) === "walmart" && walmartItemId(p) && this._retailerActive(p, cfg)
    );
  }

  /** Fresh PDP load for drop sweeps. Avoid constant bringToFront — it makes Chrome feel glitchy. */
  async _checkProductOnSweepPage(page, product, { workerId = 0, label = "PDP SWEEP", focus = false } = {}) {
    const st = this.products.get(product.id);
    if (!st || st.status === "skipped" || st.busy) return false;
    if (st.status === "success" && !this._loopCheckouts(this.config)) return false;

    const url = product.url || `https://www.target.com/p/-/A-${product.tcin}`;
    if (focus) await page.bringToFront().catch(() => {});
    await page.goto(url, { waitUntil: "commit", timeout: 12000 }).catch(() => {});

    const body = await page.evaluate(() => (document.body?.innerText || "").slice(0, 3000)).catch(() => "");
    if (/page is currently unavailable|we're sorry.*unavailable/i.test(body)) {
      await page.reload({ waitUntil: "commit", timeout: 10000 }).catch(() => {});
    }

    const pdp = await checkStockLight(page, product, { fast: true, domOnly: true });
    this._setProduct(
      product.id,
      {
        lastChecked: Date.now(),
        detail: pdp.inStock ? `${label} — IN STOCK!` : `${label} (${pdp.status})`,
      },
      { quiet: !pdp.inStock }
    );

    if (pdp.thirdParty && isFirstPartyOnly(this.config)) {
      this._setProduct(product.id, { status: "skipped", detail: "Third-party seller — skipped" });
      return false;
    }

    if (pdp.inStock) {
      await page.bringToFront().catch(() => {});
      this._logDrop(
        "STOCK",
        `${label}[w${workerId}]: ${product.name || product.tcin} (TCIN ${product.tcin}) — ${pdp.button || "buyable"}`,
        "hit"
      );
      this._enqueueStockCheckout(product, { source: "pdp-sweep", note: "pdp-sweep" });
      return true;
    }
    return false;
  }

  async _urgentPdpCheck(product) {
    if (this._urgentSweepLock || !this.running) return;
    this._urgentSweepLock = true;
    try {
      const page = this._sweepPages.find((p) => p && !p.isClosed?.()) || this._sweepPages[0];
      if (!page || page.isClosed?.()) return;
      await this._checkProductOnSweepPage(page, product, { workerId: "urgent", label: "PDP URGENT", focus: true });
    } catch {
      /* non-fatal */
    } finally {
      this._urgentSweepLock = false;
    }
  }

  async _runPdpSweepWorker(page, products, workerId) {
    let sweepCount = 0;
    while (this.running) {
      const productCount = this._targetWatchlist().length || this.config.products?.length || 1;
      await this._checkDropWindowTransition(this.config.products?.length || 1);
      const mon = this._effectiveMonitor(productCount);
      if (!mon.dropWindowActive) {
        await this._sleepSlices(2000);
        continue;
      }

      // Wait for urgent checks instead of aborting the whole cycle (that caused empty spin loops).
      while (this.running && this._urgentSweepLock) {
        await this._sleepSlices(50);
      }

      let checked = 0;
      for (const product of products) {
        if (!this.running) break;
        if (this._urgentSweepLock) {
          while (this.running && this._urgentSweepLock) await this._sleepSlices(50);
        }
        try {
          await this._checkProductOnSweepPage(page, product, { workerId, label: "PDP SWEEP" });
          checked += 1;
        } catch {
          /* continue */
        }
      }

      if (checked > 0) sweepCount += 1;
      const lastHb = this._sweepHeartbeats.get(workerId) || 0;
      if (checked > 0 && Date.now() - lastHb > 30000) {
        this._sweepHeartbeats.set(workerId, Date.now());
        this._logDrop(
          "MONITOR",
          `PDP sweep worker ${workerId} — cycle #${sweepCount}, ${products.length} armed product(s)`,
          "info"
        );
      }
    }
  }

  _startPdpSweepWorkers() {
    const targets = this._targetWatchlist();
    if (!targets.length) return;

    // Fewer armed SKUs → more workers per item; large lists stay capped to avoid Chrome thrash.
    const workers =
      targets.length <= 4
        ? Math.min(targets.length, 3)
        : targets.length <= 12
          ? Math.min(4, targets.length)
          : Math.min(4, Math.ceil(targets.length / 8));
    this._sweepPages = [];
    this._sweepTasks = [];

    for (let w = 0; w < workers; w++) {
      const subset = targets.filter((_, i) => i % workers === w);
      if (!subset.length) continue;
      void this._ensureBrowser().then(async () => {
        const page = await this._claimOrNewPage(this.browser);
        await installFastPageRoutes(page);
        this._sweepPages[w] = page;
        this._sweepTasks.push(
          this._runPdpSweepWorker(page, subset, w).catch((err) =>
            this.log("err", `PDP sweep worker ${w} ended: ${err.message}`)
          )
        );
      });
    }
    this.log(
      "ok",
      `PDP sweep — ${workers} tab(s) covering ${targets.length} armed Target product(s) during drops.`
    );
  }

  _walmartQueueMode(cfg = this.config) {
    return cfg?.checkout?.walmartQueueMode !== false;
  }

  /** After this ET time, products may be retired only if the queue is confirmed gone. */
  _pastWalmartNoQueueCutoff(date = new Date()) {
    const { hour, minute } = getEtDateParts(date);
    const wm = this.config?.monitor?.walmart || {};
    const cutH = Number(wm.noQueueCutoffHourEt ?? 21);
    const cutM = Number(wm.noQueueCutoffMinuteEt ?? 5);
    return hour > cutH || (hour === cutH && minute >= cutM);
  }

  _markWalmartQueueSignal(runtimeKey) {
    if (!runtimeKey) return;
    this._walmartQueueSignalAt.set(runtimeKey, Date.now());
  }

  /** True if we recently saw real queue activity (IN_QUEUE UI or issueTicket network). */
  _walmartQueueStillLive(runtimeKey, withinMs = 120000) {
    if (this._walmartInQueue.has(runtimeKey)) return true;
    const at = this._walmartQueueSignalAt.get(runtimeKey) || 0;
    return Date.now() - at < withinMs;
  }

  _isRealWalmartQueueNetworkUrl(url = "") {
    return /issueTicket|qpdata=.*queued|q-api\.www\.walmart\.com\/|\/qp\?|queue-it|waiting.?room/i.test(String(url));
  }

  _retireWalmartNoQueue(product, runtimeKey, reason) {
    // Never kill a task while the queue is still live — that was the 9:18 bug.
    if (this._walmartQueueStillLive(runtimeKey) || this._walmartInQueue.has(runtimeKey)) {
      this._logDrop(
        "WALMART",
        `${product.name || walmartItemId(product)}: skip retire — queue still live (${reason})`,
        "info"
      );
      return;
    }
    if (this._walmartQueueAbandoned.has(runtimeKey)) return;
    this._walmartQueueAbandoned.add(runtimeKey);
    this._walmartInQueue.delete(runtimeKey);
    this.cancelledProducts.add(product.id);
    this._setProduct(product.id, {
      status: "skipped",
      busy: false,
      availability: "NO_QUEUE",
      detail: reason,
      queueTicket: null,
    });
    this._logDrop("WALMART", `${product.name || walmartItemId(product)}: ${reason}`, "warn");
  }

  /** Checkout is only valid after leaving the virtual queue — never on false "buyable / no queue". */
  _walmartMayCheckout(runtimeKey, label = "") {
    if (!this._walmartQueueMode()) return true;
    if (label === "POST-QUEUE") return true;
    return this._walmartEverQueued.has(runtimeKey);
  }

  _walmartAccounts(product) {
    if (this._sessionManager.accountMode() !== "multi") {
      return [this._accounts?.[0] || { id: "local", label: "Local session" }];
    }
    return this._accountsForProduct(product);
  }

  _walmartRuntimeKey(product, accountId = null) {
    return this._sessionManager.accountMode() === "multi"
      ? `${accountId || this._accounts?.[0]?.id || "local"}:${product.id}`
      : product.id;
  }

  _walmartPage(product, accountId = null) {
    const key = this._walmartRuntimeKey(product, accountId);
    const session = accountId ? this._sessionManager.get(accountId) : null;
    return session?.pages?.walmart?.get(product.id) || this._walmartPages.get(key) || null;
  }

  _setWalmartPage(product, accountId, page) {
    const key = this._walmartRuntimeKey(product, accountId);
    this._walmartPages.set(key, page);
    const session = accountId ? this._sessionManager.get(accountId) : null;
    session?.pages?.walmart?.set(product.id, page);
    return page;
  }

  /**
   * Walmart monitor: dedicated tab(s) reload PDPs and read __NEXT_DATA__.
   * During drops uses one tab per product so each item gets its own queue slot.
   * While IN_QUEUE the tab is never reloaded (reload loses your place in line).
   */
  async _handleWalmartCheckResult(page, product, r, { label = "WALMART", accountId = null } = {}) {
    if (!r) return false;
    const runtimeKey = this._walmartRuntimeKey(product, accountId);
    const accountNote = accountId ? ` · ${accountId}` : "";

    if (String(r.status) === "BLOCKED") {
      this._setProduct(product.id, {
        lastChecked: Date.now(),
        availability: "BLOCKED",
        detail: 'Walmart PX — Press & Hold (bot tries auto-hold; solve in Chrome if needed)',
      });
      this._logDrop("WALMART", `Bot challenge on ${product.name || walmartItemId(product)} — Press & Hold…`, "warn");
      notify(this.config, {
        title: "Walmart Press & Hold",
        message: "PX challenge on Walmart — bot is trying auto-hold; solve in Chrome if it persists.",
      });
      const cleared = await waitForWalmartCaptchaCleared(page, {
        onWait: (msg) => this._logDrop("WALMART", msg, "warn"),
        config: this.config,
      });
      if (!cleared) {
        await handleChallenge({
          kind: "hold",
          retailer: "walmart",
          page,
          config: this.config,
          onLog: (level, msg) => this._logDrop("WALMART", msg, level === "ok" ? "ok" : "warn"),
        }).catch(() => {});
        return false;
      }
      return true;
    }

    if (r.inQueue || String(r.status) === "IN_QUEUE") {
      this._walmartInQueue.add(runtimeKey);
      this._walmartEverQueued.add(runtimeKey);
      this._walmartQueueAbandoned.delete(runtimeKey);
      this._markWalmartQueueSignal(runtimeKey);
      const trace = this._walmartQueueTraces.get(runtimeKey);
      if (trace) {
        trace.mark("queue_recognized");
        const summary = trace.finish({ ok: true });
        if (summary?.spans?.signalToQueue != null) {
          this._logDrop(
            "SPEED",
            `${product.name || walmartItemId(product)}${accountNote}: signal→queue ${(summary.spans.signalToQueue / 1000).toFixed(2)}s`,
            "ok"
          );
        }
        this._walmartQueueTraces.delete(runtimeKey);
      }
      const ticket = r.queueTicket ? `ticket ${r.queueTicket}` : "in line";
      const waitNote = r.queueWaitMins ? ` · ~${r.queueWaitMins} min` : "";
      const unlikely = r.queueUnlikely ? " · unlikely" : "";
      this._setProduct(product.id, {
        status: "in_queue",
        lastChecked: Date.now(),
        availability: "IN_QUEUE",
        detail: `Walmart queue — ${ticket}${waitNote}${unlikely} (holding spot, no reload)`,
        queueTicket: r.queueTicket || null,
      });
      const prev = this._lastApiStatus.get(runtimeKey);
      if (prev !== "IN_QUEUE") {
        this._lastApiStatus.set(runtimeKey, "IN_QUEUE");
        this._logDrop("WALMART", `${product.name || walmartItemId(product)}${accountNote} → IN QUEUE (${ticket})`, "hit");
        notify(this.config, {
          title: "Walmart — in queue!",
          message: `${product.name || walmartItemId(product)} — ${ticket}. Tab held open; do not refresh.`,
        });
      }
      return false;
    }

    if (this._walmartInQueue.has(runtimeKey)) {
      this._walmartInQueue.delete(runtimeKey);
      const trace = this._walmartQueueTraces.get(runtimeKey);
      trace?.mark("queue_cleared");
      this._logDrop("WALMART", `${product.name || walmartItemId(product)} — left queue`, "ok");
    }

    if (String(r.status) === "PRICE_TOO_HIGH") {
      this._setProduct(product.id, {
        lastChecked: Date.now(),
        availability: r.status,
        detail: r.detail || `Price $${r.price} above max`,
      });
      return false;
    }

    if (r.thirdParty && isFirstPartyOnly(this.config)) {
      this._setProduct(product.id, {
        lastChecked: Date.now(),
        availability: r.status,
        detail: "Third-party Walmart seller — waiting for Walmart-sold stock",
      });
      return false;
    }

    this._setProduct(product.id, {
      lastChecked: Date.now(),
      availability: r.status,
      detail: r.inStock ? `${label} — IN STOCK!` : `Walmart watching (${r.status})`,
    });

    const prev = this._lastApiStatus.get(runtimeKey);
    if (prev !== r.status) {
      this._lastApiStatus.set(runtimeKey, r.status);
      const short = (product.name || walmartItemId(product) || "").slice(0, 55);
      this._logDrop("WALMART", `${short} → ${r.status}${r.inStock ? " (IN STOCK)" : ""}`, r.inStock ? "hit" : "info");
    }

    if (r.inStock) {
      // Queue-mode drops: ATC without a prior queue join is a false positive — never checkout.
      if (!this._walmartMayCheckout(runtimeKey, label)) {
        // After 9:05: only end the task if the queue is actually gone (not merely "not joined yet").
        if (this._pastWalmartNoQueueCutoff() && !this._walmartQueueStillLive(runtimeKey)) {
          this._retireWalmartNoQueue(
            product,
            runtimeKey,
            "Queue gone after 9:05 PM ET (buyable, no line) — task ended; no checkout"
          );
          return false;
        }
        this._setProduct(product.id, {
          lastChecked: Date.now(),
          availability: "PENDING_QUEUE",
          detail: this._walmartQueueStillLive(runtimeKey)
            ? "Queue still live — waiting to join / hold line (not checking out)"
            : "No queue yet — holding for line (not checking out)",
        });
        const prevIgnore = this._lastApiStatus.get(`noqueue:${runtimeKey}`);
        if (prevIgnore !== "IGNORED_BUYABLE") {
          this._lastApiStatus.set(`noqueue:${runtimeKey}`, "IGNORED_BUYABLE");
          this._logDrop(
            "WALMART",
            `${product.name || walmartItemId(product)}: buyable without queue join — ignored (queue-only)`,
            "warn"
          );
        }
        return false;
      }

      const priceNote = r.price != null ? ` @ $${r.price}` : "";
      this._logDrop("STOCK", `${label}: ${product.name || walmartItemId(product)} (${this._idLabel(product)})${priceNote} — ${r.button || "buyable"} (post-queue)`, "hit");
      // CRITICAL: checkout on the SAME page that cleared the queue (not a separate warm tab)
      this._enqueueStockCheckout(product, {
        source: "walmart-monitor",
        note: "walmart-post-queue",
        page,
        accountId,
      });
      return true;
    }

    // Do NOT retire on PENDING/UNKNOWN alone after 9:05 — queue may still be up.
    return false;
  }

  async _checkWalmartOnSweepPage(page, product, { label = "WALMART", accountId = null } = {}) {
    const st = this.products.get(product.id);
    if (!st || st.status === "skipped" || (st.busy && this._sessionManager.accountMode() !== "multi")) return false;
    if (st.status === "success" && !this._loopCheckouts(this.config)) return false;
    const runtimeKey = this._walmartRuntimeKey(product, accountId);

    if (this._walmartInQueue.has(runtimeKey)) {
      const r = await pollWalmartQueueProgress(page, product, {
        onLog: (level, msg) => this._logDrop("WALMART", msg, level),
        urgent: true,
      });
      if (r.inQueue) {
        await this._handleWalmartCheckResult(page, product, r, { label: "QUEUE", accountId });
        return false;
      }
      this._walmartInQueue.delete(runtimeKey);
      if (r.inStock) return this._handleWalmartCheckResult(page, product, r, { label: "POST-QUEUE", accountId });
      return false;
    }

    let r;
    try {
      const mon = this._effectiveMonitor(this.config.products?.length || 1);
      if (mon.dropWindowActive && this._walmartQueueMode()) {
        if (this._walmartJoinLocks.has(runtimeKey)) {
          // Burst owns activation — light detect only
          const q = await detectWalmartQueueState(page);
          if (q.inQueue) {
            r = {
              inStock: false,
              status: "IN_QUEUE",
              inQueue: true,
              queueTicket: q.ticket,
              button: "In queue",
            };
          } else {
            r = await checkWalmartStock(page, product, { fast: true, skipReload: true, mode: "light" });
          }
        } else {
          const dropReload = !this._walmartDropReloaded.has(runtimeKey);
          this._walmartJoinLocks.add(runtimeKey);
          try {
            const latency = this._walmartQueueTraces.get(runtimeKey) || createLatencyTrace({
              productId: product.id,
              retailer: "walmart",
              source: "walmart-worker",
              name: product.name || walmartItemId(product),
              accountId,
            });
            if (dropReload) latency.mark("drop_open");
            r = await attemptJoinWalmartQueue(page, product, {
              onLog: (level, msg) => this._logDrop("WALMART", msg, level),
              urgent: true,
              dropReload,
              waitForQueue: !dropReload,
              timeoutMs: Number(this.config.monitor?.walmart?.joinTimeoutMs) || 8000,
              latency,
            });
            if (dropReload) this._walmartDropReloaded.add(runtimeKey);
            this._walmartQueueTraces.set(runtimeKey, latency);
          } finally {
            this._walmartJoinLocks.delete(runtimeKey);
          }
        }
      } else if (mon.dropWindowActive) {
        // Pre-drop / off-hours: sit on PDP, light read only
        await positionWalmartQueueTab(page, product, {
          onLog: (level, msg) => this._logDrop("WALMART", msg, level),
        });
        r = await checkWalmartStock(page, product, { fast: true, skipReload: true, mode: "light" });
      } else {
        r = await checkWalmartStock(page, product, {
          fast: true,
          aggressive: false,
          skipReload: true,
          mode: "light",
        });
      }
    } catch (err) {
      this._setProduct(product.id, { lastChecked: Date.now(), detail: `Walmart check failed: ${err.message.slice(0, 70)}` });
      return false;
    }

    const needsRetry = await this._handleWalmartCheckResult(page, product, r, { label, accountId });
    if (needsRetry === true) return this._checkWalmartOnSweepPage(page, product, { label, accountId });
    return !!r?.inStock;
  }

  async _runWalmartProductWorker(page, product, accountId = null) {
    let cycles = 0;
    // Pre-position on PDP before drop — sit on page, don't spam reload
    await positionWalmartQueueTab(page, product, {
      onLog: (level, msg) => this._logDrop("WALMART", msg, level),
    }).catch(() => {});

    while (this.running) {
      await this._checkDropWindowTransition(this.config.products?.length || 1);
      const mon = this._effectiveMonitor(this.config.products?.length || 1);
      const wm = this.config.monitor?.walmart || {};
      const perProduct = mon.dropWindowActive ? (wm.dropPollIntervalMs ?? 400) : (wm.pollIntervalMs ?? 12000);
      const runtimeKey = this._walmartRuntimeKey(product, accountId);
      const inQueue = this._walmartInQueue.has(runtimeKey);
      const queuePollMs = mon.dropWindowActive ? 500 : 4000;
      const detectMs = Number(wm.queueDetectMs) || 200;
      // In drop + not yet queued: fast light poll for queue UI without reload
      const idlePollMs = inQueue ? queuePollMs : mon.dropWindowActive ? detectMs : perProduct;

      const st = this.products.get(product.id);
      if (this._walmartQueueAbandoned.has(runtimeKey)) {
        break; // task terminated — queue confirmed gone
      }
      if (!st || st.status === "skipped" || (st.busy && this._sessionManager.accountMode() !== "multi")) {
        await this._sleepSlices(500);
        continue;
      }

      try {
        await this._checkWalmartOnSweepPage(page, product, { accountId });
      } catch {
        /* keep monitoring */
      }

      cycles += 1;
      if (cycles === 1 || Date.now() - (this._walmartHeartbeat || 0) > 60000) {
        this._walmartHeartbeat = Date.now();
        const mode = inQueue ? "queue hold" : mon.dropWindowActive ? "drop" : "normal";
        this._logDrop(
          "WALMART",
          `${product.name || walmartItemId(product)}${accountId ? ` · ${accountId}` : ""} tab — ${mode}${inQueue ? " (no reload)" : ` · ~${(perProduct / 1000).toFixed(1)}s between checks`}`,
          "info"
        );
      }

      await this._sleepSlices(inQueue ? queuePollMs : idlePollMs);
    }
  }

  async _runWalmartSweepWorker(page) {
    let cycles = 0;
    while (this.running) {
      const products = this._walmartWatchlist();
      if (!products.length) {
        await this._sleepSlices(3000);
        continue;
      }

      const mon = this._effectiveMonitor(this.config.products?.length || 1);
      const wm = this.config.monitor?.walmart || {};
      const perProduct = mon.dropWindowActive ? (wm.dropPollIntervalMs ?? 1000) : (wm.pollIntervalMs ?? 12000);

      for (const product of products) {
        if (!this.running) break;
        const st = this.products.get(product.id);
        if (st?.busy) {
          await this._sleepSlices(500);
          continue;
        }
        try {
          await this._checkWalmartOnSweepPage(page, product);
        } catch {
          /* keep sweeping */
        }
        await this._sleepSlices(perProduct);
      }

      cycles += 1;
      if (Date.now() - (this._walmartHeartbeat || 0) > 60000) {
        this._walmartHeartbeat = Date.now();
        this._logDrop(
          "WALMART",
          `Sweep cycle #${cycles} — ${products.length} Walmart product(s), ~${(perProduct / 1000).toFixed(1)}s between reloads${mon.dropWindowActive ? " (drop window)" : ""}`,
          "info"
        );
      }
    }
  }

  _stopWalmartMonitors() {
    const tasks = [this._walmartSweepTask, ...(this._walmartMonitorTasks || [])].filter(Boolean);
    this._walmartSweepPage = null;
    this._walmartSweepTask = null;
    this._walmartMonitorTasks = [];
    this._walmartPages.clear();
    this._walmartInQueue.clear();
    this._walmartEverQueued.clear();
    this._walmartQueueAbandoned.clear();
    this._walmartQueueSignalAt.clear();
    this._walmartDropReloaded.clear();
    this._walmartMonitorsRunning = false;
    return tasks;
  }

  _startWalmartMonitors() {
    const walmarts = this._walmartWatchlist();
    if (!walmarts.length) return;
    this._walmartMonitorsRunning = true;

    void this._ensureBrowser().then(async () => {
      const mon = this._effectiveMonitor(walmarts.length);
      const useDedicatedTabs = mon.dropWindowActive || walmarts.length <= 8 || this._walmartQueueMode();

      if (useDedicatedTabs) {
        this._walmartMonitorTasks = [];
        const freshPages = [];
        let taskCount = 0;
        for (const product of walmarts) {
          for (const account of this._walmartAccounts(product)) {
            const session =
              this._sessionManager.accountMode() === "multi"
                ? await this._sessionManager.ensureSession(account.id)
                : this._sessionManager.get(account.id) || this._sessionManager.get("local");
            const context = session?.context || this.browser;
            let page = this._walmartPage(product, account.id);
            if (!page || page.isClosed?.()) {
              // Separate Chrome window per account/product preserves each queue cookie and proxy.
              page = await openChromeWindow(context, { url: walmartProductUrl(product) || "https://www.walmart.com/" });
              await installFastPageRoutes(page);
              this._setWalmartPage(product, account.id, page);
              freshPages.push(page);
            }
            await this._bindWalmartQueueWatchers(page, product, account.id);
            const task = this._runWalmartProductWorker(page, product, account.id).catch((err) =>
              this.log("err", `Walmart window monitor ended (${product.name} · ${account.label || account.id}): ${err.message}`)
            );
            this._walmartMonitorTasks.push(task);
            taskCount += 1;
          }
        }
        if (freshPages.length) {
          const tile = await tileChromeWindows(
            [...this._walmartPages.values()].filter((p) => p && !p.isClosed?.()),
            { onLog: (msg) => this.log("info", `Window layout: ${msg}`) }
          ).catch(() => null);
          if (tile) {
            this.log(
              "ok",
              `Tiled ${tile.ok}/${taskCount} Walmart windows (${tile.cols}×${tile.rows} grid) — no manual snapping needed.`
            );
          }
        }
        this.log(
          "ok",
          `Walmart queue monitor — ${taskCount} isolated account/product window(s). Queue opens when drop goes live (no ATC until line clears).`
        );
        await this._closeExtraBlankTabs();
      } else {
        const page = await this._claimOrNewPage(this.browser);
        await installFastPageRoutes(page);
        this._walmartSweepPage = page;
        this._walmartSweepTask = this._runWalmartSweepWorker(page).catch((err) =>
          this.log("err", `Walmart monitor ended: ${err.message}`)
        );
        this.log("ok", `Walmart monitor — 1 tab reloads ${walmarts.length} Walmart PDP(s) round-robin.`);
        await this._closeExtraBlankTabs();
      }
    });
  }

  /** On drop window open: parallel one-shot activation reloads (no blocking 120s join). */
  async _burstWalmartQueueJoin(note) {
    const products = this._walmartWatchlist();
    if (!products.length || !this._walmartQueueMode()) return;
    const jobs = products.flatMap((product) => this._walmartAccounts(product).map((account) => ({ product, account })));
    this._logDrop("WALMART", `${note} — burst queue activation on ${jobs.length} isolated account/product task(s)…`, "hit");
    await this._ensureBrowser();

    const wm = this.config.monitor?.walmart || {};
    const concurrency = Math.max(1, Math.min(12, Number(wm.burstConcurrency) || 8));
    const dropTrace = createLatencyTrace({ retailer: "walmart", source: "drop-burst", name: note });
    dropTrace.mark("drop_open");

    const runOne = async ({ product, account }) => {
      const st = this.products.get(product.id);
      const accountId = account.id;
      const runtimeKey = this._walmartRuntimeKey(product, accountId);
      if (!st || st.status === "skipped" || (st.busy && this._sessionManager.accountMode() !== "multi")) return;
      if (this._walmartInQueue.has(runtimeKey)) return;
      if (this._walmartJoinLocks.has(runtimeKey)) return;

      this._walmartJoinLocks.add(runtimeKey);
      const latency = createLatencyTrace({
        productId: product.id,
        retailer: "walmart",
        source: "drop-burst",
        name: product.name || walmartItemId(product),
        accountId,
      });
      latency.mark("drop_open");
      this._walmartQueueTraces.set(runtimeKey, latency);

      try {
        const session =
          this._sessionManager.accountMode() === "multi"
            ? await this._sessionManager.ensureSession(accountId)
            : this._sessionManager.get(accountId) || this._sessionManager.get("local");
        const context = session?.context || this.browser;
        let page = this._walmartPage(product, accountId) || this._walmartSweepPage;
        if (!page || page.isClosed?.()) {
          page = await openChromeWindow(context, { url: walmartProductUrl(product) || "https://www.walmart.com/" });
          await installFastPageRoutes(page);
          this._setWalmartPage(product, accountId, page);
          await this._bindWalmartQueueWatchers(page, product, accountId);
          await tileChromeWindows([...this._walmartPages.values()].filter((p) => p && !p.isClosed?.())).catch(() => {});
        } else {
          await this._bindWalmartQueueWatchers(page, product, accountId);
        }

        const needReload = !this._walmartDropReloaded.has(runtimeKey);
        if (!needReload) {
          const r = await watchForWalmartQueue(page, product, {
            onLog: (level, msg) => this._logDrop("WALMART", msg, level),
            urgent: true,
            timeoutMs: Number(wm.joinTimeoutMs) || 8000,
            latency,
          });
          await this._handleWalmartCheckResult(page, product, r, { label: "DROP BURST", accountId });
          return;
        }

        const act = await activateWalmartQueueReload(page, product, {
          onLog: (level, msg) => this._logDrop("WALMART", msg, level),
          urgent: true,
          latency,
        });
        // Claim only after reload attempt completes
        this._walmartDropReloaded.add(runtimeKey);

        if (act.alreadyQueued && act.queue) {
          await this._handleWalmartCheckResult(page, product, act.queue, { label: "DROP BURST", accountId });
          return;
        }
        // Ignore act.buyable — Walmart queue drops never ATC without a prior queue join.

        // Non-blocking short watch — workers continue polling if still pending
        const r = await watchForWalmartQueue(page, product, {
          onLog: (level, msg) => this._logDrop("WALMART", msg, level),
          urgent: true,
          timeoutMs: Number(wm.joinTimeoutMs) || 12000,
          latency,
        });
        await this._handleWalmartCheckResult(page, product, r, { label: "DROP BURST", accountId });
      } catch (err) {
        this.log("warn", `Walmart burst (${product.name} · ${account.label || accountId}): ${err.message}`);
      } finally {
        this._walmartJoinLocks.delete(runtimeKey);
      }
    };

    for (let i = 0; i < jobs.length; i += concurrency) {
      if (!this.running) break;
      await Promise.all(jobs.slice(i, i + concurrency).map(runOne));
    }
    dropTrace.finish({ ok: true });
  }

  async _bindWalmartQueueWatchers(page, product, accountId = null) {
    if (!page || page.isClosed?.()) return;
    const runtimeKey = this._walmartRuntimeKey(product, accountId);
    const suffix = `${accountId || "local"}_${product.id}`.replace(/[^a-zA-Z0-9_]/g, "_");
    await installWalmartQueueWatcher(page, { bindingName: `__botQueueNotify_${suffix}` }).catch(() => {});
    installWalmartQueueNetworkTap(page, (hint) => {
      const url = hint?.url || "";
      if (!this._isRealWalmartQueueNetworkUrl(url)) return; // ignore GraphQL noise
      this._markWalmartQueueSignal(runtimeKey);
      // If we wrongly skipped while queue is live, reopen the task.
      if (this._walmartQueueAbandoned.has(runtimeKey) || this.products.get(product.id)?.status === "skipped") {
        this._walmartQueueAbandoned.delete(runtimeKey);
        this.cancelledProducts.delete(product.id);
        this._setProduct(product.id, {
          status: "watching",
          busy: false,
          detail: "Queue signal — reopened task, joining line",
        });
        this._logDrop("WALMART", `${product.name || walmartItemId(product)}: queue still up — task reopened`, "hit");
      }
      this._logDrop("WALMART", `Queue live signal: ${url.slice(0, 120)}`, "info");
    });
    // Also install buy-button watcher for post-queue ATC
    await this._installInstantStockWatcher(page, product).catch(() => {});
  }

  /** Live retailer switch without full restart — pauses/resumes products and starts Walmart monitor. */
  applyRetailerSwitch(retailer) {
    const allowed = ["target", "walmart", "both"];
    if (!allowed.includes(retailer)) throw new Error(`retailer must be one of: ${allowed.join(", ")}`);
    if (!this.config) this.config = loadConfig();
    this.config.retailer = retailer;

    const all = this.config.products || [];
    for (const p of all) {
      const active = this._retailerActive(p);
      const st = this.products.get(p.id);
      if (!st) continue;
      this._setProduct(p.id, {
        status: !active ? "skipped" : this._hasProductId(p) ? "watching" : "resolving",
        detail: !active
          ? `Paused — retailer switch is set to ${retailer.toUpperCase()}`
          : this._hasProductId(p)
          ? "Watching for stock"
          : `Searching: ${(Array.isArray(p.keywords) ? p.keywords : []).join(", ")}`,
      });
    }

    if (this.running) {
      if (retailer === "target") {
        const tasks = this._stopWalmartMonitors();
        void Promise.allSettled(tasks);
      } else if (this._walmartWatchlist().length && !this._walmartMonitorsRunning) {
        this._startWalmartMonitors();
      }
    }

    this.log("ok", `Retailer switch → ${retailer.toUpperCase()} (live).`);
    this._emitState();
    return { ok: true, retailer };
  }

  async _getMonitorPage() {
    await this._ensureBrowser();
    if (this._monitorPage) {
      try {
        if (!this._monitorPage.isClosed()) return this._monitorPage;
      } catch {
        /* stale */
      }
    }
    this._monitorPage = await this._claimOrNewPage(this.browser);
    await installFastPageRoutes(this._monitorPage);
    await ensureMonitorPage(this._monitorPage);
    return this._monitorPage;
  }

  /**
   * Fast built-in monitor: ONE Target tab, checks ALL TCINs via RedSky every ~1–2s.
   * No Discord Follow needed. No 18-tab scraping.
   */
  async _runFastApiMonitorWithRestart() {
    while (this.running) {
      try {
        await this._runFastApiMonitor();
        break;
      } catch (err) {
        this.log("err", `Fast API monitor crashed: ${err.message}`);
        this._clearStuckCheckouts("Monitor recovered — checkout cleared");
        if (!this.running) break;
        this.log("warn", "Restarting Fast API monitor in 3s…");
        await this._sleepSlices(3000);
      }
    }
  }

  /** Release products stuck in checkout after a monitor crash or timeout. */
  _clearStuckCheckouts(note = "Back to watching") {
    for (const [id, st] of this.products) {
      if (!st.busy) continue;
      if (st.status === "processing" || st.status === "placing_order" || st.status === "in_stock") {
        this._setProduct(id, { status: "watching", detail: note, busy: false });
      }
    }
  }

  async _runFastApiMonitor() {
    const page = await this._getMonitorPage();
    this.log("ok", "Fast API monitor started — 1 tab checking all products (no page reloads).");

    while (this.running) {
      await this._checkDropWindowTransition(this.config.products?.length || 1);
      const mon = this._effectiveMonitor(this.config.products?.length || 1);
      const cfgPoll = this.config.monitor?.fastApiMonitor?.pollIntervalMs;
      const dropPoll = this.config.monitor?.fastApiMonitor?.dropPollIntervalMs ?? 200;
      const offPoll = cfgPoll ?? 2500;
      const interval = mon.dropWindowActive ? dropPoll : offPoll;

      const targets = this._targetWatchlist();

      if (targets.length) {
        if (Date.now() < this._apiThrottleUntil) {
          await this._sleepSlices(Math.min(interval, this._apiThrottleUntil - Date.now()));
          continue;
        }

        const rows = await batchCheckStockViaPageApi(page, targets, { variationOnly: mon.dropWindowActive });
        const throttled = rows.some((r) => /HTTP_429|HTTP_503/.test(String(r.status)));
        if (throttled) {
          const backoff = mon.dropWindowActive ? 2000 : 8000;
          this._apiThrottleUntil = Date.now() + backoff;
          this.log("warn", `Fast API throttled — backing off ${(backoff / 1000).toFixed(0)}s.`);
          await this._sleepSlices(backoff);
          continue;
        }

        const byTcin = new Map(rows.map((r) => [String(r.tcin), r]));

        const stockHits = targets.filter((p) => byTcin.get(String(p.tcin))?.inStock);
        if (stockHits.length) {
          const summary = stockHits
            .map((p) => `${p.name || p.tcin} (TCIN ${p.tcin})`)
            .join(" · ");
          this._logDrop("STOCK", `API detected IN STOCK: ${summary}`, "hit");
        }

        this._pollCount += 1;
        if (mon.dropWindowActive && Date.now() - this._lastHeartbeat > 30000) {
          this._lastHeartbeat = Date.now();
          this._logDrop(
            "MONITOR",
            `Poll #${this._pollCount} — ${targets.length} armed, ${stockHits.length} in stock, interval ${interval}ms`
          );
        }

        const hype = this._isHypeMode(this.config);

        for (const product of targets) {
          const st = this.products.get(product.id);
          if (!st || st.status === "skipped") continue;

          const row = byTcin.get(String(product.tcin));
          if (!row) {
            this._setProduct(product.id, { detail: "Fast API watching…", lastChecked: Date.now() }, { quiet: true });
            continue;
          }

          if (st.busy) {
            if (row.inStock) {
              this._logDrop(
                "STOCK",
                `${product.name || product.tcin} IN STOCK but waiting — checkout in progress on "${this._busyCheckoutLabel()}"`,
                "warn"
              );
            }
            continue;
          }
          if (st.status === "success" && !this._loopCheckouts(this.config)) continue;

          this._setProduct(
            product.id,
            {
              availability: row.status,
              lastChecked: Date.now(),
              detail: row.inStock ? "IN STOCK — checking out!" : `Fast API (${row.status})`,
            },
            { quiet: !row.inStock }
          );

          const prevStatus = this._lastApiStatus.get(product.id);
          if (prevStatus !== row.status) {
            this._lastApiStatus.set(product.id, row.status);
            const short = (product.name || product.tcin).slice(0, 55);
            this._logDrop("API", `${short} → ${row.status}${row.inStock ? " (IN STOCK)" : ""}`, row.inStock ? "hit" : "info");
            if (
              mon.dropWindowActive &&
              !row.inStock &&
              prevStatus &&
              prevStatus !== row.status &&
              /OUT_OF_STOCK|UNKNOWN/i.test(prevStatus)
            ) {
              void this._urgentPdpCheck(product);
            }
          }

          if (row.inStock) {
            if (row.checkoutTcin) product.checkoutTcin = String(row.checkoutTcin);
            let confirm;
            if (hype && mon.dropWindowActive) {
              confirm = { confirmed: true, status: row.status };
            } else {
              confirm = await confirmFastApiStock(page, product, { gapMs: hype ? 80 : 280 });
            }
            if (!confirm.confirmed) {
              this._logDrop("STOCK", `${product.name || product.tcin} API flicker (${confirm.reason || "unconfirmed"}) — urgent PDP check`, "warn");
              void this._urgentPdpCheck(product);
              this._setProduct(product.id, {
                detail: `API flicker (${confirm.reason || "unconfirmed"}) — PDP sweep active`,
                lastChecked: Date.now(),
              });
              continue;
            }

            this._logDrop("STOCK", `API detected IN STOCK: ${product.name || product.tcin} (TCIN ${product.tcin})`, "hit");
            this._enqueueStockCheckout(product, { source: "fast-api", note: "fast-api" });
          }
        }
      }

      await this._sleepSlices(interval);
    }
  }

  _usesBrowserMonitor(cfg = this.config) {
    const mode = cfg?.monitor?.mode ?? "fast";
    return mode === "browser" || (mode === "hybrid" && cfg?.monitor?.hybridBrowserBackup !== false);
  }

  log(level, message) {
    this.emit("event", { kind: "log", level, message, time: Date.now() });
  }

  /** Consistent drop-window logging — always shows in dashboard Activity. */
  _logDrop(tag, message, level = "info") {
    this.log(level, `[${tag}] ${message}`);
  }

  _busyCheckoutLabel() {
    for (const st of this.products.values()) {
      if (st.busy) return st.name || st.tcin || "unknown item";
    }
    return null;
  }

  /** After a successful order, immediately re-buy if the item is still in stock (loop checkouts). */
  async _tryImmediateRebuy(product, page) {
    if (!this._loopCheckouts(this.config) || !this.running) return;
    const mon = this._effectiveMonitor(this.config.products?.length || 1);
    if (!mon.dropWindowActive) return;
    const st = this.products.get(product.id);
    if (!st || st.busy || st.status === "skipped") return;
    try {
      if (!this._isOnProductPage(page, product)) {
        await this._ensureProductPage(page, product, { fast: true }).catch(() => {});
      }
      const pdp = await checkStockLight(page, product, { fast: true, domOnly: true });
      if (pdp.inStock) {
        const qty = product.maxQuantity || 1;
        this._logDrop(
          "STOCK",
          `${product.name || product.tcin} still IN STOCK after order — looping (qty ${qty})`,
          "hit"
        );
        this._enqueueStockCheckout(product, { source: "loop-rebuy", note: "loop-rebuy", bypassCooldown: true });
      }
    } catch {
      /* non-fatal */
    }
  }

  /** Queue checkout for a stock hit (API or PDP). Respects cooldown + busy state. */
  _enqueueStockCheckout(product, { source = "fast-api", note = source, bypassCooldown = false, page = null, accountId = null } = {}) {
    const st = this.products.get(product.id);
    const multi = this._sessionManager.accountMode() === "multi";
    if (!st || st.status === "skipped" || (st.busy && !multi)) {
      if (st?.busy && !multi) {
        this._logDrop("STOCK", `${product.name || product.tcin} IN STOCK but waiting — checkout busy on "${this._busyCheckoutLabel()}"`, "warn");
      }
      return false;
    }

    const hitKey = `${this._retailer(product)}:${this._productKey(product)}`;
    const selected = accountId
      ? this._accounts.filter((a) => a.id === accountId)
      : this._accountsForProduct(product);
    const accounts = selected.filter(
      (account) =>
        taskBus.canCheckout(account.id, { maxOrders: account.maxOrders ?? 3 }) &&
        !this._orderGuard.isLocked(`${account.id}:${hitKey}`)
    );
    if (!accounts.length) {
      this._logDrop("STOCK", `${product.name || product.tcin} IN STOCK but all eligible accounts are busy or capped`, "warn");
      return false;
    }

    const hype = this._isHypeMode(this.config);
    const mon = this._effectiveMonitor(this.config.products?.length || 1);
    const cooldown = hype ? (mon.dropWindowActive ? 150 : 1800) : 12000;
    const lastHit = this._lastFastHit.get(hitKey) || 0;
    const cooldownLeft = cooldown - (Date.now() - lastHit);
    if (!bypassCooldown && cooldownLeft > 0) {
      this._logDrop("STOCK", `${product.name || product.tcin} IN STOCK (${source}) — cooldown ${(cooldownLeft / 1000).toFixed(1)}s`, "warn");
      return false;
    }

    this._lastFastHit.set(hitKey, Date.now());
    this._setProduct(product.id, {
      availability: "IN_STOCK",
      lastChecked: Date.now(),
      detail: `IN STOCK (${source}) — checking out!`,
    });
    this._logDrop("STOCK", `${product.name || product.tcin} CONFIRMED via ${source} — launching checkout NOW`, "hit");
    notify(this.config, { title: "IN STOCK!", message: `${product.name} — auto checkout (${source})` });

    const launch = (account, preferredPage = page) => {
      const orderKey = `${account.id}:${hitKey}`;
      taskBus.publishStock({
        retailer: this._retailer(product),
        productKey: this._productKey(product),
        product,
        source,
        accountId: account.id,
      });
      const latency = createLatencyTrace({
        productId: product.id,
        retailer: this._retailer(product),
        source,
        name: product.name || this._productKey(product),
        accountId: account.id,
      });
      latency.mark("stock_signal");
      latency.mark("stock_confirmed");
      this._logDrop(
        "CHECKOUT",
        `STARTED (${source}): ${product.name || this._productKey(product)} · ${account.label || account.id}`,
        "hit"
      );
      return this._triggerImmediateCheckout(product, {
        note,
        source,
        stockConfirmed: true,
        latency,
        account,
        orderKey,
        page: preferredPage,
        allowProductBusy: multi,
      });
    };
    const finish = (out) => {
      if (out?.purchased) this._logDrop("CHECKOUT", `ORDER PLACED: ${product.name || product.tcin}`, "hit");
      else if (out?.error) this._logDrop("CHECKOUT", `FAILED: ${product.name || product.tcin} — ${out.error}`, "err");
      else if (out?.ok) this._logDrop("CHECKOUT", `FINISHED (no order): ${product.name || product.tcin}`, "ok");
      if (out?.latencySummary) {
        const s = out.latencySummary;
        this._logDrop(
          "SPEED",
          `${product.name || this._productKey(product)}: ${s.ok ? "OK" : "FAIL"} total ${(s.totalMs / 1000).toFixed(2)}s` +
            (s.spans?.signalToCheckout != null ? ` · signal→checkout ${(s.spans.signalToCheckout / 1000).toFixed(2)}s` : "") +
            (s.spans?.atcMs != null ? ` · ATC ${(s.spans.atcMs / 1000).toFixed(2)}s` : ""),
          s.ok ? "ok" : "warn"
        );
      }
      return out;
    };

    // Prefer the Walmart queue window over any Target-style warm tab in this.pages
    const primaryId = this._accounts?.[0]?.id || "local";
    const wmPage = this._walmartPage(product, accountId || primaryId);
    const productTab = page || wmPage || this.pages.get(product.id);
    const hasWarmTab = productTab && !productTab.isClosed?.();

    if (hasWarmTab || multi) {
      for (const account of accounts) {
        const preferred = account.id === primaryId || accountId ? page : null;
        void launch(account, preferred).then(finish).catch((err) => {
          this._logDrop("CHECKOUT", `FAILED (${account.label || account.id}): ${product.name || product.tcin} — ${err.message}`, "err");
          return { ok: false, error: err.message };
        });
      }
      return true;
    }

    void new Promise((resolve) => {
      this._checkoutQueue = this._checkoutQueue
        .then(() => launch(accounts[0]))
        .then((out) => resolve(finish(out)))
        .catch((err) => {
          this._logDrop("CHECKOUT", `FAILED: ${product.name || product.tcin} — ${err.message}`, "err");
          resolve({ ok: false, error: err.message });
        });
    });
    return true;
  }

  _emitState() {
    const patch = {
      kind: "state",
      running: this.running,
      browserOpen: !!this.browser,
      busy: !!this.activeTask,
      hasCvv: !!this.sessionCvv,
    };
    if (this.config) {
      const productCount = this.config.products?.length || 0;
      const mon = this._effectiveMonitor(productCount);
      patch.dropWindow = {
        active: !!mon.dropWindowActive,
        label: mon.dropWindowLabel,
        pollIntervalMs: mon.pollIntervalMs,
      };
      patch.retailer = this._retailerSwitch(this.config);
    }
    this.emit("event", patch);
  }

  _setProduct(id, patch, { quiet = false } = {}) {
    const prev = this.products.get(id) || {};
    const next = { ...prev, ...patch, updatedAt: Date.now() };
    // An in-flight checkout may finish after Stop botting was pressed. Keep the
    // card stopped instead of allowing that late result to re-arm its status.
    if (prev.enabled === false && patch.enabled !== true) {
      next.enabled = false;
      next.status = "skipped";
      next.busy = false;
      next.detail = prev.detail || "Stopped — not watching or botting this product";
    }
    this.products.set(id, next);

    // Quiet routine poll ticks — dashboard was rewriting every card on each lastChecked bump.
    const meaningful =
      prev.status !== next.status ||
      prev.busy !== next.busy ||
      prev.availability !== next.availability ||
      prev.attempts !== next.attempts ||
      prev.detail !== next.detail ||
      (next.status && next.status !== "watching" && next.status !== "skipped");
    const now = Date.now();
    const due = !prev._lastUiEmit || now - prev._lastUiEmit > 4000;
    if (!quiet || meaningful || due) {
      next._lastUiEmit = now;
      this.products.set(id, next);
      this.emit("event", { kind: "product", product: next });
    }
    return next;
  }

  getState() {
    // Prefer live config; fall back to disk so UI never thinks retailer is wrong before Start
    if (!this.config) this.config = loadConfig();
    const disk = loadConfig();
    if (disk?.retailer && disk.retailer !== this.config.retailer && !this.running) {
      this.config.retailer = disk.retailer;
    }
    // Keep account UI in sync with saved config when not mid-run
    if (!this.running) {
      this.config.accountMode = disk.accountMode;
      this.config.accountStrategy = disk.accountStrategy;
      this.config.accountFanOut = disk.accountFanOut;
      this.config.accounts = disk.accounts;
      this.config.proxyGroups = disk.proxyGroups;
      this.config.checkoutProfile = disk.checkoutProfile;
      this._accounts = loadAccountProfiles(this.config);
      this._sessionManager.updateConfig(this.config);
    }
    const productCount = this.config?.products?.length || 0;
    const mon = this.config ? this._effectiveMonitor(productCount) : null;
    const secrets = loadLocalSecrets();
    const rememberCvv = secrets.rememberCvv !== false && !!getSavedCvv();
    return {
      running: this.running,
      browserOpen: !!this.browser,
      busy: !!this.activeTask,
      hasCvv: !!this.sessionCvv,
      rememberCvv,
      retailer: this._retailerSwitch(this.config),
      checkout: this.config
        ? {
            dryRun: this.config.checkout.dryRun,
            autoPlaceOrder: this.config.checkout.autoPlaceOrder,
            mode: this.config.monitor?.mode || "fast",
            pollIntervalMs: this.config.monitor.pollIntervalMs,
          }
        : null,
      checkoutProfile: this.config?.checkoutProfile || null,
      dropWindow: mon
        ? {
            active: !!mon.dropWindowActive,
            label: mon.dropWindowLabel,
            pollIntervalMs: mon.pollIntervalMs,
          }
        : null,
      products: [...this.products.values()],
      latency: getLatencyStats({ limit: 20 }),
      readiness: this._lastReadiness,
      accounts: this._accounts?.map((a) => ({
        id: a.id,
        label: a.label,
        retailer: a.retailer,
        maxOrders: a.maxOrders,
        proxyGroup: a.proxyGroup || null,
        hasCvv: this._sessionCvvByAccount.has(a.id) || (a.id === "local" && !!this.sessionCvv),
      })) || [],
      accountMode: this._sessionManager?.accountMode?.() || this.config?.accountMode || "single",
      sessions: this._sessionManager?.snapshot?.() || [],
      taskBus: taskBus.stats(),
      performanceMode: this._performanceMode(this.config),
      apiPathStats: {
        blitzOk: apiPathStats.blitzOk,
        blitzFail: apiPathStats.blitzFail,
        uiFallback: apiPathStats.uiFallback,
      },
    };
  }

  /** Store the card security code in memory; optionally remember on this PC. */
  setSessionCvv(cvv, accountId = null, { remember } = {}) {
    let cleaned = (cvv || "").replace(/\D/g, "").slice(0, 4);
    // Remember toggle with empty field: keep whatever is already in session.
    if (!cleaned && remember === true && this.sessionCvv) cleaned = this.sessionCvv;
    this.sessionCvv = cleaned;
    const id = accountId || this._accounts?.[0]?.id || "local";
    if (cleaned) this._sessionCvvByAccount.set(id, cleaned);
    else this._sessionCvvByAccount.delete(id);
    if (remember === true && cleaned) {
      saveLocalSecrets({ rememberCvv: true, cvv: cleaned });
    } else if (remember === false) {
      saveLocalSecrets({ rememberCvv: false, cvv: "" });
    }
    this._emitState();
    return {
      ok: true,
      hasCvv: !!this.sessionCvv,
      accountId: id,
      rememberCvv: remember === false ? false : !!getSavedCvv() || (remember === true && !!cleaned),
    };
  }

  /** Inject the in-memory CVV into a config copy for a checkout run. */
  _cfgWithCvv(cfg, accountId = null) {
    const id = accountId || this._accounts?.[0]?.id || "local";
    const cvv = this._sessionCvvByAccount.get(id) || this.sessionCvv || cfg.checkout?.cvv || "";
    return { ...cfg, checkout: { ...cfg.checkout, cvv } };
  }

  /** Drop-mode tips: fast checkout when auto-buying (not dry run / practice). */
  _isDropMode(cfg = this.config) {
    const co = cfg?.checkout ?? {};
    return co.dropMode !== false && co.autoPlaceOrder && !co.dryRun;
  }

  /** Hype mode: max aggression — light API polls, loop checkouts, spam checkout (Refract Hype Product style). */
  _isHypeMode(cfg = this.config) {
    return this._isDropMode(cfg) && cfg?.checkout?.hypeMode !== false;
  }

  _loopCheckouts(cfg = this.config) {
    return this._isDropMode(cfg) && cfg?.checkout?.loopCheckouts !== false;
  }

  _performanceMode(cfg = this.config) {
    return cfg?.checkout?.performanceMode !== false;
  }

  _accountForProduct(product) {
    const accounts = this._accounts?.length ? this._accounts : loadAccountProfiles(this.config);
    const picked = selectAccountsForProduct(accounts, product, {
      strategy: this.config?.accountStrategy || "first",
      maxFanOut: 1,
    });
    return picked[0] || accounts.find((a) => a.enabled !== false) || accounts[0] || { id: "local", maxOrders: 3 };
  }

  _accountsForProduct(product) {
    const accounts = this._accounts?.length ? this._accounts : loadAccountProfiles(this.config);
    const fan =
      this._sessionManager.accountMode() === "multi"
        ? Math.max(1, Math.min(5, Number(this.config?.accountFanOut) || 1))
        : 1;
    return selectAccountsForProduct(accounts, product, {
      strategy: this.config?.accountStrategy || "first",
      maxFanOut: fan,
    });
  }

  _retailer(product) {
    return product?.retailer || "target";
  }

  /** The dashboard retailer switch: target | walmart | both. */
  _retailerSwitch(cfg = this.config) {
    const sw = String(cfg?.retailer || "both").toLowerCase();
    return ["target", "walmart", "both"].includes(sw) ? sw : "both";
  }

  /** Is this product's retailer currently switched on? */
  _retailerActive(product, cfg = this.config) {
    const sw = this._retailerSwitch(cfg);
    return sw === "both" || this._retailer(product) === sw;
  }

  _productKey(product) {
    return this._retailer(product) === "walmart" ? walmartItemId(product) : product.tcin;
  }

  /** Human-friendly product-id label for logs: "TCIN 123" or "Walmart 456". */
  _idLabel(product) {
    return this._retailer(product) === "walmart"
      ? `Walmart ${walmartItemId(product) || "?"}`
      : `TCIN ${product.tcin || "?"}`;
  }

  _productUrl(product) {
    if (product.url) return product.url;
    return this._retailer(product) === "walmart"
      ? walmartProductUrl(product)
      : `https://www.target.com/p/-/A-${product.tcin}`;
  }

  _isOnProductPage(page, product) {
    return this._retailer(product) === "walmart"
      ? isOnWalmartPage(page, product)
      : isOnProductPage(page, product);
  }

  async _checkStock(page, product, opts) {
    if (this._retailer(product) === "walmart") return checkWalmartStock(page, product, opts);
    return checkStockOnPage(page, product, opts);
  }

  async _ensureProductPage(page, product, opts = {}) {
    if (this._retailer(product) === "walmart") return ensureWalmartPage(page, product, opts);
    return ensureProductPage(page, product, opts);
  }

  async _runCheckout(product, config, hooks = {}) {
    const context = hooks.context || this.browser;
    if (this._retailer(product) === "walmart") return runWalmartCheckout(context, product, config, hooks);
    return runTargetCheckout(context, product, config, hooks);
  }

  _breakerFor(retailer, accountId) {
    const key = `${retailer}:${accountId || "local"}`;
    if (!this._atcBreakers.has(key)) {
      // Soft empty-cart misses should not nuke the whole account for 20s during a live restock.
      this._atcBreakers.set(
        key,
        createCircuitBreaker({
          name: `${retailer}-atc:${accountId || "local"}`,
          failureThreshold: 6,
          cooldownMs: 8000,
          halfOpenMax: 2,
        })
      );
    }
    return this._atcBreakers.get(key);
  }

  _hasProductId(product) {
    return this._retailer(product) === "walmart" ? !!walmartItemId(product) : !!product.tcin;
  }

  _retryCooldown(cfg = this.config) {
    return this._isDropMode(cfg) ? RETRY_COOLDOWN_DROP_MS : RETRY_COOLDOWN_MS;
  }

  /** Limit how many product tabs reload Target at the same time. */
  async _acquireCheckSlot() {
    const productCount = this.config?.products?.length || 1;
    const max = Math.max(1, Number(this._effectiveMonitor(productCount).maxConcurrentChecks) || 2);
    while (this._checkSlots >= max) {
      await new Promise((resolve) => this._checkWaiters.push(resolve));
    }
    this._checkSlots++;
    const mon = this._effectiveMonitor(productCount);
    if (!mon.dropWindowActive && !mon.hypePolling) await humanPause(80, 200);
  }

  _releaseCheckSlot() {
    this._checkSlots = Math.max(0, this._checkSlots - 1);
    const next = this._checkWaiters.shift();
    if (next) next();
  }

  /** Initial delay so watchers don't all hit Target at once on Start (off-hours only). */
  _staggerStartMs(index, total) {
    const mon = this._effectiveMonitor(total);
    if (total <= 1 || mon.staggerChecks === false || mon.dropWindowActive) return 0;
    const base = mon.pollIntervalMs ?? this.config.monitor.pollIntervalMs ?? 120000;
    return Math.floor((index / total) * base);
  }

  /** Current monitor settings — faster during Fri/Tue 3–5 AM ET drop windows. */
  _effectiveMonitor(productCount = this.config?.products?.length || 1) {
    if (!this.config) return { pollIntervalMs: 120000, jitterMs: 5000, maxConcurrentChecks: 2, staggerChecks: true };
    return getEffectiveMonitor(this.config.monitor, productCount, {
      dropMode: this._isDropMode(this.config),
      hypeMode: this._isHypeMode(this.config),
    });
  }

  /** Log when a drop window starts/ends; activate Walmart immediately, cart-clear off critical path. */
  async _checkDropWindowTransition(productCount) {
    const mon = this._effectiveMonitor(productCount);
    const label = mon.dropWindowLabel;
    if (label && label !== this._lastDropWindowLabel) {
      this._lastDropWindowLabel = label;
      this._dropCartCleared = false;
      this._wakeWatchers = true;
      this._walmartDropReloaded.clear();
      this.log(
        "hit",
        `${label} — ~${(mon.pollIntervalMs / 1000).toFixed(1)}s full reloads + light API polls between (max ${mon.maxConcurrentChecks} reloads at once). Have CVV ready.`
      );
      // CRITICAL PATH: fire Walmart activation first — do not wait on cart clear
      if (!this._dropBurstStarted) {
        this._dropBurstStarted = true;
        this._burstWalmartQueueJoin("Drop window opened").catch((err) => this.log("err", err.message));
        this._burstCheckAll("Drop window opened").catch((err) => this.log("err", err.message));
      }
      if (this._isDropMode(this.config) && !this._dropCartCleared) {
        this._dropCartCleared = true;
        void (async () => {
          try {
            const page = await this._getUtilityPage();
            if (this._retailerSwitch() !== "walmart") {
              await clearCartForDrop(page, { fastMode: true });
            }
            if (this._walmartWatchlist().length) {
              await clearWalmartCart(page, { fast: true });
            }
            this.log("ok", "Cart cleared for drop window (Target + Walmart).");
          } catch {
            /* non-fatal */
          }
        })();
      }
      this._emitState();
    } else if (!label && this._lastDropWindowLabel) {
      this.log("info", "Drop window ended — back to normal poll speed.");
      this._lastDropWindowLabel = null;
      this._dropCartCleared = false;
      this._dropBurstStarted = false;
      this._walmartDropReloaded.clear();
      this._emitState();
    } else if (label && mon.dropWindowActive && !this._dropBurstStarted) {
      // Mid-window start: still run burst once
      this._dropBurstStarted = true;
      this._burstWalmartQueueJoin("Drop window already active").catch((err) => this.log("err", err.message));
      this._burstCheckAll("Drop window already active").catch((err) => this.log("err", err.message));
    }
  }

  /** Immediately reload every watchlist tab (parallel, capped). */
  async _burstCheckAll(note) {
    if (!this.running || !this.config?.products?.length) return;
    this.log("info", `${note} — burst-checking all ${this.config.products.length} products…`);
    await this.checkNow({});
  }

  _applyStealthPolling(productCount) {
    const mon = this.config.monitor;
    const userPoll = mon.pollIntervalMs ?? 120000;
    const effective = this._effectiveMonitor(productCount);
    if (effective.dropWindowActive) {
      this.log("hit", `${effective.dropWindowLabel} is active now — using faster staggered checks.`);
      return;
    }
    const floor = recommendedPollMs(productCount, {
      dropMode: this._isDropMode(this.config),
      hypeMode: this._isHypeMode(this.config),
    });
    if (userPoll < floor) {
      mon.pollIntervalMs = floor;
      mon.jitterMs = Math.max(mon.jitterMs ?? 0, Math.floor(floor * 0.25));
      this.log(
        "info",
        `Stealth: ${productCount} products — raised poll to ~${(mon.pollIntervalMs / 1000).toFixed(0)}s each (max ${mon.maxConcurrentChecks ?? 2} reloads at once).`
      );
    } else {
      this.log(
        "info",
        `Watching ${productCount} product${productCount === 1 ? "" : "s"} — ~${(userPoll / 1000).toFixed(0)}s between checks. Refresh a tab or click Check now when you hear of a restock.`
      );
    }
  }

  /** When you manually refresh a product tab, read the page and buy if it's in stock. */
  _bindManualRefresh(page, product) {
    if (page.__manualRefreshBound) return;
    page.__manualRefreshBound = true;
    let debounce = null;
    const schedule = () => {
      if (!this.running || !this._hasProductId(product)) return;
      const key = String(this._productKey(product) || "");
      if (!key || !page.url().includes(key)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        this.log("info", `You refreshed ${product.name || key} — checking if it's in stock…`);
        this._evaluateStockAndCheckout(product, page, { skipReload: true, note: "You refreshed" }).catch((err) =>
          this.log("err", err.message)
        );
      }, 1500);
    };
    page.on("load", () => {
      const recentBotNav = page.__lastBotNavAt && Date.now() - page.__lastBotNavAt < 3000;
      if (page.__botNavigating || recentBotNav) {
        page.__botNavigating = false;
        return;
      }
      schedule();
    });
  }

  /**
   * In-page instant stock detector (inspired by extension-style content scripts).
   * A MutationObserver in the live PDP fires the moment a buy button appears or
   * enables — catching stock in the gaps between sweep reloads with ~0ms latency.
   */
  async _installInstantStockWatcher(page, product) {
    if (!page || page.isClosed?.() || page.__instantWatcherBound) return;
    page.__instantWatcherBound = true;
    const key = String(this._productKey(product) || "");
    const isWalmart = this._retailer(product) === "walmart";
    const bindingName = "__botBuyBoxLive";

    try {
      await page.exposeFunction(bindingName, (payload) => {
        try {
          if (!this.running) return;
          // Only trust hits from the product's own PDP — cart/checkout pages have
          // unrelated "Add to cart" buttons in recommendation carousels.
          if (!key || !page.url().includes(key)) return;
          const mon = this._effectiveMonitor(this.config.products?.length || 1);
          // Walmart restocks aren't tied to Target drop windows — always act on them.
          if (!isWalmart && !mon.dropWindowActive) return;
          const st = this.products.get(product.id);
          if (!st || st.busy || st.status === "skipped") return;
          if (st.status === "success" && !this._loopCheckouts(this.config)) return;
          this._logDrop(
            "STOCK",
            `LIVE buy button appeared: ${product.name || key} (${this._idLabel(product)}) — ${payload?.button || "buyable"} [instant DOM watcher]`,
            "hit"
          );
          this._enqueueStockCheckout(product, { source: "dom-watch", note: "dom-watch", page });
        } catch {
          /* non-fatal */
        }
      });
    } catch {
      // Binding already registered on this page — safe to continue.
    }

    const targetSelectors = `[
        ['[data-test="buyNowButton"]', 'Buy now'],
        ['[data-test="shippingButton"]', 'Ship it'],
        ['[data-test^="addToCartButton"]', 'Add to cart'],
      ]`;
    const walmartSelectors = `[
        ['[data-automation-id="add-to-cart"]', 'Add to cart'],
        ['#WMItemAddToCartBtn', 'Add to cart'],
        ['button[data-dca-id="AddToCart"]', 'Add to cart'],
        ['[data-tl-id="ProductPrimaryCTA-cta_add_to_cart_button"]', 'Add to cart'],
      ]`;
    const buyBoxSelector = isWalmart
      ? `'[data-testid="add-to-cart-section"], [data-automation-id="buy-box"], main'`
      : `'[data-test="buybox"], [data-test="product-buy-box"], [data-test="fulfillmentOptions"], [data-test="@web/AddToCart/FulfillmentSection"]'`;

    const initScript = `(() => {
      if (window.__botWatcherInstalled) return;
      window.__botWatcherInstalled = true;
      const isEnabled = (el) => {
        if (!el) return false;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const SELECTORS = ${isWalmart ? walmartSelectors : targetSelectors};
      const findBuy = () => {
        const box = document.querySelector(${buyBoxSelector}) || document;
        for (const [sel, label] of SELECTORS) {
          const el = box.querySelector(sel) || document.querySelector(sel);
          if (isEnabled(el)) return label;
        }
        for (const btn of (box.querySelectorAll ? box.querySelectorAll('button') : [])) {
          const t = (btn.textContent || '').trim();
          if (/^(ship it|add to cart|buy now|pre-?order)$/i.test(t) && isEnabled(btn)) return t;
        }
        return null;
      };
      let fired = false;
      const check = () => {
        if (fired) return;
        const label = findBuy();
        if (label) {
          fired = true;
          try { window.${bindingName}({ button: label }); } catch (e) {}
          setTimeout(() => { fired = false; }, 4000);
        }
      };
      const obs = new MutationObserver(check);
      const start = () => {
        if (!document.body) { setTimeout(start, 50); return; }
        obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'data-test'] });
        check();
      };
      start();
    })();`;

    try {
      await page.addInitScript(initScript);
      // Run once on the current document too (addInitScript only applies to future nav).
      await page.evaluate(initScript).catch(() => {});
    } catch {
      /* non-fatal */
    }
  }

  /**
   * AI assistant sentinel: while a checkout runs, watch for stalls (no phase
   * progress for N seconds). On stall, sample the page and take a safe recovery
   * action (heuristics first, OpenAI if a key is configured). Returns a stop fn.
   */
  _startCheckoutSentinel(page, product, cfg, progress) {
    const settings = aiAssistantSettings(cfg);
    if (!settings.enabled) return () => {};
    const stallMs = settings.stallSeconds * 1000;
    const label = product.name || product.tcin;
    let stopped = false;
    let recovering = false;
    let recoveries = 0;

    // Note: don't gate on this.running — one-off test/buy checkouts run with the
    // engine stopped, and the sentinel must watch those too. stop() is explicit.
    const timer = setInterval(async () => {
      if (stopped || recovering) return;
      if (!page || page.isClosed?.()) return;
      if (Date.now() - progress.lastAt < stallMs) return;
      if (recoveries >= settings.maxRecoveriesPerCheckout) return;
      recoveries += 1;
      recovering = true;
      const stalledFor = ((Date.now() - progress.lastAt) / 1000).toFixed(0);
      this._logDrop(
        "AI",
        `${label}: checkout stalled ${stalledFor}s at "${progress.phase}" — assistant stepping in (${recoveries}/${settings.maxRecoveriesPerCheckout})`,
        "warn"
      );
      try {
        const allowPlaceOrder = !!cfg.checkout?.autoPlaceOrder && !cfg.checkout?.dryRun;
        const out = await recoverStalledCheckout(page, product, cfg, {
          log: (level, message) => this._logDrop("AI", message, level === "warn" ? "warn" : level === "ok" ? "ok" : "info"),
          phase: progress.phase,
          allowPlaceOrder,
        });
        if (out.needsHuman) {
          notify(cfg, {
            title: "Checkout needs you",
            message: `${label}: ${out.steps.at(-1)?.reason || "manual step required"}`,
          });
        }
        // Give the flow breathing room after an intervention before re-triggering.
        if (out.steps.length) progress.lastAt = Date.now();
      } catch (err) {
        this.log("warn", `AI assistant error (${label}): ${err.message}`);
      } finally {
        recovering = false;
      }
    }, 3000);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  /**
   * External monitor fired (PikaNotify, Discord bridge, webhook).
   * Target → instant checkout. Walmart queue mode → one activation reload on queue window.
   */
  async handleExternalAlert(alert = {}) {
    if (!this.running || !this.config) return { ok: false, reason: "not_running" };

    const parsed = alert.tcin || alert.itemId ? [alert] : parseStockAlert(alert);
    const results = [];

    for (const hit of parsed) {
      let products = matchAlertToProducts(hit, this.config.products || []);
      if (!products.length) {
        this.log("warn", `External alert for ${hit.tcin || hit.itemId || "unknown"} — not on your watchlist.`);
        results.push({ ok: false, reason: "not_on_watchlist", alert: hit });
        continue;
      }

      for (const product of products) {
        const label = hit.source || "external";
        const isWm = this._retailer(product) === "walmart";

        // Walmart queue drops: activate each selected account's own queue window.
        if (isWm && this._walmartQueueMode()) {
          this._logDrop(
            "ALERT",
            `${label.toUpperCase()}: ${product.name || this._productKey(product)} — Walmart queue activation`,
            "hit"
          );
          await this._ensureBrowser();
          for (const account of this._walmartAccounts(product)) {
            const accountId = account.id;
            const runtimeKey = this._walmartRuntimeKey(product, accountId);
            if (this._walmartInQueue.has(runtimeKey)) {
              results.push({ ok: true, reason: "already_in_queue", id: product.id, accountId });
              continue;
            }
            const session =
              this._sessionManager.accountMode() === "multi"
                ? await this._sessionManager.ensureSession(accountId)
                : this._sessionManager.get(accountId) || this._sessionManager.get("local");
            const context = session?.context || this.browser;
            let page = this._walmartPage(product, accountId);
            if (!page || page.isClosed?.()) {
              page = await openChromeWindow(context, { url: walmartProductUrl(product) || "https://www.walmart.com/" });
              await installFastPageRoutes(page);
              this._setWalmartPage(product, accountId, page);
            }
            await this._bindWalmartQueueWatchers(page, product, accountId);
            if (this._walmartJoinLocks.has(runtimeKey)) {
              results.push({ ok: true, reason: "join_in_flight", id: product.id, accountId });
              continue;
            }
            const latency = createLatencyTrace({
              productId: product.id,
              retailer: "walmart",
              source: label,
              name: product.name || walmartItemId(product),
              accountId,
            });
            latency.mark("external_signal");
            this._walmartQueueTraces.set(runtimeKey, latency);

            this._walmartJoinLocks.add(runtimeKey);
            try {
              const needReload = !this._walmartDropReloaded.has(runtimeKey);
              let r;
              if (needReload) {
                const act = await activateWalmartQueueReload(page, product, {
                  onLog: (level, msg) => this._logDrop("WALMART", msg, level),
                  urgent: true,
                  latency,
                });
                this._walmartDropReloaded.add(runtimeKey);
                if (act.alreadyQueued && act.queue) r = act.queue;
                else if (act.buyable?.inStock) r = act.buyable;
                else {
                  r = await watchForWalmartQueue(page, product, {
                    onLog: (level, msg) => this._logDrop("WALMART", msg, level),
                    urgent: true,
                    timeoutMs: Number(this.config.monitor?.walmart?.joinTimeoutMs) || 15000,
                    latency,
                  });
                }
              } else {
                r = await watchForWalmartQueue(page, product, {
                  onLog: (level, msg) => this._logDrop("WALMART", msg, level),
                  urgent: true,
                  timeoutMs: 8000,
                  latency,
                });
              }
              await this._handleWalmartCheckResult(page, product, r, { label: "EXTERNAL", accountId });
              results.push({ ok: true, id: product.id, accountId, inQueue: !!r?.inQueue, inStock: !!r?.inStock });
            } catch (err) {
              results.push({ ok: false, error: err.message, id: product.id, accountId });
            } finally {
              this._walmartJoinLocks.delete(runtimeKey);
            }
          }
          continue;
        }

        this._logDrop(
          "ALERT",
          `${label.toUpperCase()}: ${product.name || this._productKey(product)} (${this._idLabel(product)}) — instant checkout`,
          "hit"
        );
        notify(this.config, { title: "EXTERNAL ALERT", message: `${product.name} — checking out now` });

        const productTab = this.pages.get(product.id);
        const queued = this._enqueueStockCheckout(product, {
          note: label,
          source: label,
          page: productTab || null,
          bypassCooldown: true,
        });
        results.push({ ok: queued, queued, id: product.id });
      }
    }

    return { ok: true, results };
  }

  /** Checkout immediately — external alert already confirmed stock. */
  async _triggerImmediateCheckout(product, {
    note = "external",
    source = "external",
    stockConfirmed = false,
    latency = null,
    account = null,
    orderKey = null,
    page: preferredPage = null,
    allowProductBusy = false,
  } = {}) {
    const cfg = this.config;
    const st = this.products.get(product.id);
    if (!st || st.status === "skipped") return { ok: false, reason: "terminal" };
    if (st.busy && !allowProductBusy) return { ok: false, reason: "busy" };

    const acct = account || this._accountForProduct(product);
    const guardKey = orderKey || `${acct.id}:${this._retailer(product)}:${this._productKey(product)}`;
    if (!this._orderGuard.tryAcquire(guardKey)) {
      return { ok: false, reason: "order_guard" };
    }
    if (!taskBus.beginCheckout(acct.id, this._productKey(product))) {
      this._orderGuard.release(guardKey);
      return { ok: false, reason: "account_busy" };
    }

    const trace =
      latency ||
      createLatencyTrace({
        productId: product.id,
        retailer: this._retailer(product),
        source,
        name: product.name || this._productKey(product),
      });
    if (!latency) {
      trace.mark("stock_signal");
      if (stockConfirmed) trace.mark("stock_confirmed");
    }

    const isWalmart = this._retailer(product) === "walmart";
    const breaker = this._breakerFor(isWalmart ? "walmart" : "target", acct.id);
    if (!breaker.allow()) {
      this._orderGuard.release(guardKey);
      taskBus.endCheckout(acct.id, { ordered: false });
      this._logDrop("CHECKOUT", `${product.name || this._productKey(product)}: circuit open (${breaker.snapshot().name}) — backing off`, "warn");
      return { ok: false, reason: "circuit_open", latencySummary: trace.finish({ ok: false, error: "circuit_open" }) };
    }

    await this._ensureBrowser();
    const accountSession =
      this._sessionManager.accountMode() === "multi"
        ? await this._sessionManager.ensureSession(acct.id)
        : this._sessionManager.get(acct.id) || this._sessionManager.get("local");
    const context = accountSession?.context || this.browser;
    const pageBelongsToAccount = (candidate) => {
      if (!candidate || candidate.isClosed?.()) return false;
      try {
        return candidate.context() === context;
      } catch {
        return false;
      }
    };
    // The pre-warmed checkout tab lives on target.com — Walmart checkouts stay on their queue window.
    const useFastTab =
      this._performanceMode(cfg) &&
      this._usesFastApiMonitor(cfg) &&
      !isWalmart;

    const wmPage =
      accountSession?.pages?.walmart?.get(product.id) ||
      (pageBelongsToAccount(this._walmartPages.get(product.id)) ? this._walmartPages.get(product.id) : null);
    let productTab =
      (pageBelongsToAccount(preferredPage) ? preferredPage : null) ||
      (pageBelongsToAccount(wmPage) ? wmPage : null) ||
      (accountSession?.pages?.product?.get(product.id) || null) ||
      (pageBelongsToAccount(this.pages.get(product.id)) ? this.pages.get(product.id) : null);

    if (productTab?.isClosed?.()) {
      this.log("warn", `Product tab was closed for ${product.name || product.tcin} — opening fresh tab.`);
      productTab = isWalmart
        ? await openChromeWindow(context, { url: walmartProductUrl(product) || "https://www.walmart.com/" })
        : await this._claimOrNewPage(context);
      if (isWalmart) {
        if (accountSession) accountSession.pages.walmart.set(product.id, productTab);
        else this._walmartPages.set(product.id, productTab);
        await installFastPageRoutes(productTab).catch(() => {});
      } else {
        if (accountSession) accountSession.pages.product.set(product.id, productTab);
        else this.pages.set(product.id, productTab);
        this._bindManualRefresh(productTab, product);
      }
    }
    let onProductTab = productTab && this._isOnProductPage(productTab, product);

    let page = onProductTab ? productTab : useFastTab ? await this._getCheckoutPage(acct.id) : productTab;
    if (!page || page.isClosed?.()) {
      page = useFastTab
        ? await this._getCheckoutPage(acct.id)
        : isWalmart
          ? await openChromeWindow(context, { url: walmartProductUrl(product) || "https://www.walmart.com/" })
          : await this._claimOrNewPage(context);
      if (!useFastTab) {
        if (isWalmart) {
          if (accountSession) accountSession.pages.walmart.set(product.id, page);
          else this._walmartPages.set(product.id, page);
          await installFastPageRoutes(page).catch(() => {});
        } else {
          if (accountSession) accountSession.pages.product.set(product.id, page);
          else this.pages.set(product.id, page);
          this._bindManualRefresh(page, product);
        }
      }
      onProductTab = false;
    }
    // Keep the product tab on the PDP while a separate warm tab can take the
    // direct /checkout route when Target says a high-demand item is already carted.
    const parallelCheckoutPage =
      !isWalmart && onProductTab && useFastTab
        ? await this._getCheckoutPage(acct.id)
        : null;

    // Stay on the queue/PDP tab when possible — never hop to a different warm tab after queue clear
    const skipNavigation = onProductTab || useFastTab || (isWalmart && preferredPage && page === preferredPage);
    if (onProductTab || (isWalmart && preferredPage && page === preferredPage)) {
      this.log("ok", `${product.name || product.tcin}: using ${isWalmart ? "Walmart queue" : "pre-loaded product"} tab — zero nav delay.`);
    } else if (useFastTab) {
      this.log("ok", `${product.name || product.tcin}: warm checkout tab — API blitz path.`);
    }

    this._setProduct(product.id, {
      status: "in_stock",
      detail: `${note} — instant checkout`,
      busy: true,
      availability: "IN_STOCK",
      lastChecked: Date.now(),
    });

    const mon = this._effectiveMonitor(this.config.products?.length || 1);
    const dropMode = this._isDropMode(cfg);
    let ordered = false;

    try {
      await page.bringToFront().catch(() => {});
      const onPdp = page.url().includes(String(this._productKey(product) || ""));
      // Performance mode + stockConfirmed: do not navigate to PDP for Target API path
      const stayOnWarm =
        this._performanceMode(cfg) && stockConfirmed && useFastTab && /target\.com/i.test(page.url() || "");
      if (!stayOnWarm && (!stockConfirmed || !onPdp)) {
        const body = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).replace(/\s+/g, " ");
        if (/page is currently unavailable|we're sorry.*unavailable/i.test(body) || !onPdp) {
          await page.goto(this._productUrl(product), { waitUntil: "commit", timeout: 12000 }).catch(() => {});
        }
      }

      const wallMs = mon.dropWindowActive ? 60000 : cfg.checkout?.checkoutTimeoutMs ?? 120000;
      const progress = { phase: "starting", lastAt: Date.now() };
      const checkoutPromise = this._runCheckout(product, this._cfgWithCvv(cfg, acct.id), {
        context,
        page,
        parallelCheckoutPage,
        skipNavigation: stockConfirmed || skipNavigation || stayOnWarm,
        stockConfirmed,
        fastMode: dropMode || mon.dropWindowActive || this._performanceMode(cfg),
        dropWindowActive: !!mon.dropWindowActive,
        hypeMode: this._isHypeMode(cfg),
        latency: trace,
        shouldCancel: () => !this.running || this.cancelledProducts.has(product.id),
        onPhase: (name, detail) => {
          progress.phase = name;
          progress.lastAt = Date.now();
          if (name === "adding_to_cart") trace.mark("atc_start");
          if (name === "in_cart") {
            trace.mark("atc_ok");
            trace.mark("cart_confirmed");
          }
          if (name === "checking_out") {
            trace.mark("checkout_nav");
            trace.mark("checkout_ready");
          }
          if (name === "placing_order") trace.mark("place_order");
          const mapped = PHASE_TO_STATUS[name];
          if (mapped) this._setProduct(product.id, { status: mapped[0], detail: detail || mapped[1] });
          const label = product.name || product.tcin;
          if (name === "adding_to_cart") this._logDrop("CHECKOUT", `${label}: adding to cart…`, "ok");
          else if (name === "checking_out") this._logDrop("CHECKOUT", `${label}: rushing to checkout…`, "ok");
          else if (name === "placing_order") this._logDrop("CHECKOUT", `${label}: placing order…`, "hit");
          else if (name === "in_stock") this._logDrop("CHECKOUT", `${label}: in stock — buying now`, "hit");
        },
        onLog: (level, message) => {
          progress.lastAt = Date.now(); // log activity = checkout is alive
          this.log(level, message);
        },
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Checkout timed out after ${(wallMs / 1000).toFixed(0)}s`)), wallMs)
      );
      const stopSentinel = this._startCheckoutSentinel(page, product, cfg, progress);
      let result;
      try {
        result = await Promise.race([checkoutPromise, timeoutPromise]);
      } finally {
        stopSentinel();
      }

      const attempts = (this.products.get(product.id).attempts || 0) + 1;
      const loop = this._loopCheckouts(cfg);

      if (result.placed) {
        ordered = true;
        breaker.success();
        trace.mark("order_confirmed");
        const latencySummary = trace.finish({ ok: true });
        const orders = (this.products.get(product.id).orders || 0) + 1;
        if (loop) {
          this._setProduct(product.id, {
            status: "watching",
            detail: `Order #${orders} via ${source} — looping`,
            attempts,
            orders,
            busy: false,
          });
        } else {
          this._setProduct(product.id, {
            status: "success",
            detail: result.confirmed === false ? "Placed — verify in browser" : "Order placed!",
            attempts,
            orders,
            busy: false,
          });
        }
        notify(cfg, { title: "Order placed", message: product.name || this._productKey(product) });
        if (loop && page && !page.isClosed?.()) {
          void this._tryImmediateRebuy(product, page);
        }
        return { ok: true, purchased: true, result, latencySummary };
      }

      breaker.success();
      const latencySummary = trace.finish({ ok: true });
      if (result.dryRun) {
        this._setProduct(product.id, { status: "dry_run", detail: "Dry run — cart filled", attempts, busy: false });
      } else {
        this._setProduct(product.id, { status: "needs_review", detail: "Ready — place order in browser", attempts, busy: false });
      }
      return { ok: true, result, latencySummary };
    } catch (err) {
      const msg = err.message || String(err);
      // Empty-cart / page-OOS misses are normal during contested drops — don't trip
      // the account-wide ATC breaker and block the next live SKU.
      const softFail =
        /out of stock|empty cart|not in active cart|kept going back to add\/spam|buy box not ready|page OOS/i.test(
          msg
        );
      if (!softFail) breaker.failure();
      const latencySummary = trace.finish({ ok: false, error: msg });
      this.log("err", `Checkout failed (${product.name}): ${msg}`);
      const isSiteIssue = /unavailable|heavy traffic|glitch|timed out|bot challenge|captcha|session expired/i.test(msg);
      if (isSiteIssue) {
        const store = this._retailer(product) === "walmart" ? "Walmart" : "Target";
        notify(cfg, { title: `${store} issue during checkout`, message: `${product.name}: ${msg}` });
      }
      this._setProduct(product.id, {
        status: "watching",
        detail: isSiteIssue
          ? `${this._retailer(product) === "walmart" ? "Walmart" : "Target"} issue — still watching (${msg.slice(0, 80)})`
          : `Checkout failed: ${msg.slice(0, 80)}`,
        attempts: (this.products.get(product.id).attempts || 0) + 1,
        busy: false,
      });
      return { ok: false, error: msg, latencySummary };
    } finally {
      this._orderGuard.release(guardKey);
      taskBus.endCheckout(acct.id, { ordered });
    }
  }

  /**
   * Check one product's page and run checkout if in stock.
   * skipReload=true reads the current page (after your manual refresh).
   */
  async _evaluateStockAndCheckout(product, page, { skipReload = false, note = "", forceFull = false } = {}) {
    const cfg = this.config;
    const st = this.products.get(product.id);
    if (!st || st.status === "skipped") {
      return { ok: false, reason: "terminal" };
    }
    if (st.status === "success" && !this._loopCheckouts(cfg)) {
      return { ok: false, reason: "terminal" };
    }
    if (st.busy) return { ok: false, reason: "busy" };

    const dropMode = this._isDropMode(cfg);
    const mon = this._effectiveMonitor(this.config.products?.length || 1);
    const fastCheck = mon.fastChecks || dropMode;
    const checksSinceReload = this._reloadCounters.get(product.id) ?? 0;
    const useLight =
      !forceFull &&
      !skipReload &&
      shouldUseLightPoll(mon, checksSinceReload) &&
      this._isOnProductPage(page, product);

    let r;
    if (useLight) {
      r = await this._checkStock(page, product, { fast: fastCheck, mode: "light" });
      this._reloadCounters.set(product.id, checksSinceReload + 1);
    } else {
      await this._acquireCheckSlot();
      try {
        r = await this._checkStock(page, product, { fast: fastCheck, skipReload, mode: "full" });
      } finally {
        this._releaseCheckSlot();
      }
      this._reloadCounters.set(product.id, 0);
    }

    // DOM-confirmed stock → checkout immediately (no reload delay). API-only hits get one fast confirm.
    if (r.inStock && useLight && !r.domConfirmed && r.source !== "dom") {
      this.log("hit", `${product.name || this._productKey(product)}: API in stock — quick confirm…`);
      await this._acquireCheckSlot();
      try {
        const confirm = await this._checkStock(page, product, { fast: true, skipReload: false, mode: "full" });
        if (!confirm.inStock) {
          if (r.button && r.button !== "API") {
            this.log("warn", "Confirm reload missed stock but buy button was visible — checking out anyway.");
          } else {
            this._setProduct(product.id, {
              status: "watching",
              detail: `${note ? `${note} · ` : ""}False alarm — rechecking`,
              availability: confirm.status,
              lastChecked: Date.now(),
            });
            return { ok: true, inStock: false, status: confirm.status };
          }
        } else {
          r = confirm;
        }
      } finally {
        this._releaseCheckSlot();
      }
      this._reloadCounters.set(product.id, 0);
    }

    const prefix = note ? `${note} · ` : "";
    this._setProduct(product.id, { availability: r.status, lastChecked: Date.now() });

    if (r.thirdParty && isFirstPartyOnly(cfg)) {
      // Third-party marketplace listing (Target Plus / Walmart Marketplace).
      this._setProduct(product.id, { status: "skipped", detail: "Sold by a third-party seller — skipped." });
      this.log("warn", `${product.name || this._productKey(product)}: third-party seller — skipping.`);
      return { ok: true, inStock: false, skipped: true };
    }

    if (!r.inStock) {
      if (st.status !== "needs_review" && st.status !== "dry_run") {
        this._setProduct(product.id, { status: "watching", detail: `${prefix}Out of stock (${r.status})` });
      }
      return { ok: true, inStock: false, status: r.status };
    }

    // Route every stock source through the account-aware checkout path. This
    // preserves per-account contexts, CVVs, locks, breakers, and configured fan-out.
    const queued = this._enqueueStockCheckout(product, {
      source: "pdp-monitor",
      note: note || "pdp-monitor",
      page,
      bypassCooldown: true,
    });
    return { ok: queued, inStock: true, queued };
  }

  /**
   * Force an immediate stock check (reloads the tab). Use when you hear something restocked.
   * Works while monitoring is running.
   */
  async checkNow({ id, tcin, itemId } = {}) {
    if (!this.running) throw new Error("Start monitoring first, then use Check now.");
    await this._ensureBrowser();
    let targets = this.config.products.filter((p) => p.enabled !== false && this._retailerActive(p));
    if (id) targets = targets.filter((p) => p.id === id);
    else if (tcin) targets = targets.filter((p) => String(p.tcin) === String(tcin));
    else if (itemId) targets = targets.filter((p) => String(p.itemId || walmartItemId(p)) === String(itemId));

    if (!targets.length) throw new Error("That product isn't on your watchlist (or its retailer is switched off).");

    this.log("info", `Check now — ${targets.length} product${targets.length === 1 ? "" : "s"}…`);
    const results = [];
    const queue = targets.filter((p) => this._hasProductId(p));
    const workers = Math.min(this._effectiveMonitor(queue.length).maxConcurrentChecks ?? 8, queue.length || 1);
    let idx = 0;
    const runOne = async () => {
      while (idx < queue.length) {
        const product = queue[idx++];
        if (this._retailer(product) === "walmart") {
          for (const account of this._walmartAccounts(product)) {
            const accountId = account.id;
            const runtimeKey = this._walmartRuntimeKey(product, accountId);
            const session =
              this._sessionManager.accountMode() === "multi"
                ? await this._sessionManager.ensureSession(accountId)
                : this._sessionManager.get(accountId) || this._sessionManager.get("local");
            const context = session?.context || this.browser;
            let wmPage = this._walmartPage(product, accountId);
            if (!wmPage || wmPage.isClosed?.()) {
              wmPage = await openChromeWindow(context, { url: walmartProductUrl(product) || "https://www.walmart.com/" });
              await installFastPageRoutes(wmPage);
              this._setWalmartPage(product, accountId, wmPage);
              await positionWalmartQueueTab(wmPage, product).catch(() => {});
            }
            // Never reload a queue-holding page from the manual check action.
            const wmResult = this._walmartInQueue.has(runtimeKey)
              ? await pollWalmartQueueProgress(wmPage, product, { urgent: true })
              : await checkWalmartStock(wmPage, product, { fast: true, skipReload: true, mode: "full" });
            await this._handleWalmartCheckResult(wmPage, product, wmResult, {
              label: "CHECK NOW",
              accountId,
            });
            results.push({
              id: product.id,
              name: product.name,
              itemId: walmartItemId(product),
              accountId,
              ok: true,
              inStock: !!wmResult?.inStock,
              inQueue: !!wmResult?.inQueue,
              status: wmResult?.status,
            });
          }
          continue;
        }
        let page = this.pages.get(product.id);
        if (!page) {
          page = await this._claimOrNewPage(this.browser);
          this.pages.set(product.id, page);
        }
        this._bindManualRefresh(page, product);
        const out = await this._evaluateStockAndCheckout(product, page, { skipReload: false, note: "Check now" });
        results.push({ id: product.id, name: product.name, tcin: product.tcin, ...out });
      }
    };
    await Promise.all(Array.from({ length: workers }, () => runOne()));
    for (const product of targets.filter((p) => !this._hasProductId(p))) {
      results.push({ id: product.id, ok: false, reason: "no_product_id" });
    }
    return { ok: true, results };
  }

  async _warmSession() {
    const sw = this._retailerSwitch(this.config);
    const page = await this._getUtilityPage();
    await page.bringToFront().catch(() => {});
    if (sw !== "walmart") {
      const target = await checkTargetSession(page);
      this._targetSignedIn = !!target.signedIn;
      if (!target.signedIn) {
        this.log("warn", "NOT signed in to Target — click Login in the dashboard (or run npm run login), then sign in in the bot Chrome window.");
      } else {
        this.log("ok", "Target session verified — signed in with saved address/card on your account.");
      }
    }
    if (sw !== "target" && this._walmartWatchlist().length) {
      await page.goto("https://www.walmart.com/account", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      if (await isWalmartLoggedOut(page)) {
        this.log("warn", "Not signed in to Walmart — sign in in the bot Chrome for Walmart products.");
      } else {
        this.log("ok", "Walmart session verified.");
      }
    }
  }

  /** Keep each product on its own tab before polling — manual hunters stay on the PDP. */
  async _warmProductTabs(products) {
    // Walmart uses dedicated tiled windows (_walmartPages) — do not open duplicate tabs here
    const withId = products.filter((p) => this._hasProductId(p) && this._retailer(p) !== "walmart");
    if (!withId.length) return;
    this.log("info", `Opening ${withId.length} product tab${withId.length === 1 ? "" : "s"}…`);
    const batchSize = 4;
    for (let i = 0; i < withId.length; i += batchSize) {
      const batch = withId.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (p) => {
          let page = this.pages.get(p.id);
          if (!page) {
            page = await this._claimOrNewPage(this.browser);
            this.pages.set(p.id, page);
          }
          this._bindManualRefresh(page, p);
          try {
            await this._ensureProductPage(page, p, { fast: true });
            if (this._retailer(p) === "target") {
              await scrollToBuyBox(page, { fastMode: true });
            }
            await this._installInstantStockWatcher(page, p);
          } catch (err) {
            this.log("warn", `Tab failed to load ${p.name || this._productKey(p)}: ${err.message}`);
          }
        })
      );
    }
    this.log("ok", "Product tabs ready — watching for stock.");
    await this._closeExtraBlankTabs();
  }

  /**
   * Cancel work. With an id, abort that product's in-flight checkout (it returns
   * to watching). Without one, cancel the current one-off test/buy task.
   */
  cancel(id) {
    if (id) {
      this.cancelledProducts.add(id);
      const st = this.products.get(id);
      if (st) this._setProduct(id, { status: "watching", detail: "Cancelled — back to watching", busy: false });
      this.log("warn", `Cancelling ${st?.name || id}…`);
    }
    if (!id || this.activeTask) {
      this.cancelRequested = true;
      this.log("warn", "Cancelling the current task…");
    }
    return { ok: true };
  }

  /** Cancel checkout work and stop monitoring one product until it is armed again. */
  pauseProduct(id) {
    const key = String(id || "");
    const product =
      (this.config?.products || []).find((p) => p.id === key) ||
      (this.config?.products || []).find((p) => p.tcin && String(p.tcin) === key) ||
      (this.config?.products || []).find(
        (p) => p.itemId && (String(p.itemId) === key || `wm-${p.itemId}` === key)
      );
    const st = this.products.get(key) || (product ? this.products.get(product.id) : null);
    const resolvedId = product?.id || st?.id || key;
    if (!product && !st) throw new Error("That product is not on your watchlist.");

    if (product) product.enabled = false;
    if (this.config?.products) {
      for (const p of this.config.products) {
        if (p.id === resolvedId) p.enabled = false;
      }
    }
    this.cancelledProducts.add(resolvedId);
    this._setProduct(resolvedId, {
      enabled: false,
      status: "skipped",
      detail: "Stopped — not watching or botting this product",
      busy: false,
    });
    this.log("warn", `Stopped botting ${st?.name || product?.name || resolvedId}.`);
    return { ok: true, id: resolvedId, enabled: false };
  }

  /** True if the Playwright context is still usable (Chrome CDP still connected). */
  async _browserAlive() {
    if (!this.browser) return false;
    try {
      const b = this.browser.browser?.();
      if (b && typeof b.isConnected === "function" && !b.isConnected()) return false;
      this.browser.pages();
      return true;
    } catch {
      return false;
    }
  }

  /** Drop stale browser handles so the next launch starts clean. */
  _resetBrowserHandles() {
    this.browser = null;
    this.utilityPage = null;
    this._monitorPage = null;
    this._checkoutPage = null;
    this._walmartSweepPage = null;
    try {
      this._walmartPages?.clear?.();
    } catch {
      /* ignore */
    }
    try {
      this.pages?.clear?.();
    } catch {
      /* ignore */
    }
  }

  /** Launch the shared persistent browser once, reusing it if still connected. */
  async _ensureBrowser() {
    this._sessionManager.updateConfig(this.config);
    if (this.browser && (await this._browserAlive())) return this.browser;
    if (this.browser) {
      this.log("warn", "Bot Chrome was closed — relaunching…");
      try {
        await this.browser.close?.();
      } catch {
        /* already dead */
      }
      this._resetBrowserHandles();
      await this._sessionManager.closeAll().catch(() => {});
    }
    this.log("info", "Launching browser…");
    if (this._sessionManager.accountMode() === "multi") {
      await this._sessionManager.ensureAll();
      this.browser = (await this._sessionManager.ensurePrimaryContext());
    } else {
      this.browser = await this._sessionManager.ensurePrimaryContext();
    }
    this._emitState();
    return this.browser;
  }

  /** Public accessor used by the web server for search/preview. */
  async ensureBrowser() {
    return this._ensureBrowser();
  }

  /** Chrome starter tabs: about:blank, chrome://newtab, chrome://new-tab-page/, etc. */
  _isBlankOrNewTab(page) {
    try {
      const u = String(page?.url?.() || "");
      return (
        !u ||
        u === "about:blank" ||
        /^chrome:\/\/newtab/i.test(u) ||
        /^chrome:\/\/new-tab-page/i.test(u) ||
        /^chrome:\/\/new-tab-page-third-party/i.test(u)
      );
    } catch {
      return true;
    }
  }

  /**
   * A persistent utility tab for account/favorites/login. Reuses an existing
   * blank/new-tab page when possible so Sign in doesn't leave an extra empty tab.
   */
  async _getUtilityPage() {
    await this._ensureBrowser();
    if (this.utilityPage) {
      try {
        if (!this.utilityPage.isClosed()) return this.utilityPage;
      } catch {
        /* stale handle */
      }
      this.utilityPage = null;
    }

    // Reuse Chrome's starter tab instead of opening a second blank one
    try {
      const pages = (this.browser.pages() || []).filter((p) => p && !p.isClosed?.());
      const blank = pages.find((p) => this._isBlankOrNewTab(p));
      if (blank) {
        this.utilityPage = blank;
        return this.utilityPage;
      }
      // Fresh Chrome often has exactly one starter tab — always reclaim it for login.
      if (pages.length === 1) {
        this.utilityPage = pages[0];
        return this.utilityPage;
      }
    } catch {
      /* fall through */
    }

    try {
      this.utilityPage = await this.browser.newPage();
    } catch (err) {
      this.log("warn", `Utility tab failed (${err.message}) — relaunching Chrome…`);
      this._resetBrowserHandles();
      await this._ensureBrowser();
      const pages = (this.browser.pages() || []).filter((p) => p && !p.isClosed?.());
      const again = pages.find((p) => this._isBlankOrNewTab(p)) || (pages.length === 1 ? pages[0] : null);
      this.utilityPage = again || (await this.browser.newPage());
    }
    return this.utilityPage;
  }

  /** Close leftover about:blank / new-tab pages so only the real pages stay open. */
  async _closeExtraBlankTabs(...keepPages) {
    const keep = new Set(keepPages.flat().filter(Boolean));
    // Never close known working tabs even if they briefly look blank during nav.
    for (const p of [
      this.utilityPage,
      this._checkoutPage,
      this._monitorPage,
      this._walmartSweepPage,
      ...this.pages.values(),
      ...this._walmartPages.values(),
      ...(this._sweepPages || []),
    ]) {
      if (p) keep.add(p);
    }
    for (const session of this._sessionManager?.sessions?.values?.() || []) {
      if (session.pages?.checkout) keep.add(session.pages.checkout);
      if (session.pages?.utility) keep.add(session.pages.utility);
      for (const p of session.pages?.product?.values?.() || []) if (p) keep.add(p);
      for (const p of session.pages?.walmart?.values?.() || []) if (p) keep.add(p);
    }

    const contexts = new Set();
    if (this.browser) contexts.add(this.browser);
    for (const session of this._sessionManager?.sessions?.values?.() || []) {
      if (session.context) contexts.add(session.context);
    }

    for (const ctx of contexts) {
      try {
        for (const p of ctx.pages?.() || []) {
          if (!p || keep.has(p) || p.isClosed?.()) continue;
          if (this._isBlankOrNewTab(p)) await p.close().catch(() => {});
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  /** Reuse an unused blank/new-tab page instead of spawning another tab. */
  async _claimOrNewPage(context = this.browser) {
    const protectedPages = new Set([
      this.utilityPage,
      this._checkoutPage,
      this._monitorPage,
      this._walmartSweepPage,
      ...this.pages.values(),
      ...this._walmartPages.values(),
      ...(this._sweepPages || []),
    ]);
    for (const session of this._sessionManager?.sessions?.values?.() || []) {
      if (session.pages?.checkout) protectedPages.add(session.pages.checkout);
      if (session.pages?.utility) protectedPages.add(session.pages.utility);
      for (const p of session.pages?.product?.values?.() || []) if (p) protectedPages.add(p);
      for (const p of session.pages?.walmart?.values?.() || []) if (p) protectedPages.add(p);
    }
    try {
      const pages = (context?.pages?.() || []).filter((p) => p && !p.isClosed?.());
      const blank = pages.find((p) => this._isBlankOrNewTab(p) && !protectedPages.has(p));
      if (blank) return blank;
      if (pages.length === 1 && this._isBlankOrNewTab(pages[0]) && !protectedPages.has(pages[0])) {
        return pages[0];
      }
    } catch {
      /* fall through */
    }
    return context.newPage();
  }

  /**
   * Open the retailer's sign-in page in bot Chrome (brought to front).
   * Pass retailerOverride from the UI Store dropdown so it always matches what you selected.
   * Optional accountId selects an isolated multi-account Chrome profile.
   */
  async openLoginPage(retailerOverride, accountId = null) {
    const allowed = ["target", "walmart", "both"];
    const raw = String(retailerOverride || "").toLowerCase();
    const sw = allowed.includes(raw) ? raw : this._retailerSwitch(this.config || loadConfig());

    if (!this.config) this.config = loadConfig();
    this.config.retailer = sw;
    this._sessionManager.updateConfig(this.config);

    const acctId = accountId || this._accounts?.[0]?.id || "local";
    this.log("info", `Launching bot Chrome for ${sw} sign-in${accountId ? ` (${acctId})` : ""}…`);

    // Target's reliable entry is /account (redirects to sign-in if logged out).
    // Walmart uses /account/login.
    const loginUrls = {
      walmart: "https://www.walmart.com/account/login",
      target: "https://www.target.com/account",
      both: "https://www.target.com/account",
    };
    const url = loginUrls[sw] || loginUrls.target;

    let page;
    if (this._sessionManager.accountMode() === "multi" && accountId) {
      const session = await this._sessionManager.ensureSession(accountId);
      this.browser = session.context;
      page =
        session.pages.utility && !session.pages.utility.isClosed?.()
          ? session.pages.utility
          : session.context.pages().find((p) => !p.isClosed?.()) || (await session.context.newPage());
      session.pages.utility = page;
      this.utilityPage = page;
    } else {
      try {
        page = await this._getUtilityPage();
      } catch {
        this._resetBrowserHandles();
        page = await this._getUtilityPage();
      }
      this.utilityPage = page;
    }
    page.setDefaultTimeout?.(60000);

    await page.bringToFront().catch(() => {});
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (err) {
      this.log("warn", `Sign-in navigate failed (${err.message}) — retrying with fresh Chrome…`);
      this._resetBrowserHandles();
      if (this._sessionManager.accountMode() === "multi" && accountId) {
        await this._sessionManager.close(accountId).catch(() => {});
        const session = await this._sessionManager.ensureSession(accountId);
        this.browser = session.context;
        page = await session.context.newPage();
        session.pages.utility = page;
      } else {
        page = await this._getUtilityPage();
      }
      this.utilityPage = page;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    await page.bringToFront().catch(() => {});
    // Close Chrome's leftover new-tab starter even if it was briefly claimed.
    this.utilityPage = page;
    await this._closeExtraBlankTabs(page);
    try {
      for (const p of this.browser?.pages?.() || []) {
        if (!p || p === page || p.isClosed?.()) continue;
        if (this._isBlankOrNewTab(p)) await p.close().catch(() => {});
      }
    } catch {
      /* non-fatal */
    }

    try {
      await page.evaluate(() => {
        window.focus();
        document.title = document.title.replace(/^\[Sign in\]\s*/, "");
        document.title = `[Sign in] ${document.title}`;
      });
    } catch {
      /* non-fatal */
    }

    if (sw === "walmart") {
      this.log("info", "Sign in to Walmart in the bot Chrome window (title starts with [Sign in]).");
      return { ok: true, retailer: "walmart", url, accountId: acctId };
    }
    if (sw === "target") {
      this.log("info", "Sign in to Target in the bot Chrome window (title starts with [Sign in]).");
      return { ok: true, retailer: "target", url, accountId: acctId };
    }

    this.log("info", "Sign in to Target first — opening Walmart login…");
    try {
      // Reuse a blank tab if one exists; otherwise one extra tab for Walmart
      let wm = (this.browser.pages() || []).find((p) => {
        try {
          return p !== page && !p.isClosed?.() && this._isBlankOrNewTab(p);
        } catch {
          return false;
        }
      });
      if (!wm) wm = await this._claimOrNewPage(this.browser);
      await wm.goto(loginUrls.walmart, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await wm.bringToFront().catch(() => {});
      await this._closeExtraBlankTabs(page, wm);
    } catch {
      /* non-fatal */
    }
    return { ok: true, retailer: "both", url, accountId: acctId };
  }

  /** Read the user's Target Favorites list (requires being signed in). */
  async getFavorites() {
    const ctx = await this._ensureBrowser();
    const page = await this._getUtilityPage();
    this.log("info", "Reading your Target favorites…");
    const favorites = await fetchFavorites(ctx, {
      page,
      keepPageOpen: true,
      onStatus: (msg) => this.log("info", msg),
    });
    this.log("ok", `Found ${favorites.length} favorite${favorites.length === 1 ? "" : "s"}.`);
    return favorites;
  }

  /** Read the user's Walmart Favorites / My Lists (requires being signed in). */
  async getWalmartFavorites() {
    const ctx = await this._ensureBrowser();
    const page = await this._getUtilityPage();
    this.log("info", "Reading your Walmart favorites…");
    const favorites = await fetchWalmartFavorites(ctx, {
      page,
      keepPageOpen: true,
      onStatus: (msg) => this.log("info", msg),
    });
    this.log("ok", `Found ${favorites.length} Walmart favorite${favorites.length === 1 ? "" : "s"}.`);
    return favorites;
  }

  /** Pre-drop readiness gate — session, challenges, clock. */
  async runReadinessCheck({ retailer, accountId } = {}) {
    await this._ensureBrowser();
    const sw = retailer || this._retailerSwitch();
    const acctId = accountId || this._accounts?.[0]?.id || "local";

    if (this._sessionManager.accountMode() === "multi" && accountId) {
      const result = await this._sessionManager.runReadiness(accountId, sw === "both" ? "target" : sw);
      this._lastReadiness = { ...result, at: Date.now(), retailer: sw, accountId };
      this._emitState();
      return this._lastReadiness;
    }

    const page =
      sw === "walmart"
        ? [...this._walmartPages.values()].find((p) => p && !p.isClosed?.()) || (await this._getUtilityPage())
        : (await this._getCheckoutPage()) || (await this._getUtilityPage());

    if (sw === "walmart" && page && !/walmart\.com/i.test(page.url() || "")) {
      await page.goto("https://www.walmart.com/account", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    } else if (sw !== "walmart" && page && !/target\.com/i.test(page.url() || "")) {
      await page.goto("https://www.target.com/", { waitUntil: "commit", timeout: 20000 }).catch(() => {});
    }

    const result = await runReadinessGate(page, {
      retailer: sw === "both" ? "target" : sw,
      accountId: acctId,
    });
    this._lastReadiness = { ...result, at: Date.now(), retailer: sw, accountId: acctId };

    // Target API-key health (soft — does not fail readiness alone)
    if (sw !== "walmart") {
      try {
        const [redsky, cart] = await Promise.all([
          probeTargetApiHealth(page),
          probeTargetCartApiHealth(page),
        ]);
        const health = { ok: redsky.ok && cart.ok, redsky, cart, detail: `${redsky.detail}; ${cart.detail}` };
        this._lastReadiness.apiHealth = health;
        if (!health.ok) {
          this.log("warn", `Target API health: ${health.detail}`);
        }
        const fallbackRate =
          apiPathStats.blitzOk + apiPathStats.uiFallback > 0
            ? apiPathStats.uiFallback / (apiPathStats.blitzOk + apiPathStats.uiFallback)
            : 0;
        if (fallbackRate > 0.5 && apiPathStats.uiFallback >= 3) {
          this.log("warn", `API checkout fallback rate high (${Math.round(fallbackRate * 100)}%) — session/key may be weak`);
        }
      } catch {
        /* non-fatal */
      }
    }

    if (result.ok) {
      this.log("ok", `Readiness ${result.readyScore}% — ready for drop (${sw}).`);
    } else {
      const failed = result.checks.filter((c) => !c.ok).map((c) => c.detail || c.id);
      this.log("warn", `Readiness ${result.readyScore}% — fix: ${failed.join("; ")}`);
    }
    this._emitState();
    return this._lastReadiness;
  }

  /** Periodic monitor watchdog — logout / PX / wrong page. */
  _startWatchdog() {
    this._stopWatchdog();
    if (this.config?.watchdog?.enabled === false) return;
    const interval = Math.max(4000, Number(this.config?.watchdog?.intervalMs) || 8000);
    this._watchdogTimer = setInterval(() => {
      void this._runWatchdogTick().catch(() => {});
    }, interval);
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  _watchdogShouldNotify(key, cooldownMs = 120000) {
    const now = Date.now();
    const last = this._watchdogNotifyAt.get(key) || 0;
    if (now - last < cooldownMs) return false;
    this._watchdogNotifyAt.set(key, now);
    return true;
  }

  async _recoverCrashedWalmartPage(id, product) {
    if (!product || this._walmartInQueue.has(id)) return;
    const now = Date.now();
    const last = this._watchdogRecoverAt.get(id) || 0;
    if (now - last < 15000) return; // avoid reopen thrash
    this._watchdogRecoverAt.set(id, now);

    const dead = this._walmartPages.get(id);
    this._walmartPages.delete(id);
    try {
      await dead?.close?.();
    } catch {
      /* already dead */
    }

    try {
      const page = await this._claimOrNewPage(this.browser);
      this._walmartPages.set(id, page);
      await positionWalmartQueueTab(page, product).catch(() => {});
      this._logDrop("WATCHDOG", `${id}: recovered crashed tab`, "ok");
    } catch (err) {
      this._logDrop("WATCHDOG", `${id}: recover failed — ${err.message}`, "warn");
    }
  }

  async _runWatchdogTick() {
    if (!this.running || !this.browser) return;
    const samples = [];

    for (const [id, page] of this._walmartPages) {
      if (!page || page.isClosed?.()) continue;
      const product = (this.config.products || []).find((p) => id === p.id || String(id).endsWith(`:${p.id}`));
      const expectInQueue = this._walmartInQueue.has(id);
      const report = await inspectMonitorPage(page, {
        retailer: "walmart",
        expectInQueue,
        product,
      });
      if (report.issues.length) samples.push({ id, retailer: "walmart", product, ...report });
    }

    if (this._checkoutPage && !this._checkoutPage.isClosed?.()) {
      const report = await inspectMonitorPage(this._checkoutPage, { retailer: "target" });
      if (report.issues.length) samples.push({ id: "checkout-warm", retailer: "target", ...report });
    }

    for (const s of samples) {
      const action = s.action?.action;
      const reason = s.action?.reason || s.issues.join(",");
      // Don't flood the activity log every 8s on the same crash.
      const logKey = `${s.id}:${action}:${(s.issues || []).join(",")}`;
      if (this._watchdogShouldNotify(`log:${logKey}`, 20000)) {
        this._logDrop("WATCHDOG", `${s.id}: ${reason}`, "warn");
      }
      if (action === "recover_tab" || s.issues?.includes("target_crashed")) {
        await this._recoverCrashedWalmartPage(s.id, s.product);
        continue;
      }
      if (action === "notify") {
        if (this._watchdogShouldNotify(`toast:${s.id}:${reason}`, 120000)) {
          notify(this.config, { title: "Monitor needs you", message: `${s.id}: ${reason}` });
        }
      } else if (action === "bring_front") {
        const page = this._walmartPages.get(s.id) || this._checkoutPage;
        await page?.bringToFront?.().catch(() => {});
      } else if (action === "reload_safe" && !this._walmartInQueue.has(s.id)) {
        const page = this._walmartPages.get(s.id);
        const product =
          s.product || (this.config.products || []).find((p) => s.id === p.id || String(s.id).endsWith(`:${p.id}`));
        if (page && product && this._retailer(product) === "walmart") {
          await positionWalmartQueueTab(page, product).catch(() => {});
        }
      }
    }
  }

  async start() {
    if (this.running) {
      this.log("warn", "Already running.");
      return this.getState();
    }

    this.config = loadConfig();
    this._accounts = loadAccountProfiles(this.config);
    this._sessionManager.updateConfig(this.config);
    // Refresh remembered CVV in case secrets were updated while stopped.
    const savedCvv = getSavedCvv();
    if (savedCvv && !this.sessionCvv) {
      this.sessionCvv = savedCvv;
      this._sessionCvvByAccount.set("local", savedCvv);
    }
    this.products.clear();

    const allProducts = this.config.products || [];
    const retailerSwitch = this._retailerSwitch(this.config);
    const list = allProducts.filter((p) => p.enabled !== false && this._retailerActive(p));
    const disarmed = allProducts.filter((p) => p.enabled === false);
    const paused = allProducts.filter((p) => p.enabled !== false && !this._retailerActive(p));
    const browserMode = this._usesBrowserMonitor(this.config);
    for (const p of allProducts) {
      const kw = Array.isArray(p.keywords) ? p.keywords : p.keywords ? [p.keywords] : [];
      const armed = p.enabled !== false;
      const active = armed && this._retailerActive(p);
      this._setProduct(p.id, {
        id: p.id,
        name: p.name || kw.join(", ") || this._productKey(p),
        tcin: p.tcin,
        itemId: p.itemId,
        retailer: this._retailer(p),
        keywords: kw,
        enabled: armed,
        status: !armed ? "skipped" : !this._retailerActive(p) ? "skipped" : this._hasProductId(p) ? "watching" : "resolving",
        detail: !armed
          ? "Disarmed — not monitoring (toggle Arm on the watchlist)"
          : !this._retailerActive(p)
          ? `Paused — retailer switch is set to ${retailerSwitch.toUpperCase()}`
          : this._hasProductId(p)
          ? "Watching for stock"
          : `Searching: ${kw.join(", ")}`,
        availability: null,
        attempts: 0,
        retryAfter: 0,
      });
    }

    const nTarget = list.filter((p) => this._retailer(p) === "target").length;
    const nWalmart = list.filter((p) => this._retailer(p) === "walmart").length;
    const parts = [];
    if (disarmed.length) parts.push(`${disarmed.length} disarmed`);
    if (paused.length) parts.push(`${paused.length} paused`);
    this.log(
      "ok",
      `Monitoring ${nTarget} Target + ${nWalmart} Walmart (${retailerSwitch.toUpperCase()})${parts.length ? ` · ${parts.join(", ")}` : ""}.`
    );
    if (list.length > 10) {
      this.log(
        "warn",
        `${list.length} armed products — Chrome will feel heavy. Disarm extras on the watchlist and keep ~3–8 for drops.`
      );
    }
    if (!list.length) {
      this.log("warn", "Nothing armed — toggle Arm on watchlist items you want to bot, then Start again.");
    }
    if (retailerSwitch !== "target" && nWalmart === 0) {
      const hasWm = allProducts.some((p) => this._retailer(p) === "walmart");
      this.log(
        "warn",
        hasWm
          ? "Walmart is on but no Walmart products are armed — toggle Arm on the ones you want."
          : "Walmart is switched on but the watchlist has no Walmart products — paste a walmart.com/ip/... link in the dashboard to add one."
      );
    }

    await this._ensureBrowser();

    if (list.length) this._applyStealthPolling(list.length);

    await this._warmSession();

    // Pre-drop readiness (session / challenge / clock)
    try {
      await this.runReadinessCheck({ retailer: retailerSwitch === "both" ? "target" : retailerSwitch });
    } catch (err) {
      this.log("warn", `Readiness check failed: ${err.message}`);
    }

    if (browserMode) {
      await this._warmProductTabs(list);
    } else if (this._usesFastApiMonitor(this.config)) {
      this.log("ok", `Fast API monitor — polling ${list.length} armed TCIN(s) + PDP sweep for drops.`);
      await this._warmProductTabs(list);
      await this._warmCheckoutTab();
    } else {
      this.log("ok", "Waiting for webhook/Discord alerts — browser idle until alert.");
    }

    if (this.config.monitor?.discordBridge?.enabled) {
      try {
        this._discordBridge = await startDiscordBridge(this, this.config);
      } catch (err) {
        this.log("warn", `Discord bridge failed: ${err.message}`);
      }
    } else if (this._usesExternalMonitor(this.config)) {
      this.log("warn", "External monitor mode but Discord bridge is off — enable it in Settings for instant cook-group alerts.");
    }

    this.running = true;
    this.cancelledProducts.clear();
    this._lastDropWindowLabel = null;
    this._dropBurstStarted = false;
    this._wakeWatchers = false;
    this._emitState();

    // Dedicated scheduler keeps activation independent from monitor sleep cadence.
    this._dropWindowTimer = setInterval(() => {
      if (!this.running || this._dropWindowTicking) return;
      this._dropWindowTicking = true;
      void this._checkDropWindowTransition(this.config.products?.length || 1)
        .catch((err) => this.log("warn", `Drop scheduler: ${err.message}`))
        .finally(() => {
          this._dropWindowTicking = false;
        });
    }, 100);

    if (this._usesFastApiMonitor(this.config) && this._targetWatchlist().length) {
      this._fastMonitorTask = this._runFastApiMonitorWithRestart().catch((err) =>
        this.log("err", `Fast API monitor loop ended: ${err.message}`)
      );
      this._startPdpSweepWorkers();
    }
    // Walmart has no fast API — dedicated tab(s) per product during drops (queue-safe).
    if (this._walmartWatchlist().length) this._startWalmartMonitors();

    this._startWatchdog();
    // Give async Walmart/PDP openers a moment, then drop leftover blanks.
    setTimeout(() => {
      void this._closeExtraBlankTabs();
    }, 2500);

    if (this._performanceMode(this.config)) {
      this.log("ok", "Performance mode ON — API-first ATC, warm checkout tab, latency telemetry.");
    }

    const dropMon = list.length ? this._effectiveMonitor(list.length) : null;
    if (dropMon?.dropWindowActive) {
      this._lastDropWindowLabel = dropMon.dropWindowLabel;
      if (this._usesFastApiMonitor(this.config)) {
        const dropMs = this.config.monitor?.fastApiMonitor?.dropPollIntervalMs ?? 250;
        this.log("hit", `${dropMon.dropWindowLabel} — API ~${(dropMs / 1000).toFixed(1)}s + PDP sweep reloading all pages.`);
      } else {
        this.log("hit", `${dropMon.dropWindowLabel} — fast checks active (~${(dropMon.pollIntervalMs / 1000).toFixed(0)}s per tab).`);
      }
    }

    if (!allProducts.length) {
      this.log("warn", "Watchlist is empty — add products, then Start. (Browser stays open.)");
    } else if (!list.length) {
      this.log("warn", `Retailer switch is ${retailerSwitch.toUpperCase()} but no ${retailerSwitch} products are on the watchlist — nothing to watch.`);
    } else {
      this._logReadinessCheck();
      if (this.config.checkout.dryRun) {
        this.log("warn", "DRY RUN is ON — nothing will be purchased.");
      } else if (this.config.checkout.autoPlaceOrder) {
        const hype = this._isHypeMode(this.config);
        const mode = this.config.monitor?.mode || "fast";
        const qty = this.config.checkout?.maxOutQuantity !== false ? (this.config.checkout?.pokemonQuantityCap ?? 2) : 1;
        const loop = this._loopCheckouts(this.config);
        this.log(
          "warn",
          `AUTO-BUY is ON — ${mode} monitor · qty ${qty}/order${loop ? " · loop rebuy" : ""} · ${hype ? "hype" : "drop"} checkout.`
        );
      } else {
        this.log("warn", "Bot will fill the cart; you place the final order.");
      }
    }

    // One independent watcher (and dedicated tab) per product, running in parallel.
    this.watchers = list.map((p, i) =>
      this._watchProduct(p, i, list.length).catch((err) => this.log("err", `Watcher crashed: ${err.message}`))
    );
    return this.getState();
  }

  /** Sleep in small slices so stop()/cancel take effect quickly. */
  async _sleepSlices(ms) {
    const target = Date.now() + ms;
    const slice = ms <= 400 ? 50 : 200;
    while (this.running && Date.now() < target) {
      if (this._wakeWatchers) break;
      await sleep(Math.min(slice, target - Date.now()));
    }
  }

  /**
   * Wait until the next scheduled check. Wakes immediately when a drop window
   * opens so watchers don't sit through a 2+ minute sleep from off-hours pacing.
   */
  async _sleepUntilNextCheck(productIndex, productCount) {
    while (this.running) {
      await this._checkDropWindowTransition(productCount);
      const mon = this._effectiveMonitor(productCount);
      const ms = nextInterval(mon, { productIndex, productCount });
      const deadline = Date.now() + ms;
      const dropActive = !!mon.dropWindowActive;
      while (this.running && Date.now() < deadline) {
        if (this._wakeWatchers) {
          this._wakeWatchers = false;
          return;
        }
        await sleep(200);
        const nowMon = this._effectiveMonitor(productCount);
        if (nowMon.dropWindowActive !== dropActive) return;
      }
      if (!this.running) return;
      if (Date.now() >= deadline) return;
    }
  }

  /**
   * Watch ONE product on its own dedicated tab: resolve keywords, poll stock,
   * and check out on that same tab the moment it's in stock & sold by Target.
   * Terminal states: "success" (bought) and "skipped" (third-party seller).
   */
  async _watchProduct(product, productIndex = 0, productCount = 1) {
    const cfg = this.config;
    const externalOnly =
      this._usesExternalMonitor(cfg) && !this._usesBrowserMonitor(cfg) && !this._usesFastApiMonitor(cfg);

    if (externalOnly) {
      // No browser scraping — wait for webhook/Discord alerts.
      this._setProduct(product.id, {
        status: "watching",
        detail: "Waiting for external alert (webhook/Discord)",
      });
      while (this.running) {
        const st = this.products.get(product.id);
        if (!st || st.status === "skipped") break;
        if (st.status === "success" && !this._loopCheckouts(cfg)) break;
        if (st.busy) {
          await this._sleepSlices(300);
          continue;
        }
        await this._sleepSlices(5000);
      }
      return;
    }

    const fastApiOnly = this._usesFastApiMonitor(cfg);

    const startDelay = this._staggerStartMs(productIndex, productCount);
    if (startDelay > 0) await this._sleepSlices(startDelay);

    let page = this.pages.get(product.id);
    if (!page) {
      page = await this._claimOrNewPage(this.browser);
      this.pages.set(product.id, page);
    }
    this._bindManualRefresh(page, product);

    if (this._hasProductId(product)) {
      try {
        await this._ensureProductPage(page, product, { fast: this._isDropMode(cfg) });
        await this._installInstantStockWatcher(page, product);
      } catch (err) {
        this.log("warn", `Could not open tab for ${product.name || this._productKey(product)}: ${err.message}`);
      }
    }

    // Sweeper reloads PDPs in foreground — product tabs stay warm for instant checkout only.
    if (fastApiOnly) {
      const monStart = this._effectiveMonitor(productCount);
      const isWalmart = this._retailer(product) === "walmart";
      const isHybridBackup =
        cfg.monitor?.mode === "hybrid" &&
        cfg.monitor?.hybridBrowserBackup !== false &&
        this._retailer(product) === "target";
      let lastHybridBackup = 0;
      this._setProduct(product.id, {
        status: "watching",
        detail: isWalmart
          ? "Walmart tab warm — dedicated monitor handles queue + stock"
          : isHybridBackup
          ? monStart.dropWindowActive
            ? "Fast API + hybrid PDP backup"
            : "Fast API + hybrid PDP backup (off-hours)"
          : monStart.dropWindowActive
          ? "PDP sweep + API watching"
          : "PDP tab warm — Fast API monitor handles stock",
      });
      while (this.running) {
        const st = this.products.get(product.id);
        if (!st || st.status === "skipped") break;
        if (st.status === "success" && !this._loopCheckouts(cfg)) break;
        if (st.busy) {
          await this._sleepSlices(150);
          continue;
        }
        await this._checkDropWindowTransition(productCount);
        if (isHybridBackup) {
          const mon = this._effectiveMonitor(productCount);
          const backupMs = mon.dropWindowActive ? 30000 : 120000;
          if (Date.now() - lastHybridBackup >= backupMs) {
            lastHybridBackup = Date.now();
            await this._evaluateStockAndCheckout(product, page, { skipReload: false, note: "Hybrid backup" }).catch(
              (err) => this.log("warn", `Hybrid backup (${product.name}): ${err.message}`)
            );
          }
        }
        if (page.isClosed?.()) {
          this.log("warn", `Product tab closed for ${product.name || this._productKey(product)} — reopening…`);
          page = await this._claimOrNewPage(this.browser);
          this.pages.set(product.id, page);
          this._bindManualRefresh(page, product);
          await this._ensureProductPage(page, product, { fast: true }).catch(() => {});
          await this._installInstantStockWatcher(page, product);
        }
        if (!this._isOnProductPage(page, product)) {
          await this._ensureProductPage(page, product, { fast: true }).catch(() => {});
        }
        await this._sleepSlices(this._effectiveMonitor(productCount).dropWindowActive ? 5000 : 120000);
      }
      return;
    }

    while (this.running) {
      const st = this.products.get(product.id);
      if (!st || st.status === "skipped") break;
      if (st.status === "success" && !this._loopCheckouts(cfg)) break;

      await this._checkDropWindowTransition(productCount);

      // A cancel during checkout sends us back to watching; clear the flag here.
      if (this.cancelledProducts.has(product.id)) this.cancelledProducts.delete(product.id);

      if (st.busy) {
        const mon = this._effectiveMonitor(productCount);
        await this._sleepSlices(mon.dropWindowActive || mon.hypePolling ? 200 : 2000);
        continue;
      }

      // Resolve keyword-only Target cards to a concrete TCIN.
      if (!this._hasProductId(product) && product.keywords && this._retailer(product) === "target") {
        try {
          const match = await resolveProductByKeywords(product, this.browser);
          if (match) {
            const pct = Math.round((match.score || 0) * 100);
            product.tcin = match.tcin;
            product.url = match.url;
            product.name = product.name || match.title;
            this._setProduct(product.id, {
              tcin: match.tcin,
              name: product.name,
              matchPct: pct,
              status: "watching",
              detail: `Matched ${pct}% — ${match.title}`,
            });
            this.log("ok", `Matched ${pct}% "${(product.keywords || []).join(", ")}" → ${match.title}`);
          }
        } catch {
          /* retry next cycle */
        }
        if (!this._hasProductId(product)) {
          await this._sleepUntilNextCheck(productIndex, productCount);
          continue;
        }
      }

      try {
        const out = await this._evaluateStockAndCheckout(product, page, { skipReload: false });
        if (out.purchased && !out.looping) break;
        if (out.skipped) break;
      } catch (err) {
        this._setProduct(product.id, { status: "watching", detail: `Check error: ${err.message}` });
      }

      await this._sleepUntilNextCheck(productIndex, productCount);
    }
  }

  async stop() {
    this.running = false;
    this.cancelRequested = true;
    this._stopWatchdog();
    if (this._dropWindowTimer) {
      clearInterval(this._dropWindowTimer);
      this._dropWindowTimer = null;
    }
    this._dropWindowTicking = false;
    await stopDiscordBridge().catch(() => {});
    const bgTasks = [
      this._fastMonitorTask,
      ...(this._sweepTasks || []),
      ...this._stopWalmartMonitors(),
    ].filter(Boolean);
    this._fastMonitorTask = null;
    this._sweepPages = [];
    this._sweepTasks = [];
    this._monitorPage = null;
    this._checkoutPage = null;
    this._lastFastHit.clear();
    await Promise.allSettled(bgTasks);
    try {
      await Promise.allSettled(this.watchers);
    } catch {
      /* ignore */
    }
    this.watchers = [];
    this.pages.clear();
    if (this.browser) {
      this.log("info", "Closing browser…");
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    await this._sessionManager.closeAll().catch(() => {});
    this.cancelRequested = false;
    this._emitState();
    return this.getState();
  }

  /**
   * Shared one-off checkout used by Test (dry run) and Buy now (real purchase).
   * Resolves keywords if needed and runs the checkout on a fresh tab.
   */
  async _oneOffCheckout(spec, { dryRun, autoPlaceOrder, label }) {
    if (this.running) throw new Error("Stop monitoring before running a one-off action.");

    const base = loadConfig();
    this.config = base;
    this._accounts = loadAccountProfiles(base);
    this._sessionManager.updateConfig(base);
    const accountId = spec.accountId || this._accounts[0]?.id || "local";
    const simulateDrop = dryRun && base.checkout?.hypeMode !== false;
    const cfg = this._cfgWithCvv({
      ...base,
      checkout: {
        ...base.checkout,
        dryRun,
        autoPlaceOrder,
        ...(dryRun ? { checkoutRetries: 2 } : {}),
      },
    }, accountId);

    const kw = Array.isArray(spec.keywords) ? spec.keywords : spec.keywords ? [spec.keywords] : [];
    const retailer = spec.retailer || (spec.itemId || /walmart\.com/i.test(spec.url || "") ? "walmart" : "target");
    const product = {
      id: spec.id || `${label}-${spec.name || kw.join("-") || spec.tcin || spec.itemId || Date.now()}`,
      name: spec.name || kw.join(", ") || spec.tcin || spec.itemId || `${label} product`,
      retailer,
      tcin: spec.tcin ? String(spec.tcin) : null,
      itemId: spec.itemId ? String(spec.itemId) : null,
      keywords: kw,
      matchThreshold: spec.matchThreshold,
      maxQuantity: spec.maxQuantity || 1,
      url: spec.url,
    };

    this.cancelRequested = false;
    this.activeTask = product.id;
    this._emitState();
    const shouldCancel = () => this.cancelRequested;

    this._setProduct(product.id, {
      id: product.id,
      name: product.name,
      retailer,
      tcin: product.tcin,
      itemId: product.itemId,
      keywords: kw,
      status: "processing",
      detail: dryRun ? "Test starting (dry run — will NOT buy)…" : "Buy now starting…",
      attempts: 0,
      retryAfter: 0,
      test: dryRun,
    });
    this.log("info", dryRun ? `TEST: "${product.name}" — dry run, nothing will be purchased.` : `BUY NOW: "${product.name}" — will attempt a real purchase.`);

    await this._ensureBrowser();
    const accountSession =
      this._sessionManager.accountMode() === "multi"
        ? await this._sessionManager.ensureSession(accountId)
        : this._sessionManager.get(accountId) || this._sessionManager.get("local");
    const context = accountSession?.context || this.browser;
    let sessionPage = accountSession?.pages?.utility;
    if (!sessionPage || sessionPage.isClosed?.()) {
      sessionPage = (await this._claimOrNewPage(context)) || context.pages().find((p) => !p.isClosed?.());
      if (accountSession) accountSession.pages.utility = sessionPage;
    }
    if (retailer === "walmart") {
      await sessionPage.goto("https://www.walmart.com/account", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      if (await isWalmartLoggedOut(sessionPage)) {
        this._setProduct(product.id, {
          status: "failed",
          detail: "Not signed in to Walmart — sign in in bot Chrome, then retry.",
        });
        this.log("err", "Not signed in to Walmart. Sign in at walmart.com/account in the bot Chrome window.");
        return { ok: false, error: "not_signed_in" };
      }
    } else {
      const session = await checkTargetSession(sessionPage);
      if (!session.signedIn) {
        this._setProduct(product.id, {
          status: "failed",
          detail: "Not signed in — click Login in dashboard, sign in in bot Chrome, then retry.",
        });
        this.log("err", "Not signed in to Target. Use Login in the dashboard (bot Chrome window), then retry.");
        return { ok: false, error: "not_signed_in" };
      }
    }

    const page = await this._claimOrNewPage(context);

    try {
      if (dryRun && spec.clearCart === true && retailer === "target") {
        this.log("info", "Benchmark prep: clearing Target cart (no purchase).");
        await clearCartForDrop(page, { fastMode: true });
      }
      if (!this._hasProductId(product) && kw.length && this._retailer(product) === "target") {
        this._setProduct(product.id, { status: "resolving", detail: "Searching for a matching product…" });
        const match = await resolveProductByKeywords(product, context);
        if (!match) {
          this._setProduct(product.id, { status: "failed", detail: "No product met your keyword/threshold." });
          return { ok: false, reason: "no_match" };
        }
        product.tcin = match.tcin;
        product.url = match.url;
        const pct = Math.round((match.score || 0) * 100);
        this._setProduct(product.id, { tcin: match.tcin, matchPct: pct, detail: `Matched ${pct}% — ${match.title}` });
        this.log("ok", `Matched ${pct}%: ${match.title}`);
      }
      if (!this._hasProductId(product)) {
        this._setProduct(product.id, { status: "failed", detail: "No product ID (TCIN or Walmart itemId)." });
        return { ok: false, reason: "no_target" };
      }

      const t0 = Date.now();
      const progress = { phase: "starting", lastAt: Date.now() };
      const latency = createLatencyTrace({
        productId: product.id,
        retailer,
        source: label,
        name: product.name,
        accountId,
      });
      latency.mark("stock_signal");
      latency.mark("stock_confirmed");
      const stopSentinel = this._startCheckoutSentinel(page, product, cfg, progress);
      let result;
      try {
        result = await this._runCheckout(product, cfg, {
          context,
          page,
          fastMode: simulateDrop || this._isDropMode(cfg),
          dropWindowActive: simulateDrop || this._isDropMode(cfg),
          hypeMode: simulateDrop || this._isHypeMode(cfg),
          shouldCancel,
          latency,
          onPhase: (name, detail) => {
            progress.phase = name;
            progress.lastAt = Date.now();
            const mapped = PHASE_TO_STATUS[name];
            if (mapped) this._setProduct(product.id, { status: mapped[0], detail: detail || mapped[1] });
            const plabel = product.name || product.tcin;
            if (name === "adding_to_cart") this._logDrop("CHECKOUT", `${plabel}: adding to cart…`, "ok");
            else if (name === "checking_out") this._logDrop("CHECKOUT", `${plabel}: rushing to checkout…`, "ok");
            else if (name === "placing_order") this._logDrop("CHECKOUT", `${plabel}: placing order…`, "hit");
            else if (name === "in_stock") this._logDrop("CHECKOUT", `${plabel}: in stock — buying now`, "hit");
          },
          onLog: (level, message) => {
            progress.lastAt = Date.now(); // log activity = checkout is alive
            this.log(level, message);
          },
        });
      } finally {
        stopSentinel();
      }
      const totalMs = Date.now() - t0;
      const latencySummary = latency.finish({
        ok: !!(result?.placed || result?.dryRun || result?.manual),
        error: result?.error || null,
      });

      if (result.placed) {
        this._setProduct(product.id, { status: "success", detail: result.confirmed === false ? "Placed — verify in browser" : "Order placed!" });
        this.log("ok", `Order placed: ${product.name}`);
      } else if (result.dryRun) {
        this._setProduct(product.id, { status: "dry_run", detail: `Test OK — reached checkout in ${(totalMs / 1000).toFixed(1)}s (no purchase).`, totalMs });
        this.log("ok", `TEST complete in ${(totalMs / 1000).toFixed(1)}s (nothing purchased).`);
      } else {
        this._setProduct(product.id, { status: "needs_review", detail: "Ready — place order in browser." });
      }
      return { ok: true, totalMs, result, latencySummary };
    } catch (err) {
      const cancelled = /cancelled by user/i.test(err.message);
      const thirdParty = /third-party/i.test(err.message);
      const status = thirdParty ? "skipped" : cancelled ? "watching" : "failed";
      this._setProduct(product.id, { status, detail: thirdParty ? "Sold by a third-party seller — skipped." : cancelled ? "Cancelled." : `Failed: ${err.message}` });
      this.log(cancelled ? "warn" : "err", `${label}: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      if (dryRun && spec.clearCart === true && retailer === "target") {
        await clearCartForDrop(page, { fastMode: true }).catch(() => {});
      }
      await page.close().catch(() => {});
      await this._closeExtraBlankTabs(sessionPage);
      this.activeTask = null;
      this.cancelRequested = false;
      this._emitState();
    }
  }

  /** Dry-run a single product card end-to-end without buying. */
  async testCheckout(spec) {
    return this._oneOffCheckout(spec, { dryRun: true, autoPlaceOrder: false, label: "test" });
  }

  /** Fully attempt a real purchase of a single product card right now. */
  async buyNow(spec) {
    return this._oneOffCheckout(spec, { dryRun: false, autoPlaceOrder: true, label: "buy" });
  }
}

export const engine = new Engine();
