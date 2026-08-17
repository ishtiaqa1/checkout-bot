import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { paths } from "./config.js";
import { log } from "./logger.js";
import { PHOENIX_NAVIGATOR_PATCH } from "./browserUtils.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CDP_PORT = 9222;

export { CDP_PORT };

/** Track API-blitz vs UI-fallback rates for readiness alarms. */
export const apiPathStats = { blitzOk: 0, blitzFail: 0, uiFallback: 0 };

export function resetApiPathStats() {
  apiPathStats.blitzOk = 0;
  apiPathStats.blitzFail = 0;
  apiPathStats.uiFallback = 0;
}

/** Mirror checkout logs to dashboard when engine provides onLog hook. */
function checkoutLog(hooks, level, msg) {
  hooks?.onLog?.(level, msg);
  const fn = log[level] || log.info;
  fn(msg);
}

// ----- human-like behavior helpers (make actions look less robotic) -----
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
/** Pause for a randomized, human-ish amount of time. */
export const humanPause = (min = 140, max = 520) => sleep(rand(min, max));
/** Drift the mouse around a bit so movement isn't perfectly straight/absent. */
async function humanMouse(page) {
  try {
    const vp = page.viewportSize?.() || { width: 1280, height: 800 };
    await page.mouse.move(rand(40, vp.width - 40), rand(60, vp.height - 60), { steps: rand(4, 12) });
  } catch {
    /* non-fatal */
  }
}
/** Click a locator the way a person would: hover, small pause, then click. */
async function humanClickLocator(page, locator) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const box = await locator.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width * (0.3 + Math.random() * 0.4), box.y + box.height / 2, { steps: rand(4, 10) });
      await humanPause(60, 200);
    }
    await locator.click({ timeout: 4000, delay: rand(40, 120) });
    return true;
  } catch {
    return false;
  }
}
/** Type into a field with per-key delays like a human. */
async function humanType(locator, text) {
  await locator.click({ delay: rand(40, 110) }).catch(() => {});
  await humanPause(80, 220);
  await locator.type(String(text), { delay: rand(70, 170) }).catch(() => {});
}

// Stealth tweaks that hide common "this is a bot" signals (runs in every page).
const STEALTH_INIT = () => {
  PHOENIX_NAVIGATOR_PATCH();
  try {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    delete Navigator.prototype.webdriver;
  } catch {}
  window.chrome = window.chrome || { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
  try {
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5].map((i) => ({ name: `Plugin ${i}`, filename: `p${i}.dll` })),
    });
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });
  } catch {}
  try {
    const orig = window.navigator.permissions && window.navigator.permissions.query;
    if (orig) {
      window.navigator.permissions.query = (p) =>
        p && p.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : orig(p);
    }
  } catch {}
  try {
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return "Intel Inc.";
      if (p === 37446) return "Intel Iris OpenGL Engine";
      return getParam.call(this, p);
    };
  } catch {}
};

/** Locate the installed real Google Chrome (Windows/macOS/Linux). */
function findChrome() {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
          process.env["PROGRAMFILES(X86)"] && `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
          process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  return candidates.filter(Boolean).find((p) => fs.existsSync(p)) || null;
}

/** Return the CDP websocket endpoint if a debuggable Chrome is on the port. */
async function getCdpEndpoint(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (res.ok) return (await res.json()).webSocketDebuggerUrl;
  } catch {
    /* not up */
  }
  return null;
}

/** Track Chrome child processes per CDP port (multi-account isolation). */
const chromeProcs = new Map();

function killChrome(port = null) {
  const killOne = (pid) => {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  };
  if (port != null) {
    const proc = chromeProcs.get(Number(port));
    if (!proc) return;
    chromeProcs.delete(Number(port));
    killOne(proc.pid);
    return;
  }
  for (const [p, proc] of chromeProcs) {
    chromeProcs.delete(p);
    killOne(proc.pid);
  }
}

/**
 * Launch the user's REAL Google Chrome as an ordinary program (normal icon, no
 * automation banner) using its OWN isolated profile in ./browser-data, then
 * attach over the DevTools protocol.
 *
 * - Uses real Chrome, NOT Playwright's "Chrome for Testing" (which Target blocks
 *   and which shows a different icon).
 * - The profile is separate from your personal Chrome — different accounts,
 *   extensions and cookies — and it runs fine while your personal Chrome is open.
 */
export async function launchBrowser({
  headless = false,
  userDataDir = null,
  cdpPort = CDP_PORT,
  proxy = null,
  chromeExtraArgs = [],
  playwrightProxy = undefined,
} = {}) {
  const dataDir = userDataDir || paths.browserData;
  fs.mkdirSync(dataDir, { recursive: true });
  const chromePath = findChrome();
  const port = Number(cdpPort) || CDP_PORT;

  if (chromePath) {
    let endpoint = await getCdpEndpoint(port); // reuse our own debug Chrome if already up
    if (!endpoint) {
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${dataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--no-service-autorun",
        "--start-maximized",
        ...(chromeExtraArgs || []),
      ];
      if (headless) args.push("--headless=new");
      const proc = spawn(chromePath, args, { detached: false, stdio: "ignore" });
      chromeProcs.set(port, proc);
      proc.on("error", (err) => log.err(`Chrome failed to start: ${err.message}`));
      proc.on("exit", () => {
        if (chromeProcs.get(port) === proc) chromeProcs.delete(port);
      });

      const deadline = Date.now() + 20000;
      while (!endpoint && Date.now() < deadline) {
        await sleep(300);
        endpoint = await getCdpEndpoint(port);
      }
      if (!endpoint) {
        killChrome(port);
        throw new Error("Couldn't start Chrome with a debugging port. Close ALL Chrome windows and try again.");
      }
    }

    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    await context.addInitScript(STEALTH_INIT).catch(() => {});
    if (context.pages().length === 0) await context.newPage();

    context.close = async () => {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
      killChrome(port);
    };
    context.__botMeta = { userDataDir: dataDir, cdpPort: port, proxy: proxy?.group || null };
    return context;
  }

  // Last resort only: bundled Chromium (different icon, more likely to be blocked).
  log.warn("Real Google Chrome not found — falling back to the bundled browser. Install Google Chrome for best results.");
  const context = await chromium.launchPersistentContext(dataDir, {
    headless,
    viewport: null,
    locale: "en-US",
    args: ["--start-maximized", ...(chromeExtraArgs || [])],
    ignoreDefaultArgs: ["--enable-automation"],
    proxy: playwrightProxy,
  });
  await context.addInitScript(STEALTH_INIT);
  if (context.pages().length === 0) await context.newPage();
  context.__botMeta = { userDataDir: dataDir, cdpPort: port, proxy: proxy?.group || null };
  return context;
}

/** Open Target sign-in so the user can log in once by hand. */
export async function openLogin() {
  const context = await launchBrowser({ headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.target.com/account", { waitUntil: "domcontentloaded" });
  log.info("Sign in to your Target account in the opened window.");
  log.info("Your session is saved to ./browser-data. Close the window when done.");
  await page.waitForEvent("close", { timeout: 0 }).catch(() => {});
  await context.close().catch(() => {});
}

async function screenshot(page, label) {
  try {
    fs.mkdirSync(paths.screenshots, { recursive: true });
    const file = path.join(paths.screenshots, `${Date.now()}-${label}.png`);
    await page.screenshot({ path: file, fullPage: false });
    log.warn(`Saved screenshot: ${file}`);
  } catch {
    /* ignore */
  }
}

/** Try several selectors/strategies in order; return true once one is clicked. */
async function clickFirst(page, candidates, { timeout = 8000, shouldCancel, fastMode = false, force = false } = {}) {
  const deadline = Date.now() + timeout;
  const pollMs = fastMode ? 35 : rand(180, 360);
  const useForce = force || fastMode;
  while (Date.now() < deadline) {
    if (shouldCancel?.()) throw new Error("Cancelled by user.");
    for (const locate of candidates) {
      const el = locate().first();
      if (await el.isVisible().catch(() => false)) {
        if (await el.isEnabled().catch(() => true)) {
          if (!(await isSafeClickTarget(el))) continue;
          if (!fastMode) {
            await humanPause(80, 260);
            await humanMouse(page);
            if (await humanClickLocator(page, el)) return true;
          }
          try {
            if (!fastMode) {
              await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
            }
            await el.click({ timeout: fastMode ? 1200 : 4000, delay: 0, force: useForce });
            return true;
          } catch {
            /* try next candidate */
          }
        }
      }
    }
    await page.waitForTimeout(pollMs);
  }
  return false;
}

/** Mark the next page load as bot-initiated (not a user refresh). */
export function markBotNavigation(page) {
  if (page) {
    page.__botNavigating = true;
    page.__lastBotNavAt = Date.now();
  }
}

/** True when the tab is on this product's Target PDP (not about:blank). */
export function isOnProductPage(page, product) {
  try {
    const url = page.url();
    return (
      url.includes(String(product.tcin)) &&
      /target\.com/i.test(url) &&
      !url.startsWith("about:")
    );
  } catch {
    return false;
  }
}

/** Open the product PDP if the tab is blank or on the wrong page. */
export async function ensureProductPage(page, product, { fast = false } = {}) {
  if (isOnProductPage(page, product)) return;
  if (page.__navLock) {
    await page.__navLock.catch(() => {});
    if (isOnProductPage(page, product)) return;
  }
  const url = product.url || `https://www.target.com/p/-/A-${product.tcin}`;
  page.__navLock = (async () => {
    markBotNavigation(page);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: fast ? 25000 : 45000,
    });
  })();
  try {
    await page.__navLock;
  } finally {
    page.__navLock = null;
  }
}

/** Target buy box container — scope clicks so we don't hit header/footer duplicates. */
export function buyBox(page) {
  return page.locator(
    '[data-test="buybox"], [data-test="product-buy-box"], [data-test="@web/AddToCart/FulfillmentSection"], #pdp-cart-and-fulfillment, [data-test="fulfillmentOptions"]'
  ).first();
}

/** True when a buy control looks clickable (not just visible). */
export async function isBuyControlEnabled(el) {
  if (!(await el.isVisible().catch(() => false))) return false;
  if (await el.isDisabled().catch(() => false)) return false;
  const aria = await el.getAttribute("aria-disabled").catch(() => null);
  return aria !== "true";
}

/** Never click product hero images / gallery links — opens lightbox and wastes seconds. */
async function isSafeClickTarget(el) {
  return el
    .evaluate((node) => {
      if (!node) return false;
      const testId = (node.getAttribute("data-test") || "").toLowerCase();
      if (/buynow|addtocart|shipping|checkout|placeorder|cartcheckout|qty|fulfillment/.test(testId)) {
        return true;
      }
      if (
        node.closest(
          '[data-test*="productImage"], [data-test*="MediaGallery"], [data-test*="imageGallery"], [data-test*="HeroImage"], [data-test*="pdp-media"]'
        )
      ) {
        return false;
      }
      if (node.tagName === "IMG" || node.tagName === "PICTURE") return false;
      const anchor = node.closest("a");
      if (anchor) {
        const href = anchor.getAttribute("href") || "";
        if (
          /\/p\/|\/-\/A-\d+/i.test(href) &&
          !anchor.closest(
            '[data-test="buybox"], [data-test="product-buy-box"], [data-test="fulfillmentOptions"], [data-test="@web/AddToCart/FulfillmentSection"]'
          )
        ) {
          return false;
        }
      }
      const tag = node.tagName;
      const role = node.getAttribute("role");
      return tag === "BUTTON" || tag === "INPUT" || role === "button";
    })
    .catch(() => false);
}

