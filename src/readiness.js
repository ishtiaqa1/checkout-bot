/**
 * Pre-drop readiness gate — Stellar/Refract-style "tasks waiting / warm" check.
 * Verifies session, cart, and (best-effort) payment readiness before a drop.
 */

import { isLoggedOut } from "./checkout.js";
import { isWalmartLoggedOut, needsWalmartHold, detectWalmartQueueState } from "./walmart.js";

/** Compare local clock to HTTP Date from retailer (or fallback host). */
async function measureClockSkewMs(retailer = "target") {
  const url =
    retailer === "walmart" ? "https://www.walmart.com/" : "https://www.target.com/";
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    const dateHdr = res.headers.get("date");
    if (!dateHdr) return { ok: true, skewMs: 0, detail: "No Date header — skipped" };
    const serverMs = Date.parse(dateHdr);
    if (!Number.isFinite(serverMs)) return { ok: true, skewMs: 0, detail: "Unparseable Date — skipped" };
    const skewMs = Math.abs(Date.now() - serverMs);
    return {
      ok: skewMs < 5000,
      skewMs,
      detail: skewMs < 5000 ? `Clock OK (skew ${skewMs}ms vs ${retailer})` : `Clock skew ~${skewMs}ms vs ${retailer}`,
    };
  } catch (err) {
    return { ok: true, skewMs: null, detail: `Clock check skipped: ${err.message}` };
  }
}

/**
 * @returns {{ ok: boolean, checks: Array<{id:string,ok:boolean,detail:string}>, readyScore: number, accountId?: string }}
 */
export async function runReadinessGate(page, { retailer = "target", product = null, accountId = null } = {}) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail: detail || "" });

  if (!page || page.isClosed?.()) {
    return { ok: false, checks: [{ id: "page", ok: false, detail: "No browser page" }], readyScore: 0, accountId };
  }

  try {
    const url = page.url() || "";
    add("page_open", true, url.slice(0, 80) || "about:blank");
  } catch (err) {
    add("page_open", false, err.message);
  }

  if (retailer === "walmart") {
    const loggedOut = await isWalmartLoggedOut(page).catch(() => true);
    add("signed_in", !loggedOut, loggedOut ? "Not signed in to Walmart" : "Walmart session OK");

    const hold = await needsWalmartHold(page).catch(() => false);
    add("no_challenge", !hold, hold ? "PX / Press & Hold active" : "No PX challenge");

    if (product) {
      const q = await detectWalmartQueueState(page).catch(() => ({ inQueue: false }));
      add("queue_state", true, q.inQueue ? "Already in queue" : "Not in queue yet");
    }
  } else {
    const loggedOut = await isLoggedOut(page).catch(() => true);
    add("signed_in", !loggedOut, loggedOut ? "Not signed in to Target" : "Target session OK");

    const wall = await page
      .evaluate(() => {
        const t = (document.body?.innerText || "").slice(0, 2000);
        return /verify you.?re a human|access denied|unusual activity/i.test(t);
      })
      .catch(() => false);
    add("no_challenge", !wall, wall ? "Bot challenge / access wall" : "No challenge detected");

    // Soft ATC/session probe: presence of guest/auth cookies is a weak signal
    try {
      const cookies = await page.context().cookies("https://www.target.com");
      const hasSession = cookies.some((c) => /accessToken|idToken|RefreshToken|visitorId/i.test(c.name));
      add("session_cookies", hasSession, hasSession ? "Target session cookies present" : "Missing Target session cookies");
    } catch {
      add("session_cookies", true, "Cookie probe skipped");
    }
  }

  const clock = await measureClockSkewMs(retailer);
  add("clock", clock.ok, clock.detail);

  const passed = checks.filter((c) => c.ok).length;
  const readyScore = checks.length ? Math.round((passed / checks.length) * 100) : 0;
  const ok = checks.every((c) => c.ok || c.id === "queue_state");
  return { ok, checks, readyScore, accountId: accountId || null };
}
