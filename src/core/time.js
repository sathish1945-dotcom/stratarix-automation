/**
 * Timezone-aware date utilities.
 *
 * Design notes
 * - Instants are stored as epoch milliseconds (UTC) in the database.
 * - The user's IANA timezone is stored alongside each task so that "Today",
 *   "Overdue" and repeat rules are evaluated in the user's local time even when
 *   the server runs in a different region (this is why we never use
 *   `new Date().getDate()` on the server).
 * - `Intl.DateTimeFormat` instances are cached because constructing them is
 *   comparatively expensive and these helpers run on every list request.
 */

const formatterCache = new Map();
const MAX_CACHE = 40;

function partsFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (formatterCache.size >= MAX_CACHE) formatterCache.clear();
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function isValidTimezone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function safeTimezone(timeZone, fallback = 'UTC') {
  return typeof timeZone === 'string' && timeZone.length <= 64 && isValidTimezone(timeZone) ? timeZone : fallback;
}

/** Wall-clock parts of an instant in a given zone. */
export function zonedParts(ms, timeZone) {
  const parts = partsFormatter(timeZone).formatToParts(new Date(ms));
  const value = {};
  for (const part of parts) {
    if (part.type !== 'literal') value[part.type] = part.value;
  }
  // `hour: '2-digit'` with hour12:false can render midnight as "24".
  const hour = Number(value.hour) % 24;
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    hour,
    minute: Number(value.minute),
    second: Number(value.second),
  };
}

function zoneOffsetMs(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Convert a wall-clock time in a zone to an instant.
 * DST gaps and overlaps resolve to the closest valid instant.
 */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = naive;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = zoneOffsetMs(guess, timeZone);
    const next = naive - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export function startOfDay(ms, timeZone) {
  const { year, month, day } = zonedParts(ms, timeZone);
  return zonedToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
}

export function endOfDay(ms, timeZone) {
  return addDays(startOfDay(ms, timeZone), timeZone, 1) - 1;
}

/** Add whole days to an instant while keeping the same wall-clock time. */
export function addDays(ms, timeZone, days) {
  const p = zonedParts(ms, timeZone);
  const base = Date.UTC(p.year, p.month - 1, p.day + days);
  const shifted = new Date(base);
  return zonedToUtc(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: p.hour,
      minute: p.minute,
      second: p.second,
    },
    timeZone,
  );
}

export function addMonths(ms, timeZone, months) {
  const p = zonedParts(ms, timeZone);
  const targetMonthIndex = p.month - 1 + months;
  const year = p.year + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = daysInMonth(year, month + 1);
  return zonedToUtc(
    { year, month: month + 1, day: Math.min(p.day, lastDay), hour: p.hour, minute: p.minute, second: p.second },
    timeZone,
  );
}

export function addYears(ms, timeZone, years) {
  const p = zonedParts(ms, timeZone);
  const lastDay = daysInMonth(p.year + years, p.month);
  return zonedToUtc(
    { year: p.year + years, month: p.month, day: Math.min(p.day, lastDay), hour: p.hour, minute: p.minute, second: p.second },
    timeZone,
  );
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function weekdayIndex(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(ms, timeZone) {
  const day = weekdayIndex(ms, timeZone);
  return day === 0 ? 7 : day;
}

export function dayKey(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function isSameDay(a, b, timeZone) {
  return dayKey(a, timeZone) === dayKey(b, timeZone);
}

export function isToday(ms, timeZone, now = Date.now()) {
  return isSameDay(ms, now, timeZone);
}

export function weekdayName(ms, timeZone) {
  return WEEKDAYS[weekdayIndex(ms, timeZone)];
}

export function monthName(ms, timeZone) {
  return MONTHS[zonedParts(ms, timeZone).month - 1];
}

export function formatDateTime(ms, timeZone, locale = 'en-GB') {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(ms));
}

export function formatClock(ms, timeZone, locale = 'en-GB') {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hour12: true }).format(
    new Date(ms),
  );
}

/**
 * "Human" description of an instant relative to now, evaluated in the user's zone.
 * Used for reminder notifications and list headings.
 */
export function relativeDay(ms, timeZone, now = Date.now()) {
  const target = dayKey(ms, timeZone);
  const today = dayKey(now, timeZone);
  if (target === today) return 'Today';
  if (target === dayKey(addDays(now, timeZone, 1), timeZone)) return 'Tomorrow';
  if (target === dayKey(addDays(now, timeZone, -1), timeZone)) return 'Yesterday';
  return `${weekdayName(ms, timeZone)}, ${zonedParts(ms, timeZone).day} ${monthName(ms, timeZone)}`;
}

/* ------------------------------------------------------------------ *
 * Repeat rules
 * ------------------------------------------------------------------ */

/**
 * Next occurrence of a repeat rule.
 *
 * Rules advance from the task's own due date so that "every Monday" stays on
 * Monday and "every other Monday" keeps its 14-day rhythm, even after the user
 * skips a reminder by a few days.
 *
 * @param {string|null} rule  daily | weekdays | weekly:N | biweekly:N | monthly:D | yearly:MM-DD
 * @param {number} fromMs     current due instant
 * @param {string} timeZone
 * @param {number} [now]      reference instant used for anchored rules
 * @returns {number|null} next instant, or null when the task does not repeat
 */