/** Close product image lightbox if a mis-click opened it. */
async function dismissImageLightbox(page) {
  const modal = page
    .locator('[role="dialog"], [data-test="modal"]')
    .filter({ has: page.locator("img, [data-test*='image'], [data-test*='Image']") })
    .first();
  if (!(await modal.isVisible().catch(() => false))) return false;
  const close = modal
    .locator('[aria-label="close" i], [data-test*="close"], button:has-text("Close")')
    .first();
  if (await close.isVisible().catch(() => false)) {
    await close.click({ timeout: 600, force: true }).catch(() => {});
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(80);
  return true;
}

/** Scroll only the buy box into view — never scroll the hero image into click range. */
export async function scrollToBuyBox(page, { fastMode = true } = {}) {
  await dismissImageLightbox(page).catch(() => {});
  const box = buyBox(page);
  if (await box.isVisible().catch(() => false)) {
    await box.scrollIntoViewIfNeeded({ timeout: fastMode ? 500 : 2000 }).catch(() => {});
    return;
  }
  if (!fastMode) {
    await page.evaluate(() => window.scrollBy(0, 320)).catch(() => {});
  }
}

function addToCartDrawerCheckoutButtons(page) {
  return [
    () => page.locator('[data-test="atcDrawerCheckout"]'),
    () => page.locator('[data-test="slideout"] [data-test="checkout-button"]'),
    () => page.locator('[data-test="checkout-button"]').filter({ hasText: /check\s*out/i }),
    () => page.locator('[role="dialog"] button:has-text("Checkout")'),
    () => page.getByRole("button", { name: /^check\s*out$/i }),
  ];
}

/** After add-to-cart, Target shows a drawer — checkout from there (fastest, skips cart page). */
async function tryCheckoutFromAddDrawer(page, { bursts = 6, shouldCancel } = {}) {
  const onPdp = /\/p\/|A-\d+/i.test(page.url());
  const drawerHint = await page
    .getByText(/added to (your )?cart|item added|view cart & check out/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (!onPdp && !drawerHint) return false;
  await spamClickButtons(page, addToCartDrawerCheckoutButtons(page), { bursts, shouldCancel });
  return /\/checkout/i.test(page.url());
}

/** Pokémon drops ship to home — select Shipping (not Pickup) before add-to-cart. */
export async function ensureShippingFulfillment(page, { fastMode = false } = {}) {
  const shipping = page
    .locator('[data-test="fulfillment-cell-shipping"], [data-test="fulfillment-Shipping"]')
    .or(page.getByRole("button", { name: /^shipping$/i }))
    .first();
  const pickup = page
    .locator('[data-test="fulfillment-cell-pickup"], [data-test="fulfillment-Pickup"]')
    .or(page.getByRole("button", { name: /^pickup$/i }))
    .first();

  const pickupSelected =
    (await pickup.isVisible().catch(() => false)) &&
    ((await pickup.getAttribute("aria-selected").catch(() => null)) === "true" ||
      (await pickup.getAttribute("aria-pressed").catch(() => null)) === "true" ||
      /selected|active|checked/i.test((await pickup.getAttribute("class").catch(() => "")) || ""));

  if (!(await shipping.isVisible().catch(() => false))) {
    if (pickupSelected) log.warn("Pickup selected but shipping control missing — may fail ATC.");
    return;
  }
  const selected =
    (await shipping.getAttribute("aria-selected").catch(() => null)) === "true" ||
    (await shipping.getAttribute("aria-pressed").catch(() => null)) === "true" ||
    /selected|active|checked/i.test((await shipping.getAttribute("class").catch(() => "")) || "");
  if (!selected || pickupSelected) {
    await shipping.click({ timeout: fastMode ? 800 : 3000, force: fastMode }).catch(() => {});
    if (!fastMode) await page.waitForTimeout(500);
  }
}

/** Selectors for online ship fulfillment — Ship it / Add to cart within the buy box. */
function shippingBuyButtons(page) {
  const box = buyBox(page);
  return [
    () => box.locator('[data-test="shippingButton"]'),
    () => box.getByRole("button", { name: /ship it/i }),
    () => box.locator('[data-test="addToCartButton"]:not([disabled])'),
    () => box.locator('[data-test^="addToCartButton"]:not([disabled])'),
    () => box.getByRole("button", { name: /add to cart/i }),
    () => page.locator('[data-test="shippingButton"]'),
    () => page.locator('[data-test="addToCartButton"]:not([disabled])'),
    () => page.getByRole("button", { name: /add to cart/i }),
    () => page.getByRole("button", { name: /preorder/i }),
  ];
}

let cartApiKey = "9f36aeafbe60771e321a7cc95a78140772ab3e96";
const CART_API_FIELDS = "field_groups=CART,CART_ITEMS,SUMMARY";
const cartApiUrl = () =>
  `https://carts.target.com/web_checkouts/v1/cart_items?${CART_API_FIELDS}&key=${cartApiKey}`;
const cartReadUrl = () =>
  `https://carts.target.com/web_checkouts/v1/cart?${CART_API_FIELDS}&key=${cartApiKey}`;
const keyCapturePages = new WeakSet();

function captureCartApiKey(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "carts.target.com") return false;
    const isAddKey =
      /\/cart_items$/i.test(parsed.pathname) ||
      parsed.searchParams.get("client_feature") === "add_to_cart";
    if (!isAddKey) return false;
    const key = parsed.searchParams.get("key");
    if (!/^[a-f0-9]{32,64}$/i.test(key || "")) return false;
    const changed = key !== cartApiKey;
    cartApiKey = key;
    return changed;
  } catch {
    return false;
  }
}

function installCartApiKeyCapture(page) {
  if (keyCapturePages.has(page)) return;
  keyCapturePages.add(page);
  page.on("request", (request) => captureCartApiKey(request.url()));
}

async function scanCartApiKey(page) {
  installCartApiKeyCapture(page);
  const urls = await page
    .evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name))
    .catch(() => []);
  let changed = false;
  for (const url of urls) changed = captureCartApiKey(url) || changed;
  return changed;
}

/** Refresh Target's public cart API key from the real cart page when it rotates. */
export async function refreshTargetCartApiKey(page, { navigate = false } = {}) {
  const before = cartApiKey;
  await scanCartApiKey(page);
  if (cartApiKey !== before || !navigate) return cartApiKey;
  await fastGoto(page, "https://www.target.com/cart", { fastMode: true });
  await page.waitForTimeout(1200).catch(() => {});
  await scanCartApiKey(page);
  return cartApiKey;
}

export async function probeTargetCartApiHealth(page) {
  const probe = () =>
    page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          credentials: "include",
          headers: { accept: "application/json", "x-application-name": "web" },
        });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        return { ok: false, status: 0, error: err.message };
      }
    }, cartReadUrl());
  installCartApiKeyCapture(page);
  await scanCartApiKey(page);
  let result = await probe();
  if (!result.ok && [401, 403, 404].includes(Number(result.status))) {
    await refreshTargetCartApiKey(page, { navigate: true });
    result = await probe();
  }
  return {
    ...result,
    detail: result.ok ? "Target cart API healthy" : `Target cart API returned ${result.status || result.error || "error"}`,
  };
}

/** Fast navigation — commit fires before full page load (~1–2s faster than domcontentloaded). */
const FAST_NAV = { waitUntil: "commit", timeout: 15000 };

async function fastGoto(page, url, { fastMode = true } = {}) {
  markBotNavigation(page);
  return page.goto(url, fastMode ? FAST_NAV : { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
}

async function fastGotoProduct(page, product, { fastMode = true } = {}) {
  const url = product.url || `https://www.target.com/p/-/A-${product.tcin}`;
  return fastGoto(page, url, { fastMode });
}

const targetCartTcin = (product) => String(product.checkoutTcin || product.tcin);

/** Resolve a parent PDP TCIN to Target's currently preselected purchasable variation. */
async function resolveTargetCheckoutTcin(page, product) {
  const parent = String(product.tcin);
  const candidate = await page
    .evaluate((parentTcin) => {
      const urls = performance.getEntriesByType("resource").map((entry) => entry.name).reverse();
      for (const raw of urls) {
        try {
          const url = new URL(raw);
          const preselect = url.searchParams.get("preselect");
          if (/^\d{6,12}$/.test(preselect || "") && preselect !== parentTcin) return preselect;
        } catch {
          /* ignore malformed resource URLs */
        }
      }
      return null;
    }, parent)
    .catch(() => null);
  if (candidate) product.checkoutTcin = candidate;
  return targetCartTcin(product);
}

/** Read cart via API — ~200–400ms, no /cart page navigation. */
async function verifyItemInCartViaApi(page, product) {
  const tcin = targetCartTcin(product);
  return page.evaluate(
    async ({ url, tcin }) => {
      try {
        const res = await fetch(url, {
          credentials: "include",
          headers: { accept: "application/json", "x-application-name": "web" },
        });
        if (!res.ok) return false;
        const data = await res.json();
        const items = data?.cart_items || data?.cart?.cart_items || [];
        return items.some((i) => String(i.tcin) === tcin);
      } catch {
        return false;
      }
    },
    { url: cartReadUrl(), tcin }
  );
}

/** Poll cart API briefly after ATC — faster than loading /cart. */
async function waitForCartApi(page, product, { maxWaitMs = 1200, intervalMs = 50 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await verifyItemInCartViaApi(page, product)) return true;
    await page.waitForTimeout(intervalMs).catch(() => {});
  }
  return false;
}

/** Add to cart via Target's cart API — fastest path (~300–800ms), uses browser session cookies. */
async function addToCartViaApi(page, product) {
  const tcin = targetCartTcin(product);
  const quantity = Math.max(1, Number(product.maxQuantity) || 1);
  return page.evaluate(
    async ({ apiUrl, tcin, quantity }) => {
      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-application-name": "web",
          },
          credentials: "include",
          body: JSON.stringify({
            cart_item: { item_channel_id: "10", tcin, quantity },
            cart_type: "REGULAR",
            channel_id: "10",
            shopping_context: "DIGITAL",
          }),
        });
        const text = await res.text();
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          /* non-json */
        }
        const hasItem =
          data?.cart_items?.some?.((i) => String(i.tcin) === tcin) ||
          data?.cart?.cart_items?.some?.((i) => String(i.tcin) === tcin) ||
          /cart_item/i.test(text);
        return {
          ok: res.ok && (hasItem || res.status === 201),
          status: res.status,
          hasItem,
          error: data?.message || data?.error?.message || null,
          code: data?.code || data?.error?.code || null,
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    { apiUrl: cartApiUrl(), tcin, quantity }
  );
}

/** Target often returns 400 MAX_PURCHASE_LIMIT when the item is already reserved in cart. */
function apiAddImpliesInCart(add) {
  if (!add) return false;
  if (add.hasItem) return true;
  const blob = `${add.code || ""} ${add.error || ""}`;
  return /MAX_PURCHASE_LIMIT|ALREADY_IN_CART|ITEM_ALREADY_IN_CART|purchase limit exceeded|already in (your )?cart/i.test(blob);
}

function popupImpliesItemIsInCart(message) {
  return /already in your cart|high demand.{0,80}(already|cart)|max(?:imum)? purchase limit exceeded|quantity (has been )?adjusted|reduced to \d+/i.test(
    message || ""
  );
}

/**
 * Blitz: API add → /checkout → place order. Skips PDP entirely (~2–4s when API works).
 * Returns null to fall back to UI checkout.
 */
