/**
 * Target Pokémon drop timing (2025–2026 community trackers):
 * - New product drops: overnight ~1–4 AM ET, peak ~3 AM; often Friday, lately Tuesday too.
 * - Items usually appear one at a time — staggered tab checks help more than hammering one page.
 * - Afternoon restocks (existing SKUs): ~2–6 PM ET weekdays, peak ~5 PM.
 */

const DAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Built-in windows when config doesn't override. */
export const DEFAULT_DROP_WINDOWS = [
  {
    id: "friday-drops",
    label: "Friday drop window (2:55–5 AM ET)",
    days: [5],
    startHour: 2,
    startMinute: 55,
    endHour: 5,
    endMinute: 0,
    pollIntervalMs: 2000,
    jitterMs: 300,
    maxConcurrentChecks: 12,
    lightPollsPerReload: 6,
  },
  {
    id: "tuesday-drops",
    label: "Tuesday drop window (2:55–5 AM ET)",
    days: [2],
    startHour: 2,
    startMinute: 55,
    endHour: 5,
    endMinute: 0,
    pollIntervalMs: 2000,
    jitterMs: 300,
    maxConcurrentChecks: 12,
    lightPollsPerReload: 6,
  },
  {
    id: "afternoon-restock",
    label: "Afternoon restock window (2–6 PM ET)",
    days: [1, 2, 3, 4, 5],
    startHour: 14,
    startMinute: 0,
    endHour: 18,
    endMinute: 0,
    pollIntervalMs: 4000,
    jitterMs: 600,
    maxConcurrentChecks: 10,
    lightPollsPerReload: 4,
  },
  {
    // Listed before the broader 6–10 PM window so ~9 PM ET queue drops get fast activation.
    id: "walmart-evening-drop",
    label: "Walmart evening drop (8:45–10:15 PM ET)",
    days: [0, 1, 2, 3, 4, 5, 6],
    startHour: 20,
    startMinute: 45,
    endHour: 22,
    endMinute: 15,
    pollIntervalMs: 1500,
    jitterMs: 200,
    maxConcurrentChecks: 12,
    lightPollsPerReload: 6,
  },
  {
    id: "evening-restock",
    label: "Evening restock window (6–10 PM ET)",
    days: [0, 1, 2, 3, 4, 5, 6],
    startHour: 18,
    startMinute: 0,
    endHour: 22,
    endMinute: 0,
    pollIntervalMs: 6000,
    jitterMs: 800,
    maxConcurrentChecks: 8,
    lightPollsPerReload: 3,
  },
];

const ET_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
  hour12: false,
  minute: "numeric",
  second: "numeric",
});

/** Parse date parts in US Eastern (handles DST automatically). */
export function getEtDateParts(date = new Date()) {
  const parts = Object.fromEntries(
    ET_DATE_FORMATTER.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  return {
    day: DAY_MAP[parts.weekday] ?? 0,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second) || 0,
  };
}

/** True when time falls in [start, end) on a 24h clock (supports minutes + optional seconds). */
export function isTimeInRange(
  hour,
  minute,
  startHour,
  endHour,
  startMinute = 0,
  endMinute = 0,
  second = 0,
  startSecond = 0,
  endSecond = 0
) {
  const t = hour * 3600 + minute * 60 + (Number(second) || 0);
  const start = startHour * 3600 + startMinute * 60 + (Number(startSecond) || 0);
  const end = endHour * 3600 + endMinute * 60 + (Number(endSecond) || 0);
  return t >= start && t < end;
}

/**
 * Return the active configured drop window, if any.
 * Supports activationLeadMs / activationLeadSeconds to pre-arm before the window opens.
 */
