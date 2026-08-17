/**
 * Multi-account task scaffolding (Stellar/Refract-style).
 * Phase 4: isolated monitor → watch-checkout tasks, one checkout per account.
 *
 * Default mode remains single localhost account. Multi-account is opt-in via config.accounts[].
 */

import { EventEmitter } from "node:events";

/** Normalize account profiles from config. Caps enabled accounts at 5. */
export function loadAccountProfiles(cfg = {}) {
  const list = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  if (list.length) {
    const mapped = list.map((a, i) => ({
      id: String(a.id || `acct-${i + 1}`),
      retailer: a.retailer || "both",
      label: a.label || a.id || `Account ${i + 1}`,
      proxyGroup: a.proxyGroup || null,
      maxOrders: Number(a.maxOrders) > 0 ? Number(a.maxOrders) : 1,
      enabled: a.enabled !== false,
      profileDir: a.profileDir || null,
      cdpPort: a.cdpPort ? Number(a.cdpPort) : null,
    }));
    let enabledCount = 0;
    return mapped.map((a) => {
      if (a.enabled) {
        enabledCount += 1;
        if (enabledCount > 5) return { ...a, enabled: false };
      }
      return a;
    });
  }
  // Implicit single account (current bot Chrome profile)
  return [
    {
      id: "local",
      retailer: cfg.retailer || "both",
      label: "Local session",
      proxyGroup: null,
      maxOrders: Number(cfg.checkout?.maxOrdersPerAccount) > 0 ? Number(cfg.checkout.maxOrdersPerAccount) : 3,
      enabled: true,
      profileDir: null,
      cdpPort: null,
    },
  ];
}

/**
 * In-process stock bus: monitor tasks publish, watch-checkout tasks subscribe.
 * One checkout task per accountId+retailer (Stellar constraint).
 */
export class TaskBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._checkoutLocks = new Map(); // accountId -> productKey currently buying
    this._orderCounts = new Map(); // accountId -> count
  }

  publishStock(event) {
    // event: { retailer, productKey, product, source, accountId? }
    this.emit("stock", event);
  }

  canCheckout(accountId, { maxOrders = 1 } = {}) {
    if (this._checkoutLocks.has(accountId)) return false;
    const n = this._orderCounts.get(accountId) || 0;
    return n < maxOrders;
  }

  beginCheckout(accountId, productKey) {
    if (this._checkoutLocks.has(accountId)) return false;
    this._checkoutLocks.set(accountId, productKey);
    return true;
  }

  endCheckout(accountId, { ordered = false } = {}) {
    this._checkoutLocks.delete(accountId);
    if (ordered) {
      this._orderCounts.set(accountId, (this._orderCounts.get(accountId) || 0) + 1);
    }
  }

  stats() {
    return {
      busyAccounts: [...this._checkoutLocks.entries()].map(([id, key]) => ({ accountId: id, productKey: key })),
      orderCounts: Object.fromEntries(this._orderCounts),
    };
  }
}

/** Shared singleton bus for the engine process. */
export const taskBus = new TaskBus();
