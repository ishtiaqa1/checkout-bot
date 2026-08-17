const $ = (id) => document.getElementById(id);
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

let watchlist = []; // array of product specs being edited
const badgeState = { checkout: null, dropWindow: null, retailer: "both" };
let lastBoardProducts = [];

const STATUS_LABEL = {
  resolving: "Searching", watching: "Watching", in_stock: "In stock", in_queue: "In queue",
  processing: "Processing", placing_order: "Placing order", success: "Success",
  failed: "Failed", dry_run: "Dry run", needs_review: "Needs you", skipped: "Skipped",
};
const SPIN = new Set(["processing", "placing_order", "in_stock", "in_queue"]);
// Statuses where a per-card "Cancel" button makes sense (something is in flight).
const CANCELABLE = new Set(["resolving", "in_stock", "in_queue", "processing", "placing_order"]);

function activeRetailer() {
  return $("retailerSwitch")?.value || badgeState.retailer || "both";
}

function filterProducts(products) {
  const sw = activeRetailer();
  return (products || []).filter((p) => {
    const r = productRetailer(p);
    if (sw === "walmart") return r === "walmart";
    if (sw === "target") return r === "target";
    return true;
  });
}

function setMerchantIcon(retailer) {
  const icon = $("merchantIcon");
  if (!icon) return;
  icon.replaceChildren();
  // Reset every class so Target bullseye never sticks after a Walmart switch
  icon.removeAttribute("class");
  icon.classList.add("merchant-icon");
  icon.setAttribute("data-retailer", retailer);

  if (retailer === "walmart") {
    icon.classList.add("walmart-spark");
    icon.title = "Walmart";
    icon.innerHTML =
      '<svg class="wm-spark-svg" viewBox="0 0 40 40" aria-hidden="true" focusable="false">' +
      '<circle cx="20" cy="20" r="20" fill="#0071ce"/>' +
      '<g fill="#ffc220">' +
      '<path d="M20 6l2.2 8.2H31l-6.8 4.9 2.6 8.1L20 22.8l-6.8 4.4 2.6-8.1L9 14.2h8.8z"/>' +
      "</g></svg>";
  } else if (retailer === "target") {
    icon.classList.add("bullseye");
    icon.title = "Target";
  } else {
    icon.classList.add("both-mark");
    icon.title = "Target + Walmart";
  }
}

