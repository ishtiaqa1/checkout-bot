// Target locked down its data API (it 403s now), so we resolve products by
// reading the real search results page through the logged-in browser instead.

const FAVORITES_URL = "https://www.target.com/favorites";
const ACCOUNT_URL = "https://www.target.com/account";
const LOGIN_WAIT_MS = 10 * 60 * 1000; // up to 10 min for the user to finish signing in

function normalize(str) {
  return (str || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Accept keywords as an array of tags or a comma/newline separated string. */
function toKeywordList(keywords) {
  if (Array.isArray(keywords)) return keywords.map(normalize).filter(Boolean);
  return String(keywords || "")
    .split(/[,\n]+/)
    .map(normalize)
    .filter(Boolean);
}

/**
 * Scrape target.com search results for a keyword using a browser context.
 * Returns [{ tcin, title, url, price }].
 */
export async function searchViaBrowser(context, keyword, { count = 20 } = {}) {
  if (!context) throw new Error("Search needs the browser. Sign in / start the bot first.");
  const page = await context.newPage();
  try {
    const url = `https://www.target.com/s?searchTerm=${encodeURIComponent(keyword)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Let product tiles render, then make sure at least one is present.
    await page.waitForSelector('a[href*="/A-"]', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const items = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      document.querySelectorAll('a[href*="/A-"]').forEach((a) => {
        const m = a.getAttribute("href").match(/\/A-(\d+)/);
        if (!m) return;
        const tcin = m[1];
        if (seen.has(tcin)) return;
        let title = (a.getAttribute("aria-label") || a.textContent || "").trim();
        if (!title || title.length < 6) {
          const card = a.closest("div");
          const tEl = card && card.querySelector('[data-test="product-title"]');
          if (tEl) title = tEl.textContent.trim();
        }
        // Try to find a nearby price for display only.
        let price = "";
        const card = a.closest("div");
        const priceEl = card && card.querySelector('[data-test="current-price"]');
        if (priceEl) price = priceEl.textContent.trim();
        if (title && title.length >= 6) {
          seen.add(tcin);
          out.push({ tcin, title: title.slice(0, 120), price });
        }
      });
      return out;
    });

    return items.slice(0, count).map((i) => ({
      tcin: i.tcin,
      title: i.title,
      price: i.price || "",
      url: `https://www.target.com/p/-/A-${i.tcin}`,
    }));
  } finally {
    await page.close().catch(() => {});
  }
}

/** Scrape product links from the favorites page DOM. */
async function scrapeFavoritesFromPage(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const favList = document.querySelector('[data-test="favorites-list"]');
    const scope = favList
      ? [favList]
      : [document.querySelector('[data-test="product-list"]'), document.querySelector("main")].filter(Boolean);
    const roots = scope.length ? scope : [document];

    for (const root of roots) {
      root.querySelectorAll('a[href*="/A-"]').forEach((a) => {
        const m = a.getAttribute("href").match(/\/A-(\d+)/);
        if (!m) return;
        const tcin = m[1];
        if (seen.has(tcin)) return;

        let title = (a.getAttribute("aria-label") || a.textContent || "").trim();
        if (!title || title.length < 3) {
          const card = a.closest('[data-test="product-card"], [data-test="@web/ProductCard"], li, article, div');
          const tEl = card && card.querySelector('[data-test="product-title"]');
          if (tEl) title = tEl.textContent.trim();
        }
        if (!title || title.length < 3) {
          const img = a.querySelector("img[alt]") || a.closest("div")?.querySelector("img[alt]");
          if (img) title = img.getAttribute("alt")?.trim() || "";
        }
        if (!title) title = `Product ${tcin}`;

        seen.add(tcin);
        out.push({ tcin, title: title.slice(0, 120) });
      });
    }
    return out;
  });
}

/**
 * Target lazy-loads favorites — only the first batch is in the DOM until you scroll.
 * Scroll (and click "Load more" if present) until the count stops growing.
 */
async function loadAllFavorites(page, { onStatus } = {}) {
  onStatus?.("Scrolling to load all favorites…");
  let prevCount = 0;
  let stableRounds = 0;

  for (let round = 0; round < 40 && stableRounds < 4; round++) {
    const count = await page.evaluate(() => {
      const list = document.querySelector('[data-test="favorites-list"]');
      const root = list || document.querySelector("main") || document;
      const tcins = new Set();
      root.querySelectorAll('a[href*="/A-"]').forEach((a) => {
        const m = a.getAttribute("href").match(/\/A-(\d+)/);
        if (m) tcins.add(m[1]);
      });
      return tcins.size;
    });

    if (count > prevCount) {
      prevCount = count;
      stableRounds = 0;
    } else {
      stableRounds++;
    }

    const loadMore = page
      .getByRole("button", { name: /load more|show more|view more/i })
      .or(page.locator('[data-test="load-more-button"]'))
      .first();
    if (await loadMore.isVisible().catch(() => false)) {
      await loadMore.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1200);
      stableRounds = 0;
      continue;
    }

    await page.evaluate(() => {
      const list = document.querySelector('[data-test="favorites-list"]');
      if (list && list.scrollHeight > list.clientHeight) {
        list.scrollTop = list.scrollHeight;
      }
      window.scrollBy(0, Math.max(window.innerHeight * 0.9, 600));
    });
    await page.waitForTimeout(700);
  }

  return prevCount;
}

