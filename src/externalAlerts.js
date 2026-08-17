import { parseWalmartItemId } from "./shared.js";

const TARGET_TCIN_RE = /(?:\/A-|tcin[:\s#]*|TCIN[:\s#]*)(\d{6,12})/gi;
const TARGET_URL_RE = /target\.com\/[^\s)"']*?(?:\/A-|A-)(\d{6,12})/gi;
const WALMART_ID_RE = /walmart\.com\/ip\/[^/\s?#]+?\/(\d{6,12})/gi;

/** Cook groups (Pokémon Restocks and Alerts, etc.) often use these phrases. */
const RESTOCK_HINT_RE =
  /in\s*stock|restock|back\s*in\s*stock|live\s*now|available\s*now|just\s*went\s*live|hurry|add\s*to\s*cart|🔗|🚨|✅/i;

function collectMatches(text, re) {
  const out = new Set();
  if (!text) return out;
  const flags = re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g");
  for (const m of text.matchAll(flags)) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

function flattenEmbeds(embeds = []) {
  return embeds
    .map((e) =>
      [
        e.title,
        e.description,
        e.url,
        e.author?.name,
        e.footer?.text,
        ...(e.fields || []).map((f) => `${f.name} ${f.value}`),
      ].join("\n")
    )
    .join("\n");
}

function extractUrlsFromMarkdown(text) {
  const urls = [];
  for (const m of (text || "").matchAll(/\((https?:\/\/[^)]+)\)/g)) urls.push(m[1]);
  for (const m of (text || "").matchAll(/https?:\/\/[^\s<>"')]+/g)) urls.push(m[0]);
  return urls.join("\n");
}

/** Extract stock signals from arbitrary webhook / Discord payloads. */
export function parseStockAlert(payload = {}, { requireRestockHint = false } = {}) {
  const parts = [];
  if (typeof payload === "string") parts.push(payload);
  if (payload.text) parts.push(payload.text);
  if (payload.message) parts.push(payload.message);
  if (payload.content) parts.push(payload.content);
  if (payload.url) parts.push(payload.url);
  if (Array.isArray(payload.urls)) parts.push(payload.urls.join("\n"));
  if (payload.embed) parts.push(flattenEmbeds([payload.embed]));
  if (Array.isArray(payload.embeds)) parts.push(flattenEmbeds(payload.embeds));

  const blob = parts.join("\n");
  const markdownUrls = extractUrlsFromMarkdown(blob);
  const fullBlob = `${blob}\n${markdownUrls}`;

  if (requireRestockHint && !RESTOCK_HINT_RE.test(fullBlob) && !/target\.com|walmart\.com/i.test(fullBlob)) {
    return [];
  }

  const hits = [];

  for (const tcin of collectMatches(fullBlob, TARGET_TCIN_RE)) {
    hits.push({ retailer: "target", tcin: String(tcin), source: payload.source || "webhook" });
  }
  for (const m of fullBlob.matchAll(TARGET_URL_RE)) {
    hits.push({ retailer: "target", tcin: String(m[1]), source: payload.source || "webhook" });
  }

  for (const m of fullBlob.matchAll(WALMART_ID_RE)) {
    hits.push({ retailer: "walmart", itemId: m[1], source: payload.source || "webhook" });
  }

  if (payload.tcin) hits.push({ retailer: "target", tcin: String(payload.tcin), source: payload.source || "webhook" });
  if (payload.itemId) hits.push({ retailer: "walmart", itemId: String(payload.itemId), source: payload.source || "webhook" });
  if (Array.isArray(payload.tcins)) {
    for (const t of payload.tcins) hits.push({ retailer: "target", tcin: String(t), source: payload.source || "webhook" });
  }
  if (Array.isArray(payload.itemIds)) {
    for (const id of payload.itemIds) hits.push({ retailer: "walmart", itemId: String(id), source: payload.source || "webhook" });
  }

  const seen = new Set();
  return hits.filter((h) => {
    const key = h.tcin ? `t:${h.tcin}` : `w:${h.itemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return !!(h.tcin || h.itemId);
  });
}

/** Match parsed alerts to watchlist products (TCIN, Walmart ID, or product name in alert text). */
export function matchAlertToProducts(alert, products = []) {
  const matches = [];
  const alertText = [alert.text, alert.message, alert.content, alert.title, alert.description]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  for (const p of products) {
    const retailer = p.retailer || "target";
    if (alert.tcin && retailer === "target" && String(p.tcin) === String(alert.tcin)) {
      matches.push(p);
      continue;
    }
    if (alert.itemId && retailer === "walmart") {
      const id = p.itemId || parseWalmartItemId(p.url);
      if (id && String(id) === String(alert.itemId)) matches.push(p);
      continue;
    }
    const name = (p.name || "").toLowerCase().trim();
    if (name.length >= 24 && alertText.includes(name.slice(0, 40))) {
      matches.push(p);
    }
  }
  return matches;
}