async function tryApiBlitzCheckout(page, product, config, {
  shouldCancel,
  phase,
  tryFillCvv,
  dryRun,
  autoPlaceOrder,
  fastMode,
  dropWindowActive,
  onLog,
  latency,
}) {
  if (config.checkout?.apiCheckout === false) return null;
  if (shouldCancel?.()) throw new Error("Cancelled by user.");
  const t0 = Date.now();

  try {
    if (!/target\.com/i.test(page.url()) || page.url().startsWith("about:")) {
      await fastGoto(page, "https://www.target.com/", { fastMode: true });
    }

    await resolveTargetCheckoutTcin(page, product);
    phase("adding_to_cart", "API add (blitz)");
    latency?.mark("atc_start");
    checkoutLog({ onLog }, "ok", `[CHECKOUT] ${product.name || product.tcin}: API blitz — adding to cart…`);
    await scanCartApiKey(page);
    let add = await addToCartViaApi(page, product);
    if (!add?.ok && Number(add?.status) === 429) {
      checkoutLog({ onLog }, "warn", `[CHECKOUT] ${product.name || product.tcin}: API add rate-limited (429) — brief backoff then retry`);
      await page.waitForTimeout(350).catch(() => {});
      add = await addToCartViaApi(page, product);
      if (!add?.ok && Number(add?.status) === 429) {
        await page.waitForTimeout(700).catch(() => {});
        add = await addToCartViaApi(page, product);
      }
    }
    if (!add?.ok && [401, 403, 404].includes(Number(add?.status))) {
      const previousKey = cartApiKey;
      await refreshTargetCartApiKey(page, { navigate: true });
      if (cartApiKey !== previousKey) {
        checkoutLog({ onLog }, "info", `[CHECKOUT] Target cart API key refreshed — retrying blitz once`);
        add = await addToCartViaApi(page, product);
      }
    }
    // Max-purchase / already-in-cart means the reservation is live — skip more ATC, go checkout.
    if (!add?.ok && apiAddImpliesInCart(add)) {
      checkoutLog(
        { onLog },
        "hit",
        `[CHECKOUT] ${product.name || product.tcin}: API says already in cart (${add?.code || add?.status}) — direct checkout`
      );
      add = { ok: true, alreadyInCart: true, status: add?.status, code: add?.code };
    }
    if (!add?.ok) {
      checkoutLog(
        { onLog },
        "warn",
        `[CHECKOUT] ${product.name || product.tcin}: API add failed (${add?.status || "blocked"}${add?.code ? ` ${add.code}` : ""}${add?.error ? `: ${add.error}` : ""}) — UI fallback`
      );
      apiPathStats.blitzFail += 1;
      apiPathStats.uiFallback += 1;
      if (add?.status === 401 || add?.status === 403) {
        checkoutLog({ onLog }, "err", `[CHECKOUT] Cart API ${add.status} — API key may be stale`);
      }
      return null;
    }
    latency?.mark("atc_ok");
    latency?.mark("cart_confirmed");

    phase("checking_out", "API → checkout");
    latency?.mark("checkout_nav");
    checkoutLog({ onLog }, "ok", `[CHECKOUT] ${product.name || product.tcin}: API add OK — going to checkout…`);
    await fastGoto(page, "https://www.target.com/checkout", { fastMode: true });

    if (!(await verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: 2500 }))) {
      log.warn("API add OK but checkout empty — UI fallback.");
      apiPathStats.blitzFail += 1;
      apiPathStats.uiFallback += 1;
      return null;
    }
    latency?.mark("checkout_ready");
    await advanceCheckoutToReview(page, { fastMode: true, hypeMode: dropWindowActive, config }).catch(() => {});

    log.ok(`API blitz → checkout in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    checkoutLog({ onLog }, "hit", `[CHECKOUT] ${product.name || product.tcin}: at checkout in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    if (await isLoggedOut(page)) throw new Error("Session expired at checkout. Run login first.");

    phase("placing_order", "Placing order");
    latency?.mark("place_order");
    const result = await attemptPlaceOrder(page, config, {
      dryRun,
      autoPlaceOrder,
      fastMode,
      dropWindowActive,
      shouldCancel,
      phase,
      tryFillCvv,
    });
    if (result.placed || result.dryRun || result.manual) {
      if (result.placed) latency?.mark("order_confirmed");
      apiPathStats.blitzOk += 1;
      log.ok(`Blitz complete in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    }
    return result;
  } catch (err) {
    log.warn(`API blitz error: ${err.message} — UI fallback.`);
    apiPathStats.blitzFail += 1;
    apiPathStats.uiFallback += 1;
    return null;
  }
}

/** Target PDP "Buy now" — skips cart and goes straight toward checkout (fastest on drops). */
function buyNowButtons(page) {
  const box = buyBox(page);
  return [
    () => box.locator('[data-test="buyNowButton"]'),
    () => box.getByRole("button", { name: /^buy now$/i }),
    () => page.locator('[data-test="buyNowButton"]'),
    () => page.getByRole("button", { name: /^buy now$/i }),
  ];
}

/** Target shows transient errors under heavy load — wait briefly and retry. */
async function detectTargetWall(page) {
  const body = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).replace(/\s+/g, " ");
  const title = (await page.title().catch(() => "")).toLowerCase();
  const blob = `${body} ${title}`;

  if (/pardon our interruption|access denied|are you a robot|verify you are human|captcha|bot detection|unusual traffic/i.test(blob)) {
    return { blocked: true, reason: "captcha", message: "Target bot challenge detected — may need manual refresh." };
  }
  if (/heavy traffic|please keep trying|experiencing high demand|waiting room|queues? for checkout/i.test(blob)) {
    return { blocked: true, reason: "high_traffic", message: "Target heavy traffic — retrying…" };
  }
  if (/we're sorry|page is currently unavailable|this page is currently unavailable|please try again later/i.test(blob)) {
    return { blocked: true, reason: "site_error", message: "Target page unavailable — reloading product…" };
  }
  if (/something went wrong on our end|unable to process|temporarily down|service unavailable/i.test(blob) && !/add to cart|ship it|buy now/i.test(blob)) {
    return { blocked: true, reason: "site_error", message: "Target site glitch — reloading…" };
  }
  return { blocked: false };
}

/**
 * Recover from transient Target issues (unavailable page, heavy traffic, glitches).
 * Returns { recovered, captcha, reason } — captcha needs manual intervention.
 */
async function recoverTargetIssue(page, product, { fastMode = true, hypeMode = false, config = null } = {}) {
  const wall = await detectTargetWall(page);
  if (!wall.blocked) return { recovered: false };

  log.warn(wall.message);
  if (wall.reason === "captcha") {
    try {
      const { handleChallenge } = await import("./challenges/registry.js");
      const result = await handleChallenge({
        kind: "captcha",
        retailer: "target",
        page,
        config,
        onLog: (_level, msg) => log.warn(msg),
      });
      if (result?.status === "solved") {
        return { recovered: true, captcha: false, reason: "captcha_cleared" };
      }
    } catch {
      /* keep captcha flag */
    }
    return { recovered: false, captcha: true, reason: "captcha", message: wall.message };
  }

  await page.waitForTimeout(hypeMode ? 150 : fastMode ? 300 : 1000);
  if (product?.tcin) {
    await fastGotoProduct(page, product, { fastMode: true });
  } else {
    await page.reload({ waitUntil: fastMode ? "commit" : "domcontentloaded" }).catch(() => {});
  }
  return { recovered: true, reason: wall.reason };
}

async function handleTargetWall(page, product, { fastMode = true, hypeMode = false } = {}) {
  const out = await recoverTargetIssue(page, product, { fastMode, hypeMode });
  if (out.captcha) return out;
  return out.recovered ? true : false;
}

async function waitOutTargetGlitch(page, product, { fastMode = false, hypeMode = false } = {}) {
  const wall = await handleTargetWall(page, product, { fastMode, hypeMode });
  if (wall && wall.captcha) return wall;

  const glitch = page.getByText(/something went wrong|try again|high demand|please refresh|currently unavailable/i).first();
  if (!(await glitch.isVisible().catch(() => false))) return wall === true;

  log.warn("Target glitch detected — retrying…");
  await page.waitForTimeout(fastMode ? 250 : 1200);
  if (product?.tcin) await fastGotoProduct(page, product, { fastMode: true });
  else await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  return true;
}

/** Target popup / toast when add-to-cart fails (bot must NOT proceed to checkout). */
async function detectAddToCartFailure(page) {
  const cartFailPatterns = [
    /not added to (your )?cart/i,
    /wasn't added to (your )?cart/i,
    /was not added to (your )?cart/i,
    /couldn't add (this )?(item )?to (your )?cart/i,
    /can't add (this )?(item )?to (your )?cart/i,
    /cannot add (this )?(item )?to (your )?cart/i,
    /unable to add/i,
    /problem adding/i,
    /sorry.*(not added|couldn't add|unable to add)/i,
  ];

  const classifyPopup = (raw) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text || text.length > 350) return null;
    if (/skip to (main|footer)/i.test(text)) return null;
    if (/target circle|ship to \d{5}/i.test(text) && !cartFailPatterns.some((p) => p.test(text))) return null;
    // Already reserved — treat as success signal, not failure.
    if (popupImpliesItemIsInCart(text)) {
      return { alreadyInCart: true, message: text.slice(0, 120) };
    }
    if (cartFailPatterns.some((p) => p.test(text))) return { failed: true, message: text.slice(0, 120) };
    if (
      text.length < 280 &&
      /limit|maximum|per guest|per customer|quantity (has been )?adjusted|reduced to|only \d+ (allowed|available|per)|purchase limit|guest limit/i.test(
        text
      )
    ) {
      // Quantity limits without "already in cart" still mean we may need qty 1 — keep as soft fail.
      return { failed: true, message: text.slice(0, 120) };
    }
    if (text.length < 220 && /not available|out of stock|went wrong|try again later|no longer available/i.test(text)) {
      return { failed: true, message: text.slice(0, 120) };
    }
    // "high demand" alone is not a hard ATC failure — often appears with already-in-cart banners.
    if (text.length < 220 && /high demand/i.test(text) && /cart/i.test(text)) {
      return { alreadyInCart: true, message: text.slice(0, 120) };
    }
    return null;
  };

  const dialog = page
    .locator('[role="dialog"], [role="alertdialog"], [data-test="modal"]')
    .first();
  if (await dialog.isVisible().catch(() => false)) {
    const hit = classifyPopup(await dialog.innerText().catch(() => ""));
    if (hit?.alreadyInCart) return { failed: false, alreadyInCart: true, message: hit.message };
    if (hit?.failed) return { failed: true, message: hit.message };
  }

  const alert = page.locator('[role="alert"]').first();
  if (await alert.isVisible().catch(() => false)) {
    const hit = classifyPopup(await alert.innerText().catch(() => ""));
    if (hit?.alreadyInCart) return { failed: false, alreadyInCart: true, message: hit.message };
    if (hit?.failed) return { failed: true, message: hit.message };
  }

  for (const pattern of cartFailPatterns) {
    const el = page.getByText(pattern).first();
    if (await el.isVisible().catch(() => false)) {
      const hit = classifyPopup(await el.innerText().catch(() => "")) || { failed: true, message: pattern.source };
      if (hit.alreadyInCart) return { failed: false, alreadyInCart: true, message: hit.message };
      return { failed: true, message: hit.message };
    }
  }

  const alreadyEl = page.getByText(/already in your cart|high demand.{0,40}cart/i).first();
  if (await alreadyEl.isVisible().catch(() => false)) {
    const msg = (await alreadyEl.innerText().catch(() => "")).slice(0, 120);
    return { failed: false, alreadyInCart: true, message: msg || "Already in cart" };
  }

  return { failed: false };
}

/** Product name fuzzy match — checkout/cart DOM often omits TCIN. */
function productNameMatches(summaryText, productName) {
  const text = (summaryText || "").toLowerCase();
  const words = (productName || "").split(/\s+/).filter((w) => w.length > 3);
  if (words.length < 2) return false;
  return words.filter((w) => text.includes(w.toLowerCase())).length >= 2;
}

/** Target checkout is multi-step — advance to review / place-order when stuck on shipping. */
async function advanceCheckoutToReview(page, { fastMode = true, hypeMode = false, config = null } = {}) {
  if (!/\/checkout/i.test(page.url())) return false;

  if (config) {
    await tryFillCheckoutProfile(page, config, { fastMode: true }).catch(() => {});
  }

  const placeVisible = await page
    .locator('[data-test="placeOrderButton"], [data-test="place-order-button"], button:has-text("Place order")')
    .first()
    .isVisible()
    .catch(() => false);
  if (placeVisible) return true;

  const continueButtons = [
    () => page.locator('[data-test="checkoutButton"]'),
    () => page.locator('[data-test="continueButton"]'),
    () => page.locator('[data-test="save_and_continue_button"]'),
    () => page.getByRole("button", { name: /save and continue|continue to review|review order/i }),
    () => page.getByRole("button", { name: /^continue$/i }),
  ];

  const pauseMs = hypeMode ? 150 : fastMode ? 250 : 900;
  for (const locate of continueButtons) {
    const el = locate().first();
    if (!(await isBuyControlEnabled(el))) continue;
    try {
      await el.click({ timeout: hypeMode ? 1200 : fastMode ? 2000 : 4000, force: true });
      await page.waitForTimeout(pauseMs);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

async function getPageText(page) {
  return (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).replace(/\s+/g, " ");
}

/** Errors shown after clicking Place order. */
async function detectPlaceOrderError(page) {
  const text = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).replace(/\s+/g, " ");
  if (/thank you for your order|order placed|order #/i.test(text)) return { failed: false };
  if (/payment (method )?(declined|failed|couldn't)|update your payment|card (has )?expired|cvv|security code/i.test(text)) {
    return { failed: true, reason: "payment", message: "Payment declined or CVV required." };
  }
  if (/item (is )?no longer available|removed from your (cart|order)|sold out|out of stock/i.test(text)) {
    return { failed: true, reason: "oos", message: "Item sold out during place order." };
  }
  if (/address (is )?(invalid|incomplete)|update (your )?shipping|delivery (is )?unavailable/i.test(text)) {
    return { failed: true, reason: "address", message: "Shipping address problem." };
  }
  if (/something went wrong|try again|high demand/i.test(text)) {
    return { failed: true, reason: "glitch", message: "Target glitch during place order." };
  }
  return { failed: false };
}

/** Target's failure popup often appears 0.5–2s after the click — poll before assuming success. */
async function pollForAddToCartFailure(page, { timeoutMs = 2500, intervalMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fail = await detectAddToCartFailure(page);
    if (fail.failed || fail.alreadyInCart) return fail;
    await page.waitForTimeout(intervalMs);
  }
  return { failed: false };
}

/** Close Target's "not added to cart" popup so we can retry on the PDP. */
async function dismissAddFailurePopup(page) {
  for (const locate of [
    () => page.getByRole("button", { name: /^ok$/i }),
    () => page.getByRole("button", { name: /got it|close|dismiss|continue shopping/i }),
    () => page.locator('[data-test="modal"] button, [aria-label="close"]'),
  ]) {
    const btn = locate().first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 800, force: true }).catch(() => {});
      await page.waitForTimeout(100);
      return;
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
}

/**
 * Confirm the item is in the ACTIVE cart — not "Saved for later" (that caused false positives).
 */
async function verifyItemInCart(page, product, { fastMode = false, hypeMode = false } = {}) {
  const tcin = targetCartTcin(product);

  if (hypeMode || fastMode) {
    const apiBudget = hypeMode ? 900 : 1400;
    if (await waitForCartApi(page, product, { maxWaitMs: apiBudget, intervalMs: hypeMode ? 40 : 60 })) {
      return true;
    }
    const drawer = await page
      .getByText(/added to (your )?cart|item added|view cart & check out/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (drawer) return true;
  }

  markBotNavigation(page);
  if (!/\/cart/i.test(page.url())) {
    await page.goto("https://www.target.com/cart", {
      waitUntil: hypeMode ? "commit" : "domcontentloaded",
      timeout: fastMode ? (hypeMode ? 8000 : 10000) : 18000,
    }).catch(() => {});
  }

  // Target cart skeleton can take 1–3s — don't verify until line items or checkout render.
  await page
    .locator(
      '[data-test="cartItem"], [data-test="checkout-button"], [data-test="cartCheckoutButton"], button:has-text("Check out")'
    )
    .first()
    .waitFor({ state: "visible", timeout: fastMode ? (hypeMode ? 6000 : 10000) : 15000 })
    .catch(() => {});
  await page.waitForTimeout(fastMode ? (hypeMode ? 0 : 150) : 500);

  const empty = await page.getByText(/^your cart is empty$/i).first().isVisible().catch(() => false);
  if (empty) return false;

  const minBlock = await detectCheckoutBlocker(page);
  if (minBlock.blocked && minBlock.reason === "minimum_order") {
    throw new Error(minBlock.message);
  }

  const inActiveCart = await page
    .locator(
      `[data-test="cartItem"]:has(a[href*="${tcin}"]), ` +
        `[data-test="cartItem-faceout"]:has(a[href*="${tcin}"]), ` +
        `[data-test*="cartLineItem"]:has(a[href*="${tcin}"])`
    )
    .first()
    .isVisible()
    .catch(() => false);
  if (inActiveCart) return true;

  const cartItems = page.locator('[data-test="cartItem"]');
  const count = await cartItems.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 6); i++) {
    const html = await cartItems.nth(i).innerHTML().catch(() => "");
    if (html.includes(tcin)) return true;
    const text = await cartItems.nth(i).innerText().catch(() => "");
    const words = (product.name || "").split(/\s+/).filter((w) => w.length > 5);
    if (words.length >= 2 && words.filter((w) => text.toLowerCase().includes(w.toLowerCase())).length >= 2) {
      return true;
    }
    if (productNameMatches(text, product.name)) return true;
  }

  // Only trust checkout-ready when we cannot require a product match (slow/non-drop paths).
  if (!fastMode && !hypeMode) {
    const checkoutReady = await page
      .locator('[data-test="checkout-button"], [data-test="cartCheckoutButton"], button:has-text("Check out")')
      .first()
      .isVisible()
      .catch(() => false);
    if (checkoutReady && count > 0) {
      const savedOnly = await page.getByText(/^saved for later$/i).first().isVisible().catch(() => false);
      if (!savedOnly || count === 1) return true;
    }
  }

  return false;
}

/** On checkout review, confirm this product is actually in the order (not an empty checkout). */
async function verifyCheckoutHasProduct(page, product, { fastMode = false, maxWaitMs } = {}) {
  if (!/\/checkout/i.test(page.url())) return false;

  const tcin = targetCartTcin(product);
  const budgetMs = maxWaitMs ?? (fastMode ? 12000 : 9000);
  const intervalMs = fastMode ? 120 : 200;
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    if (page.isClosed()) return false;

    await advanceCheckoutToReview(page, { fastMode }).catch(() => {});

    const bodyText = await getPageText(page);

    if (/\byour cart is empty\b/i.test(bodyText) && !/\$\d+\.\d{2}/.test(bodyText)) {
      await page.waitForTimeout(intervalMs);
      continue;
    }

    if (bodyText.includes(tcin)) return true;
    if (productNameMatches(bodyText, product.name)) return true;

    const inOrder = await page
      .locator(
        `[data-test="cartItem"]:has(a[href*="${tcin}"]), ` +
          `[data-test*="ItemDetails"]:has(a[href*="${tcin}"]), ` +
          `[data-test*="orderSummary"]:has(a[href*="${tcin}"]), ` +
          `[data-test*="cartLineItem"]:has(a[href*="${tcin}"]), ` +
          `[data-test*="LineItem"]:has(a[href*="${tcin}"]), ` +
          `[data-test*="product-title"]:has(a[href*="${tcin}"]), ` +
          `[data-test*="productTitle"]:has(a[href*="${tcin}"])`
      )
      .first()
      .isVisible()
      .catch(() => false);
    if (inOrder) return true;

    const placeOrderReady = await page
      .locator('[data-test="placeOrderButton"], [data-test="place-order-button"], button:has-text("Place order")')
      .first()
      .isVisible()
      .catch(() => false);
    const hasMoney = /\$\d+\.\d{2}/.test(bodyText);
    const hasTotal = /(order total|estimated total|subtotal|total)/i.test(bodyText);
    const hasLine = await page
      .locator(
        '[data-test*="LineItem"], [data-test*="cartItem"], [data-test*="ItemDetails"], [data-test*="orderSummary"]'
      )
      .first()
      .isVisible()
      .catch(() => false);

    if (placeOrderReady) return true;
    if (hasLine && hasMoney && hasTotal) return true;
    if (hasMoney && hasTotal && !/\byour cart is empty\b/i.test(bodyText)) return true;

    await page.waitForTimeout(intervalMs).catch(() => {});
  }

  return false;
}

/** Spam add buttons, watch for Target's failure popup — never assume click = success. */
async function spamAddToCart(page, product, { bursts, shouldCancel, hypeMode = false, skipScroll = false } = {}) {
  const failMs1 = hypeMode ? 500 : 2200;
  const failMs2 = hypeMode ? 800 : 2800;
  const pollMs = hypeMode ? 25 : 120;
  await dismissImageLightbox(page).catch(() => {});
  if (!skipScroll) await scrollToBuyBox(page, { fastMode: true });

  const handlePopup = async (fail) => {
    if (fail?.alreadyInCart) {
      log.ok(`Target says already in cart: "${fail.message || "already in cart"}" — rushing checkout.`);
      return { ok: true, alreadyInCart: true, message: fail.message };
    }
    if (fail?.failed) {
      log.warn(`Target says add failed: "${fail.message}" — staying on product page.`);
      await dismissAddFailurePopup(page);
      return { ok: false, reason: "popup", message: fail.message };
    }
    return null;
  };

  if (hypeMode) {
    await spamClickButtons(page, buyNowButtons(page), { bursts: Math.max(bursts, 10), shouldCancel, safeOnly: true, hypeMode: true });
    if (/\/checkout/i.test(page.url()) && (await verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: 1500 }))) {
      return { ok: true, onCheckout: true };
    }
    if (await tryCheckoutFromAddDrawer(page, { bursts: 8, shouldCancel })) {
      if (await verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: 1500 })) {
        return { ok: true, onCheckout: true };
      }
    }
    if (await waitForCartApi(page, product, { maxWaitMs: 600, intervalMs: 40 })) {
      return { ok: true, needsVerify: true, apiConfirmed: true };
    }
    let fail = await pollForAddToCartFailure(page, { timeoutMs: failMs1, intervalMs: pollMs });
    const handled = await handlePopup(fail);
    if (handled) return handled;
  }

  await spamClickButtons(page, buyNowButtons(page), { bursts, shouldCancel, safeOnly: true });
  let fail = await pollForAddToCartFailure(page, { timeoutMs: failMs1, intervalMs: pollMs });
  {
    const handled = await handlePopup(fail);
    if (handled) return handled;
  }
  if (/\/checkout/i.test(page.url()) && (await verifyCheckoutHasProduct(page, product, { fastMode: true }))) {
    return { ok: true, onCheckout: true };
  }

  await spamClickButtons(page, shippingBuyButtons(page), { bursts, shouldCancel, safeOnly: true });
  fail = await pollForAddToCartFailure(page, { timeoutMs: failMs2, intervalMs: pollMs });
  {
    const handled = await handlePopup(fail);
    if (handled) return handled;
  }

  if (/\/checkout/i.test(page.url())) {
    if (await verifyCheckoutHasProduct(page, product, { fastMode: true })) {
      return { ok: true, onCheckout: true };
    }
    log.warn("Reached checkout but product is not in the order — treating as failed add.");
    return { ok: false, reason: "empty_checkout" };
  }

  // Clicks landed but no proof yet — caller must verify cart (don't assume success).
  return { ok: true, needsVerify: true };
}

/** Return to the product page to retry add-to-cart. */
async function goBackToProduct(page, product, { fastMode = true } = {}) {
  await fastGotoProduct(page, product, { fastMode });
  await scrollToBuyBox(page, { fastMode });
}

/** Rapid-fire click every visible buy/checkout button (drop mode). */
async function spamClickButtons(page, candidates, { bursts = 6, shouldCancel, safeOnly = false, hypeMode = false } = {}) {
  const gapMs = hypeMode ? 18 : 35;
  const clickMs = hypeMode ? 300 : 500;
  for (let b = 0; b < bursts; b++) {
    if (shouldCancel?.()) throw new Error("Cancelled by user.");
    if (page.isClosed()) return;
    for (const locate of candidates) {
      try {
        if (page.isClosed()) return;
        const el = locate().first();
        if (!(await isBuyControlEnabled(el))) continue;
        if (safeOnly && !(await isSafeClickTarget(el))) continue;
        await el.click({ timeout: clickMs, force: true });
      } catch {
        /* try next selector */
      }
    }
    await page.waitForTimeout(gapMs).catch(() => {});
  }
}

function checkoutButtons(page) {
  const cart = page.locator('[data-test="cartScreen"], [data-test="cart-page"], [data-test="cartContainer"]').first();
  return [
    () => cart.locator('[data-test="checkout-button"]'),
    () => cart.locator('[data-test="cartCheckoutButton"]'),
    () => page.locator('[data-test="checkout-button"]'),
    () => page.locator('[data-test="cartCheckoutButton"]'),
    () => page.locator('[data-test="checkoutButton"]'),
    () => page.getByRole("button", { name: /^check ?out$/i }),
  ];
}

/** Click the cart checkout button and wait for navigation — never mis-click product images. */
async function clickCartCheckoutButton(page, { fastMode = true, hypeMode = false, shouldCancel } = {}) {
  const urlTimeout = hypeMode ? 5000 : fastMode ? 8000 : 12000;
  // Wall clock: 8 attempts × several buttons × click/URL timeouts can otherwise
  // burn minutes — during a drop the item is long gone by then.
  const deadline = Date.now() + (hypeMode ? 10000 : fastMode ? 20000 : 40000);
  for (let attempt = 0; attempt < 8 && Date.now() < deadline; attempt++) {
    if (shouldCancel?.()) throw new Error("Cancelled by user.");
    if (page.isClosed()) return false;
    if (/\/checkout/i.test(page.url())) return true;

    for (const locate of checkoutButtons(page)) {
      const el = locate().first();
      if (!(await isBuyControlEnabled(el))) continue;
      if (!(await isSafeClickTarget(el))) continue;
      try {
        await el.click({ timeout: hypeMode ? 1200 : fastMode ? 2000 : 4000, force: true });
        await page
          .waitForURL(/\/checkout/i, { timeout: urlTimeout, waitUntil: hypeMode ? "commit" : "domcontentloaded" })
          .catch(() => {});
        await page
          .locator('[data-test="placeOrderButton"], [data-test*="orderSummary"], [data-test="cartItem"]')
          .first()
          .waitFor({ state: "visible", timeout: hypeMode ? 2500 : fastMode ? 5000 : 10000 })
          .catch(() => {});
        if (/\/checkout/i.test(page.url())) return true;
      } catch {
        /* try next */
      }
    }
    await page.waitForTimeout(hypeMode ? 40 : fastMode ? 80 : 200);
  }
  return /\/checkout/i.test(page.url());
}

/**
 * Cart → checkout ASAP. Never linger on cart — OOS can kill the reservation.
 * Order: API cart → direct checkout → ATC drawer → cart checkout button.
 */
async function rushToCheckout(page, product, { fastMode = true, hypeMode = false, shouldCancel, fromVerifiedCart = false, apiCartConfirmed = false, config = null } = {}) {
  if (/\/checkout/i.test(page.url())) {
    await advanceCheckoutToReview(page, { fastMode, hypeMode, config });
    return true;
  }
  if (page.isClosed()) return false;

  const cartReady = apiCartConfirmed || (product && (await verifyItemInCartViaApi(page, product)));
  if ((hypeMode || apiCartConfirmed) && cartReady) {
    markBotNavigation(page);
    await fastGoto(page, "https://www.target.com/checkout", { fastMode: true });
    await advanceCheckoutToReview(page, { fastMode, hypeMode, config });
    if (await verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: hypeMode ? 4000 : 6000 })) {
      return true;
    }
  }

  if (/\/p\/|A-\d+/i.test(page.url())) {
    if (await tryCheckoutFromAddDrawer(page, { bursts: hypeMode ? 10 : 8, shouldCancel })) {
      await advanceCheckoutToReview(page, { fastMode, hypeMode, config });
      return true;
    }
  }

  // Cart already verified — click checkout in-place; never reload cart or use direct URL.
  if (fromVerifiedCart && /\/cart/i.test(page.url())) {
    if (await clickCartCheckoutButton(page, { fastMode, hypeMode, shouldCancel })) {
      await advanceCheckoutToReview(page, { fastMode, hypeMode, config });
      return /\/checkout/i.test(page.url());
    }
  }

  if (!/\/cart/i.test(page.url())) {
    markBotNavigation(page);
    await page.goto("https://www.target.com/cart", {
      waitUntil: hypeMode ? "commit" : "domcontentloaded",
      timeout: fastMode ? (hypeMode ? 8000 : 10000) : 14000,
    }).catch(() => {});
  }

  if (await clickCartCheckoutButton(page, { fastMode, hypeMode, shouldCancel })) {
    await advanceCheckoutToReview(page, { fastMode, hypeMode, config });
    return true;
  }

  const budgetMs = hypeMode ? 3500 : fastMode ? 5000 : 8000;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (shouldCancel?.()) throw new Error("Cancelled by user.");
    if (page.isClosed()) return false;
    if (/\/checkout/i.test(page.url())) {
      await advanceCheckoutToReview(page, { fastMode, hypeMode, config });
      return true;
    }
    await spamClickButtons(page, checkoutButtons(page), { bursts: 2, shouldCancel, hypeMode });
    await page.waitForTimeout(hypeMode ? 40 : 80);
  }

  if (!fromVerifiedCart && !/\/checkout/i.test(page.url())) {
    markBotNavigation(page);
    await fastGoto(page, "https://www.target.com/checkout", { fastMode: true });
    await advanceCheckoutToReview(page, { fastMode, hypeMode, config });
  }

  return /\/checkout/i.test(page.url());
}

/** Checkout loaded empty — return to cart and click checkout again. */
async function retryCheckoutFromCart(page, product, { fastMode = true, hypeMode = false, shouldCancel, config = null } = {}) {
  if (page.isClosed()) return false;

  if (await verifyItemInCartViaApi(page, product)) {
    await fastGoto(page, "https://www.target.com/checkout", { fastMode: true });
    await advanceCheckoutToReview(page, { fastMode, hypeMode, config });
    if (await verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: hypeMode ? 5000 : 8000 })) {
      return true;
    }
  }

  if (/\/cart/i.test(page.url())) {
    await page
      .locator('[data-test="cartItem"], [data-test="checkout-button"], button:has-text("Check out")')
      .first()
      .waitFor({ state: "visible", timeout: fastMode ? (hypeMode ? 5000 : 8000) : 12000 })
      .catch(() => {});
  } else {
    markBotNavigation(page);
    await page.goto("https://www.target.com/cart", {
      waitUntil: hypeMode ? "commit" : "domcontentloaded",
      timeout: fastMode ? (hypeMode ? 8000 : 12000) : 18000,
    }).catch(() => {});
    await page
      .locator('[data-test="cartItem"], [data-test="checkout-button"], button:has-text("Check out")')
      .first()
      .waitFor({ state: "visible", timeout: fastMode ? (hypeMode ? 5000 : 8000) : 12000 })
      .catch(() => {});
  }

  if (!(await clickCartCheckoutButton(page, { fastMode, hypeMode, shouldCancel }))) return false;
  await advanceCheckoutToReview(page, { fastMode, hypeMode, config });
  return verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: hypeMode ? 6000 : 8000 });
}

function placeOrderButtons(page) {
  return [
    () => page.locator('[data-test="placeOrderButton"]'),
    () => page.locator('[data-test="place-order-button"]'),
    () => page.getByRole("button", { name: /place (your )?order/i }),
    () => page.locator('button:has-text("Place order")'),
  ];
}

async function attemptPlaceOrder(page, config, {
  dryRun,
  autoPlaceOrder,
  fastMode,
  dropWindowActive,
  shouldCancel,
  phase,
  tryFillCvv,
}) {
  if (dryRun) {
    log.warn("DRY RUN: stopping before placing the order. No purchase was made.");
    await screenshot(page, "dry-run-review");
    phase("dry_run", "Dry run — cart filled, not purchased");
    return { placed: false, dryRun: true };
  }
  if (!autoPlaceOrder) {
    phase("needs_review", "Ready — click 'Place order' in the browser");
    return { placed: false, manual: true };
  }

  phase("placing_order", "Placing order");
  await tryFillCheckoutProfile(page, config, { fastMode: true }).catch(() => {});
  await tryFillCvv(page, config, { fastMode: true });
  await advanceCheckoutToReview(page, { fastMode: true, hypeMode: dropWindowActive, config }).catch(() => {});

  const bursts = dropWindowActive ? 10 : 6;
  await spamClickButtons(page, placeOrderButtons(page), { bursts, shouldCancel, hypeMode: dropWindowActive });
  await page.waitForTimeout(fastMode ? (dropWindowActive ? 80 : 150) : 400);

  let placed = await clickFirst(page, placeOrderButtons(page), {
    timeout: fastMode ? 4000 : 7000,
    shouldCancel,
    fastMode: true,
  });

  if (!placed) {
    await tryFillCheckoutProfile(page, config, { fastMode: true }).catch(() => {});
    await tryFillCvv(page, config, { fastMode: true });
    await advanceCheckoutToReview(page, { fastMode: true, hypeMode: dropWindowActive, config }).catch(() => {});
    await spamClickButtons(page, placeOrderButtons(page), { bursts: 4, shouldCancel });
    placed = await clickFirst(page, placeOrderButtons(page), {
      timeout: fastMode ? 3000 : 6000,
      shouldCancel,
      fastMode: true,
    });
  }

  if (!placed) return { placed: false };

  await page.waitForTimeout(fastMode ? 200 : 500);
  const orderErr = await detectPlaceOrderError(page);
  if (orderErr.failed) {
    log.warn(`Place order error: ${orderErr.message}`);
    await screenshot(page, "place-order-error");
    return { placed: false, reason: orderErr.reason, message: orderErr.message };
  }

  const confirmed = await page
    .getByText(/thank you for your order|order placed|order #|order number/i)
    .first()
    .waitFor({ state: "visible", timeout: fastMode ? 10000 : 15000 })
    .then(() => true)
    .catch(() => false);

  if (!confirmed) {
    await screenshot(page, "post-place-order");
    log.warn("Clicked 'Place order' but couldn't confirm — check the browser.");
    return { placed: true, confirmed: false };
  }

  log.ok("Order placed and confirmed.");
  return { placed: true, confirmed: true };
}

/** Place order once we're on a verified checkout page. */
async function placeOrderFromCheckout(page, product, config, ctx) {
  if (await isLoggedOut(page)) {
    throw new Error("Session expired at checkout. Run `node src/index.js login` first.");
  }
  return attemptPlaceOrder(page, config, {
    dryRun: ctx.dryRun,
    autoPlaceOrder: ctx.autoPlaceOrder,
    fastMode: ctx.fastMode,
    dropWindowActive: ctx.dropWindowActive,
    shouldCancel: ctx.shouldCancel,
    phase: ctx.phase,
    tryFillCvv,
  });
}

/** Target PDP broken during heavy drops — reload instead of treating as OOS. */
async function isPageUnavailable(page) {
  const wall = await detectTargetWall(page);
  return wall.blocked && (wall.reason === "site_error" || wall.reason === "high_traffic");
}

/** Quick PDP check — enabled buy control means in stock for UI path. */
async function isProductBuyable(page) {
  if (await isPageUnavailable(page)) return false;
  const soldOut = await page
    .getByText(/^sold out$|out of stock|temporarily out of stock/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (soldOut) return false;
  for (const locate of [...buyNowButtons(page), ...shippingBuyButtons(page)]) {
    if (await isBuyControlEnabled(locate().first())) return true;
  }
  return false;
}

/**
 * Drop checkout loop: PDP → spam add → verify cart → spam checkout → place order.
 * If cart is empty at any point, goes back to the product page and retries.
 */
async function aggressiveDropCheckout(page, product, config, {
  fastMode,
  dropWindowActive,
  hypeMode,
  shouldCancel,
  phase,
  tryFillCvv,
  dryRun,
  autoPlaceOrder,
  onLog,
  stockConfirmed = false,
  latency = null,
  parallelCheckoutPage = null,
}) {
  const hype = hypeMode !== false && config.checkout?.hypeMode !== false;
  const retries = Math.max(1, Number(config.checkout?.checkoutRetries) || 8);
  const maxRounds = dropWindowActive && hype ? 6 : dropWindowActive ? retries + 4 : retries;
  const addBursts = dropWindowActive ? (hype ? 20 : 8) : hype ? 8 : 5;
  const ctx = { dryRun, autoPlaceOrder, fastMode, dropWindowActive, shouldCancel, phase, onLog, latency };
  let consecutiveOos = 0;

  // Backup trick: park the warm tab on /checkout while PDP ATC runs so we can
  // skip the checkout button when Target says high-demand / already in cart.
  if (parallelCheckoutPage && !parallelCheckoutPage.isClosed?.()) {
    markBotNavigation(parallelCheckoutPage);
    void fastGoto(parallelCheckoutPage, "https://www.target.com/checkout", { fastMode: true })
      .then(() =>
        advanceCheckoutToReview(parallelCheckoutPage, { fastMode: true, hypeMode: hype, config })
      )
      .catch(() => {});
  }

  const tryAlreadyInCartCheckout = async (round, note) => {
    checkoutLog(
      { onLog },
      "hit",
      `[CHECKOUT] ${product.name || product.tcin}: ${note}`
    );
    phase("checking_out", "Already in cart → direct checkout");

    // Prefer the parallel warm tab so the PDP tab stays intact.
    const lanes = [parallelCheckoutPage, page].filter(
      (p, i, arr) => p && !p.isClosed?.() && arr.indexOf(p) === i
    );
    for (const lane of lanes) {
      markBotNavigation(lane);
      await fastGoto(lane, "https://www.target.com/checkout", { fastMode: true });
      await advanceCheckoutToReview(lane, { fastMode: true, hypeMode: hype, config });
      if (
        await verifyCheckoutHasProduct(lane, product, {
          fastMode: true,
          maxWaitMs: hype ? 5000 : 8000,
        })
      ) {
        log.ok(`Round ${round}: already-in-cart checkout confirmed — placing order.`);
        return placeOrderFromCheckout(lane, product, config, ctx);
      }
    }
    // Cart API may still see it even if checkout page was empty once.
    if (await verifyItemInCartViaApi(page, product)) {
      if (
        await rushToCheckout(page, product, {
          fastMode: true,
          hypeMode: hype,
          shouldCancel,
          apiCartConfirmed: true,
          config,
        })
      ) {
        if (await verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: hype ? 5000 : 8000 })) {
          return placeOrderFromCheckout(page, product, config, ctx);
        }
      }
    }
    log.warn(`Round ${round}: already-in-cart signal but checkout empty — continuing.`);
    return null;
  };

  // Performance / hype: always try API blitz first when enabled
  if ((hype || config.checkout?.performanceMode !== false) && config.checkout?.apiCheckout !== false) {
    const blitz = await tryApiBlitzCheckout(page, product, config, ctx);
    if (blitz?.placed || blitz?.dryRun || blitz?.manual) return blitz;
  }

  for (let round = 1; round <= maxRounds; round++) {
    if (shouldCancel?.()) throw new Error("Cancelled by user.");

    if (!(stockConfirmed && round === 1)) {
      const issue = await recoverTargetIssue(page, product, { fastMode: true, hypeMode: hype });
      if (issue.captcha) {
        checkoutLog({ onLog }, "err", `[CHECKOUT] ${product.name || product.tcin}: Target bot challenge — needs manual refresh`);
        throw new Error("Target bot challenge — refresh the bot Chrome tab manually, then Stop → Start.");
      }
    }

    if (await isLoggedOut(page)) {
      throw new Error("Session expired during drop — use Login in the dashboard, then Stop → Start.");
    }

    phase("adding_to_cart", `Spam add (round ${round}/${maxRounds})`);
    if (round > 1 || !page.url().includes(String(product.tcin))) {
      await goBackToProduct(page, product, { fastMode: true });
    }
    if (!(stockConfirmed && round === 1)) {
      if (await isPageUnavailable(page)) {
        log.warn(`Round ${round}: Target page unavailable — reloading PDP NOW`);
        await fastGotoProduct(page, product, { fastMode: true });
        await page.waitForTimeout(hype ? 120 : 300);
      }
      if (!(await isProductBuyable(page))) {
        consecutiveOos += 1;
        // Don't burn the whole timeout spam-clicking a page that already shows OOS.
        if (consecutiveOos >= 3) {
          // Last chance: item may already be reserved from an earlier click.
          const lastChance = await tryAlreadyInCartCheckout(round, "page OOS — checking if already reserved in cart");
          if (lastChance?.placed || lastChance?.dryRun || lastChance?.manual) return lastChance;
          throw new Error("Product went out of stock on page before cart confirmed.");
        }
        if (round <= 2 && dropWindowActive) {
          log.warn(`Round ${round}: buy box not ready — fast reload…`);
          await fastGotoProduct(page, product, { fastMode: true });
          await page.waitForTimeout(hype ? 100 : 300);
          if (!(await isProductBuyable(page)) && round === 1) {
            throw new Error("Product is out of stock — cannot add to cart.");
          }
          if (!(await isProductBuyable(page))) continue;
        } else if (round === 1) {
          throw new Error("Product is out of stock — cannot add to cart.");
        } else {
          log.warn(`Round ${round}: product OOS on page — retrying…`);
          continue;
        }
      } else {
        consecutiveOos = 0;
      }
    }
    if (round === 1 && hype && !stockConfirmed) {
      await ensureShippingFulfillment(page, { fastMode: true });
    } else if (!stockConfirmed || round > 1) {
      if (!(stockConfirmed && round === 1)) {
        await waitOutTargetGlitch(page, product, { fastMode: true, hypeMode: hype });
        await ensureShippingFulfillment(page, { fastMode: true });
      }
    }

    if ((product.maxQuantity || 1) > 1) {
      await trySetQuantity(page, product.maxQuantity);
    }

    const addResult = await spamAddToCart(page, product, {
      bursts: addBursts,
      shouldCancel,
      hypeMode: hype,
      skipScroll: stockConfirmed && round === 1,
    });
    if (addResult.alreadyInCart) {
      const reserved = await tryAlreadyInCartCheckout(
        round,
        "Target says already in cart — direct /checkout (parallel tab if available)"
      );
      if (reserved?.placed || reserved?.dryRun || reserved?.manual) return reserved;
      continue;
    }
    if (!addResult.ok) {
      if (
        addResult.reason === "popup" &&
        popupImpliesItemIsInCart(addResult.message)
      ) {
        const reserved = await tryAlreadyInCartCheckout(
          round,
          "Target popup implies already in cart — direct /checkout"
        );
        if (reserved?.placed || reserved?.dryRun || reserved?.manual) return reserved;
      }
      if (addResult.reason === "popup" && /limit|maximum|quantity|per guest/i.test(addResult.message || "")) {
        if ((product.maxQuantity || 1) > 1) {
          log.warn("Quantity limit — retrying with qty 1.");
          product.maxQuantity = 1;
          continue;
        }
      }
      log.warn(`Round ${round}: add failed (${addResult.reason || "unknown"}) — retrying on product page…`);
      await dismissAddFailurePopup(page);
      continue;
    }

    if (addResult.onCheckout) {
      log.ok(`Round ${round}: buy now → checkout (skipped cart).`);
      const result = await placeOrderFromCheckout(page, product, config, ctx);
      if (result.placed || result.dryRun || result.manual) return result;
      log.warn("Place order failed — back to product page…");
      continue;
    }

    if (await tryCheckoutFromAddDrawer(page, { bursts: hype ? 10 : 6, shouldCancel })) {
      if (await verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: hype ? 4000 : 8000 })) {
        log.ok(`Round ${round}: add drawer → checkout (skipped cart page).`);
        const result = await placeOrderFromCheckout(page, product, config, ctx);
        if (result.placed || result.dryRun || result.manual) return result;
        log.warn("Place order failed — back to product page…");
        continue;
      }
    }

    const apiInCart = addResult.apiConfirmed || (await waitForCartApi(page, product, { maxWaitMs: hype ? 700 : 1200, intervalMs: 40 }));
    if (apiInCart) {
      log.ok(`Round ${round}: cart API confirmed — rushing checkout NOW`);
      phase("checking_out", "API cart → checkout");
      if (await rushToCheckout(page, product, {
        fastMode: true,
        hypeMode: hype,
        shouldCancel,
        apiCartConfirmed: true,
        config,
      })) {
        let onCheckout = await verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: hype ? 5000 : 8000 });
        if (onCheckout) {
          log.ok("Checkout page confirmed — placing order.");
          const result = await placeOrderFromCheckout(page, product, config, ctx);
          if (result.placed || result.dryRun || result.manual) return result;
        }
      }
    }

    // Never go to checkout unless the item is verified in the ACTIVE cart.
    if (!(await verifyItemInCart(page, product, { fastMode: true, hypeMode: hype }))) {
      const popup = await pollForAddToCartFailure(page, { timeoutMs: hype ? 400 : 800 });
      if (popup.alreadyInCart || popupImpliesItemIsInCart(popup.message)) {
        const reserved = await tryAlreadyInCartCheckout(round, "cart verify missed but popup says reserved");
        if (reserved?.placed || reserved?.dryRun || reserved?.manual) return reserved;
      }
      if (popup.failed) await dismissAddFailurePopup(page);
      log.warn(`Round ${round}: not in active cart — back to product page…`);
      continue;
    }

    log.ok(`Round ${round}: in cart — rushing checkout NOW`);
    checkoutLog({ onLog }, "hit", `[CHECKOUT] ${product.name || product.tcin}: in cart — rushing checkout`);
    phase("checking_out", "Rushing checkout");
    const cartBlock = await detectCheckoutBlocker(page);
    if (cartBlock.blocked) {
      if (cartBlock.reason === "captcha") {
        throw new Error(cartBlock.message || "Target bot challenge — refresh Chrome tab manually.");
      }
      if (cartBlock.reason === "site_error" || cartBlock.reason === "high_traffic") {
        log.warn(`${cartBlock.message} — recovering before checkout…`);
        await recoverTargetIssue(page, product, { fastMode: true, hypeMode: hype });
        continue;
      }
      if (cartBlock.reason === "quantity_limit" && (product.maxQuantity || 1) > 1) {
        log.warn("Cart quantity limit — retrying with qty 1.");
        product.maxQuantity = 1;
        continue;
      }
      if (cartBlock.reason === "minimum_order" || cartBlock.reason === "not_signed_in") {
        throw new Error(cartBlock.message);
      }
      if (cartBlock.reason === "item_unavailable") {
        log.warn(`Round ${round}: item OOS in cart — back to product page…`);
        continue;
      }
    }

    if (!(await rushToCheckout(page, product, { fastMode: true, hypeMode: hype, shouldCancel, fromVerifiedCart: true, config }))) {
      log.warn(`Round ${round}: couldn't reach checkout — retrying…`);
      continue;
    }

    let onCheckout = await verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: hype ? 5000 : 8000 });
    if (!onCheckout) {
      log.warn(`Round ${round}: checkout empty — retrying from cart…`);
      onCheckout = await retryCheckoutFromCart(page, product, { fastMode: true, hypeMode: hype, shouldCancel, config });
    }
    if (!onCheckout) {
      log.warn(`Round ${round}: checkout open but product missing — retrying…`);
      continue;
    }
    log.ok("Checkout page confirmed — placing order.");

    const result = await placeOrderFromCheckout(page, product, config, ctx);
    if (result.placed || result.dryRun || result.manual) return result;
    if (result.reason === "oos") {
      log.warn(`Round ${round}: sold out at place order — back to product page…`);
      continue;
    }
    if (result.reason === "payment") {
      throw new Error(result.message || "Payment failed — check card/CVV in dashboard.");
    }

    if (!(await verifyItemInCart(page, product, { fastMode: true, hypeMode: hype }))) {
      log.warn(`Round ${round}: cart cleared after failed checkout — back to product page…`);
      continue;
    }
  }

  await screenshot(page, "drop-checkout-exhausted");
  throw new Error("Could not complete checkout — kept going back to add/spam after empty cart.");
}