/** Favorites-specific sign-in gate (NOT the generic password-field check used at checkout). */
async function needsSignInForFavorites(page) {
  const url = page.url();
  if (/\/login|\/account\/signin|\/gsp/i.test(url)) return true;
  const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ")).catch(() => "");
  if (/sign in to (view|see|access) (your )?favorites/i.test(body)) return true;
  if (/create an account or sign in to save favorites/i.test(body)) return true;
  const signInBtn = page.getByRole("button", { name: /^sign in$/i }).first();
  const onFavorites = /\/favorites/i.test(url);
  if (onFavorites && (await signInBtn.isVisible().catch(() => false))) {
    const hasFavList = await page.locator('[data-test="favorites-list"]').isVisible().catch(() => false);
    if (!hasFavList) return true;
  }
  return false;
}

/** True when the favorites page loaded for a signed-in user (items or empty list). */
async function favoritesPageReady(page) {
  if (!/\/favorites/i.test(page.url())) return false;
  if (await needsSignInForFavorites(page)) return false;
  const items = await scrapeFavoritesFromPage(page);
  if (items.length > 0) return true;
  const empty = await page
    .getByText(/no favorites|haven't favorited|start saving|save your favorites|nothing saved/i)
    .first()
    .isVisible()
    .catch(() => false);
  const list = await page.locator('[data-test="favorites-list"]').isVisible().catch(() => false);
  return empty || list;
}

/** Wait until favorites are visible or the user finishes signing in. */
async function waitForFavoritesReady(page, { onStatus, timeoutMs = LOGIN_WAIT_MS } = {}) {
  onStatus?.("Loading favorites — sign in on this tab only if Target asks.");
  await page.bringToFront().catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await favoritesPageReady(page)) return true;
    if (await needsSignInForFavorites(page)) {
      onStatus?.("Target wants sign-in for favorites — use the Chrome tab (bot is waiting)…");
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

/**
 * Read the signed-in user's Target Favorites list and return the products on it.
 * Returns [{ tcin, title, url }].
 *
 * Uses a persistent utility tab (same browser session as stock checks) instead of
 * opening/closing a throwaway tab — that was causing false sign-in prompts and
 * tabs closing before you could finish logging in.
 */
export async function fetchFavorites(context, { page, onStatus, keepPageOpen = false } = {}) {
  if (!context) throw new Error("Loading favorites needs the browser. Sign in first.");
  const ownedPage = !page;
  const tab = page ?? (await context.newPage());
  let leaveTabOpen = keepPageOpen || !ownedPage;

  try {
    await tab.bringToFront().catch(() => {});

    // Warm the same cookie session the stock-check tabs use (account hub first).
    onStatus?.("Using your existing Target session…");
    await tab.goto(ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await tab.waitForTimeout(1000);

    onStatus?.("Opening favorites…");
    await tab.goto(FAVORITES_URL, { waitUntil: "domcontentloaded", timeout: 45000 });

    const ready = await waitForFavoritesReady(tab, { onStatus });
    if (!ready) {
      leaveTabOpen = true;
      throw new Error(
        "Favorites didn't load in time. Finish signing in on the open Chrome tab, then click Load my favorites again."
      );
    }

    await tab.waitForSelector('[data-test="favorites-list"], a[href*="/A-"]', { timeout: 15000 }).catch(() => {});
    await tab.waitForTimeout(1000);

    await loadAllFavorites(tab, { onStatus });
    const items = await scrapeFavoritesFromPage(tab);
    onStatus?.(`Loaded ${items.length} favorite${items.length === 1 ? "" : "s"}.`);
    return items.map((i) => ({
      tcin: i.tcin,
      title: i.title,
      url: `https://www.target.com/p/-/A-${i.tcin}`,
    }));
  } finally {
    if (!leaveTabOpen && ownedPage) await tab.close().catch(() => {});
  }
}

/**
 * Score how well a product title matches a set of keywords.
 * Returns the fraction (0..1) of keywords found in the title, plus details.
 */
export function scoreMatch(title, keywords) {
  const list = toKeywordList(keywords);
  const t = normalize(title);
  if (list.length === 0) return { score: 0, matched: [], missed: [], total: 0 };
  const matched = list.filter((k) => t.includes(k));
  const missed = list.filter((k) => !t.includes(k));
  return { score: matched.length / list.length, matched, missed, total: list.length };
}

const DEFAULT_THRESHOLD = 0.9;

function thresholdOf(spec) {
  const t = spec.matchThreshold;
  if (typeof t !== "number" || Number.isNaN(t)) return DEFAULT_THRESHOLD;
  return t > 1 ? t / 100 : t; // accept 0..1 or 0..100
}

/**
 * Return every search result for a product card, annotated with its match
 * score and whether it passes the card's threshold. Sorted best-first.
 * spec: { keywords, matchThreshold?, excludeWords? }
 */
export async function previewMatches(spec, context) {
  const query = toKeywordList(spec.keywords).join(" ");
  if (!query) return { threshold: thresholdOf(spec), results: [] };
  const threshold = thresholdOf(spec);
  const exclude = toKeywordList(spec.excludeWords);
  const results = await searchViaBrowser(context, query);

  const scored = results
    .map((r) => {
      const m = scoreMatch(r.title, spec.keywords);
      const excluded = exclude.some((w) => normalize(r.title).includes(w));
      return { ...r, ...m, excluded, pass: m.score >= threshold && !excluded };
    })
    .sort((a, b) => b.score - a.score);

  return { threshold, results: scored };
}

/**
 * Pick the single best match for a product card: the highest-scoring result
 * that meets the threshold (default 90%) and isn't excluded. Null if none.
 */
export async function resolveProductByKeywords(spec, context) {
  const { results } = await previewMatches(spec, context);
  return results.find((r) => r.pass) ?? null;
}
