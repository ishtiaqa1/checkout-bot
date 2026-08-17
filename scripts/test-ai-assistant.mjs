#!/usr/bin/env node
/**
 * Offline test for the AI assistant recovery logic — no browser, no network.
 * Feeds canned page snapshots through recoverStalledCheckout via a mock page
 * and asserts the heuristics pick the right action. Run: npm run test-ai
 */
import { recoverStalledCheckout, aiAssistantSettings } from "../src/aiAssistant.js";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Mock Playwright page: returns a canned snapshot, records actions. */
function mockPage(snapshot) {
  const actions = [];
  return {
    actions,
    isClosed: () => false,
    url: () => snapshot.url,
    evaluate: async (fnOrString, arg) => {
      // snapshotPage passes a function with no arg; executeAction("click") passes button text.
      if (arg !== undefined) {
        actions.push({ type: "click", text: arg });
        return true;
      }
      return snapshot;
    },
    reload: async () => actions.push({ type: "reload" }),
    goto: async (url) => actions.push({ type: "goto", url }),
  };
}

const product = { name: "Test ETB", tcin: "12345678" };
const cfg = { aiAssistant: { enabled: true, stallSeconds: 1, maxStepsPerRecovery: 1 } }; // no API key → heuristics only
const quietLog = () => {};

async function main() {
  console.log("AI assistant heuristics test (offline)\n");

  // 1. Defaults sanity.
  const s = aiAssistantSettings({});
  check(
    "settings defaults",
    s.enabled && s.stallSeconds === 18 && s.maxRecoveriesPerCheckout === 2 && s.maxStepsPerRecovery === 4,
    JSON.stringify(s)
  );

  // 2. Target error page with a retry button → clicks it.
  {
    const page = mockPage({
      url: "https://www.target.com/checkout",
      title: "Target",
      hasDialog: false,
      dialogText: "",
      bodyText: "We're sorry, something went wrong. High traffic is causing delays.",
      buttons: [{ text: "Try again", dataTest: "", disabled: false }],
    });
    await recoverStalledCheckout(page, product, cfg, { log: quietLog });
    check(
      "error page → click Try again",
      page.actions.some((a) => a.type === "click" && /try again/i.test(a.text)),
      JSON.stringify(page.actions)
    );
  }

  // 3. Error page without buttons → reload.
  {
    const page = mockPage({
      url: "https://www.target.com/checkout",
      title: "Target",
      hasDialog: false,
      dialogText: "",
      bodyText: "This page is currently unavailable.",
      buttons: [],
    });
    await recoverStalledCheckout(page, product, cfg, { log: quietLog });
    check("unavailable page → reload", page.actions.some((a) => a.type === "reload"), JSON.stringify(page.actions));
  }

  // 4. Blocking dialog → dismissed with a safe button.
  {
    const page = mockPage({
      url: "https://www.target.com/checkout",
      title: "Target",
      hasDialog: true,
      dialogText: "Want to add a protection plan?",
      bodyText: "checkout page content",
      buttons: [
        { text: "Add protection plan", dataTest: "", disabled: false },
        { text: "No thanks", dataTest: "", disabled: false },
      ],
    });
    await recoverStalledCheckout(page, product, cfg, { log: quietLog });
    check(
      "upsell dialog → click No thanks",
      page.actions.some((a) => a.type === "click" && /no thanks/i.test(a.text)),
      JSON.stringify(page.actions)
    );
  }

  // 5. Captcha → notify (needs human), never clicks.
  {
    const page = mockPage({
      url: "https://www.target.com/checkout",
      title: "Target",
      hasDialog: false,
      dialogText: "",
      bodyText: "Please verify you're a human. Press and hold the button.",
      buttons: [{ text: "Continue", dataTest: "", disabled: false }],
    });
    const out = await recoverStalledCheckout(page, product, cfg, { log: quietLog });
    check("captcha → needs human, no clicks", out.needsHuman && page.actions.length === 0, JSON.stringify(out.steps));
  }

  // 6. Never clicks Place order unless allowed.
  {
    const snap = {
      url: "https://www.target.com/checkout",
      title: "Target",
      hasDialog: false,
      dialogText: "",
      bodyText: "Review your order details below.",
      buttons: [{ text: "Place your order", dataTest: "placeOrderButton", disabled: false }],
    };
    const blocked = mockPage(snap);
    await recoverStalledCheckout(blocked, product, cfg, { log: quietLog, allowPlaceOrder: false });
    const allowed = mockPage(snap);
    await recoverStalledCheckout(allowed, product, cfg, { log: quietLog, allowPlaceOrder: true });
    check(
      "place-order safety gate",
      !blocked.actions.some((a) => a.type === "click") &&
        allowed.actions.some((a) => a.type === "click" && /place your order/i.test(a.text)),
      `blocked=${JSON.stringify(blocked.actions)} allowed=${JSON.stringify(allowed.actions)}`
    );
  }

  // 7. Bounced to cart → clicks checkout.
  {
    const page = mockPage({
      url: "https://www.target.com/cart",
      title: "Cart",
      hasDialog: false,
      dialogText: "",
      bodyText: "1 item in your cart",
      buttons: [{ text: "Check out", dataTest: "checkout-button", disabled: false }],
    });
    await recoverStalledCheckout(page, product, cfg, { log: quietLog });
    check(
      "cart page → click Check out",
      page.actions.some((a) => a.type === "click" && /check ?out/i.test(a.text)),
      JSON.stringify(page.actions)
    );
  }

  // 8. Forbidden buttons are never clicked even when stuck.
  {
    const page = mockPage({
      url: "https://www.target.com/checkout",
      title: "Target",
      hasDialog: true,
      dialogText: "Are you sure?",
      bodyText: "checkout",
      buttons: [
        { text: "Remove item", dataTest: "", disabled: false },
        { text: "Sign out", dataTest: "", disabled: false },
      ],
    });
    await recoverStalledCheckout(page, product, cfg, { log: quietLog });
    check("forbidden buttons never clicked", !page.actions.some((a) => a.type === "click"), JSON.stringify(page.actions));
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  if (fails.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