/** Empty cart before a drop checkout so old items don't block the order. */
async function clearCart(page, { fastMode = false } = {}) {
  markBotNavigation(page);
  await page.goto("https://www.target.com/cart", { waitUntil: "domcontentloaded" }).catch(() => {});
  const deadline = Date.now() + (fastMode ? 10000 : 15000);
  while (Date.now() < deadline) {
    const remove = page
      .locator(
        '[data-test="cartItem-delete"], [data-test="cartItem-deleteBtn"], [data-test="cartItemDeleteBtn"], button[aria-label^="Remove"][aria-label*="from Cart"], button:has-text("Remove")'
      )
      .first();
    if (await remove.isVisible().catch(() => false)) {
      await remove.click({ timeout: 1500, force: fastMode }).catch(() => {});
      await page.waitForTimeout(fastMode ? 250 : 700);
      continue;
    }
    const empty = await page.getByText(/^your cart is empty$/i).first().isVisible().catch(() => false);
    if (empty) break;
    // Cart line items often render several seconds after domcontentloaded.
    await page.waitForTimeout(fastMode ? 200 : 500);
  }
}

/** Exported for drop-window prep (clears cart without disturbing product tabs). */
export async function clearCartForDrop(page, opts = {}) {
  return clearCart(page, opts);
}

