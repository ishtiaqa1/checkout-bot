import notifier from "node-notifier";
import { log } from "./logger.js";

/** After one Windows toaster spawn failure, skip desktop toasts for the rest of the process. */
let desktopDisabled = false;

/**
 * Fire-and-forget alerts. Must never throw or crash the Node process —
 * node-notifier's SnoreToast spawn has killed the bot mid-drop before.
 */
export function notify(config, { title, message }) {
  if (config?.notifications?.sound) {
    try {
      process.stdout.write("\u0007");
    } catch {
      /* ignore */
    }
  }

  if (!config?.notifications?.desktop || desktopDisabled) return;

  const payload = {
    title: title || "Checkout Bot",
    message: String(message || "").slice(0, 200),
    sound: false, // bell already handled above; avoid double OS sound spawn
    wait: false,
  };

  // Defer so a sync/async spawn failure cannot unwind checkout/monitor stacks.
  setImmediate(() => {
    if (desktopDisabled) return;
    try {
      notifier.notify(payload, (err) => {
        if (!err) return;
        desktopDisabled = true;
        log.warn(`Desktop notifications disabled (bot stays up): ${err.message || err}`);
      });
    } catch (err) {
      desktopDisabled = true;
      log.warn(`Desktop notifications disabled (bot stays up): ${err.message || err}`);
    }
  });
}
