/**
 * Resolve proxyGroups + optional env credentials into Playwright/Chrome proxy options.
 * Env overlay: PROXY_<GROUP>_USER / PROXY_<GROUP>_PASS (group id uppercased, non-alnum → _).
 */

export function resolveProxyGroup(cfg = {}, groupName) {
  if (!groupName) return null;
  const groups = cfg.proxyGroups || {};
  const raw = groups[groupName];
  if (!raw) return null;

  const envKey = String(groupName).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const username = process.env[`PROXY_${envKey}_USER`] || raw.username || undefined;
  const password = process.env[`PROXY_${envKey}_PASS`] || raw.password || undefined;
  const server = raw.server || raw.url || null;
  if (!server) return null;

  return {
    server,
    username: username || undefined,
    password: password || undefined,
    group: groupName,
  };
}

/** Chrome CLI form: --proxy-server=host:port (auth via Playwright when using persistent context). */
export function chromeProxyArgs(proxy) {
  if (!proxy?.server) return [];
  // Playwright CDP Chrome: pass --proxy-server; credentials need extension or URL form
  let server = proxy.server;
  if (proxy.username && proxy.password && !/@/.test(server)) {
    try {
      const u = new URL(server.includes("://") ? server : `http://${server}`);
      u.username = proxy.username;
      u.password = proxy.password;
      server = u.toString().replace(/\/$/, "");
    } catch {
      /* keep plain server */
    }
  }
  return [`--proxy-server=${server.replace(/^https?:\/\//i, "")}`];
}

/** Playwright proxy option for launchPersistentContext. */
export function playwrightProxyOption(proxy) {
  if (!proxy?.server) return undefined;
  const out = { server: proxy.server };
  if (proxy.username) out.username = proxy.username;
  if (proxy.password) out.password = proxy.password;
  return out;
}