/**
 * Detect a third-party (Target Plus marketplace) item. Products SOLD BY TARGET
 * have no "Sold & shipped by <seller>" line; marketplace items show one with a
 * partner's name. We treat anything sold by a non-Target seller as off-limits.
 */
export async function isThirdPartySeller(page) {
  const text = await page
    .evaluate(() => document.body.innerText.replace(/\s+/g, " "))
    .catch(() => "");
  if (!/sold (and|&) shipped by/i.test(text)) return false; // first-party: no seller line
  if (/sold (and|&) shipped by target\b/i.test(text)) return false; // explicitly Target
  return true; // a non-Target seller is named
}

/** Detect whether Target bounced us to a sign-in wall. */
export async function isLoggedOut(page) {
  if (/\/login|\/account\/signin/i.test(page.url())) return true;
  const pwd = page.locator('input[type="password"], input[name="password"]').first();
  if (await pwd.isVisible().catch(() => false)) return true;

  const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  if (/^sign in$/im.test(body) && /create account/i.test(body) && /target\.com\/account/i.test(page.url())) {
    return true;
  }
  if (/\/checkout/i.test(page.url()) && /sign in to (check out|continue)|please sign in to place/i.test(body)) {
    return true;
  }

  const signInNav = page
    .getByRole("link", { name: /^sign in$/i })
    .or(page.getByRole("button", { name: /^sign in$/i }))
    .first();
  if (await signInNav.isVisible().catch(() => false)) {
    const accountUrl = /target\.com\/account/i.test(page.url());
    const checkoutGuest = /target\.com\/checkout/i.test(page.url()) && /continue as guest|sign in to checkout/i.test(body);
    if (accountUrl || checkoutGuest) return true;
  }
  return false;
}

