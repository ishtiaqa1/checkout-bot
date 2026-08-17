import { log } from "./logger.js";
import { markBotNavigation } from "./checkout.js";
import { humanPageWarmup } from "./browserUtils.js";
import { parseWalmartItemId, sleep } from "./shared.js";

export function walmartItemId(product) {
  if (product.itemId) return String(product.itemId);
  return parseWalmartItemId(product.url || "");
}

export function walmartProductUrl(product) {
  const id = walmartItemId(product);
  if (product.url && /walmart\.com/i.test(product.url)) return product.url;
  if (!id) return null;
  return `https://www.walmart.com/ip/${id}`;
}

export function isOnWalmartPage(page, product) {
  try {
    const url = page.url();
    const id = walmartItemId(product);
    return /walmart\.com/i.test(url) && id && url.includes(id) && !url.startsWith("about:");
  } catch {
    return false;
  }
}

export async function ensureWalmartPage(page, product, { fast = false } = {}) {
  const url = walmartProductUrl(product);
  if (!url) throw new Error("Walmart product needs itemId or a walmart.com URL.");
  if (isOnWalmartPage(page, product)) {
    if (await needsWalmartHold(page)) await clearWalmartPxChallenge(page, { urgent: true });
    return;
  }
  markBotNavigation(page);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: fast ? 25000 : 45000,
  });
  await page.waitForTimeout(fast ? 150 : 500);
  if (await needsWalmartHold(page)) await clearWalmartPxChallenge(page, { urgent: fast });
}

function addToCartButtons(page) {
  return [
    () => page.locator('[data-automation-id="add-to-cart"]'),
    () => page.locator("#WMItemAddToCartBtn"),
    () => page.locator('[data-tl-id="ProductPrimaryCTA-cta_add_to_cart_button"]'),
    () => page.locator('button[data-dca-id="AddToCart"]'),
    () => page.getByRole("button", { name: /^add to cart$/i }),
  ];
}

function buyNowButtons(page) {
  return [
    () => page.locator('[data-automation-id="buy-now"]'),
    () => page.locator('button[data-dca-id="BuyNow"]'),
    () => page.getByRole("button", { name: /^buy now$/i }),
  ];
}

function checkoutButtons(page) {
  return [
    () => page.locator('[data-automation-id="checkout"]'),
    () => page.locator('[data-automation-id="checkout-button"]'),
    () => page.getByRole("button", { name: /^check\s?out$/i }),
    () => page.getByRole("link", { name: /^check\s?out$/i }),
    () => page.locator('a[href*="/checkout"]'),
  ];
}

function placeOrderButtons(page) {
  return [
    () => page.locator('[data-automation-id="place-order"]'),
    () => page.getByRole("button", { name: /place order/i }),
    () => page.locator('button:has-text("Place order")'),
  ];
}

async function isBuyEnabled(el) {
  if (!(await el.isVisible().catch(() => false))) return false;
  if (await el.isDisabled().catch(() => false)) return false;
  const aria = await el.getAttribute("aria-disabled").catch(() => null);
  return aria !== "true";
}

async function spamClick(page, candidates, { bursts = 8, shouldCancel } = {}) {
  for (let b = 0; b < bursts; b++) {
    if (shouldCancel?.()) throw new Error("Cancelled by user.");
    for (const locate of candidates) {
      try {
        const el = locate().first();
        if (await isBuyEnabled(el)) await el.click({ timeout: 500, force: true });
      } catch {
        /* next */
      }
    }
    await page.waitForTimeout(40);
  }
}

async function clickFirst(page, candidates, { timeout = 8000, shouldCancel, fast = true } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (shouldCancel?.()) throw new Error("Cancelled by user.");
    for (const locate of candidates) {
      const el = locate().first();
      if (await isBuyEnabled(el)) {
        try {
          await el.click({ timeout: fast ? 1200 : 4000, force: fast });
          return true;
        } catch {
          /* try next */
        }
      }
    }
    await page.waitForTimeout(fast ? 40 : 200);
  }
  return false;
}

/**
 * Read Walmart's embedded Next.js payload — the same data source serious
 * Walmart monitors use. It carries availabilityStatus + seller info and is far
 * more stable than DOM selectors.
 */
export async function readWalmartNextData(page) {
  return page
    .evaluate(() => {
      try {
        const el = document.getElementById("__NEXT_DATA__");
        if (!el?.textContent) return null;
        const blob = JSON.parse(el.textContent);
        const product = blob?.props?.pageProps?.initialData?.data?.product;
        if (!product) return null;
        return {
          availabilityStatus: product.availabilityStatus || null,
          name: product.name || null,
          usItemId: product.usItemId || null,
          sellerName: product.sellerName || product.sellerDisplayName || null,
          sellerType: product.sellerType || null,
          price: product.priceInfo?.currentPrice?.price ?? null,
          maxQty: product.orderLimit ?? product.orderMinLimit ?? null,
        };
      } catch {
        return null;
      }
    })
    .catch(() => null);
}

/** PerimeterX / queue "hold your spot" — any press-and-hold challenge on page. */
export async function isWalmartBlocked(page) {
  return page
    .evaluate(() => {
      const t = (document.body?.innerText || "").slice(0, 3000);
      const html = document.documentElement?.innerHTML?.slice(0, 10000) || "";
      return (
        /robot or human|verify your identity|are you a human|press\s*&?\s*hold|press and hold|tap and hold/i.test(t) ||
        /px-captcha|captcha\.px-cdn\.net|_pxCaptcha/i.test(html) ||
        !!document.querySelector("#px-captcha, [id*='px-captcha'], [class*='px-captcha']")
      );
    })
    .catch(() => false);
}

/** In-queue "hold your spot" / anti-bot tap-and-hold while waiting in line. */
export async function isWalmartQueueSpotHold(page) {
  return page
    .evaluate(() => {
      const t = (document.body?.innerText || "").slice(0, 4000);
      return (
        /hold your spot|hold my spot|keep your (spot|place)|press.*hold.*(spot|place|continue)|tap.*hold.*(spot|continue)|confirm you.?re still here/i.test(
          t
        ) ||
        !!document.querySelector(
          '[data-automation-id*="hold"], [class*="hold-spot"], [class*="queue-hold"], button[aria-label*="hold" i]'
        )
      );
    })
    .catch(() => false);
}

export async function needsWalmartHold(page) {
  return (await isWalmartBlocked(page)) || (await isWalmartQueueSpotHold(page));
}

/**
 * Locate Press & Hold control — PX iframe or in-queue "hold your spot" button.
 */
