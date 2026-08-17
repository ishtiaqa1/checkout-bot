#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { createMonitor } from "./monitor.js";
import { searchViaBrowser, resolveProductByKeywords } from "./search.js";
import { launchBrowser, openLogin } from "./checkout.js";
import { engine } from "./engine.js";
import { startServer } from "./server.js";

// Install ASAP — node-notifier / OS spawn failures must not kill the dashboard mid-drop.
function isBenignOsSpawnError(err) {
  const msg = err?.message || String(err || "");
  return /spawn/i.test(msg) || err?.syscall === "spawn" || err?.code === "UNKNOWN";
}

process.on("uncaughtException", (err) => {
  if (isBenignOsSpawnError(err)) {
    log.warn(`Ignored notification/OS spawn error (bot stays up): ${err?.message || err}`);
    return;
  }
  log.err(`Uncaught exception: ${err?.message || err}`);
  console.error(err);
});
process.on("unhandledRejection", (reason) => {
  if (isBenignOsSpawnError(reason)) {
    log.warn(`Ignored notification/OS spawn rejection (bot stays up): ${reason?.message || reason}`);
    return;
  }
  log.warn(`Unhandled rejection: ${reason?.message || reason}`);
});

/**
 * For any product defined only by keywords, search Target and fill in its TCIN.
 * Mutates products in place. Products that can't be resolved are dropped.
 */
async function resolveProducts(config, browser) {
  const resolved = [];
  for (const product of config.products) {
    if (product.tcin) {
      resolved.push(product);
      continue;
    }
    if (!product.keywords) continue;
    try {
      const match = await resolveProductByKeywords(product, browser);
      if (match) {
        product.tcin = match.tcin;
        product.url = match.url;
        product.name = product.name || match.title;
        log.ok(`Matched "${product.keywords}" → ${match.title} (TCIN ${match.tcin})`);
        resolved.push(product);
      } else {
        log.warn(`No product matched keywords "${product.keywords}" yet — will retry while running.`);
        resolved.push(product); // keep it; we'll re-resolve in the loop
      }
    } catch (err) {
      log.err(`Search failed for "${product.keywords}": ${err.message}`);
      resolved.push(product);
    }
  }
  config.products = resolved;
}

async function cmdLogin() {
  await openLogin();
}

async function cmdSearch() {
  const keyword = process.argv.slice(3).join(" ").trim();
  if (!keyword) {
    log.err('Usage: node src/index.js search "your keywords here"');
    process.exitCode = 1;
    return;
  }
  const browser = await launchBrowser({ headless: false });
  try {
    const results = await searchViaBrowser(browser, keyword, { count: 15 });
    if (results.length === 0) {
      log.warn("No results.");
      return;
    }
    log.title(`Top results for "${keyword}"`);
    results.forEach((r, i) => {
      console.log(`${String(i + 1).padStart(2)}. ${(r.price || "").padEnd(8)} TCIN ${r.tcin}  ${r.title}`);
    });
    console.log("\nCopy a TCIN into config.json, or use keywords directly in a product entry.");
  } finally {
    await browser.close().catch(() => {});
  }
}

async function cmdCheck() {
  const config = loadConfig();
  // Target's data API is blocked, so checks run through a real browser.
  config.monitor.mode = "browser";
  const browser = await launchBrowser({ headless: false });
  await resolveProducts(config, browser);
  const monitor = createMonitor(config, { browser });

  for (const product of config.products) {
    if (!product.tcin) {
      log.warn(`${product.name || product.keywords}: not resolved to a TCIN yet.`);
      continue;
    }
    try {
      const r = await monitor.check(product);
      const tag = r.inStock ? "IN STOCK" : "out of stock";
      log.info(`${product.name || product.tcin}: ${tag} (${r.status}, qty ${r.available})`);
    } catch (err) {
      log.err(`${product.name || product.tcin}: ${err.message}`);
    }
  }
  if (browser) await browser.close().catch(() => {});
}

function wireEngineLogs() {
  const fns = { ok: log.ok, warn: log.warn, err: log.err, hit: log.hit, info: log.info };
  engine.on("event", (e) => {
    if (e.kind === "log") (fns[e.level] || log.info)(e.message);
  });
}

async function cmdRun() {
  log.title("Target Checkout Bot");
  wireEngineLogs();

  let stopping = false;
  process.on("SIGINT", async () => {
    if (stopping) process.exit(0);
    stopping = true;
    log.warn("Stopping… (press Ctrl+C again to force quit)");
    await engine.stop();
    process.exit(0);
  });

  await engine.start();
  // Keep the process alive while the engine loop runs.
  while (engine.running) await sleep(500);
}

function openBrowser(url) {
  const cmd =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* user can open manually */
  }
}

async function cmdUi() {
  const port = Number(process.argv[3]) || Number(process.env.PORT) || 5273;
  wireEngineLogs();
  await startServer({ port });
  const url = `http://localhost:${port}`;
  log.info(`Opening ${url} … (if it doesn't open, paste that into your browser)`);
  openBrowser(url);
  process.on("SIGINT", async () => {
    await engine.stop().catch(() => {});
    process.exit(0);
  });
  // Hold the process open.
  await new Promise(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELP = `
Target Checkout Bot — personal-use stock monitor + assisted checkout

Usage:
  node src/index.js <command>

Commands:
  ui [port]          Launch the web dashboard (default http://localhost:5273)
  login              Open a browser to sign in to Target (session is saved)
  search "<words>"   Search Target by keyword and print matching TCINs
  check              Check current stock for all products once and exit
  run                Continuously monitor and auto-checkout when in stock
  help               Show this message

First time:
  1) npm install && npx playwright install chromium
  2) node src/index.js ui      (then use the dashboard to log in & configure)
`;

async function main() {
  const cmd = (process.argv[2] || "help").toLowerCase();
  try {
    switch (cmd) {
      case "ui": return await cmdUi();
      case "login": return await cmdLogin();
      case "search": return await cmdSearch();
      case "check": return await cmdCheck();
      case "run": return await cmdRun();
      default: console.log(HELP);
    }
  } catch (err) {
    log.err(err.message);
    process.exitCode = 1;
  }
}

main();