/** Confirm the saved Chrome profile has an active Target session. */
export async function checkTargetSession(page) {
  await page.bringToFront().catch(() => {});
  await page.goto("https://www.target.com/account", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (await isLoggedOut(page)) return { signedIn: false };

  const signedInSignals = [
    page.getByRole("link", { name: /sign out|log out/i }).first(),
    page.getByRole("link", { name: /orders/i }).first(),
    page.locator('[data-test="accountUserName"], [data-test="accountNav"]').first(),
  ];
  for (const el of signedInSignals) {
    if (await el.isVisible().catch(() => false)) return { signedIn: true };
  }

  // No explicit sign-in CTA on account home usually means we're in.
  const signIn = page.getByRole("link", { name: /^sign in$/i }).first();
  return { signedIn: !(await signIn.isVisible().catch(() => false)) };
}

/** Cart/checkout blockers that look like success but prevent placing an order. */
export async function detectCheckoutBlocker(page) {
  const text = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).replace(/\s+/g, " ");
  if (/minimum (order|purchase|cart)|order minimum|below the order minimum|add \$\d+(\.\d{2})? more to (checkout|check out)|\$\d+(\.\d{2})? minimum/i.test(text)) {
    const match = text.match(/add \$(\d+(?:\.\d{2})?) more/i) || text.match(/\$(\d+(?:\.\d{2})?) minimum/i);
    const detail = match ? `needs ~$${match[1]} more in cart` : "order minimum not met";
    return { blocked: true, reason: "minimum_order", message: `Target order minimum not met (${detail}).` };
  }
  if (await isLoggedOut(page)) {
    return { blocked: true, reason: "not_signed_in", message: "Not signed in to Target — use Login in the dashboard first." };
  }
  if (/item is no longer available|this item is no longer available|has been removed from your (cart|order)|no longer in your (cart|order)/i.test(text)) {
    return { blocked: true, reason: "item_unavailable", message: "Item went out of stock — back to product page." };
  }
  if (/payment (method )?(declined|failed|couldn't be processed)|update your payment|card (has )?expired/i.test(text)) {
    return { blocked: true, reason: "payment", message: "Payment issue — check card in your Target account." };
  }
  if (/address (is )?(invalid|incomplete)|update (your )?shipping address|delivery (is )?unavailable/i.test(text)) {
    return { blocked: true, reason: "address", message: "Shipping address issue — fix in Target account settings." };
  }
  if (/quantity (has been )?adjusted|purchase limit|guest limit|limited to \d+/i.test(text)) {
    return { blocked: true, reason: "quantity_limit", message: "Quantity limit hit — reduce qty and retry." };
  }
  const wall = await detectTargetWall(page);
  if (wall.blocked) return wall;
  return { blocked: false };
}

/** Best-effort: set the desired quantity on the product page. */
async function trySetQuantity(page, qty) {
  if (!qty || qty <= 1) return;
  try {
    const dropdown = page.locator('[data-test="qtyDropdown"], select[id*="quantity" i]').first();
    if (await dropdown.isVisible().catch(() => false)) {
      await dropdown.selectOption(String(qty)).catch(() => {});
      return;
    }
    // Stepper fallback: click the "+" button (qty-1) times.
    const plus = page.getByRole("button", { name: /increase quantity|increment|\+/i }).first();
    if (await plus.isVisible().catch(() => false)) {
      for (let i = 1; i < qty; i++) {
        await plus.click({ timeout: 800 }).catch(() => {});
        await page.waitForTimeout(60);
      }
    }
  } catch {
    /* quantity is best-effort; ignore */
  }
}

/** Fill a React/controlled input so Target's checkout registers the value. */
async function fillReactField(field, value, { fastMode = true } = {}) {
  if (value == null || value === "") return false;
  if (!(await field.isVisible().catch(() => false))) return false;
  const text = String(value);
  if (fastMode) {
    await field.fill(text).catch(() => {});
    await field
      .evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }, text)
      .catch(() => {});
  } else {
    await humanType(field, text);
  }
  return true;
}