function applyRetailerTheme(retailer = activeRetailer(), { refreshBoard = false } = {}) {
  badgeState.retailer = retailer;
  document.body.classList.remove("mode-target", "mode-walmart", "mode-both");
  document.body.classList.add(`mode-${retailer}`);

  setMerchantIcon(retailer);
  const cvvWrap = $("cvvInput")?.closest(".cvv-wrap");

  if (retailer === "walmart") {
    $("brandTitle").textContent = "Walmart Drop Bot";
    $("brandSub").textContent = "Join queue fast → checkout for your qty";
    $("loginBtn").textContent = "Sign in to Walmart";
    document.title = "Walmart Drop Bot — Queue & Checkout";
    if (cvvWrap) cvvWrap.style.display = "none";
  } else if (retailer === "target") {
    $("brandTitle").textContent = "Target Checkout Bot";
    $("brandSub").textContent = "Stock monitor & auto-checkout";
    $("loginBtn").textContent = "Sign in to Target";
    document.title = "Target Checkout Bot";
    if (cvvWrap) cvvWrap.style.display = "";
  } else {
    $("brandTitle").textContent = "Checkout Bot";
    $("brandSub").textContent = "Target & Walmart stock monitor & auto-checkout";
    $("loginBtn").textContent = "Sign in (Target + Walmart)";
    document.title = "Checkout Bot — Target & Walmart";
    if (cvvWrap) cvvWrap.style.display = "";
  }

  if ($("targetAddSection")) $("targetAddSection").style.display = retailer === "walmart" ? "none" : "";
  if ($("walmartAddSection")) $("walmartAddSection").style.display = retailer === "target" ? "none" : "";
  if ($("targetFavSection")) $("targetFavSection").style.display = retailer === "walmart" ? "none" : "";
  if ($("walmartFavSection")) $("walmartFavSection").style.display = retailer === "target" ? "none" : "";
  // Also hide Target watchlist immediately on theme switch (renderWatchlist confirms)
  if ($("watchlistTargetGroup")) $("watchlistTargetGroup").style.display = retailer === "walmart" ? "none" : "";
  if ($("watchlistWalmartGroup")) $("watchlistWalmartGroup").style.display = retailer === "target" ? "none" : "";
  if ($("watchlistPausedNote")) $("watchlistPausedNote").style.display = "none";

  renderWatchlist();
  if (refreshBoard && lastBoardProducts.length) resetBoard(lastBoardProducts);
  updateModeBadge();
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------- config load / save ---------- */
let cfgCache = {};

async function loadConfig() {
  const cfg = await api("/api/config");
  cfgCache = cfg;
  $("retailerSwitch").value = cfg.retailer || "both";
  const mon = cfg.monitor || {};
  $("pollSeconds").value = Math.max(30, Math.round((mon.pollIntervalMs ?? 120000) / 1000));
  $("monitorMode").value = mon.mode || "fast";
  $("webhookSecret").value = mon.webhook?.secret || "";
  $("discordBridge").checked = !!mon.discordBridge?.enabled;
  $("discordToken").value = mon.discordBridge?.botToken || "";
  $("discordChannels").value = (mon.discordBridge?.channelIds || []).join(", ");
  try {
    const wh = await api("/api/webhook/info");
    $("webhookUrl").value = wh.url || "";
  } catch {
    $("webhookUrl").value = "";
  }
  const co = cfg.checkout || {};
  // Reverse-map the two safety flags into one friendly dropdown.
  $("stockAction").value = co.dryRun ? "practice" : co.autoPlaceOrder ? "buy" : "cart";
  $("targetSoldOnly").checked = co.targetSoldOnly !== false;
  $("dropMode").checked = co.dropMode !== false;
  $("hypeMode").checked = co.hypeMode !== false;
  if ($("performanceMode")) $("performanceMode").checked = co.performanceMode !== false;
  $("loopCheckouts").checked = co.loopCheckouts !== false;
  $("maxOutQuantity").checked = co.maxOutQuantity !== false;
  if ($("accountMode")) $("accountMode").value = cfg.accountMode || "single";
  if ($("accountStrategy")) $("accountStrategy").value = cfg.accountStrategy || "first";
  if ($("accountFanOut")) $("accountFanOut").value = cfg.accountFanOut || 1;
  if ($("accountsJson")) {
    $("accountsJson").value = cfg.accounts?.length ? JSON.stringify(cfg.accounts, null, 2) : "";
  }
  if ($("proxyGroupsJson")) {
    $("proxyGroupsJson").value =
      cfg.proxyGroups && Object.keys(cfg.proxyGroups).length ? JSON.stringify(cfg.proxyGroups, null, 2) : "";
  }
  const ai = cfg.aiAssistant || {};
  $("aiAssistant").checked = ai.enabled !== false;
  $("aiApiKey").value = ai.openaiApiKey || "";
  const n = cfg.notifications || {};
  $("notifyDesktop").checked = n.desktop !== false;
  $("notifySound").checked = n.sound !== false;
  applyCheckoutProfile(cfg.checkoutProfile || {});
  try {
    const cvvStatus = await api("/api/cvv");
    if ($("rememberCvv")) $("rememberCvv").checked = !!cvvStatus.rememberCvv;
    uiState.hasCvv = !!cvvStatus.hasCvv;
    updateCvvDot();
  } catch {
    /* ignore */
  }
  watchlist = (cfg.products || []).filter(
    (p) => p && (p.tcin || p.keywords || p.itemId || /walmart\.com/i.test(p.url || ""))
  );
  let renamed = 0;
  for (const p of watchlist) {
    if (productRetailer(p) !== "walmart") continue;
    const id = p.itemId || parseWalmartItemId(p.url);
    if (!isGenericWalmartName(p.name, id)) continue;
    const fromUrl = titleFromWalmartUrl(p.url);
    if (fromUrl) {
      p.name = fromUrl;
      renamed++;
    }
  }
  applyRetailerTheme(cfg.retailer || "both");
  if (renamed) void saveConfigQuiet();
}

function applyCheckoutProfile(profile = {}) {
  const ship = profile.shipping || {};
  const bill = profile.billing || {};
  if ($("profileFullName")) $("profileFullName").value = profile.fullName || "";
  if ($("profilePhone")) $("profilePhone").value = profile.phone || "";
  if ($("profileEmail")) $("profileEmail").value = profile.email || "";
  if ($("profileCardLast4")) $("profileCardLast4").value = profile.cardLast4 || "";
  if ($("shipLine1")) $("shipLine1").value = ship.line1 || "";
  if ($("shipLine2")) $("shipLine2").value = ship.line2 || "";
  if ($("shipCity")) $("shipCity").value = ship.city || "";
  if ($("shipState")) $("shipState").value = ship.state || "";
  if ($("shipZip")) $("shipZip").value = ship.postalCode || "";
  if ($("billingSameAsShipping")) $("billingSameAsShipping").checked = profile.billingSameAsShipping !== false;
  if ($("billLine1")) $("billLine1").value = bill.line1 || "";
  if ($("billLine2")) $("billLine2").value = bill.line2 || "";
  if ($("billCity")) $("billCity").value = bill.city || "";
  if ($("billState")) $("billState").value = bill.state || "";
  if ($("billZip")) $("billZip").value = bill.postalCode || "";
  syncBillingVisibility();
}

function syncBillingVisibility() {
  const same = $("billingSameAsShipping")?.checked !== false;
  if ($("billingFields")) $("billingFields").style.display = same ? "none" : "";
}

function readCheckoutProfile() {
  const same = $("billingSameAsShipping")?.checked !== false;
  return {
    fullName: ($("profileFullName")?.value || "").trim(),
    phone: ($("profilePhone")?.value || "").trim(),
    email: ($("profileEmail")?.value || "").trim(),
    cardLast4: ($("profileCardLast4")?.value || "").replace(/\D/g, "").slice(-4),
    billingSameAsShipping: same,
    shipping: {
      line1: ($("shipLine1")?.value || "").trim(),
      line2: ($("shipLine2")?.value || "").trim(),
      city: ($("shipCity")?.value || "").trim(),
      state: ($("shipState")?.value || "").trim().toUpperCase().slice(0, 2),
      postalCode: ($("shipZip")?.value || "").trim(),
      country: "US",
    },
    billing: {
      line1: ($("billLine1")?.value || "").trim(),
      line2: ($("billLine2")?.value || "").trim(),
      city: ($("billCity")?.value || "").trim(),
      state: ($("billState")?.value || "").trim().toUpperCase().slice(0, 2),
      postalCode: ($("billZip")?.value || "").trim(),
      country: "US",
    },
  };
}

function actionToFlags(action) {
  if (action === "buy") return { dryRun: false, autoPlaceOrder: true };
  if (action === "cart") return { dryRun: false, autoPlaceOrder: false };
  return { dryRun: true, autoPlaceOrder: false }; // practice
}

function buildConfig() {
  const flags = actionToFlags($("stockAction").value);
  const maxQty = $("maxOutQuantity").checked ? 2 : 1;
  const products = watchlist.map((p) => {
    const isWm = productRetailer(p) === "walmart";
    const qty = isWm ? (p.maxQuantity || 1) : ($("maxOutQuantity").checked ? maxQty : (p.maxQuantity || 1));
    return { ...p, maxQuantity: qty };
  });

  let accounts = [];
  let proxyGroups = {};
  try {
    const rawAccounts = ($("accountsJson")?.value || "").trim();
    if (rawAccounts) accounts = JSON.parse(rawAccounts);
  } catch {
    toast("Accounts JSON is invalid — fix before saving");
  }
  try {
    const rawProxy = ($("proxyGroupsJson")?.value || "").trim();
    if (rawProxy) proxyGroups = JSON.parse(rawProxy);
  } catch {
    toast("Proxy groups JSON is invalid — fix before saving");
  }

  const prevMon = cfgCache.monitor || {};
  const prevWm = prevMon.walmart || {};
  const prevDrop = prevMon.dropWindow || {};

  return {
    retailer: $("retailerSwitch").value || "both",
    accountMode: $("accountMode")?.value || "single",
    accountStrategy: $("accountStrategy")?.value || "first",
    accountFanOut: Math.max(1, Math.min(5, Number($("accountFanOut")?.value) || 1)),
    accounts,
    proxyGroups,
    products,
    monitor: {
      mode: $("monitorMode").value || "fast",
      pollIntervalMs: Math.max(30, Number($("pollSeconds").value) || 120) * 1000,
      jitterMs: prevMon.jitterMs ?? 5000,
      maxConcurrentChecks: prevMon.maxConcurrentChecks ?? 9,
      staggerChecks: prevMon.staggerChecks !== false,
      hybridBrowserBackup: $("monitorMode").value === "hybrid",
      useLightPolls: true,
      lightPollsPerReload: prevMon.lightPollsPerReload ?? 4,
      hypePollIntervalMs: prevMon.hypePollIntervalMs ?? 8000,
      fastApiMonitor: {
        enabled: $("monitorMode").value === "fast" || $("monitorMode").value === "hybrid",
        pollIntervalMs: prevMon.fastApiMonitor?.pollIntervalMs ?? 2500,
        dropPollIntervalMs: prevMon.fastApiMonitor?.dropPollIntervalMs ?? 800,
      },
      webhook: {
        enabled: true,
        secret: $("webhookSecret").value.trim(),
      },
      discordBridge: {
        enabled: $("discordBridge").checked,
        botToken: $("discordToken").value.trim(),
        channelIds: $("discordChannels").value.split(",").map((s) => s.trim()).filter(Boolean),
        botsOnly: false,
        requireRestockHint: false,
      },
      // Preserve custom drop windows / lead times so UI save doesn't wipe drop prep.
      dropWindow: {
        ...prevDrop,
        enabled: prevDrop.enabled !== false,
      },
      walmart: {
        pollIntervalMs: prevWm.pollIntervalMs ?? 12000,
        dropPollIntervalMs: prevWm.dropPollIntervalMs ?? 400,
        queueDetectMs: prevWm.queueDetectMs ?? 200,
        burstConcurrency: prevWm.burstConcurrency ?? 8,
        activationLeadMs: prevWm.activationLeadMs ?? 30000,
        joinTimeoutMs: prevWm.joinTimeoutMs ?? 45000,
      },
    },
    checkout: {
      dryRun: flags.dryRun,
      autoPlaceOrder: flags.autoPlaceOrder,
      targetSoldOnly: $("targetSoldOnly").checked,
      walmartQueueMode: true,
      dropMode: $("dropMode").checked,
      hypeMode: $("hypeMode").checked,
      performanceMode: $("performanceMode")?.checked !== false,
      apiCheckout: true,
      loopCheckouts: $("loopCheckouts").checked,
      maxOutQuantity: $("maxOutQuantity").checked,
      maxQuantityPerOrder: 2,
      pokemonQuantityCap: 2,
      checkoutRetries: 12,
      clearCartBeforeCheckout: $("dropMode").checked,
      checkoutTimeoutMs: 60000,
    },
    notifications: { desktop: $("notifyDesktop").checked, sound: $("notifySound").checked },
    aiAssistant: {
      enabled: $("aiAssistant").checked,
      openaiApiKey: $("aiApiKey").value.trim(),
    },
    checkoutProfile: readCheckoutProfile(),
  };
}

async function saveConfig() {
  const body = buildConfig();
  await api("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  cfgCache = { ...cfgCache, ...body };
  toast("Settings saved");
}

async function saveConfigQuiet() {
  try {
    const body = buildConfig();
    await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    cfgCache = { ...cfgCache, ...body };
  } catch (e) {
    toast(e.message);
  }
}

function setAllArmed(armed) {
  watchlist.forEach((p) => {
    p.enabled = !!armed;
  });
  renderWatchlist();
  void saveConfigQuiet();
  toast(armed ? "All products armed" : "All products disarmed — arm the ones you want before Start");
}

/* ---------- card security code (CVV), memory only ---------- */
let cvvTimer = null;
function selectedAccountId() {
  return $("accountSelect")?.value || "local";
}

function syncAccountSelect(accounts = [], accountMode = "single") {
  const sel = $("accountSelect");
  if (!sel) return;
  const prev = sel.value;
  const list =
    accounts?.length > 0
      ? accounts.filter((a) => a && a.enabled !== false).slice(0, 5)
      : [{ id: "local", label: "Local" }];
  sel.innerHTML = list
    .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label || a.id)}</option>`)
    .join("");
  if (list.some((a) => a.id === prev)) sel.value = prev;
  sel.disabled = accountMode !== "multi" && list.length <= 1;
}

function renderAccountsPanel(accounts = [], sessions = [], accountMode = "single") {
  const panel = $("accountsPanel");
  if (!panel) return;
  const list = (accounts || []).filter((a) => a && a.enabled !== false).slice(0, 5);
  if (!list.length || accountMode !== "multi") {
    panel.innerHTML =
      accountMode === "multi"
        ? `<p class="muted">Add accounts in the JSON below (max 5 enabled).</p>`
        : `<p class="muted">Single mode uses the shared ./browser-data profile. Switch to Multi to isolate 2–5 accounts.</p>`;
    return;
  }
  const sessionMap = new Map((sessions || []).map((s) => [s.id, s]));
  panel.innerHTML = list
    .map((a) => {
      const s = sessionMap.get(a.id);
      const ready = s?.readiness?.readyScore != null ? `${s.readiness.readyScore}%` : "—";
      return `<div class="account-row" data-account="${escapeHtml(a.id)}">
        <strong>${escapeHtml(a.label || a.id)}</strong>
        <span class="muted">${escapeHtml(a.retailer || "both")}${a.proxyGroup ? ` · proxy ${escapeHtml(a.proxyGroup)}` : ""}</span>
        <span class="muted">ready ${ready}</span>
        <button type="button" class="btn btn-tiny btn-ghost" data-acct-login="${escapeHtml(a.id)}">Sign in</button>
        <button type="button" class="btn btn-tiny btn-ghost" data-acct-ready="${escapeHtml(a.id)}">Readiness</button>
      </div>`;
    })
    .join("");
  panel.querySelectorAll("[data-acct-login]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if ($("accountSelect")) $("accountSelect").value = btn.getAttribute("data-acct-login");
      $("loginBtn")?.click();
    });
  });
  panel.querySelectorAll("[data-acct-ready]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const accountId = btn.getAttribute("data-acct-ready");
      if ($("accountSelect")) $("accountSelect").value = accountId;
      try {
        const readiness = await api("/api/readiness", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ retailer: activeRetailer(), accountId }),
        });
        updateModeBadge({ readiness, accounts: badgeStateCache.accounts, accountMode: badgeStateCache.accountMode, sessions: badgeStateCache.sessions });
        toast(readiness.ok ? `${accountId}: ready` : `${accountId}: needs attention`);
      } catch (e) {
        toast(e.message);
      }
    });
  });
}

let badgeStateCache = {};

async function sendCvv() {
  const cvv = $("cvvInput").value.replace(/\D/g, "").slice(0, 4);
  try {
    const { hasCvv } = await api("/api/cvv", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cvv,
        accountId: selectedAccountId(),
        remember: !!$("rememberCvv")?.checked,
      }),
    });
    uiState.hasCvv = hasCvv;
    updateCvvDot();
  } catch (e) {
    toast(e.message);
  }
}
function updateCvvDot() {
  const dot = $("cvvDot");
  const typed = $("cvvInput").value.replace(/\D/g, "");
  dot.classList.toggle("on", !!uiState.hasCvv);
  dot.classList.toggle("pending", !uiState.hasCvv && typed.length > 0);
}

/* ---------- keyword chips (card creator) ---------- */
let chips = [];
function renderChips() {
  const box = $("chips");
  box.innerHTML = "";
  chips.forEach((kw, i) => {
    const el = document.createElement("span");
    el.className = "chip";
    el.innerHTML = `${escapeHtml(kw)} <button title="Remove" data-c="${i}">✕</button>`;
    el.querySelector("button").addEventListener("click", () => { chips.splice(i, 1); renderChips(); });
    box.appendChild(el);
  });
}
function addChipFromInput() {
  const inp = $("kwInput");
  inp.value.split(",").map((s) => s.trim()).filter(Boolean).forEach((kw) => {
    if (!chips.includes(kw.toLowerCase())) chips.push(kw.toLowerCase());
  });
  inp.value = "";
  renderChips();
}
function currentCardSpec() {
  return {
    keywords: chips.slice(),
    matchThreshold: Number($("thresh").value) / 100,
    excludeWords: [],
  };
}

/* ---------- watchlist ---------- */
function productRetailer(p) {
  if (p.retailer) return p.retailer;
  if (/walmart\.com/i.test(p.url || "")) return "walmart";
  return "target";
}

function parseWalmartItemId(url) {
  if (!url) return null;
  const m = url.match(/\/ip\/[^/]+\/(\d{6,})/) || url.match(/\/(\d{8,})(?:[?#]|$)/);
  return m?.[1] || null;
}

/** Turn /ip/Some-Product-Name/123 into "Some Product Name" when favorites scrape misses the title. */
function titleFromWalmartUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/ip\/([^/?#]+)\/(\d{6,})/i);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]);
  if (!slug || /^(seot|ip|product)$/i.test(slug) || /^\d+$/.test(slug)) return null;
  const title = slug
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title.length >= 3 ? title.slice(0, 140) : null;
}

function isGenericWalmartName(name, itemId) {
  const n = String(name || "").trim();
  if (!n) return true;
  if (itemId && new RegExp(`^Walmart\\s*${itemId}$`, "i").test(n)) return true;
  return /^Walmart\s+\d+$/i.test(n);
}

function productIdMeta(p) {
  const r = productRetailer(p);
  if (r === "walmart") {
    const id = p.itemId || parseWalmartItemId(p.url);
    return id ? `Item ${id}` : "Walmart (no item ID)";
  }
  return p.tcin ? `TCIN ${p.tcin}` : "";
}

function renderWatchlistGroup(box, items, indices) {
  if (!box) return;
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = '<p class="empty">No products in this section yet.</p>';
    return;
  }
  items.forEach((p, localIdx) => {
    const i = indices[localIdx];
    const kws = Array.isArray(p.keywords) ? p.keywords : p.keywords ? [p.keywords] : [];
    const thr = typeof p.matchThreshold === "number" ? Math.round((p.matchThreshold > 1 ? p.matchThreshold : p.matchThreshold * 100)) : 90;
    const retailer = productRetailer(p);
    const armed = p.enabled !== false;
    const badge = retailer === "walmart"
      ? '<span class="retailer-badge wm">Walmart</span>'
      : '<span class="retailer-badge tg">Target</span>';
    const meta = p.tcin || p.itemId || p.url
      ? `${badge} <span class="wl-meta">${escapeHtml(productIdMeta(p))}</span>`
      : `${badge}<div class="wl-chips">${kws.map((k) => `<span class="mini">${escapeHtml(k)}</span>`).join("")}</div><div class="wl-meta">match ≥ ${thr}%</div>`;
    const el = document.createElement("div");
    el.className = `wl-item${armed ? "" : " wl-disarmed"}`;
    const productName = p.name || kws.join(", ") || p.tcin || p.itemId || "product";
    el.innerHTML = `
      <label class="wl-arm" title="Arm to monitor this product on Start">
        <input type="checkbox" data-arm="${i}" ${armed ? "checked" : ""} aria-label="Arm ${escapeHtml(productName)}" />
        Arm
      </label>
      <div class="wl-product">
        <input class="wl-name-input" type="text" data-name="${i}" value="${escapeHtml(productName)}"
          placeholder="Product name" title="Click to rename — saves automatically"
          aria-label="Name for ${escapeHtml(productName)}" />
        <div>${meta}</div>
      </div>
      <div class="wl-fields">
        <label class="wl-field">Qty
          <input type="number" min="1" value="${p.maxQuantity || 1}" data-qty="${i}" aria-label="Quantity for ${escapeHtml(productName)}" />
        </label>
        <label class="wl-field">Max price
          <input type="number" min="0" step="0.01" value="${p.maxPrice || ""}" placeholder="No limit" data-maxprice="${i}" style="width:88px" aria-label="Maximum price for ${escapeHtml(productName)}" />
        </label>
      </div>
      <div class="wl-actions">
        <button class="btn btn-tiny btn-ghost" title="Check stock now while monitoring" data-check="${i}">Check stock</button>
        <button class="btn btn-tiny btn-ghost" title="Run checkout without placing an order" data-test="${i}">Practice</button>
        <span class="wl-buy-wrap">
          <button class="btn btn-tiny btn-buy" title="Attempt a real purchase" data-buy="${i}">Buy now</button>
          <button class="icon-btn" title="Remove ${escapeHtml(productName)}" aria-label="Remove ${escapeHtml(productName)}" data-rm="${i}">✕</button>
        </span>
      </div>`;
    box.appendChild(el);
  });
  box.querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => {
      watchlist.splice(Number(b.dataset.rm), 1);
      renderWatchlist();
      void saveConfigQuiet();
    })
  );
  box.querySelectorAll("[data-arm]").forEach((inp) =>
    inp.addEventListener("change", () => {
      watchlist[Number(inp.dataset.arm)].enabled = inp.checked;
      renderWatchlist();
      void saveConfigQuiet();
    })
  );
  box.querySelectorAll("[data-name]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const i = Number(inp.dataset.name);
      const name = inp.value.trim();
      if (!watchlist[i]) return;
      watchlist[i].name = name || watchlist[i].itemId || watchlist[i].tcin || "product";
      inp.value = watchlist[i].name;
      void saveConfigQuiet();
      toast("Name saved");
    })
  );
  box.querySelectorAll("[data-qty]").forEach((inp) =>
    inp.addEventListener("change", () => {
      watchlist[Number(inp.dataset.qty)].maxQuantity = Number(inp.value) || 1;
      void saveConfigQuiet();
    })
  );
  box.querySelectorAll("[data-maxprice]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const v = Number(inp.value);
      watchlist[Number(inp.dataset.maxprice)].maxPrice = v > 0 ? v : undefined;
      void saveConfigQuiet();
    })
  );
  box.querySelectorAll("[data-test]").forEach((b) =>
    b.addEventListener("click", () => testProduct(Number(b.dataset.test), b))
  );
  box.querySelectorAll("[data-check]").forEach((b) =>
    b.addEventListener("click", () => checkProduct(Number(b.dataset.check), b))
  );
  box.querySelectorAll("[data-buy]").forEach((b) =>
    b.addEventListener("click", () => buyProduct(Number(b.dataset.buy), b))
  );
}

function renderWatchlist() {
  const sw = activeRetailer();
  const targetItems = [];
  const targetIdx = [];
  const wmItems = [];
  const wmIdx = [];
  watchlist.forEach((p, i) => {
    if (productRetailer(p) === "walmart") {
      wmItems.push(p);
      wmIdx.push(i);
    } else {
      targetItems.push(p);
      targetIdx.push(i);
    }
  });

  // In Walmart mode: hide Target watchlist completely (products stay saved in config).
  // In Target mode: hide Walmart watchlist. Both: show everything.
  if ($("watchlistTargetGroup")) {
    $("watchlistTargetGroup").classList.remove("wl-paused");
    $("watchlistTargetGroup").style.display = sw === "walmart" ? "none" : "";
  }
  if ($("watchlistWalmartGroup")) {
    $("watchlistWalmartGroup").classList.remove("wl-paused");
    $("watchlistWalmartGroup").style.display = sw === "target" ? "none" : "";
  }

  const note = $("watchlistPausedNote");
  if (note) note.style.display = "none";

  if (sw !== "walmart") renderWatchlistGroup($("watchlistTarget"), targetItems, targetIdx);
  if (sw !== "target") renderWatchlistGroup($("watchlistWalmart"), wmItems, wmIdx);
}

async function checkProduct(i, btn, { all = false } = {}) {
  const p = watchlist[i];
  if (!all && !p) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Checking…";
  try {
    const body = all ? {} : { id: p.id, tcin: p.tcin, itemId: p.itemId };
    const out = await api("/api/check-now", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const hit = (out.results || []).find((r) => r.inStock);
    if (hit?.purchased) toast(`${hit.name || hit.tcin}: order placed!`);
    else if (hit) toast(`${hit.name || hit.tcin}: in stock — checkout started`);
    else toast(all ? "Check all finished — still out of stock" : "Checked — still out of stock");
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function testProduct(i, btn) {
  const p = watchlist[i];
  if (!p) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Testing…";
  try {
    await saveConfig();
    toast("Test started — watch the status board & browser window");
    const out = await api("/api/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    });
    if (out.ok) toast(`Test passed in ${(out.totalMs / 1000).toFixed(1)}s — no purchase made`);
    else toast(`Test: ${out.error || out.reason || "failed"}`);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function buyProduct(i, btn) {
  const p = watchlist[i];
  if (!p) return;
  const name = p.name || (p.keywords || []).join(", ") || p.tcin;
  if (productRetailer(p) === "target" && !uiState.hasCvv && !confirm(`No CVV entered. Target may need your card security code to finish.\n\nBuy "${name}" now anyway?`)) return;
  if (!confirm(`This will attempt a REAL purchase of "${name}" using your default address & card. Continue?`)) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Buying…";
  try {
    await saveConfig();
    toast("Buy now started — watch the status board & browser window");
    const out = await api("/api/buy", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    });
    if (out.ok) toast("Buy now finished — check the status board");
    else toast(`Buy now: ${out.error || out.reason || "failed"}`);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function addProduct(spec) {
  watchlist.push({ enabled: true, maxQuantity: 2, ...spec });
  renderWatchlist();
  void saveConfigQuiet();
  toast(`Added "${spec.name || (spec.keywords || []).join(", ") || spec.url || "product"}"`);
}

function addWalmartProduct() {
  const url = $("wmUrl").value.trim();
  const name = $("wmName").value.trim();
  if (!url || !/walmart\.com/i.test(url)) {
    toast("Paste a valid walmart.com product URL");
    return;
  }
  const itemId = parseWalmartItemId(url);
  if (!itemId) {
    toast("Could not read Walmart item ID from that URL");
    return;
  }
  if (watchlist.some((p) => productRetailer(p) === "walmart" && (p.itemId === itemId || parseWalmartItemId(p.url) === itemId))) {
    toast("That Walmart product is already on the watchlist");
    return;
  }
  addProduct({
    retailer: "walmart",
    name: name || titleFromWalmartUrl(url) || `Walmart ${itemId}`,
    url,
    itemId,
    maxQuantity: Math.max(1, Number($("wmQty").value) || 1),
    maxPrice: Number($("wmMaxPrice").value) > 0 ? Number($("wmMaxPrice").value) : undefined,
  });
  $("wmUrl").value = "";
  $("wmName").value = "";
  $("wmMaxPrice").value = "";
  $("wmQty").value = "1";
}

function addCard() {
  addChipFromInput();
  if (chips.length === 0) { toast("Add at least one keyword"); return; }
  const name = $("cardName").value.trim() || chips.join(", ");
  addProduct({ name, keywords: chips.slice(), matchThreshold: Number($("thresh").value) / 100, retailer: "target" });
  chips = []; renderChips();
  $("cardName").value = "";
  $("previewResults").innerHTML = "";
}

/* ---------- Target favorites ---------- */
let favorites = [];
function renderFavorites() {
  const box = $("favResults");
  $("addAllFavBtn").disabled = favorites.length === 0;
  if (!favorites.length) {
    box.innerHTML = '<p class="muted">No favorites found. Sign in to Target and heart some products, then try again.</p>';
    return;
  }
  box.innerHTML = "";
  favorites.forEach((f, i) => {
    const already = watchlist.some((p) => p.tcin === f.tcin);
    const el = document.createElement("div");
    el.className = "result";
    el.innerHTML = `
      <span class="r-title">${escapeHtml(f.title)}<br>
        <span class="r-tcin">TCIN ${f.tcin}</span></span>
      <button class="btn btn-tiny ${already ? "btn-ghost" : "btn-primary"}" data-fav="${i}" ${already ? "disabled" : ""}>${already ? "Added" : "Add"}</button>`;
    box.appendChild(el);
  });
  box.querySelectorAll("[data-fav]").forEach((b) =>
    b.addEventListener("click", () => addFavorite(Number(b.dataset.fav)))
  );
}

async function loadFavorites() {
  const box = $("favResults");
  const btn = $("loadFavBtn");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Loading…";
  box.innerHTML = '<p class="muted">Opening favorites in Chrome… if Target asks you to sign in, use that tab — the bot will wait up to 10 minutes.</p>';
  try {
    const { favorites: favs } = await api("/api/favorites", { method: "POST" });
    favorites = favs || [];
    renderFavorites();
    toast(`Found ${favorites.length} favorite${favorites.length === 1 ? "" : "s"}`);
  } catch (e) {
    box.innerHTML = `<p class="l-err">${escapeHtml(e.message)}</p>`;
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function addFavorite(i) {
  const f = favorites[i];
  if (!f || watchlist.some((p) => p.tcin === f.tcin)) return;
  watchlist.push({ enabled: true, maxQuantity: 2, name: f.title, tcin: f.tcin, url: f.url, retailer: "target" });
  renderWatchlist();
  renderFavorites();
  void saveConfigQuiet();
  toast(`Added "${f.title}"`);
}

function addAllFavorites() {
  let added = 0;
  favorites.forEach((f) => {
    if (!watchlist.some((p) => p.tcin === f.tcin)) {
      watchlist.push({ enabled: true, maxQuantity: 2, name: f.title, tcin: f.tcin, url: f.url, retailer: "target" });
      added++;
    }
  });
  renderWatchlist();
  renderFavorites();
  void saveConfigQuiet();
  toast(added ? `Added ${added} favorite${added === 1 ? "" : "s"} to watchlist` : "All favorites already added");
}

/* ---------- Walmart favorites ---------- */
let wmFavorites = [];
function renderWmFavorites() {
  const box = $("wmFavResults");
  if (!box) return;
  if ($("addAllWmFavBtn")) $("addAllWmFavBtn").disabled = wmFavorites.length === 0;
  if (!wmFavorites.length) {
    box.innerHTML = '<p class="muted">No favorites found. Sign in to Walmart and heart items on My Lists, then try again.</p>';
    return;
  }
  box.innerHTML = "";
  wmFavorites.forEach((f, i) => {
    const already = watchlist.some(
      (p) => productRetailer(p) === "walmart" && (p.itemId === f.itemId || parseWalmartItemId(p.url) === f.itemId)
    );
    const el = document.createElement("div");
    el.className = "result";
    el.innerHTML = `
      <span class="r-title">${escapeHtml(f.title)}<br>
        <span class="r-tcin">Walmart ${f.itemId}</span></span>
      <button class="btn btn-tiny ${already ? "btn-ghost" : "btn-primary"}" data-wmfav="${i}" ${already ? "disabled" : ""}>${already ? "Added" : "Add"}</button>`;
    box.appendChild(el);
  });
  box.querySelectorAll("[data-wmfav]").forEach((b) =>
    b.addEventListener("click", () => addWmFavorite(Number(b.dataset.wmfav)))
  );
}

async function loadWmFavorites() {
  const box = $("wmFavResults");
  const btn = $("loadWmFavBtn");
  if (!box || !btn) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Loading…";
  box.innerHTML = '<p class="muted">Opening Walmart favorites in Chrome… if Walmart asks you to sign in, use that tab — the bot will wait up to 10 minutes.</p>';
  try {
    const { favorites: favs } = await api("/api/walmart-favorites", { method: "POST" });
    wmFavorites = favs || [];
    renderWmFavorites();
    toast(`Found ${wmFavorites.length} Walmart favorite${wmFavorites.length === 1 ? "" : "s"}`);
  } catch (e) {
    box.innerHTML = `<p class="l-err">${escapeHtml(e.message)}</p>`;
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function addWmFavorite(i) {
  const f = wmFavorites[i];
  if (!f) return;
  if (watchlist.some((p) => productRetailer(p) === "walmart" && (p.itemId === f.itemId || parseWalmartItemId(p.url) === f.itemId))) {
    return;
  }
  const url = f.url || `https://www.walmart.com/ip/${f.itemId}`;
  const name = !isGenericWalmartName(f.title, f.itemId)
    ? f.title
    : titleFromWalmartUrl(url) || f.title || `Walmart ${f.itemId}`;
  watchlist.push({
    enabled: true,
    maxQuantity: Math.max(1, Number($("wmQty")?.value) || 1),
    name,
    itemId: f.itemId,
    url,
    retailer: "walmart",
  });
  renderWatchlist();
  renderWmFavorites();
  void saveConfigQuiet();
  toast(`Added "${name}"`);
}