export function nextOccurrence(rule, fromMs, timeZone, now = Date.now()) {
  if (!rule) return null;
  if (rule === 'daily') return addDays(fromMs, timeZone, 1);
  if (rule === 'biweekly') return addDays(fromMs, timeZone, 14);
  if (rule === 'weekdays') {
    let next = addDays(fromMs, timeZone, 1);
    while (isoWeekday(next, timeZone) > 5) next = addDays(next, timeZone, 1);
    return next;
  }
  let match = /^weekly:([1-7])$/.exec(rule);
  if (match) {
    const target = Number(match[1]);
    // When the stored date already sits on the requested weekday the rhythm is
    // simply +7 days; otherwise walk forward so the rule is honoured even if the
    // date drifted (for example after a manual reschedule).
    if (isoWeekday(fromMs, timeZone) === target) return addDays(fromMs, timeZone, 7);
    return nextMatchingWeekday(fromMs, timeZone, target, 7);
  }
  match = /^biweekly:([1-7])$/.exec(rule);
  if (match) {
    const target = Number(match[1]);
    if (isoWeekday(fromMs, timeZone) === target) return addDays(fromMs, timeZone, 14);
    return nextMatchingWeekday(fromMs, timeZone, target, 7);
  }
  match = /^monthly:(\d{1,2})$/.exec(rule);
  if (match) {
    const target = Number(match[1]);
    const p = zonedParts(fromMs, timeZone);
    const clampedThisMonth = Math.min(target, daysInMonth(p.year, p.month));
    const thisMonth = zonedToUtc(
      { year: p.year, month: p.month, day: clampedThisMonth, hour: p.hour, minute: p.minute, second: p.second },
      timeZone,
    );
    if (p.day === clampedThisMonth) return addMonths(fromMs, timeZone, 1);
    if (thisMonth > fromMs) return thisMonth;
    return addMonths(thisMonth, timeZone, 1);
  }
  match = /^yearly:(\d{2})-(\d{2})$/.exec(rule);
  if (match) return addYears(fromMs, timeZone, 1);
  if (rule === 'weekly') {
    // Unanchored weekly rule: keep the weekday of the current due date and make
    // sure the result is still in the future.
    let next = addDays(fromMs, timeZone, 7);
    while (next <= now) next = addDays(next, timeZone, 7);
    return next;
  }
  if (rule === 'monthly') return addMonths(fromMs, timeZone, 1);
  if (rule === 'yearly') return addYears(fromMs, timeZone, 1);
  return null;
}

/** Advance to the next whole number of days that lands on `target` (ISO weekday). */
function nextMatchingWeekday(fromMs, timeZone, target, fallbackDays) {
  let probe = fromMs;
  for (let step = 0; step < 8; step += 1) {
    probe = addDays(probe, timeZone, 1);
    if (isoWeekday(probe, timeZone) === target) return probe;
  }
  return addDays(fromMs, timeZone, fallbackDays);
}

/**
 * Next occurrence of a rule strictly after `now` in the user's timezone.
 * Used by the parser when the user says "every Monday".
 */
export function nextOccurrenceFromNow(rule, now, timeZone, { hour = 9, minute = 0 } = {}) {
  const p = zonedParts(now, timeZone);
  let candidate;
  if (rule === 'daily' || rule === 'weekdays') {
    candidate = zonedToUtc({ ...p, hour, minute, second: 0 }, timeZone);
    for (let i = 0; i < 8; i += 1) {
      if (candidate > now && (rule === 'daily' || isoWeekday(candidate, timeZone) <= 5)) return candidate;
      candidate = addDays(candidate, timeZone, 1);
    }
    return null;
  }
  let match = /^(bi)?weekly:([1-7])$/.exec(rule);
  if (match) {
    const target = Number(match[2]);
    const step = match[1] ? 14 : 7;
    let probe = zonedToUtc({ ...p, hour, minute, second: 0 }, timeZone);
    for (let i = 0; i < 14; i += 1) {
      if (isoWeekday(probe, timeZone) === target && probe > now) return probe;
      probe = addDays(probe, timeZone, 1);
    }
    // Fall back to a fixed step to avoid an infinite scan.
    void step;
    return addDays(now, timeZone, step);
  }
  match = /^monthly:(\d{1,2})$/.exec(rule);
  if (match) {
    const day = Number(match[1]);
    let probe = zonedToUtc({ year: p.year, month: p.month, day: Math.min(day, daysInMonth(p.year, p.month)), hour, minute, second: 0 }, timeZone);
    if (probe <= now) probe = addMonths(probe, timeZone, 1);
    return probe;
  }
  return null;
}

export function describeRecurrence(rule) {
  if (!rule) return '';
  if (rule === 'daily') return 'Every day';
  if (rule === 'weekdays') return 'Every weekday';
  if (rule === 'weekly') return 'Every week';
  if (rule === 'biweekly') return 'Every 2 weeks';
  if (rule === 'monthly') return 'Every month';
  if (rule === 'yearly') return 'Every year';
  let match = /^(bi)?weekly:([1-7])$/.exec(rule);
  if (match) {
    const name = WEEKDAYS[Number(match[2]) % 7];
    return match[1] ? `Every other ${name}` : `Every ${name}`;
  }
  match = /^monthly:(\d{1,2})$/.exec(rule);
  if (match) return `Day ${Number(match[1])} of each month`;
  match = /^yearly:(\d{2})-(\d{2})$/.exec(rule);
  if (match) return `Every year on ${MONTHS[Number(match[1]) - 1]} ${Number(match[2])}`;
  return 'Repeats';
}

export function weekdayToRule(name) {
  const index = WEEKDAYS.findIndex((day) => day.toLowerCase() === String(name).toLowerCase());
  if (index < 0) return null;
  return `weekly:${index === 0 ? 7 : index}`;
}

export { WEEKDAYS, MONTHS };
