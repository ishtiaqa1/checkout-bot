/** Shared helpers used across modules. */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Parse Walmart item ID from a product URL (single source of truth). */
export function parseWalmartItemId(url = "") {
  if (!url) return null;
  const m = url.match(/\/ip\/[^/]+\/(\d{6,})/) || url.match(/\/(\d{8,})(?:[?#]|$)/);
  return m?.[1] || null;
}

/** Normalize retailer from product fields. */
export function productRetailer(product) {
  if (product?.retailer) return product.retailer;
  if (/walmart\.com/i.test(product?.url || "")) return "walmart";
  return "target";
}

/** First-party-only filter (Target + Walmart marketplace skip). */
export function isFirstPartyOnly(cfg = {}) {
  const co = cfg.checkout || {};
  if (co.firstPartyOnly === false) return false;
  return co.targetSoldOnly !== false;
}
