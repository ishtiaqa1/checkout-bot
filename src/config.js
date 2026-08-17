import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CONFIG_PATH = path.join(ROOT, "config.json");
const EXAMPLE_PATH = path.join(ROOT, "config.example.json");

const DEFAULTS = {
  // Target RedSky API is polled from a real browser tab (fast mode). Walmart uses PDP reloads.
  retailer: "both",
  monitor: {
    // external = webhook/Discord optional. fast = built-in API monitor (recommended).
    mode: "fast",
    pollIntervalMs: 120000,
    jitterMs: 5000,
    maxConcurrentChecks: 2,
    staggerChecks: true,
    hybridBrowserBackup: false,
    useLightPolls: true,
    lightPollsPerReload: 4,
    hypePollIntervalMs: 8000,
    fastApiMonitor: {
      enabled: true,
      pollIntervalMs: 2500,
      dropPollIntervalMs: 800,
    },
    webhook: {
      enabled: true,
      // Set a secret in config or WEBHOOK_SECRET env — required for /api/webhook/in-stock
      secret: "",
    },
    discordBridge: {
      enabled: false,
      botToken: "",
      channelIds: [],
      // false = catch cook-group followed channels + webhooks (recommended for Pokémon Restocks and Alerts)
      botsOnly: false,
      requireRestockHint: false,
    },
    dropWindow: {
      enabled: true,
    },
    // Walmart has no free stock API — a dedicated tab reloads each Walmart PDP
    // and reads the embedded __NEXT_DATA__ JSON (availabilityStatus).
    walmart: {
      pollIntervalMs: 12000, // per-product cadence outside drop windows
      dropPollIntervalMs: 400, // per-product cadence during drop windows
      queueDetectMs: 200, // light poll while waiting for queue UI
      burstConcurrency: 8, // parallel activation reloads at drop open
      activationLeadMs: 30000, // pre-arm drop window this many ms early (queue tabs warm)
      joinTimeoutMs: 45000, // max watch-for-queue after activation
      // After this ET clock time, products that never entered the virtual queue are retired.
      // Checkout only runs after leaving the queue — never on false "buyable / no queue".
      noQueueCutoffHourEt: 21,
      noQueueCutoffMinuteEt: 5,
    },
  },
  checkout: {
    autoPlaceOrder: false,
    dryRun: true,
    targetSoldOnly: true,
    checkoutTimeoutMs: 60000,
    // Walmart drops: join virtual queue first; hold tab without reload while in line.
    walmartQueueMode: true,
    // Drop-mode: fast polls, ship-first, qty cap, retries — like Refract/Stellar hype tasks.
    dropMode: true,
    hypeMode: true,
    // AIO Speed Upgrade: API-first ATC, warm checkout tab, event-driven waits, readiness gate.
    performanceMode: true,
    apiCheckout: true,
    loopCheckouts: true,
    maxOutQuantity: true,
    maxQuantityPerOrder: 2,
    pokemonQuantityCap: 2,
    checkoutRetries: 12,
    clearCartBeforeCheckout: true,
    maxOrdersPerAccount: 3,
  },
  // Saved checkout profile (name/address/billing) — persisted in config.json.
  // CVV is optional and stored separately in data/local-secrets.json when "remember" is on.
  checkoutProfile: {
    fullName: "",
    phone: "",
    email: "",
    shipping: {
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
      country: "US",
    },
    billingSameAsShipping: true,
    billing: {
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
      country: "US",
    },
    cardLast4: "",
  },
  // Optional multi-account profiles (empty = single local Chrome session).
  // accountMode: "single" | "multi". Multi caps at 5 enabled accounts.
  accountMode: "single",
  // Each account: { id, label, retailer, proxyGroup?, maxOrders?, enabled?, profileDir?, cdpPort? }
  accounts: [],
  proxyGroups: {},
  accountStrategy: "first", // first | least_orders | round_robin | sticky
  accountFanOut: 1, // how many eligible accounts to enqueue per stock hit (multi mode)
  challenges: {
    captcha: { provider: "manual" },
    hold: { provider: "walmartHold" },
    twoFactor: { provider: "manual" },
  },
  // Monitor watchdog — flags logout / PX / wrong page while watching.
  watchdog: {
    enabled: true,
    intervalMs: 8000,
  },
  notifications: { desktop: true, sound: true },
  // AI assistant: watches running checkouts and recovers stalls (dismiss dialogs,
  // retry, reload). Heuristics are always on; add an OpenAI key for smarter recovery.
  aiAssistant: {
    enabled: true,
    openaiApiKey: "",
    model: "gpt-4o-mini",
    stallSeconds: 18,
    maxRecoveriesPerCheckout: 2,
    maxStepsPerRecovery: 4,
  },
};

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (key.startsWith("//")) continue; // strip JSON comment keys
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = deepMerge(base[key] ?? {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `No config.json found.\nCopy the example first:\n  copy "${EXAMPLE_PATH}" "${CONFIG_PATH}"\nThen edit config.json (or just use the dashboard to add products).`
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }

  const config = deepMerge(DEFAULTS, raw);

  const retailer = String(config.retailer || "both").toLowerCase();
  config.retailer = ["target", "walmart", "both"].includes(retailer) ? retailer : "both";

  const mode = String(config.accountMode || "single").toLowerCase();
  config.accountMode = mode === "multi" ? "multi" : "single";
  if (Array.isArray(config.accounts)) {
    const enabled = config.accounts.filter((a) => a && a.enabled !== false);
    if (enabled.length > 5) {
      config.accounts = config.accounts.map((a, i) => {
        if (a && a.enabled !== false && enabled.indexOf(a) >= 5) return { ...a, enabled: false };
        return a;
      });
    }
  }
  const strategy = String(config.accountStrategy || "first").toLowerCase();
  config.accountStrategy = ["first", "least_orders", "round_robin", "sticky"].includes(strategy)
    ? strategy
    : "first";
  config.accountFanOut = Math.max(1, Math.min(5, Number(config.accountFanOut) || 1));

  const products = (config.products ?? []).filter(
    (p) => p && (p.tcin || p.keywords || p.itemId || /walmart\.com/i.test(p.url || ""))
  );
  // An empty watchlist is allowed — you can add products from the dashboard.
  // Normalize: ensure each product has a stable id and a numeric maxQuantity.
  config.products = products.map((p, i) => {
    const kwLabel = Array.isArray(p.keywords) ? p.keywords.join("-") : p.keywords || p.name || "";
    const retailer =
      p.retailer || (/walmart\.com/i.test(p.url || "") ? "walmart" : "target");
    let itemId = p.itemId ? String(p.itemId) : null;
    if (retailer === "walmart" && !itemId && p.url) {
      const m = p.url.match(/\/ip\/[^/]+\/(\d{6,})/) || p.url.match(/\/(\d{8,})(?:[?#]|$)/);
      itemId = m?.[1] || null;
    }
    let maxQuantity = Number.isFinite(p.maxQuantity) ? p.maxQuantity : 1;
    // Target Pokémon TCG online limit is typically 2 per item — max out when configured.
    if (config.checkout.dropMode !== false) {
      const cap = Number.isFinite(config.checkout.pokemonQuantityCap)
        ? config.checkout.pokemonQuantityCap
        : 2;
      if (config.checkout.maxOutQuantity !== false) {
        maxQuantity = cap;
      } else {
        const perOrder = Number(config.checkout.maxQuantityPerOrder);
        if (Number.isFinite(perOrder) && perOrder > 0) {
          maxQuantity = Math.min(Math.max(1, perOrder), cap);
        } else {
          maxQuantity = Math.min(Math.max(1, maxQuantity), cap);
        }
      }
    }
    const tcin = p.tcin ? String(p.tcin) : null;
    const id =
      retailer === "walmart"
        ? itemId
          ? `wm-${itemId}`
          : `kw-wm-${i}-${String(kwLabel).slice(0, 24)}`
        : tcin
        ? String(tcin)
        : `kw-${i}-${String(kwLabel).slice(0, 32)}`;
    return {
      ...p,
      retailer,
      itemId,
      tcin,
      maxQuantity,
      id,
    };
  });

  const n = config.products.length;
  const dropBuy = config.checkout.dropMode !== false && config.checkout.autoPlaceOrder && !config.checkout.dryRun;
  if (n > 0 && dropBuy) {
    config.checkout.checkoutRetries = Math.max(Number(config.checkout.checkoutRetries) || 3, 12);
    config.checkout.hypeMode = config.checkout.hypeMode !== false;
    config.checkout.loopCheckouts = config.checkout.loopCheckouts !== false;
    config.checkout.apiCheckout = config.checkout.apiCheckout !== false;
    config.monitor.useLightPolls = config.monitor.useLightPolls !== false;
    config.monitor.maxConcurrentChecks = Math.max(
      Number(config.monitor.maxConcurrentChecks) || 2,
      Math.min(12, Math.ceil(n / 2))
    );
    if (n > 8) {
      const fam = config.monitor.fastApiMonitor || {};
      if ((fam.dropPollIntervalMs ?? 800) > 200) {
        fam.dropPollIntervalMs = 200;
        config.monitor.fastApiMonitor = fam;
      }
    }
    if (n > 8 && (config.monitor.pollIntervalMs ?? 120000) > 90000) {
      config.monitor.pollIntervalMs = 90000;
    }
  }

  // Normalize checkout profile fields (never require them).
  const profile = config.checkoutProfile || {};
  const shipping = profile.shipping || {};
  const billing = profile.billing || {};
  config.checkoutProfile = {
    fullName: String(profile.fullName || "").trim(),
    phone: String(profile.phone || "").trim(),
    email: String(profile.email || "").trim(),
    shipping: {
      line1: String(shipping.line1 || "").trim(),
      line2: String(shipping.line2 || "").trim(),
      city: String(shipping.city || "").trim(),
      state: String(shipping.state || "").trim().toUpperCase().slice(0, 2),
      postalCode: String(shipping.postalCode || "").trim(),
      country: String(shipping.country || "US").trim() || "US",
    },
    billingSameAsShipping: profile.billingSameAsShipping !== false,
    billing: {
      line1: String(billing.line1 || "").trim(),
      line2: String(billing.line2 || "").trim(),
      city: String(billing.city || "").trim(),
      state: String(billing.state || "").trim().toUpperCase().slice(0, 2),
      postalCode: String(billing.postalCode || "").trim(),
      country: String(billing.country || "US").trim() || "US",
    },
    cardLast4: String(profile.cardLast4 || "").replace(/\D/g, "").slice(-4),
  };

  // Orders ship to your Target account's default address, so no location/zip is
  // needed. Monitor mode controls how stock is detected (external avoids scraping).
  if (config.monitor.mode === "api") {
    config.monitor.mode = "external";
  }

  return config;
}

/**
 * Persist a raw config object to config.json (used by the web UI).
 * Strips runtime-only fields that loadConfig() adds (id).
 */
export function saveConfig(raw) {
  const clean = JSON.parse(JSON.stringify(raw));
  if (Array.isArray(clean.products)) {
    clean.products = clean.products.map(({ id, ...rest }) => rest);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2), "utf8");
  return clean;
}

/** Read config.json if present, else fall back to the example, else {}. */
export function readRawConfig() {
  const file = fs.existsSync(CONFIG_PATH)
    ? CONFIG_PATH
    : fs.existsSync(EXAMPLE_PATH)
    ? EXAMPLE_PATH
    : null;
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export const paths = {
  root: ROOT,
  browserData: path.join(ROOT, "browser-data"),
  screenshots: path.join(ROOT, "screenshots"),
  accountBrowserData: (accountId) => path.join(ROOT, "browser-data", String(accountId || "local")),
};