function addAllWmFavorites() {
  let added = 0;
  const qty = Math.max(1, Number($("wmQty")?.value) || 1);
  wmFavorites.forEach((f) => {
    if (!watchlist.some((p) => productRetailer(p) === "walmart" && (p.itemId === f.itemId || parseWalmartItemId(p.url) === f.itemId))) {
      const url = f.url || `https://www.walmart.com/ip/${f.itemId}`;
      const name = !isGenericWalmartName(f.title, f.itemId)
        ? f.title
        : titleFromWalmartUrl(url) || f.title || `Walmart ${f.itemId}`;
      watchlist.push({
        enabled: true,
        maxQuantity: qty,
        name,
        itemId: f.itemId,
        url,
        retailer: "walmart",
      });
      added++;
    }
  });
  renderWatchlist();
  renderWmFavorites();
  void saveConfigQuiet();
  toast(added ? `Added ${added} Walmart favorite${added === 1 ? "" : "s"} to watchlist` : "All favorites already added");
}

/* ---------- preview matches for the card being built ---------- */
async function previewCard() {
  addChipFromInput();
  const box = $("previewResults");
  if (chips.length === 0) { toast("Add at least one keyword"); return; }
  box.innerHTML = '<p class="muted">Searching Target…</p>';
  try {
    const { threshold, results } = await api("/api/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentCardSpec()),
    });
    if (!results.length) { box.innerHTML = '<p class="muted">No results from Target.</p>'; return; }
    const thrPct = Math.round(threshold * 100);
    box.innerHTML = `<p class="muted">Need ≥ ${thrPct}% keyword match. Green = the bot would buy this.</p>`;
    results.slice(0, 12).forEach((r) => {
      const pct = Math.round(r.score * 100);
      const el = document.createElement("div");
      el.className = "result" + (r.excluded ? " excluded" : "");
      el.innerHTML = `
        <span class="score ${r.pass ? "pass" : "fail"}">${pct}%</span>
        <span class="r-title">${escapeHtml(r.title)}<br>
          <span class="r-tcin">TCIN ${r.tcin} · matched: ${r.matched.map(escapeHtml).join(", ") || "none"}</span></span>
        <span class="thumb-price">${escapeHtml(r.price || "")}</span>`;
      box.appendChild(el);
    });
  } catch (err) {
    box.innerHTML = `<p class="l-err">${escapeHtml(err.message)}</p>`;
  }
}