async function findWalmartHoldLocator(page) {
  const iframeSels = [
    "#px-captcha iframe",
    'iframe[src*="px-captcha"]',
    'iframe[src*="px-cdn"]',
    'iframe[title*="human" i]',
    'iframe[id*="px" i]',
  ];
  const btnSels = [
    "#px-captcha",
    "button",
    '[role="button"]',
    'div[tabindex="0"]',
    "text=/press\\s*&?\\s*hold/i",
    "text=/tap\\s+and\\s+hold/i",
    "text=/hold your spot/i",
    "text=/hold my spot/i",
    "text=/keep your (spot|place)/i",
    "text=/confirm you are a human/i",
    "text=/confirm you.?re still here/i",
  ];

  for (const iframeSel of iframeSels) {
    try {
      const frame = page.frameLocator(iframeSel).first();
      for (const btnSel of btnSels) {
        const loc = frame.locator(btnSel).first();
        if (await loc.isVisible({ timeout: 600 }).catch(() => false)) {
          const box = await loc.boundingBox().catch(() => null);
          if (box && box.width > 20 && box.height > 10) return loc;
        }
      }
    } catch {
      /* next */
    }
  }

  for (const frame of page.frames()) {
    try {
      const url = frame.url() || "";
      if (!/px-captcha|px-cdn|captcha/i.test(url) && frame.parentFrame() !== null) continue;
      for (const btnSel of btnSels) {
        const loc = frame.locator(btnSel).first();
        if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
          const box = await loc.boundingBox().catch(() => null);
          if (box && box.width > 20 && box.height > 10) return loc;
        }
      }
    } catch {
      /* next frame */
    }
  }

  for (const sel of [
    "#px-captcha",
    "[id*='px-captcha']",
    "button:has-text('Press')",
    "button:has-text('hold')",
    "button:has-text('spot')",
    '[aria-label*="hold" i]',
  ]) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        const box = await loc.boundingBox().catch(() => null);
        if (box && box.width > 20 && box.height > 10) return loc;
      }
    } catch {
      /* next */
    }
  }
  return null;
}

/** Low-level mouse hold at viewport coordinates (with micro-jitter while held). */
async function mouseHoldAt(page, x, y, holdMs, { urgent = false } = {}) {
  await page.bringToFront().catch(() => {});
  await page.mouse.move(x, y, { steps: urgent ? 4 : 10 });
  await page.mouse.down();
  const stepMs = urgent ? 200 : 300;
  const steps = Math.max(3, Math.ceil(holdMs / stepMs));
  for (let i = 0; i < steps; i++) {
    await sleep(stepMs);
    await page.mouse
      .move(x + (Math.random() * 5 - 2.5), y + (Math.random() * 5 - 2.5), { steps: 1 })
      .catch(() => {});
  }
  await page.mouse.up();
}

/** CDP mouse hold — sometimes succeeds when Playwright mouse API does not reach PX iframe. */
async function cdpHoldAt(page, x, y, holdMs) {
  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch {
    return false;
  }
  try {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    const steps = Math.max(4, Math.ceil(holdMs / 350));
    for (let i = 0; i < steps; i++) {
      await sleep(350);
      const jx = x + (Math.random() * 4 - 2);
      const jy = y + (Math.random() * 4 - 2);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: jx,
        y: jy,
        button: "left",
      });
    }
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt Press & Hold / Tap and Hold (PX captcha or queue spot).
 * urgent=true: minimal delays for drop-time speed.
 */
export async function tryPressAndHoldCaptcha(page, { holdMs = 5500, urgent = false } = {}) {
  if (!(await needsWalmartHold(page))) return true;

  await page.bringToFront().catch(() => {});
  if (!urgent) await page.waitForTimeout(300);

  const loc = await findWalmartHoldLocator(page);
  if (!loc) return false;

  const box = await loc.boundingBox().catch(() => null);
  if (!box) return false;

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const settle = urgent ? 300 : 1200;

  // Strategy 1: CDP first during drops (fastest path in live tests)
  if (urgent && (await cdpHoldAt(page, x, y, holdMs))) {
    await sleep(settle);
    if (!(await needsWalmartHold(page))) return true;
  }

  // Strategy 2: Playwright click with delay = hold duration
  try {
    await loc.click({ delay: holdMs, force: true, timeout: holdMs + 6000, noWaitAfter: true });
    await sleep(settle);
    if (!(await needsWalmartHold(page))) return true;
  } catch {
    /* try next */
  }

  // Strategy 3: CDP mouse (non-urgent fallback)
  if (!urgent && (await cdpHoldAt(page, x, y, holdMs))) {
    await sleep(settle);
    if (!(await needsWalmartHold(page))) return true;
  }

  // Strategy 4: page.mouse down/up with jitter
  await mouseHoldAt(page, x, y, holdMs, { urgent });
  await sleep(settle);
  return !(await needsWalmartHold(page));
}

/**
 * Clear any Walmart hold challenge ASAP (PX or queue spot).
 * urgent=true uses shorter gaps and starts at 4s hold (live tests cleared at 4–7.5s).
 */
export async function clearWalmartPxChallenge(page, { onLog, maxAttempts = 5, urgent = false } = {}) {
  if (!(await needsWalmartHold(page))) return true;

  const holdTimes = urgent ? [4000, 5000, 6000, 7000, 7500] : [4000, 5500, 6500, 7500, 8500];
  const attempts = urgent ? Math.min(maxAttempts, 4) : maxAttempts;
  const gap = urgent ? 100 : 800;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const holdMs = holdTimes[Math.min(attempt, holdTimes.length - 1)];
    const kind = (await isWalmartQueueSpotHold(page)) ? "queue spot" : "PX";
    onLog?.("warn", `${kind} Press & Hold — attempt ${attempt + 1}/${attempts} (${(holdMs / 1000).toFixed(1)}s)…`);
    const ok = await tryPressAndHoldCaptcha(page, { holdMs, urgent });
    if (ok) {
      onLog?.("ok", `${kind} hold cleared.`);
      return true;
    }
    await page.waitForTimeout(gap);
  }
  return !(await needsWalmartHold(page));
}

/** During queue wait: instantly complete any spot-hold or PX without blocking long. */
export async function maintainWalmartQueueSpot(page, { onLog, urgent = true } = {}) {
  if (!(await needsWalmartHold(page))) return true;
  onLog?.("warn", "Queue spot / PX hold — clearing now…");
  return clearWalmartPxChallenge(page, { onLog, maxAttempts: 3, urgent });
}

