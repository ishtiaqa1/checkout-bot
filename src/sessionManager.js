/**
 * Per-account browser session manager (1 Chrome profile / CDP port / optional proxy).
 * Single mode wraps today's shared browser-data path as account "local".
 */

import path from "node:path";
import { launchBrowser, probeTargetCartApiHealth } from "./checkout.js";
import { paths } from "./config.js";
import { resolveProxyGroup, chromeProxyArgs, playwrightProxyOption } from "./proxy.js";
import { loadAccountProfiles } from "./taskBus.js";
import { runReadinessGate } from "./readiness.js";
import { probeTargetApiHealth } from "./monitor.js";

const BASE_CDP = 9222;

export class SessionManager {
  constructor({ config, onLog } = {}) {
    this.config = config || {};
    this.onLog = onLog || (() => {});
    /** @type {Map<string, import('./sessionManager.js').AccountSession>} */
    this.sessions = new Map();
  }

  updateConfig(cfg) {
    this.config = cfg || {};
  }

  accountMode() {
    const mode = String(this.config.accountMode || "single").toLowerCase();
    if (mode === "multi") return "multi";
    const accounts = (this.config.accounts || []).filter((a) => a && a.enabled !== false);
    return accounts.length > 1 ? "multi" : "single";
  }

  enabledAccounts() {
    const all = loadAccountProfiles(this.config);
    const enabled = all.filter((a) => a.enabled !== false).slice(0, 5);
    return enabled.length ? enabled : [{ id: "local", retailer: "both", label: "Local session", maxOrders: 3, enabled: true }];
  }

  profileDir(accountId) {
    if (this.accountMode() === "single" || accountId === "local") return paths.browserData;
    return paths.accountBrowserData?.(accountId) || path.join(paths.browserData, String(accountId));
  }

  cdpPortFor(accountId, index = 0) {
    if (this.accountMode() === "single" || accountId === "local") return BASE_CDP;
    const acct = this.enabledAccounts().find((a) => a.id === accountId);
    if (acct?.cdpPort) return Number(acct.cdpPort);
    return BASE_CDP + index + 1;
  }

  async ensureSession(accountId = "local") {
    const existing = this.sessions.get(accountId);
    if (existing?.context) {
      try {
        // Touch pages list to detect dead CDP
        existing.context.pages();
        return existing;
      } catch {
        this.sessions.delete(accountId);
      }
    }

    const accounts = this.enabledAccounts();
    const idx = Math.max(0, accounts.findIndex((a) => a.id === accountId));
    const acct = accounts.find((a) => a.id === accountId) || accounts[0] || { id: "local" };
    const id = acct.id || accountId;
    const proxy = resolveProxyGroup(this.config, acct.proxyGroup);
    const userDataDir = this.profileDir(id);
    const cdpPort = this.cdpPortFor(id, idx);

    this.onLog("info", `Opening browser session "${acct.label || id}" (CDP ${cdpPort})${proxy ? ` via proxy ${proxy.group}` : ""}…`);
    const context = await launchBrowser({
      headless: false,
      userDataDir,
      cdpPort,
      proxy,
      chromeExtraArgs: chromeProxyArgs(proxy),
      playwrightProxy: playwrightProxyOption(proxy),
    });

    const session = {
      id,
      label: acct.label || id,
      account: acct,
      context,
      cdpPort,
      proxy,
      profileDir: userDataDir,
      pages: {
        checkout: null,
        utility: null,
        product: new Map(),
        walmart: new Map(),
      },
      readiness: null,
      lastChallenge: null,
    };
    this.sessions.set(id, session);
    return session;
  }

  /** Ensure the primary/local session and return its Playwright context (legacy API). */
  async ensurePrimaryContext() {
    const accounts = this.enabledAccounts();
    const primary = accounts[0]?.id || "local";
    const session = await this.ensureSession(primary);
    return session.context;
  }

  get(accountId = "local") {
    return this.sessions.get(accountId) || null;
  }

  async ensureAll() {
    if (this.accountMode() !== "multi") {
      return [await this.ensureSession("local")];
    }
    const out = [];
    for (const acct of this.enabledAccounts()) {
      out.push(await this.ensureSession(acct.id));
    }
    return out;
  }

  async runReadiness(accountId, retailer = "target") {
    const session = await this.ensureSession(accountId);
    let page = session.pages.checkout;
    if (!page || page.isClosed?.()) {
      page = session.context.pages().find((p) => !p.isClosed?.()) || (await session.context.newPage());
      session.pages.checkout = page;
    }
    const result = await runReadinessGate(page, { retailer, accountId });
    if (retailer === "target") {
      const [redsky, cart] = await Promise.all([
        probeTargetApiHealth(page),
        probeTargetCartApiHealth(page),
      ]).catch((err) => [
        { ok: false, detail: `Target API health probe failed: ${err.message}` },
        { ok: false, detail: "Target cart API probe skipped" },
      ]);
      result.apiHealth = {
        ok: redsky.ok && cart.ok,
        redsky,
        cart,
        detail: `${redsky.detail}; ${cart.detail}`,
      };
    }
    session.readiness = result;
    return result;
  }

  async close(accountId) {
    const session = this.sessions.get(accountId);
    if (!session) return;
    try {
      await session.context.close?.();
    } catch {
      /* ignore */
    }
    this.sessions.delete(accountId);
  }

  async closeAll() {
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.close(id);
  }

  snapshot() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      label: s.label,
      cdpPort: s.cdpPort,
      proxyGroup: s.account?.proxyGroup || null,
      readiness: s.readiness,
      hasCheckoutPage: !!(s.pages.checkout && !s.pages.checkout.isClosed?.()),
    }));
  }
}

/**
 * @typedef {object} AccountSession
 * @property {string} id
 * @property {import('playwright').BrowserContext} context
 */