const cards = new Map();
const productSnapshots = new Map();
function updateModeBadge(patch) {
  Object.assign(badgeState, patch);
  const parts = [];
  if (badgeState.retailer && badgeState.retailer !== "both") {
    parts.push(badgeState.retailer === "walmart" ? "Walmart only" : "Target only");
  }
  if (badgeState.performanceMode !== false) parts.push("Performance");
  if (badgeState.checkout) {
    parts.push(
      badgeState.checkout.dryRun ? "Practice" : badgeState.checkout.autoPlaceOrder ? "Auto-buy" : "Fill cart"
    );
    if (badgeState.checkout.mode === "external") parts.push("external alerts");
    else if (badgeState.checkout.mode === "hybrid") parts.push("fast API + hybrid backup");
    else if (badgeState.checkout.mode === "fast") parts.push("fast API monitor");
    else if (badgeState.checkout.mode === "browser") parts.push("browser monitor");
  }
  if (badgeState.dropWindow?.active) {
    const secs = Math.round((badgeState.dropWindow.pollIntervalMs || 2000) / 1000);
    parts.push(badgeState.retailer === "walmart" ? `drop window · queue ~${secs}s` : `drop window ~${secs}s + light polls`);
  }
  $("modeBadge").textContent = parts.join(" · ") || "Standard monitoring";

  const lat = badgeState.latency;
  const gate = lat?.readinessGate;
  const samples = gate?.measuredSamples ?? lat?.count ?? 0;
  const latencyText = lat?.p50CheckoutMs != null
    ? `p50 ${(lat.p50CheckoutMs / 1000).toFixed(1)}s`
    : lat?.p50TotalMs != null
      ? `p50 ${(lat.p50TotalMs / 1000).toFixed(1)}s`
      : "No checkout data";
  if ($("latencyStatus")) $("latencyStatus").textContent = latencyText;
  if ($("latencyDetail")) {
    const base =
      samples > 0
        ? `${samples}/${gate?.requiredSamples || 30} measured · p95 ${
            (gate?.p95Ms ?? lat?.p95CheckoutMs) != null ? `${((gate?.p95Ms ?? lat.p95CheckoutMs) / 1000).toFixed(1)}s` : "—"
          } · ${gate?.ready ? "8/10 gate passed" : "collecting"}`
        : "Recent signal-to-checkout latency";
    const ap = badgeState.apiPathStats;
    const total = ap ? (ap.blitzOk || 0) + (ap.uiFallback || 0) : 0;
    const fallbackNote =
      total > 0 && (ap.uiFallback || 0) / total > 0.5 && (ap.uiFallback || 0) >= 3
        ? ` · UI fallback high (${ap.uiFallback}/${total})`
        : "";
    $("latencyDetail").textContent = base + fallbackNote;
  }
  if ($("queueLatencyStatus")) {
    const q50 = lat?.p50QueueMs != null ? `p50 ${(lat.p50QueueMs / 1000).toFixed(2)}s` : null;
    const q95 = lat?.p95QueueMs != null ? `p95 ${(lat.p95QueueMs / 1000).toFixed(2)}s` : null;
    $("queueLatencyStatus").textContent = q50 ? (q95 ? `${q50} · ${q95}` : q50) : "No queue data";
  }

  if ($("accountsStatus") && badgeState.accounts) {
    const mode = badgeState.accountMode || "single";
    const n = (badgeState.accounts || []).length;
    $("accountsStatus").textContent = `Mode: ${mode} · ${n} account profile${n === 1 ? "" : "s"} loaded`;
  }
  syncAccountSelect(badgeState.accounts, badgeState.accountMode || "single");
  renderAccountsPanel(badgeState.accounts, badgeState.sessions, badgeState.accountMode || "single");
  badgeStateCache = badgeState;

  const readiness = badgeState.readiness;
  if ($("readinessStatus") && readiness?.readyScore != null) {
    const failed = (readiness.checks || []).filter((check) => !check.ok);
    $("readinessStatus").textContent = `${readiness.readyScore}% ready`;
    $("readinessStatus").className =
      readiness.readyScore >= 100 ? "readiness-good" : readiness.readyScore >= 70 ? "readiness-warn" : "readiness-bad";
    $("readinessDetail").textContent = failed.length
      ? failed.map((check) => check.detail || check.id).slice(0, 2).join(" · ")
      : "Browser, session, and clock checks passed";
  }
}
function renderProduct(p) {
  if (!filterProducts([p]).length) {
    const card = cards.get(p.id);
    if (card) {
      card.remove();
      cards.delete(p.id);
    }
    productSnapshots.delete(p.id);
    return;
  }
  const board = $("board");
  const emptyMsg = board.querySelector(".empty");
  if (emptyMsg) emptyMsg.remove();

  let card = cards.get(p.id);
  const prev = productSnapshots.get(p.id);
  const status = p.status || "watching";
  const spin = SPIN.has(status) ? "spin" : "";
  const checked = p.lastChecked ? new Date(p.lastChecked).toLocaleTimeString() : "Never checked";
  const cancelNeeded = CANCELABLE.has(status);
  const checkNeeded = uiState.running && status === "watching" && (p.tcin || p.itemId);
  const stopNeeded = uiState.running && p.enabled !== false && status !== "skipped";
  const idLine = p.retailer === "walmart"
    ? (p.itemId ? `Walmart ${p.itemId}` : "")
    : (p.tcin ? "TCIN " + p.tcin : "");
  const name = p.name || p.tcin || p.itemId || "Product";
  const detail = p.detail || "";
  const availability = p.availability || "Unknown";
  const attempts = p.attempts || 0;
  const retailerBadge =
    p.retailer === "walmart"
      ? '<span class="retailer-badge wm">Walmart</span>'
      : p.retailer === "target" || p.tcin
        ? '<span class="retailer-badge tg">Target</span>'
        : "";

  // Skip full rebuild when only the clock tick / same watching detail changed.
  if (
    card &&
    prev &&
    prev.status === status &&
    prev.busy === p.busy &&
    prev.detail === detail &&
    prev.availability === availability &&
    prev.attempts === attempts &&
    prev.name === name &&
    prev.cancelNeeded === cancelNeeded &&
    prev.checkNeeded === checkNeeded &&
    prev.stopNeeded === stopNeeded
  ) {
    const timeEl = card.querySelector("[data-pcard-time]");
    if (timeEl) timeEl.textContent = checked;
    productSnapshots.set(p.id, { ...prev, checked });
    return;
  }

  if (!card) {
    card = document.createElement("div");
    card.className = "pcard";
    board.appendChild(card);
    cards.set(p.id, card);
  }
  card.className = `pcard s-${status} ${spin}`;
  const cancelBtn = cancelNeeded
    ? `<button class="pcard-cancel" title="Cancel this product" data-cancel="${escapeHtml(p.id)}">Cancel</button>`
    : "";
  const checkBtn = checkNeeded
    ? `<button class="pcard-check" title="Reload and check now" data-check-id="${escapeHtml(p.id)}">Check now</button>`
    : "";
  const stopBtn = stopNeeded
    ? `<button class="pcard-stop" title="Cancel checkout and stop monitoring this product" data-stop-id="${escapeHtml(p.id)}">Stop botting</button>`
    : "";
  card.innerHTML = `
    <div class="accentbar"></div>
    <div class="pcard-head">
      <h3>${escapeHtml(name)}</h3>
      <div class="pcard-actions">${checkBtn}${cancelBtn}${stopBtn}</div>
    </div>
    <span class="badge b-${status}"><span class="dot"></span>${STATUS_LABEL[status] || status}</span>
    <div class="detail">${escapeHtml(detail)}</div>
    <div class="pcard-meta">
      <span>${retailerBadge} ${idLine}</span>
      ${p.retailer === "walmart" && p.maxQuantity ? `<span>Qty ${p.maxQuantity}</span>` : ""}
      <span>Availability: ${escapeHtml(availability)}</span>
      <span>Attempts: ${attempts}</span>
      <span data-pcard-time>${checked}</span>
    </div>`;
  const cb = card.querySelector("[data-cancel]");
  if (cb) cb.addEventListener("click", () => cancelProduct(cb.dataset.cancel));
  const chk = card.querySelector("[data-check-id]");
  if (chk) chk.addEventListener("click", () => checkProductById(chk.dataset.checkId, chk));
  const stop = card.querySelector("[data-stop-id]");
  if (stop) stop.addEventListener("click", () => stopBottingProduct(stop.dataset.stopId, stop));
  productSnapshots.set(p.id, {
    status,
    busy: p.busy,
    detail,
    availability,
    attempts,
    name,
    cancelNeeded,
    checkNeeded,
    stopNeeded,
    checked,
  });
}