async function fillFirstMatching(page, selectors, value, { fastMode = true } = {}) {
  if (!value) return false;
  for (const sel of selectors) {
    const field = page.locator(sel).first();
    if (await fillReactField(field, value, { fastMode })) return true;
  }
  return false;
}

/**
 * Autofill shipping / contact / billing from the saved dashboard profile.
 * Best-effort — Target may already have an address on the account.
 */
async function tryFillCheckoutProfile(page, config, { fastMode = true } = {}) {
  const profile = config?.checkoutProfile;
  if (!profile) return;
  if (!/\/checkout/i.test(page.url())) return;

  const fullName = String(profile.fullName || "").trim();
  const [firstName, ...rest] = fullName.split(/\s+/).filter(Boolean);
  const lastName = rest.join(" ") || firstName || "";
  const ship = profile.shipping || {};
  const bill =
    profile.billingSameAsShipping === false ? profile.billing || {} : ship;

  await fillFirstMatching(
    page,
    [
      'input[name="fullName"]',
      'input[autocomplete="name"]',
      '[data-test*="fullName" i] input',
      'input[id*="fullName" i]',
    ],
    fullName,
    { fastMode }
  );
  await fillFirstMatching(
    page,
    [
      'input[name="firstName"]',
      'input[autocomplete="given-name"]',
      '[data-test*="firstName" i] input',
      'input[id*="firstName" i]',
    ],
    firstName,
    { fastMode }
  );
  await fillFirstMatching(
    page,
    [
      'input[name="lastName"]',
      'input[autocomplete="family-name"]',
      '[data-test*="lastName" i] input',
      'input[id*="lastName" i]',
    ],
    lastName,
    { fastMode }
  );
  await fillFirstMatching(
    page,
    [
      'input[name="phone"]',
      'input[type="tel"]',
      'input[autocomplete="tel"]',
      '[data-test*="phone" i] input',
      'input[id*="phone" i]',
    ],
    profile.phone,
    { fastMode }
  );
  await fillFirstMatching(
    page,
    [
      'input[name="email"]',
      'input[type="email"]',
      'input[autocomplete="email"]',
      '[data-test*="email" i] input',
    ],
    profile.email,
    { fastMode }
  );

  const fillAddress = async (addr, prefixSelectors = []) => {
    if (!addr) return;
    await fillFirstMatching(
      page,
      [
        ...prefixSelectors.map((p) => `${p} input[name*="address" i], ${p} input[autocomplete="street-address"]`),
        'input[name="addressLine1"]',
        'input[name="address1"]',
        'input[autocomplete="address-line1"]',
        '[data-test*="addressLine1" i] input',
        'input[id*="addressLine1" i]',
        'input[placeholder*="street address" i]',
      ],
      addr.line1,
      { fastMode }
    );
    await fillFirstMatching(
      page,
      [
        'input[name="addressLine2"]',
        'input[name="address2"]',
        'input[autocomplete="address-line2"]',
        '[data-test*="addressLine2" i] input',
      ],
      addr.line2,
      { fastMode }
    );
    await fillFirstMatching(
      page,
      [
        'input[name="city"]',
        'input[autocomplete="address-level2"]',
        '[data-test*="city" i] input',
        'input[id*="city" i]',
      ],
      addr.city,
      { fastMode }
    );
    // State: prefer select, then text input
    if (addr.state) {
      const stateSel = page
        .locator('select[name="state"], select[autocomplete="address-level1"], [data-test*="state" i] select')
        .first();
      if (await stateSel.isVisible().catch(() => false)) {
        await stateSel.selectOption(String(addr.state).toUpperCase()).catch(() => {});
      } else {
        await fillFirstMatching(
          page,
          [
            'input[name="state"]',
            'input[autocomplete="address-level1"]',
            '[data-test*="state" i] input',
          ],
          addr.state,
          { fastMode }
        );
      }
    }
    await fillFirstMatching(
      page,
      [
        'input[name="zipCode"]',
        'input[name="postalCode"]',
        'input[name="zip"]',
        'input[autocomplete="postal-code"]',
        '[data-test*="zip" i] input',
        'input[id*="zip" i]',
      ],
      addr.postalCode,
      { fastMode }
    );
  };

  await fillAddress(ship);
  if (profile.billingSameAsShipping === false) {
    await fillAddress(bill, ['[data-test*="billing" i]', '[id*="billing" i]']);
  } else {
    // Tick "same as shipping" if Target shows it
    const same = page
      .locator(
        'input[type="checkbox"][name*="same" i], [data-test*="billingSame" i] input, label:has-text("same as shipping") input'
      )
      .first();
    if (await same.isVisible().catch(() => false)) {
      const checked = await same.isChecked().catch(() => true);
      if (!checked) await same.check({ force: true }).catch(() => {});
    }
  }
}

