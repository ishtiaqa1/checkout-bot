/**
 * Provider-neutral challenge registry.
 * Built-ins: manual, walmartHold, targetWall.
 * Optional paid providers can register via registerChallengeProvider(name, handler).
 */

const providers = new Map();

export function registerChallengeProvider(name, handler) {
  providers.set(String(name), handler);
}

export function listChallengeProviders() {
  return [...providers.keys()];
}

/** @typedef {{ kind: string, retailer?: string, accountId?: string, page?: any, signal?: AbortSignal, onLog?: Function, config?: object }} ChallengeContext */

/**
 * @param {ChallengeContext} ctx
 * @returns {Promise<{ status: 'solved'|'failed'|'needs_human', detail?: string, provider?: string }>}
 */
export async function handleChallenge(ctx = {}) {
  const cfg = ctx.config?.challenges || {};
  const kind = ctx.kind || "captcha";
  const preferred =
    (kind === "hold" && (cfg.hold?.provider || cfg.captcha?.provider)) ||
    (kind === "otp" && cfg.twoFactor?.provider) ||
    (kind === "email_code" && cfg.twoFactor?.provider) ||
    cfg.captcha?.provider ||
    "manual";

  const chain = [
    preferred !== "manual" ? preferred : null,
    kind === "hold" ? "walmartHold" : null,
    kind === "captcha" && ctx.retailer === "target" ? "targetWall" : null,
    "manual",
  ].filter(Boolean);

  const tried = new Set();
  for (const name of chain) {
    if (tried.has(name)) continue;
    tried.add(name);
    const handler = providers.get(name);
    if (!handler) continue;
    try {
      const result = await handler(ctx);
      if (result?.status === "solved" || result?.status === "needs_human") {
        return { ...result, provider: name };
      }
    } catch (err) {
      ctx.onLog?.("warn", `Challenge provider ${name}: ${err.message}`);
    }
  }
  return { status: "needs_human", detail: "No challenge provider solved it", provider: "none" };
}

// ---- built-in providers (registered at import) ----

registerChallengeProvider("manual", async (ctx) => {
  try {
    await ctx.page?.bringToFront?.();
  } catch {
    /* ignore */
  }
  ctx.onLog?.("warn", "Challenge needs human — solve it in bot Chrome.");
  return { status: "needs_human", detail: "Manual solve required" };
});

registerChallengeProvider("walmartHold", async (ctx) => {
  if (ctx.retailer && ctx.retailer !== "walmart" && ctx.kind !== "hold") {
    return { status: "failed", detail: "Not a Walmart hold" };
  }
  const { clearWalmartPxChallenge, needsWalmartHold } = await import("../walmart.js");
  const needs = await needsWalmartHold(ctx.page).catch(() => false);
  if (!needs) return { status: "solved", detail: "No hold present" };
  const ok = await clearWalmartPxChallenge(ctx.page, {
    onLog: ctx.onLog,
    urgent: true,
    maxAttempts: 4,
  });
  if (ok) return { status: "solved", detail: "Press & Hold cleared" };
  try {
    await ctx.page?.bringToFront?.();
  } catch {
    /* ignore */
  }
  return { status: "needs_human", detail: "Hold not cleared — manual required" };
});

registerChallengeProvider("targetWall", async (ctx) => {
  const wall = await ctx.page
    ?.evaluate(() => {
      const t = (document.body?.innerText || "").slice(0, 2000);
      return /verify you.?re a human|access denied|unusual activity/i.test(t);
    })
    .catch(() => false);
  if (!wall) return { status: "solved", detail: "No Target wall" };
  try {
    await ctx.page?.bringToFront?.();
  } catch {
    /* ignore */
  }
  ctx.onLog?.("warn", "Target bot wall — solve in browser or refresh session.");
  return { status: "needs_human", detail: "Target access wall" };
});
