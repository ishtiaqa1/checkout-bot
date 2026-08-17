import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SECRETS_PATH = path.join(ROOT, "data", "local-secrets.json");

/** CVV and similar secrets stay off config.json — local PC only. */
export function loadLocalSecrets() {
  try {
    if (!fs.existsSync(SECRETS_PATH)) return {};
    return JSON.parse(fs.readFileSync(SECRETS_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

export function saveLocalSecrets(patch = {}) {
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
  const next = { ...loadLocalSecrets(), ...patch, updatedAt: Date.now() };
  // Never leave empty CVV keys lying around.
  if (!next.cvv) delete next.cvv;
  if (next.rememberCvv === false) delete next.cvv;
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function getSavedCvv() {
  const secrets = loadLocalSecrets();
  if (secrets.rememberCvv === false) return "";
  return String(secrets.cvv || "").replace(/\D/g, "").slice(0, 4);
}
