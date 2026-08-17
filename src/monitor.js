import { randomUUID } from "node:crypto";
import { humanPageWarmup } from "./browserUtils.js";
import { isThirdPartySeller, ensureShippingFulfillment, buyBox, isBuyControlEnabled, markBotNavigation, isOnProductPage, ensureProductPage, scrollToBuyBox } from "./checkout.js";

const REDSKY_VARIATION_BASE =
  "https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_and_variation_hierarchy_v1";
const REDSKY_BULK_BASE =
  "https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1";

// Fallback keys Target has used on the web PDP (extracted from page when possible).
const REDSKY_KEY_FALLBACKS = [
  "9f36aeafbe60771e321a7cc95a78140772ab3e96",
  "ff775888581dda2babe1184b75433943469dc6dc",
  "ff457966e64d5e877fdbad070f276d18ecec4a01",
];

// Statuses that mean "you can buy it right now".
const SELLABLE_STATUSES = new Set(["IN_STOCK", "LIMITED_STOCK"]);
// Preorder/launch statuses are buyable even when the live quantity reads 0.
const PREORDER_STATUSES = new Set(["PRELAUNCH_SELLABLE", "PRE_ORDER_SELLABLE"]);

function shippingInStock(shipping) {
  if (!shipping) return false;
  const status = shipping?.availability_status ?? "UNKNOWN";
  const available = shipping?.available_to_promise_quantity;
  if (PREORDER_STATUSES.has(status)) return true;
  if (!SELLABLE_STATUSES.has(status)) return false;
  // Target often omits quantity on IN_STOCK — trust status (and services) when qty is absent.
  if (available == null || available === undefined) return true;
  if (available > 0) return true;
  return Array.isArray(shipping?.services) && shipping.services.length > 0;
}

function isBuyable(status, available) {
  if (PREORDER_STATUSES.has(status)) return true;
  if (SELLABLE_STATUSES.has(status)) return available == null || available > 0;
  return false;
}

function parseFulfillment(data) {
  const fulfillment = data?.data?.product?.fulfillment;
  const shipping = fulfillment?.shipping_options;
  const status = shipping?.availability_status ?? "UNKNOWN";
  const available = shipping?.available_to_promise_quantity ?? 0;
  return {
    inStock: isBuyable(status, available),
    status,
    available,
  };
}

/**
 * Query Target's RedSky fulfillment API for a single product.
 * Returns { inStock, status, raw } or throws on a hard failure.
 */
async function checkViaApi(product, config, visitorId) {
  const { location, monitor } = config;
  const params = new URLSearchParams({
    key: monitor.apiKey,
    tcin: String(product.tcin),
    is_bot: "false",
    store_id: location.storeId ?? "",
    zip: location.zip,
    state: location.state ?? "",
    latitude: String(location.latitude ?? ""),
    longitude: String(location.longitude ?? ""),
    scheduled_delivery_store_id: location.storeId ?? "",
    required_store_id: location.storeId ?? "",
    pricing_store_id: location.storeId ?? "",
    has_pricing_store_id: "true",
    visitor_id: visitorId,
    channel: "WEB",
    page: `/p/A-${product.tcin}`,
  });

  const res = await fetch(`${REDSKY_VARIATION_BASE}?${params.toString()}`, {
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      origin: "https://www.target.com",
      referer: `https://www.target.com/p/A-${product.tcin}`,
    },
  });

  if (res.status === 404) {
    throw new Error(`TCIN ${product.tcin} not found (404). Check the tcin in config.`);
  }
  if (!res.ok) {
    throw new Error(`API returned HTTP ${res.status} (the public apiKey may be stale).`);
  }

  const data = await res.json();
  return parseFulfillment(data);
}

/**
 * Keep one lightweight tab on Target for API stock checks (no product page reloads).
 */