export function getActiveDropWindow(monitorConfig = {}, date = new Date()) {
  if (monitorConfig.dropWindow?.enabled === false) return null;
  const windows = monitorConfig.dropWindow?.windows?.length
    ? monitorConfig.dropWindow.windows
    : DEFAULT_DROP_WINDOWS;
  const leadMs =
    Number(monitorConfig.walmart?.activationLeadMs) > 0
      ? Number(monitorConfig.walmart.activationLeadMs)
      : Number(monitorConfig.dropWindow?.activationLeadMs) > 0
        ? Number(monitorConfig.dropWindow.activationLeadMs)
        : 5000;
  const { day, hour, minute, second } = getEtDateParts(date);
  for (const w of windows) {
    if (!Array.isArray(w.days) || !w.days.includes(day)) continue;
    const startMinute = w.startMinute ?? 55;
    const leadSec = Math.floor(leadMs / 1000);
    const leadMinute = Math.floor(leadSec / 60);
    const leadSecond = leadSec % 60;
    let adjStartMinute = startMinute - leadMinute;
    let adjStartHour = w.startHour ?? 2;
    let adjStartSecond = (w.startSecond ?? 0) - leadSecond;
    if (adjStartSecond < 0) {
      adjStartSecond += 60;
      adjStartMinute -= 1;
    }
    while (adjStartMinute < 0) {
      adjStartMinute += 60;
      adjStartHour = (adjStartHour + 23) % 24;
    }
    if (
      !isTimeInRange(
        hour,
        minute,
        adjStartHour,
        w.endHour ?? 5,
        adjStartMinute,
        w.endMinute ?? 0,
        second,
        adjStartSecond,
        w.endSecond ?? 0
      )
    )
      continue;
    return { ...w, preArmed: leadMs > 0 };
  }
  return null;
}

/** During drops every product gets the same fast interval — don't slow down large watchlists. */
export function scalePollForProductCount(baseMs, productCount, { dropWindow = false } = {}) {
  if (dropWindow) return baseMs;
  if (productCount <= 3) return baseMs;
  if (productCount <= 6) return Math.round(baseMs * 1.2);
  if (productCount <= 10) return Math.round(baseMs * 1.4);
  return Math.round(baseMs * 1.55);
}

/**
 * Merge drop-window overrides into monitor settings for the current moment.
 * Outside a window, returns the user's normal poll settings.
 */
export function getEffectiveMonitor(monitor = {}, productCount = 1, { dropMode = false, hypeMode = false, date = new Date() } = {}) {
  const active = getActiveDropWindow(monitor, date);
  if (active) {
    const hype = hypeMode !== false;
    const base = active.pollIntervalMs ?? (hype ? 2000 : 3500);
    return {
      ...monitor,
      pollIntervalMs: scalePollForProductCount(base, productCount, { dropWindow: true }),
      jitterMs: active.jitterMs ?? (hype ? 400 : 800),
      maxConcurrentChecks: active.maxConcurrentChecks ?? (hype ? 10 : 6),
      lightPollsPerReload: active.lightPollsPerReload ?? (hype ? 5 : 4),
      useLightPolls: monitor.useLightPolls !== false,
      staggerChecks: false,
      dropWindowActive: true,
      dropWindowLabel: active.label || "Drop window",
      fastChecks: true,
      hypePolling: hype,
    };
  }
  const hypeOffHours = dropMode && hypeMode !== false;
  return {
    ...monitor,
    dropWindowActive: false,
    dropWindowLabel: null,
    fastChecks: !!dropMode,
    hypePolling: hypeOffHours,
    useLightPolls: hypeOffHours && monitor.useLightPolls !== false,
    lightPollsPerReload: monitor.lightPollsPerReload ?? 3,
    pollIntervalMs: hypeOffHours
      ? scalePollForProductCount(monitor.hypePollIntervalMs ?? 8000, productCount, { dropWindow: false })
      : monitor.pollIntervalMs,
    maxConcurrentChecks: hypeOffHours
      ? Math.max(monitor.maxConcurrentChecks ?? 2, 6)
      : monitor.maxConcurrentChecks,
  };
}
