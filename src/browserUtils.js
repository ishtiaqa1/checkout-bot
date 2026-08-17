/**
 * Browser helpers inspired by modern retail bots (2025–2026):
 * - BuyBot / CartPilot: block images for faster PDP reloads
 * - PhoenixBot: navigator.webdriver proxy
 * - walmart-kroger-petco-scraper: human scroll + mouse jitter before reads
 */

import { rand } from "./shared.js";

function isBlankPage(page) {
  try {
    const u = String(page.url() || "");
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
 * Open a real separate Chrome WINDOW (not a tab in the same window).
 * Uses CDP Target.createTarget({ newWindow: true }).
 * Avoids leaving leftover about:blank seed tabs from CDP bootstrap.
 */
export async function openChromeWindow(context, { url = "about:blank" } = {}) {
  const open = (context.pages() || []).filter((p) => p && !p.isClosed?.());
  // Prefer an existing real page as the CDP seed so we do not invent an extra blank tab.
  let seed = open.find((p) => !isBlankPage(p)) || open[0] || null;
  let createdSeed = false;
  if (!seed) {
    seed = await context.newPage();
    createdSeed = true;
  }

  const session = await context.newCDPSession(seed);
  const before = new Set(context.pages());

  const { targetId } = await session.send("Target.createTarget", {
    url: url && url !== "about:blank" ? url : "about:blank",
    newWindow: true,
  });

  let page = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    page = context.pages().find((p) => !before.has(p) && !p.isClosed?.());
    if (page) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) {
    // Last resort — still better than failing the monitor
    page = await context.newPage();
  }

  // Close a seed we only created for CDP — otherwise Chrome piles up blank tabs.
  if (createdSeed && seed && seed !== page && !seed.isClosed?.() && isBlankPage(seed)) {
    await seed.close().catch(() => {});
  }

  if (url && url !== "about:blank") {
    const current = page.url?.() || "";
    if (!current.includes(String(url).slice(0, 48))) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    }
  }

  // Keep targetId on the page for tiling
  page.__cdpTargetId = targetId;
  return page;
}

/** Tile open pages into non-overlapping Chrome windows across the screen.
 *  1–2 → side by side | 3–4 → 2×2 quadrants (TL/TR/BL/BR) | 5+ → 3-column grid
 */
export async function tileChromeWindows(pages, { cols, onLog } = {}) {
  const list = (pages || []).filter((p) => p && !p.isClosed?.());
  if (!list.length) return { ok: 0, failed: 0 };

  let availW = 1920;
  let availH = 1080;
  // Always tile on the primary monitor (0,0). Dual-monitor setups often report
  // availLeft < 0 for a side display — using that hides windows off the main screen.
  let screenLeft = 0;
  let screenTop = 0;
  try {
    const metrics = await list[0].evaluate(() => ({
      w: window.screen.availWidth || 1920,
      h: window.screen.availHeight || 1080,
    }));
    availW = metrics.w;
    availH = metrics.h;
  } catch {
    /* defaults */
  }

  const n = list.length;
  // 4 windows → classic quadrants; 3 → still 2 cols (TL/TR/BL)
  const gridCols = cols || (n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 2 : 3);
  const gridRows = Math.ceil(n / gridCols);
  const gap = 6;
  const taskbarPad = 40;
  const cellW = Math.floor((availW - gap * (gridCols + 1)) / gridCols);
  const cellH = Math.floor((availH - taskbarPad - gap * (gridRows + 1)) / gridRows);

  let ok = 0;
  let failed = 0;
  const slots = ["top-left", "top-right", "bottom-left", "bottom-right"];

  for (let i = 0; i < n; i++) {
    const page = list[i];
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);
    const left = screenLeft + gap + col * (cellW + gap);
    const top = screenTop + gap + row * (cellH + gap);
    const slot = slots[i] || `cell-${i + 1}`;

    try {
      const session = await page.context().newCDPSession(page);
      let targetId = page.__cdpTargetId;
      if (!targetId) {
        const info = await session.send("Target.getTargetInfo").catch(() => null);
        targetId = info?.targetInfo?.targetId;
      }
      if (!targetId) throw new Error("no targetId");

      const { windowId } = await session.send("Browser.getWindowForTarget", { targetId });

      // Chrome ignores size/position while maximized — must restore first
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal" },
      });
      await new Promise((r) => setTimeout(r, 100));

      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left,
          top,
          width: cellW,
          height: cellH,
          windowState: "normal",
        },
      });

      const after = await session.send("Browser.getWindowBounds", { windowId });
      const b = after?.bounds || {};
      onLog?.(`tiled ${slot}: ${b.width}×${b.height} at (${b.left},${b.top})`);
      ok += 1;
    } catch (err) {
      failed += 1;
      onLog?.(`tile failed (${slot}): ${err.message}`);
    }
  }

  return { ok, failed, cols: gridCols, rows: gridRows, cellW, cellH };
}

/** Block heavy assets on monitor tabs — faster reload loops. */
export async function installFastPageRoutes(page) {
  if (!page || page.__fastRoutesInstalled) return;
  page.__fastRoutesInstalled = true;
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "media" || type === "font") {
      route.abort().catch(() => {});
    } else {
      route.continue().catch(() => {});
    }
  }).catch(() => {});
}

/** PhoenixBot-style navigator proxy — hides webdriver from simple JS probes. */
export const PHOENIX_NAVIGATOR_PATCH = () => {
  try {
    Object.defineProperty(window, "navigator", {
      value: new Proxy(navigator, {
        has: (target, key) => (key === "webdriver" ? false : key in target),
        get: (target, key) =>
          key === "webdriver"
            ? undefined
            : typeof target[key] === "function"
            ? target[key].bind(target)
            : target[key],
      }),
    });
  } catch {
    /* non-fatal */
  }
};

/**
 * Simulate human browsing before stock reads — scroll + mouse drift.
 * Used by modern Walmart/Target scrapers to reduce passive bot scoring.
 */
export async function humanPageWarmup(page, { fast = true } = {}) {
  if (!page || page.isClosed?.()) return;
  try {
    const vp = page.viewportSize?.() || { width: 1280, height: 800 };
    await page.mouse.move(rand(80, vp.width - 80), rand(100, vp.height - 100), { steps: rand(3, 8) });
    const scrolls = fast ? 2 : 4;
    for (let i = 0; i < scrolls; i++) {
      await page.evaluate((y) => window.scrollBy(0, y), rand(200, 500));
      await page.waitForTimeout(fast ? rand(40, 120) : rand(120, 280));
    }
  } catch {
    /* non-fatal */
  }
}
