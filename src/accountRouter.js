/**
 * Account selection for 1–5 account mode.
 * Strategies: first | least_orders | round_robin | sticky
 */

import { taskBus } from "./taskBus.js";

const stickyMap = new Map(); // productKey -> accountId
let rrIndex = 0;

export function resetAccountRouterState() {
  stickyMap.clear();
  rrIndex = 0;
}

export function eligibleAccounts(accounts, product, { maxFanOut = 1 } = {}) {
  const retailer = product?.retailer || "target";
  const list = (accounts || []).filter(
    (a) => a && a.enabled !== false && (a.retailer === "both" || a.retailer === retailer) && taskBus.canCheckout(a.id, { maxOrders: a.maxOrders ?? 1 })
  );
  return list.slice(0, Math.max(1, maxFanOut));
}

/**
 * Pick account(s) for a product stock hit.
 * @returns {Array<object>}
 */
export function selectAccountsForProduct(accounts, product, { strategy = "first", maxFanOut = 1 } = {}) {
  const eligible = eligibleAccounts(accounts, product, { maxFanOut: 99 });
  if (!eligible.length) return [];

  const productKey = String(product?.id || product?.tcin || product?.itemId || "");
  const fan = Math.max(1, Math.min(maxFanOut, eligible.length));

  if (strategy === "sticky" && productKey) {
    const preferred = stickyMap.get(productKey);
    const hit = preferred && eligible.find((a) => a.id === preferred);
    if (hit) return [hit, ...eligible.filter((a) => a.id !== hit.id)].slice(0, fan);
  }

  let ordered = eligible;
  if (strategy === "least_orders") {
    ordered = [...eligible].sort((a, b) => {
      const ca = taskBus.stats().orderCounts[a.id] || 0;
      const cb = taskBus.stats().orderCounts[b.id] || 0;
      return ca - cb;
    });
  } else if (strategy === "round_robin") {
    if (!eligible.length) return [];
    const start = rrIndex % eligible.length;
    rrIndex += 1;
    ordered = [...eligible.slice(start), ...eligible.slice(0, start)];
  }

  const picked = ordered.slice(0, fan);
  if (strategy === "sticky" && productKey && picked[0]) stickyMap.set(productKey, picked[0].id);
  return picked;
}
