/**
 * Monitor watchdog — rule-first discrepancy detection for monitor/checkout tabs.
 * Inspired by AIO "watch task" health checks. AI may diagnose; only allowlisted actions run.
 */

import { needsWalmartHold, detectWalmartQueueState, isWalmartLoggedOut } from "./walmart.js";
import { isLoggedOut } from "./checkout.js";

const ALLOWED_ACTIONS = new Set(["notify", "bring_front", "reload_safe", "wait", "recover_tab"]);

/**
 * Sample a monitor/checkout page and return issues + safe suggested action.
 * @returns {{ issues: string[], action: {action:string,reason:string}|null, snapshot: object }}
 */
export async function inspectMonitorPage(page, { retailer = "target", expectInQueue = false, product = null } = {}) {
  const issues = [];
  let snapshot = { url: "", title: "", bodySnippet: "" };

  if (!page || page.isClosed?.()) {
    return {
      issues: ["page_closed"],
      action: { action: "notify", reason: "Monitor tab closed" },
      snapshot,
    };
  }

  try {
    snapshot = await page.evaluate(() => ({
      url: location.href,
      title: (document.title || "").slice(0, 120),
      bodySnippet: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 500),
    }));
  } catch (err) {
    const msg = err?.message || String(err);
    issues.push("evaluate_failed");
    // Crashed renderer — recover the tab; do not spam desktop toasts (that killed Node before).
    const crashed = /Target crashed|crashed|Session closed|Target closed|has been closed/i.test(msg);
    return {
      issues: crashed ? [...issues, "target_crashed"] : issues,
      action: {
        action: crashed ? "recover_tab" : "notify",
        reason: msg,
      },
      snapshot,
    };
  }

  if (retailer === "walmart") {
    if (await isWalmartLoggedOut(page).catch(() => false)) {
      issues.push("logged_out");
    }
    if (await needsWalmartHold(page).catch(() => false)) {
      issues.push("px_hold");
    }
    const q = await detectWalmartQueueState(page).catch(() => ({ inQueue: false }));
    if (expectInQueue && !q.inQueue) {
      issues.push("queue_expected_missing");
    }
    if (!expectInQueue && q.inQueue) {
      issues.push("unexpected_queue");
    }
    if (/couldn.?t find this page|page not found|404/i.test(snapshot.bodySnippet)) {
      issues.push("not_found");
    }
  } else {
    if (await isLoggedOut(page).catch(() => false)) {
      issues.push("logged_out");
    }
    if (/verify you.?re a human|access denied|bot challenge/i.test(snapshot.bodySnippet)) {
      issues.push("bot_challenge");
    }
    if (product?.tcin && snapshot.url && !snapshot.url.includes(String(product.tcin)) && /\/p\//i.test(snapshot.url)) {
      issues.push("wrong_product_page");
    }
  }

  let action = null;
  if (issues.includes("logged_out") || issues.includes("bot_challenge") || issues.includes("px_hold")) {
    action = { action: "notify", reason: `Needs you: ${issues.join(", ")}` };
  } else if (issues.includes("not_found") || issues.includes("wrong_product_page")) {
    action = { action: "reload_safe", reason: "Wrong/missing product page" };
  } else if (issues.includes("queue_expected_missing")) {
    action = { action: "wait", reason: "Expected queue UI not visible yet" };
  } else if (issues.length) {
    action = { action: "notify", reason: issues.join(", ") };
  }

  if (action && !ALLOWED_ACTIONS.has(action.action)) {
    action = { action: "notify", reason: action.reason };
  }

  return { issues, action, snapshot };
}

export { ALLOWED_ACTIONS as WATCHDOG_ALLOWED_ACTIONS };
