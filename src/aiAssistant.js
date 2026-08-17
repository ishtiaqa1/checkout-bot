/**
 * AI assistant — watches checkouts and recovers stalls (inspired by Polar Assist's
 * "AI recovery"). When a checkout stops progressing, it samples the live page and
 * takes a safe next step: dismiss a dialog, click continue/try-again, reload, or
 * hop to cart/checkout. Heuristics run first (free, instant); if they don't match
 * and an OpenAI key is configured, the model picks from the same constrained
 * action set. It never clicks "Place order" unless auto-place-order is enabled.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalize the aiAssistant config block with defaults + env fallback. */
export function aiAssistantSettings(cfg = {}) {
  const ai = cfg.aiAssistant || {};
  return {
    enabled: ai.enabled !== false,
    apiKey: process.env.OPENAI_API_KEY || ai.openaiApiKey || "",
    model: ai.model || "gpt-4o-mini",
    stallSeconds: Number(ai.stallSeconds) > 0 ? Number(ai.stallSeconds) : 18,
    maxRecoveriesPerCheckout: Number(ai.maxRecoveriesPerCheckout) > 0 ? Number(ai.maxRecoveriesPerCheckout) : 2,
    maxStepsPerRecovery: Number(ai.maxStepsPerRecovery) > 0 ? Number(ai.maxStepsPerRecovery) : 4,
  };
}

/** Collect what the assistant needs to reason about the page. */
async function snapshotPage(page) {
  return page
    .evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const describe = (el) => ({
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
        dataTest: el.getAttribute("data-test") || "",
        disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true"),
      });
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"], [data-test*="modal" i]');
      const scope = dialog && visible(dialog) ? dialog : document;
      const buttons = [...scope.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .slice(0, 40)
        .map(describe)
        .filter((b) => b.text || b.dataTest);
      return {
        url: location.href,
        title: (document.title || "").slice(0, 120),
        hasDialog: !!(dialog && visible(dialog)),
        dialogText: dialog && visible(dialog) ? (dialog.innerText || "").replace(/\s+/g, " ").slice(0, 500) : "",
        bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1800),
        buttons,
      };
    })
    .catch(() => null);
}

const SAFE_CLICK_RE =
  /^(continue|try again|retry|got it|ok(ay)?|yes,? continue|no thanks|not now|maybe later|close|dismiss|save (&|and) continue|continue to checkout|check ?out|view cart (&|and) check ?out|proceed|confirm|keep item|continue shopping)$/i;
const FORBIDDEN_CLICK_RE =
  /sign out|log ?out|delete|remove|cancel order|clear cart|pick ?up|drive ?up/i;
const PLACE_ORDER_RE = /^place (your )?order$/i;