async function checkProductById(id, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "…";
  try {
    const out = await api("/api/check-now", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const hit = (out.results || [])[0];
    if (hit?.purchased) toast("In stock — order placed!");
    else if (hit?.inStock) toast("In stock — checkout started");
    else toast("Checked — still out of stock");
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function cancelProduct(id) {
  try {
    await api("/api/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    toast("Cancelling…");
  } catch (e) { toast(e.message); }
}

async function stopBottingProduct(id, btn) {
  btn.disabled = true;
  btn.textContent = "Stopping…";
  try {
    await api(`/api/products/${encodeURIComponent(id)}/pause`, { method: "POST" });
    const product = watchlist.find((p) => p.id === id);
    if (product) product.enabled = false;
    renderWatchlist();
    toast("Stopped — this product is no longer watched or botted");
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Stop botting";
    toast(e.message);
  }
}

function resetBoard(products) {
  lastBoardProducts = products || [];
  const visible = filterProducts(lastBoardProducts);
  $("board").innerHTML = visible.length
    ? ""
    : `<p class="empty">${activeRetailer() === "walmart" ? "No Walmart products yet. Add a walmart.com link below, then press Start." : activeRetailer() === "target" ? "No Target products yet. Add one below, then press Start." : "No products yet. Add one below, then press Start."}</p>`;
  cards.clear();
  productSnapshots.clear();
  visible.forEach(renderProduct);
}

/* ---------- log ---------- */
function addLog(e) {
  const box = $("logBox");
  const line = document.createElement("div");
  line.className = `logline l-${e.level || "info"}`;
  const time = new Date(e.time || Date.now()).toLocaleTimeString();
  line.innerHTML = `<span class="t">${time}</span>${escapeHtml(e.message)}`;
  box.appendChild(line);
  if ($("autoScrollLog")?.checked) box.scrollTop = box.scrollHeight;
  while (box.children.length > 400) box.removeChild(box.firstChild);
}

/* ---------- running / busy state ---------- */
const uiState = { running: false, browserOpen: false, busy: false, hasCvv: false };
function applyState(patch) {
  Object.assign(uiState, patch);
  const pill = $("statePill");
  pill.textContent = uiState.running ? "Running" : uiState.browserOpen ? "Browser open" : "Stopped";
  pill.className = "pill " + (uiState.running ? "pill-running" : "pill-stopped");
  $("startBtn").disabled = uiState.running;
  $("checkAllBtn").disabled = !uiState.running;
  $("stopBtn").disabled = !uiState.running && !uiState.browserOpen;
  $("loginBtn").disabled = uiState.busy;
  $("cancelBtn").disabled = !uiState.busy;
  updateCvvDot();
}

/* ---------- SSE ---------- */
function connectEvents() {
  const es = new EventSource("/api/events");
  const connection = $("connectionStatus");
  es.onopen = () => {
    connection.textContent = "Live";
    connection.className = "connection-state connected";
  };
  es.addEventListener("snapshot", (ev) => {
    const state = JSON.parse(ev.data);
    applyState({ running: state.running, browserOpen: state.browserOpen, busy: state.busy, hasCvv: state.hasCvv });
    updateModeBadge({
      ...state,
      performanceMode: state.performanceMode,
      latency: state.latency,
      readiness: state.readiness,
      accounts: state.accounts,
      accountMode: state.accountMode,
      sessions: state.sessions,
      apiPathStats: state.apiPathStats,
    });
    // Prefer live Store dropdown if user just changed it; otherwise sync from server
    const fromServer = state.retailer;
    const fromUi = $("retailerSwitch")?.value;
    const retailer = fromServer || fromUi || "both";
    if (fromServer && $("retailerSwitch")) $("retailerSwitch").value = fromServer;
    resetBoard(state.products || []);
    applyRetailerTheme(retailer);
  });
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.kind === "log") addLog(e);
    else if (e.kind === "product") renderProduct(e.product);
    else if (e.kind === "state") {
      applyState({ running: e.running, browserOpen: e.browserOpen, busy: e.busy, hasCvv: e.hasCvv });
      updateModeBadge({ dropWindow: e.dropWindow });
      if (e.retailer) {
        $("retailerSwitch").value = e.retailer;
        applyRetailerTheme(e.retailer);
      }
    }
  };
  es.onerror = () => {
    connection.textContent = "Reconnecting…";
    connection.className = "connection-state disconnected";
  };
}

/* ---------- helpers ---------- */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ---------- wire up ---------- */
$("kwInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addChipFromInput(); }
});
$("kwInput").addEventListener("blur", addChipFromInput);
$("thresh").addEventListener("input", () => { $("threshVal").textContent = `${$("thresh").value}%`; });
$("previewBtn").addEventListener("click", previewCard);
$("addCardBtn").addEventListener("click", addCard);
$("addWmBtn").addEventListener("click", addWalmartProduct);
$("wmUrl").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addWalmartProduct(); }
});
$("loadFavBtn").addEventListener("click", loadFavorites);
$("addAllFavBtn").addEventListener("click", addAllFavorites);
$("loadWmFavBtn")?.addEventListener("click", loadWmFavorites);
$("addAllWmFavBtn")?.addEventListener("click", addAllWmFavorites);
$("saveBtn").addEventListener("click", () => saveConfig().catch((e) => toast(e.message)));
$("armAllBtn")?.addEventListener("click", () => setAllArmed(true));
$("disarmAllBtn")?.addEventListener("click", () => setAllArmed(false));
$("clearLog").addEventListener("click", () => ($("logBox").innerHTML = ""));
$("readinessBtn").addEventListener("click", async () => {
  const btn = $("readinessBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    const readiness = await api("/api/readiness", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retailer: activeRetailer(), accountId: selectedAccountId() }),
    });
    updateModeBadge({ readiness, ...badgeStateCache });
    toast(readiness.ok ? "Ready for checkout" : "Readiness check found an issue");
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

$("cvvInput").addEventListener("input", () => {
  updateCvvDot();
  clearTimeout(cvvTimer);
  cvvTimer = setTimeout(sendCvv, 450);
});
$("cvvInput").addEventListener("change", sendCvv);
$("cvvInput").addEventListener("blur", sendCvv);
$("rememberCvv")?.addEventListener("change", sendCvv);
$("billingSameAsShipping")?.addEventListener("change", syncBillingVisibility);
$("saveProfileBtn")?.addEventListener("click", async () => {
  const btn = $("saveProfileBtn");
  const hint = $("profileHint");
  btn.disabled = true;
  try {
    await saveConfigQuiet();
    if (hint) hint.textContent = "Profile saved";
    toast("Checkout profile saved");
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
});

$("cancelBtn").addEventListener("click", async () => {
  try { await api("/api/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); toast("Cancelling…"); }
  catch (e) { toast(e.message); }
});
$("loginBtn").addEventListener("click", async () => {
  const retailer = activeRetailer();
  $("loginBtn").disabled = true;
  try {
    toast(
      retailer === "walmart"
        ? "Opening Walmart sign-in…"
        : retailer === "target"
        ? "Opening Target sign-in…"
        : "Opening sign-in…"
    );
    const out = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retailer, accountId: selectedAccountId() }),
    });
    const r = out.retailer || retailer;
    const acctNote = out.accountId && out.accountId !== "local" ? ` (${out.accountId})` : "";
    if (r === "walmart") {
      toast(`Look for bot Chrome — sign in to Walmart${acctNote} (tab title [Sign in])`);
    } else if (r === "target") {
      toast(`Look for bot Chrome — sign in to Target${acctNote} (tab title [Sign in])`);
    } else {
      toast(`Bot Chrome opened — Target + Walmart login tabs${acctNote}`);
    }
  } catch (e) {
    const msg = String(e.message || e);
    if (/failed to fetch|networkerror|load failed|Unable to connect/i.test(msg)) {
      toast("Dashboard server is not running — start it with npm run ui");
    } else {
      toast(msg);
    }
  } finally {
    $("loginBtn").disabled = false;
  }
});
$("retailerSwitch").addEventListener("change", async () => {
  const val = $("retailerSwitch").value;
  applyRetailerTheme(val, { refreshBoard: true });
  try {
    await api("/api/retailer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retailer: val }),
    });
    // Persist locally so Save/Start don't overwrite Store back to Target
    toast(val === "walmart" ? "Walmart mode — icon + sign-in are Walmart now" : `Store: ${val}`);
  } catch (e) {
    toast(e.message);
  }
});
$("startBtn").addEventListener("click", async () => {
  try {
    await saveConfig();
    await api("/api/start", { method: "POST" });
    toast("Monitoring started — only Armed products are warmed and polled");
  } catch (e) { toast(e.message); }
});
$("checkAllBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Checking…";
  try {
    const out = await api("/api/check-now", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const hits = (out.results || []).filter((r) => r.inStock);
    toast(hits.length ? `${hits.length} in stock — checkout started` : "All checked — still out of stock");
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = !uiState.running;
    btn.textContent = original;
  }
});
$("stopBtn").addEventListener("click", async () => {
  try { await api("/api/stop", { method: "POST" }); toast("Stopped"); }
  catch (e) { toast(e.message); }
});

loadConfig().catch((e) => toast(e.message));
connectEvents();