export async function ensureMonitorPage(page) {
  try {
    const url = page.url();
    if (/target\.com/i.test(url) && !url.startsWith("about:")) return;
  } catch {
    /* continue */
  }
  markBotNavigation(page);
  await page.goto("https://www.target.com/", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(400);
}

function parseShippingStock(shipping) {
  const status = shipping?.availability_status ?? "UNKNOWN";
  const available = shipping?.available_to_promise_quantity ?? 0;
  const inStock = shippingInStock(shipping);
  return { inStock, status, available: inStock ? Math.max(available, 1) : 0 };
}

/** Check ALL watchlist TCINs in one tab via RedSky — ~1 round-trip for 18 SKUs. */
export async function batchCheckStockViaPageApi(page, products, { variationOnly = false } = {}) {
  await ensureMonitorPage(page);
  const tcins = products.filter((p) => p.tcin).map((p) => String(p.tcin));
  if (!tcins.length) return [];

  try {
    const rows = await page.evaluate(
      async ({ tcins, keys, bulkBase, variationBase, variationOnly }) => {
        const scripts = [...document.querySelectorAll("script")]
          .map((s) => s.textContent || "")
          .join("\n");
        const scraped = scripts.match(/key['":\s]+([a-f0-9]{40})/i)?.[1];
        const apiKeys = [...new Set([scraped, ...keys].filter(Boolean))];
        if (!apiKeys.length) return null;

        const visitorId =
          (typeof crypto !== "undefined" && crypto.randomUUID
            ? crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 32)
            : Array.from({ length: 32 }, () => "0123456789ABCDEF"[Math.floor(Math.random() * 16)]).join(""));

        const userLoc = document.cookie.match(/UserLocation=([^;]+)/i)?.[1];
        const guestLoc = document.cookie.match(/GuestLocation=([^;]+)/i)?.[1];
        const locParts = (userLoc || guestLoc || "").split("|");
        const zip =
          locParts[0] ||
          localStorage.getItem("tgt:zip") ||
          localStorage.getItem("guestZip") ||
          sessionStorage.getItem("tgt:zip") ||
          "10001";
        const state = locParts[3] || "NY";
        const sdd = document.cookie.match(/sddStore=([^;]+)/i)?.[1] || "";
        const storeId = sdd.match(/DSI_(\d+)/i)?.[1] || "2885";

        const shippingInStock = (shipping) => {
          if (!shipping) return false;
          const status = shipping?.availability_status ?? "UNKNOWN";
          const available = shipping?.available_to_promise_quantity;
          const preorder = ["PRELAUNCH_SELLABLE", "PRE_ORDER_SELLABLE"].includes(status);
          const sellable = ["IN_STOCK", "LIMITED_STOCK"].includes(status);
          if (preorder) return true;
          if (!sellable) return false;
          if (available == null) return true;
          if (available > 0) return true;
          return Array.isArray(shipping?.services) && shipping.services.length > 0;
        };

        const rowFromShipping = (tcin, shipping, checkoutTcin = null) => {
          if (!shipping) return { tcin, inStock: false, status: "UNKNOWN", available: 0 };
          const status = shipping?.availability_status ?? "UNKNOWN";
          const available = shipping?.available_to_promise_quantity ?? 0;
          const inStock = shippingInStock(shipping);
          return {
            tcin,
            inStock,
            status,
            available: inStock ? Math.max(available, 1) : 0,
            checkoutTcin: checkoutTcin || tcin,
          };
        };

        const buyableChild = (product) => {
          const children = Array.isArray(product?.children) ? product.children : [];
          return children.find((child) => shippingInStock(child?.fulfillment?.shipping_options)) || null;
        };

        const parseSummaryList = (data) => {
          const list = data?.data?.product_summaries ?? data?.data?.products ?? [];
          if (!Array.isArray(list) || !list.length) return null;
          return list.map((p) => {
            const id = String(p?.tcin || p?.item?.tcin || "");
            const child = buyableChild(p) || buyableChild(p?.item);
            const shipping =
              child?.fulfillment?.shipping_options ??
              p?.fulfillment?.shipping_options ??
              p?.item?.fulfillment?.shipping_options;
            return rowFromShipping(id, shipping, child?.tcin ? String(child.tcin) : id);
          });
        };

        for (const key of apiKeys) {
          if (!variationOnly) {
            try {
              const bulkParams = new URLSearchParams({
                key,
                tcins: tcins.join(","),
                is_bot: "false",
                zip,
                state,
                store_id: storeId,
                pricing_store_id: storeId,
                has_pricing_store_id: "true",
                visitor_id: visitorId,
                channel: "WEB",
              });
              const bulkRes = await fetch(`${bulkBase}?${bulkParams}`, {
                headers: { accept: "application/json" },
                credentials: "include",
              });
              if (bulkRes.ok) {
                const bulkData = await bulkRes.json();
                const parsed = parseSummaryList(bulkData);
                if (parsed?.length) return parsed;
              }
            } catch {
              /* try singles */
            }
          }

          const singles = await Promise.all(
            tcins.map(async (tcin) => {
              const params = new URLSearchParams({
                key,
                tcin,
                is_bot: "false",
                zip,
                state,
                store_id: storeId,
                pricing_store_id: storeId,
                has_pricing_store_id: "true",
                visitor_id: visitorId,
                channel: "WEB",
                page: `/p/A-${tcin}`,
              });
              try {
                const res = await fetch(`${variationBase}?${params}`, {
                  headers: { accept: "application/json" },
                  credentials: "include",
                });
                if (!res.ok) return { tcin, inStock: false, status: "HTTP_" + res.status, available: 0 };
                const data = await res.json();
                const apiProduct = data?.data?.product;
                const child = buyableChild(apiProduct);
                const shipping = child?.fulfillment?.shipping_options ?? apiProduct?.fulfillment?.shipping_options;
                if (shipping) return rowFromShipping(tcin, shipping, child?.tcin ? String(child.tcin) : tcin);
                const soldOut = apiProduct?.fulfillment?.sold_out;
                return {
                  tcin,
                  inStock: soldOut === false && !data?.data?.product?.fulfillment?.is_out_of_stock_in_all_store_locations,
                  status: soldOut ? "OUT_OF_STOCK" : "UNKNOWN",
                  available: 0,
                };
              } catch {
                return { tcin, inStock: false, status: "ERROR", available: 0 };
              }
            })
          );
          if (singles.some((s) => s.status !== "ERROR" && !String(s.status).startsWith("HTTP_"))) return singles;
        }
        return null;
      },
      { tcins, keys: REDSKY_KEY_FALLBACKS, bulkBase: REDSKY_BULK_BASE, variationBase: REDSKY_VARIATION_BASE, variationOnly }
    );

    if (!rows?.length) return [];
    return rows.map((r) => ({
      ...r,
      source: "fast-api",
      thirdParty: false,
      button: r.inStock ? "API" : null,
    }));
  } catch {
    return [];
  }
}

/**
 * Fast stock probe via RedSky inside the open Target tab (uses browser cookies/session).
 * Works on any target.com page — not just the product PDP.
 */
export async function checkStockViaPageApi(page, product) {
  const rows = await batchCheckStockViaPageApi(page, [product]);
  return rows.find((r) => String(r.tcin) === String(product.tcin)) ?? null;
}

/**
 * Probe RedSky API key health from a warm Target tab.
 * Returns { ok, status, keySource, detail }.
 */
export async function probeTargetApiHealth(page, { tcin = "94960637" } = {}) {
  await ensureMonitorPage(page);
  try {
    const result = await page.evaluate(
      async ({ tcin, keys, variationBase }) => {
        const scraped =
          [...document.scripts]
            .map((s) => s.textContent || "")
            .join("\n")
            .match(/apiKey["']?\s*[:=]\s*["']([a-f0-9]{32,})["']/i)?.[1] || null;
        const apiKeys = [...new Set([scraped, ...keys].filter(Boolean))];
        if (!apiKeys.length) return { ok: false, status: 0, keySource: "none", detail: "No API keys available" };

        for (const key of apiKeys) {
          const params = new URLSearchParams({
            key,
            tcin: String(tcin),
            is_bot: "false",
            channel: "WEB",
          });
          try {
            const res = await fetch(`${variationBase}?${params}`, {
              headers: { accept: "application/json" },
              credentials: "include",
            });
            if (res.status === 401 || res.status === 403) {
              continue;
            }
            if (res.ok) {
              return {
                ok: true,
                status: res.status,
                keySource: key === scraped ? "scraped" : "fallback",
                detail: `RedSky OK (${res.status})`,
              };
            }
            return {
              ok: false,
              status: res.status,
              keySource: key === scraped ? "scraped" : "fallback",
              detail: `RedSky HTTP ${res.status}`,
            };
          } catch (err) {
            return { ok: false, status: 0, keySource: "error", detail: err.message };
          }
        }
        return { ok: false, status: 401, keySource: "all", detail: "All RedSky keys returned 401/403" };
      },
      { tcin, keys: REDSKY_KEY_FALLBACKS, variationBase: REDSKY_VARIATION_BASE }
    );
    return result || { ok: false, status: 0, detail: "Probe failed" };
  } catch (err) {
    return { ok: false, status: 0, detail: err.message };
  }
}

/**
 * Ultra-fast DOM read on the open PDP — no reload (like monitor-only tasks in retail bots).
 * Confirmed with a full reload before checkout when this fires during drops.
 */
export async function checkStockLight(page, product, { fast = true, domOnly = false } = {}) {
  if (!isOnProductPage(page, product)) {
    return { inStock: false, status: "OFF_PAGE", available: 0, thirdParty: false, button: null, light: true, needsReload: true };
  }

  if (!domOnly) {
    const apiHit = await checkStockViaPageApi(page, product);
    if (apiHit?.inStock) {
      await ensureShippingFulfillment(page, { fastMode: fast });
      const buyable = await detectBuyableOnPage(page, { fast });
      if (buyable.inStock) {
        return {
          ...apiHit,
          button: buyable.button,
          source: "api+dom",
          domConfirmed: true,
          thirdParty: await isThirdPartySeller(page).catch(() => false),
        };
      }
      return { ...apiHit, domConfirmed: false, thirdParty: false };
    }
  }

  if (!domOnly) await ensureShippingFulfillment(page, { fastMode: fast });
  const thirdParty = domOnly ? false : await isThirdPartySeller(page).catch(() => false);
  const buyable = await detectBuyableOnPage(page, { fast: domOnly || fast });
  return {
    inStock: buyable.inStock,
    status: buyable.status,
    available: buyable.inStock ? 1 : 0,
    thirdParty,
    button: buyable.button,
    light: true,
    source: domOnly ? "pdp-dom" : "dom",
    domConfirmed: buyable.inStock,
  };
}

/**
 * Resilient fallback: load the product page in the shared browser context and
 * look for an enabled add-to-cart / "shipping" button.
 */
async function checkViaBrowser(product, browser) {
  const page = await browser.newPage();
  try {
    await page.bringToFront().catch(() => {});
    await page.goto(product.url || `https://www.target.com/p/-/A-${product.tcin}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // The buy box is lazy-loaded; nudge it and wait for a fulfillment control.
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
    const buyBox = page
      .locator(
        '[data-test="shippingButton"], [data-test^="addToCartButton"], button:has-text("Add to cart"), button:has-text("Preorder"), button:has-text("Sold out"), button:has-text("Out of stock")'
      )
      .first();
    await buyBox.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});

    const soldOut = await page
      .getByText(/sold out|out of stock|temporarily out of stock/i)
      .first()
      .isVisible()
      .catch(() => false);

    const addToCart = page
      .locator('[data-test="shippingButton"], [data-test^="addToCartButton"], button:has-text("Add to cart"), button:has-text("Ship it"), button:has-text("Preorder")')
      .first();
    const hasButton = await addToCart.isVisible().catch(() => false);
    const enabled = hasButton ? await addToCart.isEnabled().catch(() => false) : false;

    return {
      inStock: enabled && !soldOut,
      status: enabled ? "IN_STOCK" : soldOut ? "OUT_OF_STOCK" : "UNKNOWN",
      available: enabled ? 1 : 0,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Scan buy-box controls in priority order; any enabled button means in stock. */
async function detectBuyableOnPage(page, { fast = false } = {}) {
  if (fast) {
    const hit = await page
      .evaluate(() => {
        const isEnabled = (el) => {
          if (!el) return false;
          if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const buybox = document.querySelector(
          '[data-test="buybox"], [data-test="product-buy-box"], [data-test="fulfillmentOptions"], [data-test="@web/AddToCart/FulfillmentSection"]'
        );
        const scope = buybox || document;
        const selectors = [
          '[data-test="buyNowButton"]',
          '[data-test="shippingButton"]',
          '[data-test^="addToCartButton"]',
          '[data-test="orderPickupButton"]',
          'button[data-test*="shipping"]',
          'button[data-test*="addToCart"]',
        ];
        for (const sel of selectors) {
          const el = scope.querySelector(sel) || document.querySelector(sel);
          if (isEnabled(el)) {
            const label = (el.textContent || "").trim().slice(0, 24) || sel;
            return { inStock: true, status: "IN_STOCK", button: label };
          }
        }
        for (const btn of scope.querySelectorAll("button")) {
          const text = (btn.textContent || "").trim();
          if (/^(ship it|add to cart|buy now|pre-?order)$/i.test(text) && isEnabled(btn)) {
            return { inStock: true, status: "IN_STOCK", button: text };
          }
        }
        const text = (document.body?.innerText || "").slice(0, 4000);
        const soldOut = /sold out|out of stock|temporarily out of stock/i.test(text);
        return { inStock: false, status: soldOut ? "OUT_OF_STOCK" : "UNKNOWN", button: null };
      })
      .catch(() => null);
    if (hit) return hit;
  }

  const box = buyBox(page);
  const root = (await box.isVisible().catch(() => false)) ? box : page;
  const candidates = [
    { sel: '[data-test="buyNowButton"]', label: "Buy now" },
    { sel: '[data-test="shippingButton"]', label: "Ship it" },
    { sel: '[data-test^="addToCartButton"]', label: "Add to cart" },
    { sel: 'button:has-text("Buy now")', label: "Buy now" },
    { sel: 'button:has-text("Ship it")', label: "Ship it" },
    { sel: 'button:has-text("Add to cart")', label: "Add to cart" },
    { sel: 'button:has-text("Preorder")', label: "Preorder" },
    { sel: 'button:has-text("Pre-order")', label: "Pre-order" },
  ];
  for (const { sel, label } of candidates) {
    const el = root.locator(sel).first();
    if (await isBuyControlEnabled(el)) return { inStock: true, status: "IN_STOCK", button: label };
  }
  const soldOut = await root
    .getByText(/sold out|out of stock|temporarily out of stock/i)
    .first()
    .isVisible()
    .catch(() => false);
  return { inStock: false, status: soldOut ? "OUT_OF_STOCK" : "UNKNOWN", button: null };
}

/**
 * Check stock on an ALREADY-OPEN page (the product's dedicated tab). Reloads the
 * page, nudges the lazy-loaded buy box, and reports stock + third-party status.
 * Returns { inStock, status, available, thirdParty }.
 *
 * With { fast: true } (drop mode): shorter waits — tab stays on the product page
 * between checks, which is what manual drop hunters do.
 */
export async function checkStockOnPage(page, product, { fast = false, skipReload = false, mode = "full" } = {}) {
  if (mode === "light") return checkStockLight(page, product, { fast });

  const settleMs = skipReload ? (fast ? 300 : 900) : fast ? 250 : 600;
  const scrollWait = fast ? 100 : 500;

  if (!skipReload) {
    markBotNavigation(page);
    if (isOnProductPage(page, product)) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: fast ? 20000 : 30000 }).catch(() => {});
    } else {
      await ensureProductPage(page, product, { fast }).catch(() => {});
    }
    await page.waitForTimeout(settleMs);
  } else {
    await page.waitForTimeout(settleMs);
  }

  await humanPageWarmup(page, { fast });
  await scrollToBuyBox(page, { fastMode: fast });
  await ensureShippingFulfillment(page, { fastMode: fast });
  await buyBox(page)
    .waitFor({ state: "visible", timeout: fast ? 10000 : 15000 })
    .catch(() => {});
  await page
    .locator(
      '[data-test="shippingButton"], [data-test^="addToCartButton"], [data-test="buyNowButton"], button:has-text("Add to cart"), button:has-text("Ship it"), button:has-text("Buy now"), button:has-text("Preorder"), button:has-text("Sold out"), button:has-text("Out of stock")'
    )
    .first()
    .waitFor({ state: "visible", timeout: fast ? 8000 : 15000 })
    .catch(() => {});

  const thirdParty = await isThirdPartySeller(page).catch(() => false);

  const buyable = await detectBuyableOnPage(page);

  await page.waitForTimeout(fast ? 0 : scrollWait - settleMs);

  return {
    inStock: buyable.inStock,
    status: buyable.status,
    available: buyable.inStock ? 1 : 0,
    thirdParty,
    button: buyable.button,
  };
}

export function createMonitor(config, { browser } = {}) {
  const visitorId = randomUUID().replace(/-/g, "").toUpperCase().slice(0, 32);

  return {
    async check(product) {
      if (config.monitor.mode === "browser") {
        if (!browser) throw new Error("Browser mode requires a launched browser.");
        return checkViaBrowser(product, browser);
      }
      return checkViaApi(product, config, visitorId);
    },
  };
}

export function nextInterval(monitor, { productIndex = 0, productCount = 1 } = {}) {
  const base = monitor.pollIntervalMs ?? 120000;
  const jitter = Math.floor(Math.random() * (monitor.jitterMs ?? 0));
  // Light polls run faster than full reloads during drop/hype windows.
  const lightRatio = Math.max(1, Number(monitor.lightPollsPerReload) || 4);
  const effectiveBase =
    monitor.dropWindowActive && monitor.useLightPolls !== false
      ? Math.max(800, Math.round(base / lightRatio))
      : base;
  // During drop windows every tab polls on its own fast cycle; stagger only off-hours.
  const stagger =
    monitor.staggerChecks !== false && productCount > 1 && !monitor.dropWindowActive
      ? Math.floor((productIndex / productCount) * effectiveBase * 0.85)
      : 0;
  return effectiveBase + jitter + stagger;
}

/** Whether this watcher cycle should use a light (no-reload) stock probe. */
export function shouldUseLightPoll(monitor, checksSinceReload = 0) {
  if (!monitor.dropWindowActive && !monitor.hypePolling) return false;
  if (monitor.useLightPolls === false) return false;
  const ratio = Math.max(1, Number(monitor.lightPollsPerReload) || 4);
  return checksSinceReload < ratio;
}

/** Minimum per-product poll when watching many items (only raises speed if you set poll too fast). */
export function recommendedPollMs(productCount, { dropMode = false, hypeMode = false } = {}) {
  if (hypeMode && dropMode) {
    if (productCount <= 6) return 2000;
    if (productCount <= 12) return 3000;
    return 4000;
  }
  if (productCount <= 3) return dropMode ? 3500 : 5000;
  if (productCount <= 6) return dropMode ? 5000 : 8000;
  if (productCount <= 10) return dropMode ? 6500 : 10000;
  return dropMode ? 8000 : 12000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Double-tap Fast API to filter ghost IN_STOCK flickers (RedSky often flips 1–2s before ATC works).
 * Returns { confirmed, reason?, status? }.
 */
export async function confirmFastApiStock(page, product, { gapMs = 280 } = {}) {
  const first = await batchCheckStockViaPageApi(page, [product]);
  const row1 = first?.[0];
  if (!row1?.inStock) return { confirmed: false, reason: "first_miss", status: row1?.status };

  if (String(row1.status).startsWith("HTTP_429") || row1.status === "HTTP_503") {
    return { confirmed: false, reason: "throttled", status: row1.status };
  }

  await sleep(gapMs);
  const second = await batchCheckStockViaPageApi(page, [product]);
  const row2 = second?.[0];
  if (!row2?.inStock) return { confirmed: false, reason: "flicker", status: row2?.status };
  return { confirmed: true, status: row2.status };
}
