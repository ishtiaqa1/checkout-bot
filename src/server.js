import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { readRawConfig, saveConfig } from "./config.js";
import { searchViaBrowser, previewMatches } from "./search.js";
import { engine } from "./engine.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

export function startServer({ port = 5273 } = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(PUBLIC_DIR));

  const wrap = (fn) => (req, res) =>
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        res.status(400).json({ error: err.message || String(err) });
      });

  app.get("/api/state", (req, res) => res.json(engine.getState()));

  app.get("/api/latency", (req, res) => {
    const state = engine.getState();
    res.json(state.latency || { count: 0, recent: [] });
  });

  app.post(
    "/api/readiness",
    wrap(async (req, res) => {
      const retailer = req.body?.retailer;
      const accountId = req.body?.accountId;
      const out = await engine.runReadinessCheck({ retailer, accountId });
      res.json(out);
    })
  );

  app.get("/api/accounts", (req, res) => {
    const state = engine.getState();
    res.json({
      accountMode: state.accountMode,
      accounts: state.accounts || [],
      sessions: state.sessions || [],
    });
  });

  app.get("/api/config", (req, res) => {
    const raw = readRawConfig();
    // Redact proxy passwords from API responses
    if (raw.proxyGroups && typeof raw.proxyGroups === "object") {
      const redacted = {};
      for (const [k, v] of Object.entries(raw.proxyGroups)) {
        redacted[k] = { ...v, password: v?.password ? "••••••" : "" };
      }
      raw.proxyGroups = redacted;
    }
    res.json(raw);
  });

  app.post(
    "/api/config",
    wrap((req, res) => {
      const saved = saveConfig(req.body);
      res.json({ ok: true, config: saved });
    })
  );

  app.post(
    "/api/retailer",
    wrap((req, res) => {
      const retailer = req.body?.retailer;
      const out = engine.applyRetailerSwitch(retailer);
      saveConfig({ ...readRawConfig(), retailer });
      res.json(out);
    })
  );

  // External stock alerts → instant checkout (PikaNotify forwarder, custom monitors).
  app.post(
    "/api/webhook/in-stock",
    wrap(async (req, res) => {
      const cfg = readRawConfig();
      const expected =
        cfg.monitor?.webhook?.secret || process.env.WEBHOOK_SECRET || cfg.monitor?.webhookSecret;
      if (expected) {
        const got = req.headers["x-webhook-secret"] || req.body?.secret;
        if (got !== expected) throw new Error("Invalid webhook secret.");
      } else if (cfg.monitor?.webhook?.enabled !== false) {
        log.warn("Webhook received without secret — set monitor.webhook.secret in config for security.");
      }
      const out = await engine.handleExternalAlert({ ...req.body, source: req.body?.source || "webhook" });
      res.json(out);
    })
  );

  app.get("/api/webhook/info", (req, res) => {
    const port = Number(process.env.PORT) || 5273;
    res.json({
      url: `http://localhost:${port}/api/webhook/in-stock`,
      methods: ["POST"],
      headers: { "Content-Type": "application/json", "x-webhook-secret": "(optional secret)" },
      examples: [
        { tcin: "94300072", source: "pikanotify" },
        { tcins: ["94300072", "94681782"] },
        { url: "https://www.target.com/p/-/A-94300072" },
        { text: "IN STOCK https://www.target.com/p/-/A-94300072" },
      ],
      trackalacker:
        "No public API — use PikaNotify Discord alerts + discordBridge, or Zapier to forward messages to this webhook.",
    });
  });

  app.post(
    "/api/search",
    wrap(async (req, res) => {
      const keyword = (req.body?.keyword || "").trim();
      if (!keyword) throw new Error("Missing keyword.");
      const ctx = await engine.ensureBrowser();
      const results = await searchViaBrowser(ctx, keyword, { count: 15 });
      res.json({ results });
    })
  );

  // Preview which products a keyword "card" would match, with scores.
  app.post(
    "/api/preview",
    wrap(async (req, res) => {
      const spec = {
        keywords: req.body?.keywords ?? [],
        matchThreshold: req.body?.matchThreshold,
        excludeWords: req.body?.excludeWords ?? [],
      };
      const ctx = await engine.ensureBrowser();
      const out = await previewMatches(spec, ctx);
      res.json(out);
    })
  );

  // Read the signed-in user's Target Favorites list.
  app.post(
    "/api/favorites",
    wrap(async (req, res) => {
      const favorites = await engine.getFavorites();
      res.json({ favorites });
    })
  );

  // Read the signed-in user's Walmart Favorites / My Lists.
  app.post(
    "/api/walmart-favorites",
    wrap(async (req, res) => {
      const favorites = await engine.getWalmartFavorites();
      res.json({ favorites });
    })
  );

  app.post(
    "/api/start",
    wrap(async (req, res) => res.json(await engine.start()))
  );

  app.post(
    "/api/stop",
    wrap(async (req, res) => res.json(await engine.stop()))
  );

  // Force an immediate stock check while monitoring (reloads tab; buys if in stock).
  app.post(
    "/api/check-now",
    wrap(async (req, res) => res.json(await engine.checkNow(req.body || {})))
  );

  // Test (dry-run) a single product card end-to-end without buying.
  app.post(
    "/api/test",
    wrap(async (req, res) => res.json(await engine.testCheckout(req.body || {})))
  );

  // Buy now: fully attempt a real purchase of a single product card.
  app.post(
    "/api/buy",
    wrap(async (req, res) => res.json(await engine.buyNow(req.body || {})))
  );

  // Cancel: with { id } abort that product's checkout; otherwise the active task.
  app.post(
    "/api/cancel",
    wrap(async (req, res) => res.json(engine.cancel(req.body?.id)))
  );

  // Persistently disarm one product and cancel any checkout currently using it.
  // Raw config strips runtime `id` fields, so match by TCIN / Walmart itemId / wm- prefix.
  app.post(
    "/api/products/:id/pause",
    wrap(async (req, res) => {
      const id = String(req.params.id || "");
      const raw = readRawConfig();
      const products = raw.products || [];
      const product =
        products.find((p) => p && String(p.id) === id) ||
        products.find((p) => p?.tcin && String(p.tcin) === id) ||
        products.find((p) => p?.itemId && (String(p.itemId) === id || `wm-${p.itemId}` === id));
      if (!product) {
        // Still stop the live engine card even if disk config is oddly shaped.
        const out = engine.pauseProduct(id);
        res.json(out);
        return;
      }
      product.enabled = false;
      saveConfig(raw);
      res.json(engine.pauseProduct(id));
    })
  );

  // Store the card security code in memory (and optionally remember on this PC).
  app.post(
    "/api/cvv",
    wrap(async (req, res) =>
      res.json(
        engine.setSessionCvv(req.body?.cvv, req.body?.accountId || null, {
          remember: req.body?.remember,
        })
      )
    )
  );

  app.get("/api/cvv", (req, res) => {
    const state = engine.getState();
    res.json({ hasCvv: !!state.hasCvv, rememberCvv: !!state.rememberCvv });
  });

  app.post(
    "/api/login",
    wrap(async (req, res) => {
      const retailer = req.body?.retailer;
      const accountId = req.body?.accountId || null;
      const out = await engine.openLoginPage(retailer, accountId);
      res.json({ ...out, accountId: accountId || out.accountId || null });
    })
  );

  // Server-Sent Events: stream every engine event to the browser live.
  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(engine.getState())}\n\n`);

    const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    engine.on("event", onEvent);

    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      engine.off("event", onEvent);
    });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      log.ok(`Dashboard running at http://localhost:${port}`);
      resolve(server);
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use — an old bot instance is still running.\n` +
              `Open http://localhost:${port} or stop the other process, then try again.`
          )
        );
      } else {
        reject(err);
      }
    });
  });
}
