/**
 * Circuit breaker + retry budget for retailer API / checkout paths.
 * Prevents hammering a dead session or rate-limited endpoint.
 */

export function createCircuitBreaker({
  name = "circuit",
  failureThreshold = 4,
  cooldownMs = 15000,
  halfOpenMax = 1,
} = {}) {
  let failures = 0;
  let state = "closed"; // closed | open | half_open
  let openedAt = 0;
  let halfOpenAttempts = 0;

  const snapshot = () => ({ name, state, failures, openedAt, cooldownMs });

  const allow = () => {
    if (state === "closed") return true;
    if (state === "open") {
      if (Date.now() - openedAt >= cooldownMs) {
        state = "half_open";
        halfOpenAttempts = 0;
        return true;
      }
      return false;
    }
    // half_open
    if (halfOpenAttempts < halfOpenMax) {
      halfOpenAttempts += 1;
      return true;
    }
    return false;
  };

  const success = () => {
    failures = 0;
    state = "closed";
    halfOpenAttempts = 0;
  };

  const failure = () => {
    failures += 1;
    if (state === "half_open" || failures >= failureThreshold) {
      state = "open";
      openedAt = Date.now();
    }
  };

  return { allow, success, failure, snapshot, get state() { return state; } };
}

/** Per-key order dedupe — avoid double place-order on the same product/account. */
export function createOrderGuard({ ttlMs = 120000 } = {}) {
  const locks = new Map(); // key -> expiresAt

  const tryAcquire = (key) => {
    const now = Date.now();
    for (const [k, exp] of locks) {
      if (exp <= now) locks.delete(k);
    }
    if (locks.has(key)) return false;
    locks.set(key, now + ttlMs);
    return true;
  };

  const release = (key) => {
    locks.delete(key);
  };

  const isLocked = (key) => {
    const exp = locks.get(key);
    if (!exp) return false;
    if (exp <= Date.now()) {
      locks.delete(key);
      return false;
    }
    return true;
  };

  return { tryAcquire, release, isLocked };
}