/** If Target asks for the card's security code, fill it from config/env. */
async function tryFillCvv(page, config, { fastMode = false } = {}) {
  const cvv = process.env.CHECKOUT_CVV || config.checkout?.cvv;
  const field = page
    .locator('input[name="cardCVV"], [data-test="creditCardInput-cvv"], input[id*="cvv" i]')
    .first();
  if (!(await field.isVisible().catch(() => false))) return;
  if (!cvv) {
    log.warn("Target is asking for your card security code. Enter your CVV in the dashboard top bar.");
    return;
  }
  await fillReactField(field, cvv, { fastMode: true });
  if (!fastMode) {
    // Already filled via fillReactField; humanType only when slow mode and empty
  }
}

/**
 * Run the full assisted checkout for one product.
 * Honors config.checkout.dryRun and config.checkout.autoPlaceOrder for safety.
 */
export async function runCheckout(context, product, config, hooks = {}) {
  const phase = (name, detail) => hooks.onPhase?.(name, detail);
  const shouldCancel = hooks.shouldCancel;
  const ck = () => {
    if (shouldCancel?.()) throw new Error("Cancelled by user.");
  };
  const { dryRun, autoPlaceOrder, checkoutTimeoutMs } = config.checkout;
  const isTestRun = !!dryRun;
  const dropMode =
    hooks.fastMode === true ||
    (!isTestRun && (config.checkout?.dropMode !== false && autoPlaceOrder && !dryRun));
  const fastMode =
    hooks.fastMode === true || (!isTestRun && (dropMode || !!hooks.dropWindowActive));
  const dropWindowActive =
    hooks.dropWindowActive === true || (!isTestRun && !!hooks.dropWindowActive);
  const hypeMode =
    hooks.hypeMode === true ||
    (!isTestRun && (config.checkout?.hypeMode !== false && dropMode));
  const skipNavigation = !!hooks.skipNavigation;
  const stockConfirmed = !!hooks.stockConfirmed;
  const latency = hooks.latency || null;
  // Use the product's dedicated tab when provided, else the first/new tab.
  const page = hooks.page ?? context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(checkoutTimeoutMs);
  installCartApiKeyCapture(page);

  if (!product.tcin) throw new Error("Product has no TCIN to check out.");
  const hype = hypeMode !== false && config.checkout?.hypeMode !== false;
  const navPause = fastMode ? (hype ? 0 : 150) : isTestRun ? 200 : 1200;
  const confirmPause = fastMode ? (hype ? 0 : 200) : isTestRun ? 200 : 1200;
  log.title(
    `Checkout: ${product.name || product.tcin}${
      isTestRun && !fastMode
        ? " (test — fast)"
        : fastMode
        ? hype
          ? " (hype mode)"
          : " (drop mode)"
        : ""
    }`
  );

  // Don't leave the in-stock product tab for cart cleanup — cart is cleared at drop-window start.
  const shouldClearCart =
    config.checkout?.clearCartBeforeCheckout !== false && dropMode && !skipNavigation && !dropWindowActive;
  if (shouldClearCart) {
    ck();
    phase("processing", "Clearing cart before checkout");
    await clearCart(page, { fastMode });
  }

  ck();
  if (!skipNavigation) {
    phase("navigating", "Opening product page");
    await page.bringToFront().catch(() => {});
    await fastGotoProduct(page, product, { fastMode: fastMode || isTestRun });
    if (navPause) await page.waitForTimeout(navPause);
    await scrollToBuyBox(page, { fastMode: fastMode || isTestRun });
  } else {
    // Stock check just succeeded on this tab — stay on the PDP and buy immediately.
    phase("in_stock", "In stock — buying now");
    await page.bringToFront().catch(() => {});
    if (!page.url().includes(String(product.tcin))) {
      await fastGotoProduct(page, product, { fastMode: true });
      if (!stockConfirmed && confirmPause) await page.waitForTimeout(confirmPause);
    }
    if (!stockConfirmed) {
      if (hype) {
        await scrollToBuyBox(page, { fastMode: true });
        await ensureShippingFulfillment(page, { fastMode: true });
      } else {
        await waitOutTargetGlitch(page, { fastMode });
      }
    }
  }

  if (await isLoggedOut(page)) {
    throw new Error("You're not signed in. Run `node src/index.js login` first.");
  }

  // Hype/drop: spam buy buttons ASAP — don't wait for full buy-box render.
  if (!(hype && (fastMode || skipNavigation))) {
    await page
      .locator('[data-test="shippingButton"], [data-test^="addToCartButton"], [data-test="buyNowButton"], button:has-text("Add to cart"), button:has-text("Ship it"), button:has-text("Buy now")')
      .first()
      .waitFor({ state: "visible", timeout: fastMode ? (hype ? 2500 : 4000) : 12000 })
      .catch(() => {});
  }

  // Sold-by-Target guard — skip in hype round 1 for speed (Pokémon is Target-sold).
  if (config.checkout?.targetSoldOnly !== false && !hype && (await isThirdPartySeller(page))) {
    throw new Error("Sold by a third-party seller, not Target — skipped.");
  }

  // Drop mode: spam add → verify cart → spam checkout → place order (loop back to PDP if cart empty).
  if (fastMode) {
    ck();
    await trySetQuantity(page, product.maxQuantity);
    return aggressiveDropCheckout(page, product, config, {
      fastMode,
      dropWindowActive,
      hypeMode,
      shouldCancel,
      phase,
      tryFillCvv,
      dryRun,
      autoPlaceOrder,
      onLog: hooks.onLog,
      stockConfirmed,
      latency,
      parallelCheckoutPage: hooks.parallelCheckoutPage || null,
    });
  }

  // Non-drop / dry-run: single fast pass — add → cart → checkout → stop before place order.
  ck();
  phase("adding_to_cart", isTestRun ? "Adding to cart (test)" : "Adding to cart");
  await ensureShippingFulfillment(page, { fastMode: isTestRun || fastMode });
  await trySetQuantity(page, product.maxQuantity);

  const clickFast = isTestRun || fastMode;
  await dismissImageLightbox(page).catch(() => {});
  await scrollToBuyBox(page, { fastMode: true });
  let added = await clickFirst(page, buyNowButtons(page), {
    timeout: clickFast ? 3500 : 8000,
    shouldCancel,
    fastMode: clickFast,
    force: true,
  });
  if (!added) {
    added = await clickFirst(page, shippingBuyButtons(page), {
      timeout: clickFast ? 5000 : 12000,
      shouldCancel,
      fastMode: clickFast,
    });
  }
  const fail = await pollForAddToCartFailure(page, {
    timeoutMs: clickFast ? 1000 : 3500,
    intervalMs: clickFast ? 60 : 120,
  });
  if (fail.alreadyInCart) {
    log.ok("Target says already in cart — rushing checkout.");
    phase("checking_out", "Already in cart → checkout");
    await rushToCheckout(page, product, { fastMode: true, hypeMode: isTestRun, shouldCancel, apiCartConfirmed: true, config });
    if (await verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: 10000 })) {
      if (await isLoggedOut(page)) throw new Error("Session expired at checkout. Run login first.");
      return attemptPlaceOrder(page, config, {
        dryRun,
        autoPlaceOrder,
        fastMode: true,
        dropWindowActive: false,
        shouldCancel,
        phase,
        tryFillCvv,
      });
    }
  }
  if (fail.failed) {
    await dismissAddFailurePopup(page);
    await screenshot(page, "add-to-cart-failed");
    throw new Error(`Target blocked add to cart: ${fail.message}`);
  }

  if (/\/checkout/i.test(page.url()) && (await verifyCheckoutHasProduct(page, product, { fastMode: true }))) {
    log.ok("Buy now → checkout (skipped cart).");
    if (await isLoggedOut(page)) throw new Error("Session expired at checkout. Run login first.");
    return attemptPlaceOrder(page, config, {
      dryRun,
      autoPlaceOrder,
      fastMode: true,
      dropWindowActive: false,
      shouldCancel,
      phase,
      tryFillCvv,
    });
  }

  if (await tryCheckoutFromAddDrawer(page, { bursts: 10, shouldCancel })) {
    if (await verifyCheckoutHasProduct(page, product, { fastMode: true })) {
      log.ok("Add-to-cart drawer → checkout (skipped cart page).");
      if (await isLoggedOut(page)) throw new Error("Session expired at checkout. Run login first.");
      return attemptPlaceOrder(page, config, {
        dryRun,
        autoPlaceOrder,
        fastMode: true,
        dropWindowActive: false,
        shouldCancel,
        phase,
        tryFillCvv,
      });
    }
  }

  if (!(await verifyItemInCart(page, product, { fastMode: true, hypeMode: isTestRun }))) {
    await screenshot(page, "add-to-cart-failed");
    throw new Error("Could not add to cart — item not verified in active cart.");
  }
  log.ok("In cart — rushing checkout NOW");

  phase("checking_out", "Rushing checkout");
  const block = await detectCheckoutBlocker(page);
  if (block.blocked) throw new Error(block.message);

  if (!(await rushToCheckout(page, product, { fastMode: true, hypeMode: isTestRun, shouldCancel, fromVerifiedCart: true, config }))) {
    throw new Error("Could not reach checkout — item may have sold out while in cart.");
  }

  await advanceCheckoutToReview(page, { fastMode: true, hypeMode: isTestRun, config });
  let onCheckout = await verifyCheckoutHasProduct(page, product, { fastMode: true, maxWaitMs: 10000 });
  if (!onCheckout) {
    log.warn("Checkout not confirmed — retrying cart → checkout click…");
    onCheckout = await retryCheckoutFromCart(page, product, { fastMode: true, hypeMode: isTestRun, shouldCancel, config });
  }
  if (!onCheckout) {
    await screenshot(page, "checkout-verify-failed");
    const block = await detectCheckoutBlocker(page);
    if (block.blocked) throw new Error(block.message);
    throw new Error("Checkout reached but product is not in the order.");
  }
  log.ok("Checkout page confirmed.");

  if (await isLoggedOut(page)) {
    throw new Error("Session expired at checkout. Run `node src/index.js login` again.");
  }

  return attemptPlaceOrder(page, config, {
    dryRun,
    autoPlaceOrder,
    fastMode: true,
    dropWindowActive: false,
    shouldCancel,
    phase,
    tryFillCvv,
  });
}