/** Walmart high-demand drop queue / waiting room state. */
export async function detectWalmartQueueState(page) {
  return page
    .evaluate(() => {
      const t = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 6000);
      const html = document.documentElement?.innerHTML?.slice(0, 12000) || "";
      // Tight signals only — do not treat plain "high demand" / OOS as queue
      const strong =
        /waiting in line|you.?re in line|in the queue|queue position|virtual queue|waiting room|estimated wait|we.?ll let you in|hold your spot|ticket number|place in line|entering the queue|you.?re almost there|spots? ahead|holding your spot/i.test(
          t
        );
      const placeholderTimer = /\b([0-2]?\d:[0-5]\d)\b/.test(t) && /wait|queue|line|minute/i.test(t) && /queue|line|waiting room/i.test(t);
      const ticket =
        t.match(/ticket\s*(?:number|#)?\s*:?\s*#?(\d{2,})/i)?.[1] ||
        t.match(/position\s*(?:in line)?\s*:?\s*#?(\d{1,6})/i)?.[1] ||
        null;
      const waitMins = t.match(/(\d{1,3})\s*(?:min(?:ute)?s?)\s*(?:wait|left|remaining)?/i)?.[1] || null;
      const unlikely = /unlikely|may not get|sold out before/i.test(t);
      const markup = /queue-it|virtual.?queue|waitingroom|waiting-room/i.test(html);
      const queueActive = !!(strong || ticket || (placeholderTimer && (strong || markup)) || markup);
      return {
        inQueue: queueActive,
        ticket,
        waitMins,
        unlikely,
        placeholderTimer,
        snippet: t.slice(0, 180),
      };
    })
    .catch(() => ({ inQueue: false, ticket: null, waitMins: null, unlikely: false, placeholderTimer: false, snippet: "" }));
}

/** True when page shows waiting room / queue UI but ATC is not available yet. */
export async function isWalmartQueueGated(page) {
  const q = await detectWalmartQueueState(page);
  if (q.inQueue) return true;
  return page
    .evaluate(() => {
      const t = (document.body?.innerText || "").slice(0, 4000);
      return /you.?re in line|virtual (waiting )?room|estimated wait|spots? ahead|holding your spot/i.test(t);
    })
    .catch(() => false);
}

function formatQueueResult(queue, extra = {}) {
  return {
    inStock: false,
    status: "IN_QUEUE",
    inQueue: true,
    queueTicket: queue.ticket,
    queueWaitMins: queue.waitMins,
    queueUnlikely: queue.unlikely,
    button: "In queue",
    ...extra,
  };
}

/**
 * One-shot drop activation reload. Does NOT wait for queue UI (use watchForWalmartQueue).
 * Returns { reloaded, alreadyQueued, buyable, queue }.
 */
export async function activateWalmartQueueReload(page, product, { onLog, urgent = true, latency = null } = {}) {
  markBotNavigation(page);
  const url = walmartProductUrl(product);

  if (!isOnWalmartPage(page, product)) {
    onLog?.("info", "Opening product page for queue activation…");
    await page.goto(url, { waitUntil: "commit", timeout: urgent ? 20000 : 25000 }).catch(() => {});
  }

  if (await needsWalmartHold(page)) {
    onLog?.("warn", "PX/spot hold — clearing before activation reload…");
    await clearWalmartPxChallenge(page, { onLog, urgent: true, maxAttempts: 3 });
  }

  let queue = await detectWalmartQueueState(page);
  if (queue.inQueue) {
    onLog?.("hit", `IN QUEUE${queue.ticket ? ` — ticket ${queue.ticket}` : ""} (already on page)`);
    latency?.mark("queue_recognized");
    return { reloaded: false, alreadyQueued: true, buyable: null, queue: formatQueueResult(queue) };
  }

  onLog?.("info", "Drop live — single reload to enter queue…");
  latency?.mark("activation_reload");
  await page.reload({ waitUntil: "commit", timeout: urgent ? 15000 : 20000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: urgent ? 4000 : 8000 }).catch(() => {});

  if (await needsWalmartHold(page)) {
    await clearWalmartPxChallenge(page, { onLog, urgent: true, maxAttempts: 3 });
  }

  queue = await detectWalmartQueueState(page);
  if (queue.inQueue) {
    onLog?.("hit", `IN QUEUE${queue.ticket ? ` — ticket ${queue.ticket}` : ""}`);
    latency?.mark("queue_recognized");
    return { reloaded: true, alreadyQueued: true, buyable: null, queue: formatQueueResult(queue) };
  }

  // Queue-only: never treat "buyable without queue UI" as a hit — engine checkouts only post-queue.
  return {
    reloaded: true,
    alreadyQueued: false,
    buyable: null,
    queue: null,
    pending: true,
    status: "PENDING_QUEUE",
  };
}

/**
 * Event-driven / short-poll wait for queue UI or ATC after activation.
 * Does NOT reload. Returns queue result, buyable hit, or timeout status.
 */
export async function watchForWalmartQueue(page, product, { onLog, urgent = true, timeoutMs, latency = null } = {}) {
  const pollMs = urgent ? 150 : 600;
  const deadline = Date.now() + (timeoutMs ?? (urgent ? 45000 : 30000));

  // Prefer MutationObserver wake if installed
  const waitObserver = async () => {
    try {
      const hit = await page.evaluate(() => {
        if (window.__botQueueLive) return window.__botQueueLive;
        return null;
      });
      return hit;
    } catch {
      return null;
    }
  };

  while (Date.now() < deadline) {
    if (await needsWalmartHold(page)) {
      await clearWalmartPxChallenge(page, { onLog, urgent: true, maxAttempts: 2 });
    }

    const live = await waitObserver();
    if (live?.inQueue) {
      latency?.mark("queue_recognized");
      onLog?.("hit", `IN QUEUE${live.ticket ? ` — ticket ${live.ticket}` : ""} [watcher]`);
      return formatQueueResult(live);
    }

    const queue = await detectWalmartQueueState(page);
    if (queue.inQueue) {
      latency?.mark("queue_recognized");
      onLog?.("hit", `IN QUEUE${queue.ticket ? ` — ticket ${queue.ticket}` : ""}`);
      return formatQueueResult(queue);
    }

    if (await isWalmartQueueGated(page)) {
      latency?.mark("queue_recognized");
      onLog?.("info", "Queue/waiting room active — holding page");
      return formatQueueResult(queue, { detail: "Waiting room — no ATC until queue clears" });
    }

    const buyable = await detectWalmartBuyable(page);
    if (buyable.inStock) {
      // Queue drops: looking buyable without queue UI is a false signal — keep waiting for the line.
      onLog?.("info", "Buyable without queue UI — still waiting for line (not ATC)");
    }

    await page.waitForTimeout(pollMs);
  }

  const queue = await detectWalmartQueueState(page);
  if (queue.inQueue) {
    latency?.mark("queue_recognized");
    return formatQueueResult(queue);
  }
  return { inStock: false, inQueue: false, status: "PENDING_QUEUE", pending: true };
}

/**
 * Install in-page MutationObserver for queue UI on a Walmart PDP window.
 * Exposes window.__botQueueLive and calls binding `__botQueueLive` when queue appears.
 */
export async function installWalmartQueueWatcher(page, { bindingName = "__botQueueNotify" } = {}) {
  if (!page || page.isClosed?.() || page.__queueWatcherInstalled) return false;
  page.__queueWatcherInstalled = true;

  await page.addInitScript(() => {
    const scan = () => {
      try {
        const t = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 6000);
        const html = document.documentElement?.innerHTML?.slice(0, 8000) || "";
        const strong =
          /waiting in line|you.?re in line|in the queue|queue position|virtual queue|waiting room|estimated wait|we.?ll let you in|hold your spot|ticket number|place in line|entering the queue|spots? ahead|holding your spot/i.test(
            t
          );
        const ticket =
          t.match(/ticket\s*(?:number|#)?\s*:?\s*#?(\d{2,})/i)?.[1] ||
          t.match(/position\s*(?:in line)?\s*:?\s*#?(\d{1,6})/i)?.[1] ||
          null;
        const markup = /queue-it|virtual.?queue|waitingroom|waiting-room/i.test(html);
        if (strong || ticket || markup) {
          window.__botQueueLive = { inQueue: true, ticket, at: Date.now() };
          return window.__botQueueLive;
        }
      } catch {
        /* ignore */
      }
      return null;
    };
    window.__botQueueScan = scan;
  }).catch(() => {});

  try {
    await page.exposeFunction(bindingName, () => {}).catch(() => {});
  } catch {
    /* already exposed */
  }

  await page
    .evaluate((bind) => {
      if (window.__botQueueObserver) return;
      const notify = () => {
        const hit = window.__botQueueScan?.();
        if (hit && typeof window[bind] === "function") {
          try {
            window[bind](hit);
          } catch {
            /* ignore */
          }
        }
      };
      window.__botQueueObserver = new MutationObserver(() => notify());
      const root = document.body || document.documentElement;
      if (root) window.__botQueueObserver.observe(root, { childList: true, subtree: true, characterData: true });
      notify();
    }, bindingName)
    .catch(() => {});

  return true;
}

/**
 * Optional network tap — queue/waiting-room responses often precede paint.
 */
export function installWalmartQueueNetworkTap(page, onHint) {
  if (!page || page.__queueNetworkTap) return;
  page.__queueNetworkTap = true;
  page.on("response", (res) => {
    try {
      const url = res.url() || "";
      // Real queue endpoints only — not orchestra GraphQL / ccm noise
      if (!/issueTicket|qpdata=|\/qp\?|q-api\.www\.walmart\.com|queue-it|waiting.?room/i.test(url)) return;
      if (/orchestra\/(home|cartxo)\/graphql|ccm\/v3\/bootstrap/i.test(url)) return;
      onHint?.({ url: url.slice(0, 160), status: res.status() });
    } catch {
      /* ignore */
    }
  });
}

/**
 * Walmart queue drops: you enter the virtual line by being on the PDP when it goes live.
 * There is NO Add to Cart until the queue clears — do NOT spam ATC or reload in queue.
 *
 * Flow: position on PDP → (one reload at drop) → wait for queue UI → hold spot → checkout after.
 * Pass `{ waitForQueue: false }` from burst path so activation returns immediately.
 */
export async function attemptJoinWalmartQueue(
  page,
  product,
  { onLog, urgent = true, dropReload = false, waitForQueue = true, timeoutMs, latency = null } = {}
) {
  if (dropReload) {
    const act = await activateWalmartQueueReload(page, product, { onLog, urgent, latency });
    if (act.alreadyQueued && act.queue) return act.queue;
    if (act.buyable?.inStock) return { ...act.buyable, inQueue: false };
    if (!waitForQueue) {
      return { inStock: false, inQueue: false, status: "PENDING_QUEUE", pending: true, activated: true };
    }
    return watchForWalmartQueue(page, product, { onLog, urgent, timeoutMs, latency });
  }

  markBotNavigation(page);
  const url = walmartProductUrl(product);

  if (!isOnWalmartPage(page, product)) {
    onLog?.("info", "Opening product page — queue starts when drop goes live on this page");
    await page.goto(url, { waitUntil: "commit", timeout: urgent ? 20000 : 25000 }).catch(() => {});
    await page.waitForTimeout(urgent ? 100 : 300);
  }

  if (await needsWalmartHold(page)) {
    onLog?.("warn", "PX/spot hold — clearing before queue…");
    await clearWalmartPxChallenge(page, { onLog, urgent: true, maxAttempts: 4 });
  }

  let queue = await detectWalmartQueueState(page);
  if (queue.inQueue) {
    onLog?.("hit", `IN QUEUE${queue.ticket ? ` — ticket ${queue.ticket}` : ""} (already on page)`);
    latency?.mark("queue_recognized");
    return formatQueueResult(queue);
  }

  if (!waitForQueue) {
    const buyable = await detectWalmartBuyable(page);
    // Ignore false buyable — queue-only until cutoff / join.
    if (buyable.inStock) {
      return { inStock: false, inQueue: false, status: "PENDING_QUEUE", pending: true };
    }
    return { inStock: false, inQueue: false, status: "PENDING_QUEUE", pending: true };
  }

  return watchForWalmartQueue(page, product, { onLog, urgent, timeoutMs, latency });
}

/** Optional pre-drop homepage visit — queue drops should stay on PDP instead. */
export async function warmWalmartSession(page) {
  markBotNavigation(page);
  await page.goto("https://www.walmart.com", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(400);
  if (await needsWalmartHold(page)) await clearWalmartPxChallenge(page, { urgent: true });
}

/** Pre-position tab on PDP before drop — sit on page, no reload spam. */
export async function positionWalmartQueueTab(page, product, { onLog } = {}) {
  const url = walmartProductUrl(product);
  if (!isOnWalmartPage(page, product)) {
    onLog?.("info", "Pre-positioning on product page for queue drop…");
    markBotNavigation(page);
    await page.goto(url, { waitUntil: "commit", timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  if (await needsWalmartHold(page)) await clearWalmartPxChallenge(page, { urgent: true, onLog });
}

/** Poll queue on an open tab WITHOUT reloading (reload kicks you out of line). */
export async function pollWalmartQueueProgress(page, product, { onLog, urgent = true } = {}) {
  await maintainWalmartQueueSpot(page, { onLog, urgent });

  const queue = await detectWalmartQueueState(page);
  if (queue.inQueue) {
    return {
      inStock: false,
      status: "IN_QUEUE",
      inQueue: true,
      queueTicket: queue.ticket,
      queueWaitMins: queue.waitMins,
      queueUnlikely: queue.unlikely,
      detail: queue.ticket ? `Queue ticket ${queue.ticket}` : "Waiting in Walmart queue",
    };
  }
  const buyable = await detectWalmartBuyable(page);
  if (buyable.inStock) {
    onLog?.("hit", `Queue cleared — IN STOCK (${buyable.button || "buyable"})`);
    return { ...buyable, inQueue: false };
  }
  return { inStock: false, status: "OUT_OF_STOCK", inQueue: false };
}

/**
 * PhoenixBot / BuyBot pattern: open the page, notify the user, and poll until
 * the captcha is gone — then resume monitoring automatically.
 */
export async function waitForWalmartCaptchaCleared(page, { timeoutMs = 600000, onWait, config } = {}) {
  if (!(await needsWalmartHold(page))) return true;
  await page.bringToFront().catch(() => {});

  // Provider-neutral path (walmartHold → manual). Avoids hardcoding a CAPTCHA vendor.
  try {
    const { handleChallenge } = await import("./challenges/registry.js");
    const result = await handleChallenge({
      kind: "hold",
      retailer: "walmart",
      page,
      config,
      onLog: (_level, msg) => onWait?.(msg),
    });
    if (result?.status === "solved") return true;
  } catch {
    /* fall through to direct clear */
  }

  const cleared = await clearWalmartPxChallenge(page, {
    onLog: (_level, msg) => onWait?.(msg),
    maxAttempts: 4,
    urgent: true,
  });
  if (cleared) return true;

  onWait?.("Auto hold failed — press and HOLD in bot Chrome until cleared.");
  const deadline = Date.now() + timeoutMs;
  let lastAutoTry = 0;
  while (Date.now() < deadline) {
    if (!(await needsWalmartHold(page))) return true;
    if (Date.now() - lastAutoTry > 8000) {
      lastAutoTry = Date.now();
      let retryOk = false;
      try {
        const { handleChallenge } = await import("./challenges/registry.js");
        const retryCh = await handleChallenge({
          kind: "hold",
          retailer: "walmart",
          page,
          config,
          onLog: (_level, msg) => onWait?.(msg),
        });
        retryOk = retryCh?.status === "solved";
      } catch {
        /* fall through */
      }
      if (!retryOk) {
        retryOk = await clearWalmartPxChallenge(page, { maxAttempts: 2, urgent: true });
      }
      if (retryOk) return true;
    }
    await sleep(800);
  }
  return false;
}

/** PhoenixBot price guard — skip if live price exceeds product.maxPrice. */
export function passesPriceGuard(product, price) {
  const max = Number(product.maxPrice);
  if (!Number.isFinite(max) || max <= 0) return { ok: true };
  if (!Number.isFinite(price)) return { ok: true };
  if (price > max) return { ok: false, reason: `Price $${price} exceeds max $${max}` };
  return { ok: true };
}

/**
 * BuyBot pattern: tight reload loop until the buy button appears.
 * Used during drop windows for faster restock detection.
 */
export async function reloadUntilWalmartBuyable(page, product, { deadlineMs = 90000, reloadMs = 1500 } = {}) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await isWalmartBlocked(page)) {
      const cleared = await waitForWalmartCaptchaCleared(page, { timeoutMs: 300000 });
      if (!cleared) break;
    }
    const buyable = await detectWalmartBuyable(page);
    if (buyable.inStock) return buyable;
    markBotNavigation(page);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(reloadMs);
  }
  return detectWalmartBuyable(page);
}

/** BuyBot recommends an empty cart before checkout — clear Walmart cart items. */
export async function clearWalmartCart(page, { fast = true } = {}) {
  markBotNavigation(page);
  await page.goto("https://www.walmart.com/cart", {
    waitUntil: "domcontentloaded",
    timeout: fast ? 12000 : 20000,
  }).catch(() => {});
  await page.waitForTimeout(fast ? 300 : 800);
  const empty = await page.getByText(/your cart is empty|cart is empty/i).first().isVisible().catch(() => false);
  if (empty) return true;
  const removeBtns = page.locator(
    '[data-automation-id="remove"], button[aria-label*="Remove" i], button:has-text("Remove")'
  );
  for (let i = 0; i < 20; i++) {
    if (!(await removeBtns.first().isVisible().catch(() => false))) break;
    await removeBtns.first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(fast ? 400 : 800);
  }
  return true;
}

/** Detect buyable state on an open Walmart PDP (NEXT_DATA first, DOM fallback). */
export async function detectWalmartBuyable(page) {
  const data = await readWalmartNextData(page);
  const thirdParty = !!(
    data &&
    (data.sellerType ? data.sellerType !== "INTERNAL" : data.sellerName && !/^walmart(\.com)?$/i.test(data.sellerName))
  );

  if (data?.availabilityStatus) {
    const status = String(data.availabilityStatus).toUpperCase();
    if (status === "IN_STOCK" || status === "LIMITED_STOCK") {
      // Confirm a clickable button when possible so we don't fire on stale data.
      for (const locate of addToCartButtons(page)) {
        const el = locate().first();
        if (await isBuyEnabled(el)) {
          const label = (await el.innerText().catch(() => "")).trim() || "Add to cart";
          return { inStock: true, status, button: label, thirdParty, price: data.price };
        }
      }
      // NEXT_DATA says buyable but the button hasn't hydrated yet — still a hit.
      return { inStock: true, status, button: "Add to cart", thirdParty, price: data.price };
    }
    return { inStock: false, status, button: null, thirdParty, price: data.price };
  }

  if (await isWalmartBlocked(page)) {
    return { inStock: false, status: "BLOCKED", button: null, thirdParty: false };
  }

  const soldOut = await page
    .getByText(/out of stock|sold out|not available|get in-stock alert/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (soldOut) return { inStock: false, status: "OUT_OF_STOCK", button: null, thirdParty };

  for (const locate of addToCartButtons(page)) {
    const el = locate().first();
    if (await isBuyEnabled(el)) {
      const label = (await el.innerText().catch(() => "")).trim() || "Add to cart";
      return { inStock: true, status: "IN_STOCK", button: label, thirdParty };
    }
  }
  return { inStock: false, status: "UNKNOWN", button: null, thirdParty };
}

/** Fast DOM read — no reload. */
export async function checkWalmartStockLight(page, product) {
  if (!isOnWalmartPage(page, product)) {
    return { inStock: false, status: "OFF_PAGE", available: 0, button: null, light: true, needsReload: true };
  }
  const queue = await detectWalmartQueueState(page);
  if (queue.inQueue) {
    return {
      inStock: false,
      status: "IN_QUEUE",
      inQueue: true,
      queueTicket: queue.ticket,
      queueWaitMins: queue.waitMins,
      available: 0,
      button: "In queue",
      light: true,
      source: "dom",
    };
  }
  const buyable = await detectWalmartBuyable(page);
  return {
    inStock: buyable.inStock,
    status: buyable.status,
    available: buyable.inStock ? 1 : 0,
    button: buyable.button,
    thirdParty: !!buyable.thirdParty,
    light: true,
    source: "dom",
    domConfirmed: buyable.inStock,
  };
}

/** Full stock check with optional reload. */
export async function checkWalmartStock(page, product, { fast = false, skipReload = false, mode = "full", aggressive = false } = {}) {
  if (mode === "light") return checkWalmartStockLight(page, product);

  if (!skipReload) {
    markBotNavigation(page);
    if (isOnWalmartPage(page, product)) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: fast ? 20000 : 30000 }).catch(() => {});
    } else {
      await ensureWalmartPage(page, product, { fast });
    }
    await page.waitForTimeout(fast ? 300 : 800);
  }

  if (await needsWalmartHold(page)) {
    const cleared = await clearWalmartPxChallenge(page, { urgent: true, maxAttempts: 4 });
    if (!cleared && (await needsWalmartHold(page))) {
      return { inStock: false, status: "BLOCKED", available: 0, button: null, thirdParty: false };
    }
  }

  const queue = await detectWalmartQueueState(page);
  if (queue.inQueue) {
    return {
      inStock: false,
      status: "IN_QUEUE",
      inQueue: true,
      queueTicket: queue.ticket,
      queueWaitMins: queue.waitMins,
      queueUnlikely: queue.unlikely,
      available: 0,
      button: "In queue",
      thirdParty: false,
    };
  }

  let buyable;
  if (aggressive && fast) {
    buyable = await reloadUntilWalmartBuyable(page, product, { deadlineMs: 60000, reloadMs: fast ? 1200 : 2000 });
  } else {
    await humanPageWarmup(page, { fast });
    await page
      .locator('[data-automation-id="add-to-cart"], #WMItemAddToCartBtn, button:has-text("Add to cart")')
      .first()
      .waitFor({ state: "visible", timeout: fast ? 8000 : 15000 })
      .catch(() => {});
    buyable = await detectWalmartBuyable(page);
  }

  const priceGuard = passesPriceGuard(product, buyable.price);
  if (buyable.inStock && !priceGuard.ok) {
    return {
      inStock: false,
      status: "PRICE_TOO_HIGH",
      available: 0,
      button: buyable.button,
      price: buyable.price,
      thirdParty: !!buyable.thirdParty,
      detail: priceGuard.reason,
    };
  }

  return {
    inStock: buyable.inStock,
    status: buyable.status,
    available: buyable.inStock ? 1 : 0,
    button: buyable.button,
    price: buyable.price,
    thirdParty: !!buyable.thirdParty,
    domConfirmed: buyable.inStock,
  };
}

export async function isWalmartLoggedOut(page) {
  if (/\/account\/login|sign-in|identity\.walmart/i.test(page.url())) return true;
  const signIn = page.getByRole("button", { name: /^sign in$/i }).first();
  if (await signIn.isVisible().catch(() => false)) {
    const pwd = page.locator('input[type="password"]').first();
    if (await pwd.isVisible().catch(() => false)) return true;
  }
  return false;
}

/** Best-effort quantity bump on the cart page (Walmart caps per-order limits itself). */
async function maxOutCartQuantity(page, product, targetQty) {
  if (!targetQty || targetQty <= 1) return;
  const plus = page
    .locator('[data-automation-id="quantity-stepper-increase"], button[aria-label*="Increase quantity" i], button[aria-label*="increase" i]')
    .first();
  for (let i = 1; i < targetQty; i++) {
    if (!(await isBuyEnabled(plus))) break;
    await plus.click({ timeout: 800 }).catch(() => {});
    await page.waitForTimeout(250);
  }
}

async function verifyItemInCart(page, product, { fast = false } = {}) {
  markBotNavigation(page);
  await page.goto("https://www.walmart.com/cart", {
    waitUntil: "domcontentloaded",
    timeout: fast ? 12000 : 20000,
  }).catch(() => {});
  await page.waitForTimeout(fast ? 250 : 600);

  const empty = await page.getByText(/your cart is empty|cart is empty/i).first().isVisible().catch(() => false);
  if (empty) return false;

  const id = walmartItemId(product);
  if (!id) return false;
  const html = await page.content().catch(() => "");
  return html.includes(id);
}

async function aggressiveWalmartCheckout(page, product, config, {
  fastMode,
  dropWindowActive,
  shouldCancel,
  phase,
  dryRun,
  autoPlaceOrder,
  wantQty: wantQtyIn,
  latency = null,
}) {
  const retries = Math.max(1, Number(config.checkout?.checkoutRetries) || 12);
  const perf = config.checkout?.performanceMode !== false;
  const maxRounds = dropWindowActive ? retries + 8 : retries;
  const bursts = dropWindowActive ? (perf ? 16 : 12) : 8;
  const wantQty = Math.max(1, Number(wantQtyIn ?? product.maxQuantity) || 1);

  for (let round = 1; round <= maxRounds; round++) {
    if (shouldCancel?.()) throw new Error("Cancelled by user.");

    phase("adding_to_cart", `Walmart add (round ${round}/${maxRounds})`);
    latency?.mark("atc_start");
    // Stay on current PDP if already there (post-queue) — avoid extra nav
    if (!isOnWalmartPage(page, product)) {
      await ensureWalmartPage(page, product, { fast: true });
    }

    // Express path: "Buy now" jumps straight to checkout review (fastest, single qty).
    if (round === 1 && wantQty === 1) {
      const bought = await clickFirst(page, buyNowButtons(page), { timeout: perf ? 900 : 1500, shouldCancel, fast: true });
      if (bought) {
        await page.waitForTimeout(perf ? 200 : 800);
        if (/\/checkout/i.test(page.url())) {
          latency?.mark("atc_ok");
          latency?.mark("checkout_nav");
          latency?.mark("checkout_ready");
          log.ok("Walmart Buy now — straight to checkout.");
        }
      }
    }

    if (!/\/checkout/i.test(page.url())) {
      await spamClick(page, addToCartButtons(page), { bursts, shouldCancel });
      await page.waitForTimeout(perf ? 80 : 200);

      if (!(await verifyItemInCart(page, product, { fast: true }))) {
        log.warn(`Walmart round ${round}: not in cart — retrying…`);
        continue;
      }
      latency?.mark("atc_ok");
      latency?.mark("cart_confirmed");

      log.ok(`Walmart round ${round}: verified in cart.`);
      phase("checking_out", "Walmart checkout");
      latency?.mark("checkout_nav");
      markBotNavigation(page);
      // Performance: skip cart page when qty=1 — go straight to /checkout
      if (wantQty <= 1 && perf) {
        await page.goto("https://www.walmart.com/checkout", { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
      } else {
        await page.goto("https://www.walmart.com/cart", { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
        await maxOutCartQuantity(page, product, wantQty);
        await spamClick(page, checkoutButtons(page), { bursts, shouldCancel });
      }
    }

    if (!/\/checkout/i.test(page.url())) {
      markBotNavigation(page);
      await page.goto("https://www.walmart.com/checkout", { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
    }

    if (!/\/checkout/i.test(page.url())) {
      log.warn(`Walmart round ${round}: couldn't reach checkout…`);
      continue;
    }
    latency?.mark("checkout_ready");

    if (await isWalmartBlocked(page)) {
      log.warn("Walmart captcha at checkout — solve it in the browser; bot resumes automatically (BuyBot-style).");
      await waitForWalmartCaptchaCleared(page, {
        timeoutMs: 900000,
        onWait: (msg) => log.warn(msg),
      });
    }

    if (await isWalmartLoggedOut(page)) {
      throw new Error("Not signed in to Walmart. Sign in via the bot Chrome, then restart.");
    }

    if (dryRun) {
      log.warn("DRY RUN: stopping before Walmart place order.");
      phase("dry_run", "Dry run — cart filled");
      return { placed: false, dryRun: true };
    }
    if (!autoPlaceOrder) {
      phase("needs_review", "Ready — click Place order in browser");
      return { placed: false, manual: true };
    }

    phase("placing_order", "Placing Walmart order");
    latency?.mark("place_order");
    await spamClick(page, placeOrderButtons(page), { bursts, shouldCancel });
    await page.waitForTimeout(perf ? 120 : 300);

    const confirmed = await page
      .getByText(/thank you|order placed|order number|confirmation/i)
      .first()
      .waitFor({ state: "visible", timeout: 12000 })
      .then(() => true)
      .catch(() => false);

    if (confirmed) {
      latency?.mark("order_confirmed");
      log.ok("Walmart order placed and confirmed.");
      return { placed: true, confirmed: true };
    }

    const clicked = await clickFirst(page, placeOrderButtons(page), { timeout: 5000, shouldCancel, fast: true });
    if (clicked) {
      latency?.mark("order_confirmed");
      return { placed: true, confirmed: false };
    }
  }

  throw new Error("Walmart checkout failed after all retries.");
}

/** Wait in queue: maintain spot holds, detect stock ASAP, then caller checks out. */
export async function waitThroughWalmartQueue(page, product, { shouldCancel, phase, onLog, maxWaitMs = 35 * 60 * 1000, urgent = true } = {}) {
  const deadline = Date.now() + maxWaitMs;
  const pollMs = urgent ? 1000 : 4000;
  while (Date.now() < deadline) {
    if (shouldCancel?.()) throw new Error("Cancelled by user.");

    await maintainWalmartQueueSpot(page, { onLog, urgent });

    const q = await pollWalmartQueueProgress(page, product, { onLog, urgent });
    if (!q.inQueue) {
      if (q.inStock) onLog?.("hit", "Your turn — product available, starting checkout…");
      return { cleared: true, inStock: !!q.inStock, status: q.status };
    }
    const ticket = q.queueTicket ? `ticket ${q.queueTicket}` : "in line";
    phase?.("in_queue", `Holding spot — ${ticket}`);
    onLog?.(`Queue: ${ticket}${q.queueWaitMins ? ` · ~${q.queueWaitMins} min` : ""}`);
    await sleep(pollMs);
  }
  return { cleared: false, inStock: false, status: "QUEUE_TIMEOUT" };
}

/** Run Walmart checkout for one product. */
export async function runWalmartCheckout(context, product, config, hooks = {}) {
  const phase = (name, detail) => hooks.onPhase?.(name, detail);
  const shouldCancel = hooks.shouldCancel;
  const ck = () => {
    if (shouldCancel?.()) throw new Error("Cancelled by user.");
  };
  const { dryRun, autoPlaceOrder, checkoutTimeoutMs } = config.checkout;
  const fastMode = hooks.fastMode ?? (config.checkout?.dropMode !== false && autoPlaceOrder && !dryRun);
  const dropWindowActive = !!hooks.dropWindowActive;
  const skipNavigation = !!hooks.skipNavigation;
  const page = hooks.page ?? context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(checkoutTimeoutMs);

  const id = walmartItemId(product);
  if (!id) throw new Error("Walmart product needs itemId or walmart.com URL.");

  log.title(`Walmart checkout: ${product.name || id}${fastMode ? " (drop mode)" : ""}`);
  ck();

  if (config.checkout?.clearCartBeforeCheckout !== false && fastMode && !skipNavigation) {
    await clearWalmartCart(page, { fast: true });
  }

  if (!skipNavigation) {
    phase("navigating", "Opening Walmart product page");
    await page.bringToFront().catch(() => {});
    await ensureWalmartPage(page, product, { fast: fastMode });
    await page.waitForTimeout(fastMode ? (config.checkout?.performanceMode !== false ? 150 : 600) : 1000);
  } else {
    phase("in_stock", "In stock — buying now");
    await page.bringToFront().catch(() => {});
    if (!isOnWalmartPage(page, product)) {
      await ensureWalmartPage(page, product, { fast: true });
    }
  }

  if (await isWalmartLoggedOut(page)) {
    throw new Error("Not signed in to Walmart. Sign in in the bot Chrome window.");
  }

  // Walmart drops: PX → join queue → hold spot → wait → checkout for requested qty.
  if (config.checkout?.walmartQueueMode !== false) {
    let queue = await detectWalmartQueueState(page);
    if (queue.inQueue) {
      phase("in_queue", "In queue — holding your spot");
      const waited = await waitThroughWalmartQueue(page, product, {
        shouldCancel,
        phase,
        onLog: (msg) => log.info(msg),
        urgent: true,
      });
      if (!waited.cleared) throw new Error("Timed out waiting in Walmart queue.");
      if (!waited.inStock) {
        const buyable = await detectWalmartBuyable(page);
        if (!buyable.inStock) throw new Error("Queue cleared but product not buyable yet.");
      }
    } else if (!skipNavigation && !/\/checkout|\/cart/i.test(page.url())) {
      const buyable = await detectWalmartBuyable(page).catch(() => ({ inStock: false }));
      if (!buyable.inStock) {
        phase("joining_queue", "Joining queue ASAP");
        log.info("Joining Walmart queue…");
        await attemptJoinWalmartQueue(page, product, {
          onLog: (_level, msg) => log.warn(msg),
          urgent: true,
        });
        queue = await detectWalmartQueueState(page);
        if (queue.inQueue) {
          phase("in_queue", "In queue — holding your spot");
          const waited = await waitThroughWalmartQueue(page, product, {
            shouldCancel,
            phase,
            onLog: (msg) => log.info(msg),
            urgent: true,
          });
          if (!waited.cleared) throw new Error("Timed out waiting in Walmart queue.");
        }
      }
    }
  }

  const wantQty = Math.max(1, Number(product.maxQuantity) || 1);
  log.info(`Checkout qty: ${wantQty}`);
  if (fastMode) {
    return aggressiveWalmartCheckout(page, product, config, {
      fastMode,
      dropWindowActive,
      shouldCancel,
      phase,
      dryRun,
      autoPlaceOrder,
      wantQty,
      latency: hooks.latency || null,
    });
  }

  phase("adding_to_cart", "Adding to Walmart cart");
  const added = await clickFirst(page, addToCartButtons(page), { timeout: 12000, shouldCancel, fast: false });
  if (!added || !(await verifyItemInCart(page, product, { fast: false }))) {
    throw new Error("Could not add Walmart item to cart.");
  }
  log.ok("Added to Walmart cart.");

  phase("checking_out", "Proceeding to checkout");
  markBotNavigation(page);
  await page.goto("https://www.walmart.com/cart", { waitUntil: "domcontentloaded" }).catch(() => {});
  await maxOutCartQuantity(page, product, wantQty);
  await clickFirst(page, checkoutButtons(page), { timeout: 10000, shouldCancel, fast: false });
  if (!/\/checkout/i.test(page.url())) {
    markBotNavigation(page);
    await page.goto("https://www.walmart.com/checkout", { waitUntil: "domcontentloaded" }).catch(() => {});
  }
  if (!/\/checkout/i.test(page.url())) throw new Error("Could not start Walmart checkout.");

  if (dryRun) {
    phase("dry_run", "Dry run — cart filled");
    return { placed: false, dryRun: true };
  }
  if (!autoPlaceOrder) {
    phase("needs_review", "Ready — place order in browser");
    return { placed: false, manual: true };
  }

  phase("placing_order", "Placing order");
  const clicked = await clickFirst(page, placeOrderButtons(page), { timeout: 8000, shouldCancel, fast: false });
  if (!clicked) return { placed: false, manual: true };
  const confirmed = await page
    .getByText(/thank you|order placed|order number/i)
    .first()
    .waitFor({ state: "visible", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  return { placed: confirmed, confirmed };
}

/* ---------- Favorites / My Lists ---------- */

const WALMART_FAVORITES_URL = "https://www.walmart.com/lists/favorites";
const WALMART_LISTS_URL = "https://www.walmart.com/lists";
const WALMART_ACCOUNT_URL = "https://www.walmart.com/account";
const WALMART_LOGIN_WAIT_MS = 10 * 60 * 1000;

/** Scrape product links from a Walmart list / favorites page. */
async function scrapeWalmartListItems(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const roots = [
      document.querySelector('[data-testid="list-items"]'),
      document.querySelector('[data-automation-id="list-items"]'),
      document.querySelector("main"),
      document.body,
    ].filter(Boolean);

    const titleFromSlug = (href) => {
      const m = String(href || "").match(/\/ip\/([^/?#]+)\/(\d{6,})/i);
      if (!m) return "";
      const slug = decodeURIComponent(m[1]);
      if (!slug || /^(seot|ip|product)$/i.test(slug) || /^\d+$/.test(slug)) return "";
      return slug.replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
    };

    const looksGeneric = (title, itemId) => {
      const t = (title || "").trim();
      if (!t || t.length < 3) return true;
      if (itemId && new RegExp(`^Walmart\\s*${itemId}$`, "i").test(t)) return true;
      if (/^(add to cart|options|view|save|remove|product)$/i.test(t)) return true;
      return false;
    };

    const push = (itemId, title, href) => {
      if (!itemId || seen.has(itemId)) return;
      seen.add(itemId);
      let cleanTitle = (title || "").replace(/\s+/g, " ").trim();
      if (looksGeneric(cleanTitle, itemId)) {
        cleanTitle = titleFromSlug(href) || `Walmart ${itemId}`;
      }
      cleanTitle = cleanTitle.slice(0, 140);
      const url = href?.startsWith("http")
        ? href.split("?")[0]
        : `https://www.walmart.com/ip/${itemId}`;
      out.push({ itemId, title: cleanTitle, url });
    };

    for (const root of roots) {
      root.querySelectorAll('a[href*="/ip/"]').forEach((a) => {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/ip\/(?:[^/?#]+\/)?(\d{6,})/i) || href.match(/\/(\d{8,})(?:[?#]|$)/);
        if (!m) return;
        const itemId = m[1];
        const card =
          a.closest('[data-item-id], [data-testid*="list-item"], [data-testid*="item"], [data-automation-id*="item"], li, article') ||
          a.closest("div");

        let title = (a.getAttribute("aria-label") || "").trim();
        if (looksGeneric(title, itemId)) title = (a.textContent || "").trim();
        if (looksGeneric(title, itemId) && card) {
          const tEl =
            card.querySelector('[data-automation-id="product-title"]') ||
            card.querySelector('[data-testid="product-title"]') ||
            card.querySelector('[data-automation-id="product-name"]') ||
            card.querySelector("span.w_iUH7, a[link-identifier] span, [class*='ProductTitle']");
          if (tEl) title = tEl.textContent.trim();
        }
        if (looksGeneric(title, itemId)) {
          const img =
            a.querySelector("img[alt]") ||
            card?.querySelector("img[alt]") ||
            a.closest("div")?.querySelector("img[alt]");
          const alt = img?.getAttribute("alt")?.trim() || "";
          if (!looksGeneric(alt, itemId)) title = alt;
        }
        if (looksGeneric(title, itemId)) title = titleFromSlug(href);

        push(itemId, title, href.startsWith("http") ? href : `https://www.walmart.com${href}`);
      });
    }
    return out;
  });
}

async function loadAllWalmartListItems(page, { onStatus } = {}) {
  onStatus?.("Scrolling to load all saved items…");
  let prevCount = 0;
  let stableRounds = 0;
  for (let round = 0; round < 40 && stableRounds < 4; round++) {
    const count = await page.evaluate(() => {
      const ids = new Set();
      document.querySelectorAll('a[href*="/ip/"]').forEach((a) => {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/ip\/(?:[^/?#]+\/)?(\d{6,})/i);
        if (m) ids.add(m[1]);
      });
      return ids.size;
    });
    if (count > prevCount) {
      prevCount = count;
      stableRounds = 0;
    } else {
      stableRounds++;
    }
    const loadMore = page
      .getByRole("button", { name: /load more|show more|view more|see more/i })
      .first();
    if (await loadMore.isVisible().catch(() => false)) {
      await loadMore.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1200);
      stableRounds = 0;
      continue;
    }
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.9, 600)));
    await page.waitForTimeout(700);
  }
  return prevCount;
}

async function needsSignInForWalmartLists(page) {
  const url = page.url();
  if (/\/login|\/account\/login|\/signin/i.test(url)) return true;
  const body = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 4000)).catch(() => "");
  if (/sign in to see your saved lists|sign in or create account|sign in to view/i.test(body)) return true;
  const signIn = page.getByRole("button", { name: /^sign in$/i }).or(page.getByRole("link", { name: /^sign in$/i })).first();
  if (await signIn.isVisible().catch(() => false)) {
    const items = await scrapeWalmartListItems(page);
    if (!items.length) return true;
  }
  return false;
}

async function walmartListsPageReady(page) {
  if (!/walmart\.com\/lists/i.test(page.url())) return false;
  if (await needsSignInForWalmartLists(page)) return false;
  const items = await scrapeWalmartListItems(page);
  if (items.length > 0) return true;
  const empty = await page
    .getByText(/no items|nothing saved|list is empty|haven't saved|start saving|add items/i)
    .first()
    .isVisible()
    .catch(() => false);
  return empty;
}

async function waitForWalmartListsReady(page, { onStatus, timeoutMs = WALMART_LOGIN_WAIT_MS } = {}) {
  onStatus?.("Loading Walmart favorites — sign in on this tab only if Walmart asks.");
  await page.bringToFront().catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await needsWalmartHold(page)) {
      onStatus?.("Press & Hold on the favorites tab…");
      await clearWalmartPxChallenge(page, { urgent: true }).catch(() => {});
    }
    if (await walmartListsPageReady(page)) return true;
    if (await needsSignInForWalmartLists(page)) {
      onStatus?.("Walmart wants sign-in for favorites — use the Chrome tab (bot is waiting)…");
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

/**
 * Read the signed-in user's Walmart Favorites / My Lists products.
 * Returns [{ itemId, title, url }].
 */
export async function fetchWalmartFavorites(context, { page, onStatus, keepPageOpen = false } = {}) {
  if (!context) throw new Error("Loading Walmart favorites needs the browser. Sign in first.");
  const ownedPage = !page;
  const tab = page ?? (await context.newPage());
  let leaveTabOpen = keepPageOpen || !ownedPage;

  try {
    await tab.bringToFront().catch(() => {});
    onStatus?.("Using your existing Walmart session…");
    await tab.goto(WALMART_ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await tab.waitForTimeout(800);
    if (await needsWalmartHold(tab)) await clearWalmartPxChallenge(tab, { urgent: true }).catch(() => {});

    onStatus?.("Opening Walmart favorites…");
    await tab.goto(WALMART_FAVORITES_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (await needsWalmartHold(tab)) await clearWalmartPxChallenge(tab, { urgent: true }).catch(() => {});

    let ready = await waitForWalmartListsReady(tab, { onStatus });
    if (!ready) {
      onStatus?.("Trying My Lists hub…");
      await tab.goto(WALMART_LISTS_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      ready = await waitForWalmartListsReady(tab, { onStatus });
    }
    if (!ready) {
      leaveTabOpen = true;
      throw new Error(
        "Walmart favorites didn't load in time. Finish signing in on the open Chrome tab, then click Load my favorites again."
      );
    }

    // If we're on the lists hub, open the Favorites / first list with items.
    const listLinks = await tab.evaluate(() => {
      const out = [];
      document.querySelectorAll('a[href*="/lists/"]').forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (/\/lists\/(favorites|WL\/|FL\/)/i.test(href)) {
          out.push(href.startsWith("http") ? href : `https://www.walmart.com${href}`);
        }
      });
      return [...new Set(out)];
    });

    const all = new Map();
    const pagesToScrape = [tab.url(), ...listLinks].filter((u, i, arr) => arr.indexOf(u) === i).slice(0, 6);

    for (const listUrl of pagesToScrape) {
      if (!/walmart\.com\/lists/i.test(tab.url()) || tab.url().split("?")[0] !== listUrl.split("?")[0]) {
        await tab.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await tab.waitForTimeout(800);
        if (await needsWalmartHold(tab)) await clearWalmartPxChallenge(tab, { urgent: true }).catch(() => {});
      }
      await loadAllWalmartListItems(tab, { onStatus });
      const items = await scrapeWalmartListItems(tab);
      for (const item of items) {
        if (!all.has(item.itemId)) all.set(item.itemId, item);
      }
    }

    const favorites = [...all.values()];
    onStatus?.(`Loaded ${favorites.length} Walmart favorite${favorites.length === 1 ? "" : "s"}.`);
    return favorites;
  } finally {
    if (!leaveTabOpen && ownedPage) await tab.close().catch(() => {});
  }
}