/** Rule-based recovery for known Target failure modes. Returns an action or null. */
function heuristicAction(snap, { allowPlaceOrder }) {
  const body = `${snap.dialogText} ${snap.bodyText}`;

  if (/verify you('| a)re a human|captcha|bot challenge|press and hold/i.test(body)) {
    return { action: "notify", reason: "Captcha / bot challenge — needs a human" };
  }
  if (/page is currently unavailable|we're sorry|something went wrong|high traffic|heavy traffic|try again later/i.test(body)) {
    const retryBtn = snap.buttons.find((b) => !b.disabled && /try again|retry|reload/i.test(b.text));
    if (retryBtn) return { action: "click", buttonText: retryBtn.text, reason: "Error page with retry button" };
    return { action: "reload", reason: "Target error page — reloading" };
  }
  if (/session expired|sign in to continue|please sign in/i.test(body)) {
    return { action: "notify", reason: "Session expired — sign in needed" };
  }

  // A dialog is blocking progress — prefer a safe continue/dismiss inside it.
  if (snap.hasDialog) {
    const btn = snap.buttons.find(
      (b) => !b.disabled && SAFE_CLICK_RE.test(b.text) && !FORBIDDEN_CLICK_RE.test(b.text)
    );
    if (btn) return { action: "click", buttonText: btn.text, reason: "Dismissing blocking dialog" };
  }

  // Stuck mid-flow with an obvious next-step button on screen.
  const next = snap.buttons.find(
    (b) =>
      !b.disabled &&
      !FORBIDDEN_CLICK_RE.test(b.text) &&
      (/^(save (&|and) continue|continue to checkout|check ?out|view cart (&|and) check ?out)$/i.test(b.text) ||
        (allowPlaceOrder && PLACE_ORDER_RE.test(b.text)))
  );
  if (next) return { action: "click", buttonText: next.text, reason: "Clicking visible next-step button" };

  // Bounced to the cart page with items in it — push toward checkout.
  if (/\/cart/i.test(snap.url)) {
    const co = snap.buttons.find((b) => !b.disabled && /check ?out/i.test(b.text));
    if (co) return { action: "click", buttonText: co.text, reason: "On cart page — continuing to checkout" };
  }

  return null;
}

/** Ask OpenAI to pick a recovery action from the constrained set. */
async function openAiAction(snap, settings, { allowPlaceOrder, phase, productName }) {
  const system = [
    "You are a checkout recovery assistant for a Target.com purchase bot.",
    "A checkout has stalled. Given a snapshot of the page, choose ONE next action as JSON:",
    '{"action":"click","buttonText":"<exact text of a listed button>","reason":"..."}',
    '{"action":"reload","reason":"..."} — reload the current page',
    '{"action":"goto_cart","reason":"..."} — navigate to the cart',
    '{"action":"goto_checkout","reason":"..."} — navigate to /checkout',
    '{"action":"wait","reason":"..."} — the page is still working, do nothing',
    '{"action":"notify","reason":"..."} — a human is required (captcha, sign-in, payment issue)',
    "Rules: only click buttons from the provided list. Never click anything related to signing out,",
    "removing/deleting items, cancelling, or store pickup.",
    allowPlaceOrder
      ? 'Clicking "Place your order" IS allowed if it completes the purchase.'
      : 'NEVER click "Place your order" or any final purchase button.',
    "Prefer the smallest action that unblocks the checkout. Respond with JSON only.",
  ].join("\n");

  const user = JSON.stringify({
    product: productName,
    stalledPhase: phase,
    url: snap.url,
    title: snap.title,
    hasDialog: snap.hasDialog,
    dialogText: snap.dialogText,
    pageTextExcerpt: snap.bodyText.slice(0, 1200),
    buttons: snap.buttons,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
    const data = await res.json();
    const action = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    if (!action?.action) return null;
    return action;
  } finally {
    clearTimeout(timer);
  }
}

/** Validate an action (especially model output) against the snapshot + safety rules. */
function validateAction(action, snap, { allowPlaceOrder }) {
  if (!action || typeof action !== "object") return null;
  const kind = String(action.action || "");
  if (["reload", "goto_cart", "goto_checkout", "wait", "notify"].includes(kind)) return action;
  if (kind !== "click") return null;
  const text = String(action.buttonText || "").trim();
  if (!text || FORBIDDEN_CLICK_RE.test(text)) return null;
  if (PLACE_ORDER_RE.test(text) && !allowPlaceOrder) return null;
  const match = snap.buttons.find((b) => !b.disabled && b.text.toLowerCase() === text.toLowerCase());
  if (!match) return null;
  return { ...action, buttonText: match.text };
}

/** Perform the chosen action on the page. */
async function executeAction(page, action) {
  switch (action.action) {
    case "click": {
      const clicked = await page
        .evaluate((wanted) => {
          const visible = (el) => {
            const s = getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden") return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const dialog = document.querySelector('[role="dialog"], [role="alertdialog"], [data-test*="modal" i]');
          const scopes = dialog && visible(dialog) ? [dialog, document] : [document];
          for (const scope of scopes) {
            for (const el of scope.querySelectorAll('button, [role="button"]')) {
              const text = (el.textContent || "").replace(/\s+/g, " ").trim();
              if (text.toLowerCase() === wanted.toLowerCase() && visible(el) && !el.disabled) {
                el.click();
                return true;
              }
            }
          }
          return false;
        }, action.buttonText)
        .catch(() => false);
      return clicked;
    }
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      return true;
    case "goto_cart":
      await page.goto("https://www.target.com/cart", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      return true;
    case "goto_checkout":
      await page.goto("https://www.target.com/checkout", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      return true;
    case "wait":
      await sleep(3000);
      return true;
    default:
      return false;
  }
}

/**
 * One recovery pass on a stalled checkout: up to maxStepsPerRecovery actions.
 * Returns { steps: [...], needsHuman: bool }.
 */
export async function recoverStalledCheckout(page, product, cfg, { log = () => {}, phase = "unknown", allowPlaceOrder = false } = {}) {
  const settings = aiAssistantSettings(cfg);
  const label = product.name || product.tcin || "product";
  const steps = [];
  let needsHuman = false;

  for (let step = 0; step < settings.maxStepsPerRecovery; step++) {
    if (!page || page.isClosed?.()) break;
    const snap = await snapshotPage(page);
    if (!snap) break;

    let action = heuristicAction(snap, { allowPlaceOrder });
    let decidedBy = "heuristic";

    if (!action && settings.apiKey) {
      try {
        const raw = await openAiAction(snap, settings, { allowPlaceOrder, phase, productName: label });
        action = validateAction(raw, snap, { allowPlaceOrder });
        decidedBy = "openai";
      } catch (err) {
        log("warn", `${label}: OpenAI recovery call failed (${err.message}) — heuristics only.`);
      }
    } else if (action) {
      action = validateAction(action, snap, { allowPlaceOrder }) || action;
    }

    if (!action) {
      if (step === 0) log("info", `${label}: no recovery action found — page may just be slow.`);
      break;
    }

    if (action.action === "notify") {
      needsHuman = true;
      log("warn", `${label}: NEEDS YOU — ${action.reason}`);
      steps.push({ ...action, decidedBy });
      break;
    }
    if (action.action === "wait") {
      steps.push({ ...action, decidedBy });
      await executeAction(page, action);
      break;
    }

    const desc = action.action === "click" ? `click "${action.buttonText}"` : action.action.replace("_", " ");
    log("ok", `${label}: ${desc} (${decidedBy}) — ${action.reason || "recovering"}`);
    const done = await executeAction(page, action);
    steps.push({ ...action, decidedBy, done });
    if (!done) break;
    await sleep(2500);
  }

  return { steps, needsHuman };
}
