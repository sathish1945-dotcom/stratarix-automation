/**
 * Deterministic task-command parser.
 *
 * This is NOT a language model and it is never presented as one. It exists so
 * that the most common reminder commands still work when the Gemini API is
 * unavailable or not configured. Every result produced here is labelled
 * `source: 'offline-parser'` and the interface tells the user which engine
 * answered. Anything it cannot handle returns `intent: 'unsupported'` instead of
 * inventing a conversational answer.
 *
 * Supported examples:
 *   "Remind me to submit my assignment tomorrow at 8 PM."
 *   "Wake me at 6 AM."
 *   "Remind me every Monday to check Buyora."
 *   "Add gym at 6 PM."
 *   "Remind me to call Arun in 30 minutes."
 */
import {
  addDays,
  describeRecurrence,
  isSameDay,
  isoWeekday,
  nextOccurrenceFromNow,
  safeTimezone,
  startOfDay,
  zonedParts,
  zonedToUtc,
  MONTHS,
} from './time.js';

const WEEKDAY_WORDS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_WORDS = MONTHS.map((month) => month.toLowerCase());

const URGENT_WORDS = /\b(urgent(?:ly)?|asap|as soon as possible|immediately|right away|right now|critical|emergency|super important)\b/i;
const HIGH_WORDS = /\b(important|high priority|do not forget|don'?t forget|must|priority)\b/i;
const LOW_WORDS = /\b(low priority|whenever|no rush|sometime|someday|eventually|not urgent)\b/i;

const TASK_VERBS =
  /\b(remind|remember|wake|alarm|add|create|schedule|set up|note|log|book|order|call|text|email|message|meet|buy|pay|submit|send|finish|complete|clean|study|revise|review|check|pick|drop|visit|attend|gym|workout|meditate|medicine|work on|task|todo|to-do)\b/i;

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Remove literal phrases (matched case-insensitively) from the text. */
function stripPhrases(input, phrases) {
  let output = input;
  for (const phrase of phrases) {
    if (!phrase) continue;
    if (phrase instanceof RegExp) output = output.replace(phrase, ' ');
    else output = output.replace(new RegExp(escapeRegExp(phrase), 'i'), ' ');
  }
  return output;
}

function cleanTitle(input) {
  let title = input
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:\-–—.]+/, '')
    .replace(/[\s,;:\-–—.]+$/, '')
    .replace(/^(?:to|about|that|for|and)\s+/i, '')
    .trim();
  if (!title) return '';
  if (title.length > 140) title = `${title.slice(0, 137).trimEnd()}…`;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** Detect an explicit repeat rule such as "every Monday" or "every 2 weeks". */
export function detectRecurrence(work) {
  let match = /\bevery\s+other\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(work);
  if (match) {
    const day = WEEKDAY_WORDS.indexOf(match[1].toLowerCase());
    return { rule: `biweekly:${day === 0 ? 7 : day}`, phrase: match[0] };
  }
  match = /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(work);
  if (match) {
    const day = WEEKDAY_WORDS.indexOf(match[1].toLowerCase());
    return { rule: `weekly:${day === 0 ? 7 : day}`, phrase: match[0] };
  }
  match = /\bevery\s+(?:single\s+)?day\b|\beach day\b|\bdaily\b/i.exec(work);
  if (match) return { rule: 'daily', phrase: match[0] };
  match = /\bevery\s+weekday\b|\bevery\s+working\s+day\b|\b(?:on\s+)?weekdays\b/i.exec(work);
  if (match) return { rule: 'weekdays', phrase: match[0] };
  match = /\bevery\s+(?:other|2)\s+weeks\b|\bbiweekly\b|\bfortnightly\b/i.exec(work);
  if (match) return { rule: 'biweekly', phrase: match[0] };
  match = /\bevery\s+week\b/i.exec(work);
  if (match) return { rule: 'weekly', phrase: match[0] };
  match = /\bweekly\b|\beach\s+week\b/i.exec(work);
  if (match) return { rule: 'weekly', phrase: match[0] };
  match = /\b(\d{1,2})(?:st|nd|rd|th)\s+of\s+(?:every|each)\s+month\b/i.exec(work);
  if (match) {
    const day = Number(match[1]);
    if (day >= 1 && day <= 31) return { rule: `monthly:${String(day).padStart(2, '0')}`, phrase: match[0] };
  }
  match = /\bevery\s+month\b/i.exec(work);
  if (match) return { rule: 'monthly', phrase: match[0] };
  match = /\bmonthly\b|\beach\s+month\b/i.exec(work);
  if (match) return { rule: 'monthly', phrase: match[0] };
  match = /\bevery\s+year\b/i.exec(work);
  if (match) return { rule: 'yearly', phrase: match[0] };
  match = /\bannually\b|\byearly\b|\beach\s+year\b/i.exec(work);
  if (match) return { rule: 'yearly', phrase: match[0] };
  match = /\bevery\s+(\d{1,2})(?:st|nd|rd|th)\b/i.exec(work);
  if (match) {
    const day = Number(match[1]);
    if (day >= 1 && day <= 31) return { rule: `monthly:${day}`, phrase: match[0] };
  }
  return { rule: null, phrase: '' };
}

/** True when the weekday word at `index` is part of an "every <weekday>" phrase. */
function insideEveryPhrase(work, index) {
  return /\b(every|each)\s+(?:other\s+)?\s*$/.test(work.slice(0, index));
}

function explicitDateFromWords(match, day, monthIndex, now, timeZone) {
  const p = zonedParts(now, timeZone);
  let year = p.year;
  let candidate = zonedToUtc({ year, month: monthIndex + 1, day, hour: 9 }, timeZone);
  if (candidate < startOfDay(now, timeZone)) {
    year += 1;
    candidate = zonedToUtc({ year, month: monthIndex + 1, day, hour: 9 }, timeZone);
  }
  void match;
  return candidate;
}

/** Detect a day reference. Returns the target day window plus the matched phrase. */
function detectDay(work, now, timeZone) {
  const phrases = [];
  let base = now;
  let explicit = false;

  if (/\b(?:the\s+)?day after tomorrow\b/i.test(work)) {
    phrases.push(/\b(?:the\s+)?day after tomorrow\b/i);
    base = addDays(now, timeZone, 2);
    explicit = true;
  } else if (/\b(tomorrow|tmrw|tmr)\b/i.test(work)) {
    phrases.push(/\b(tomorrow|tmrw|tmr)\b/i);
    base = addDays(now, timeZone, 1);
    explicit = true;
  } else if (/\b(today|tonight|this evening|this afternoon|this morning)\b/i.test(work)) {
    phrases.push(/\b(today|tonight|this evening|this afternoon|this morning)\b/i);
    explicit = true;
  } else if (/\bnext\s+week\b/i.test(work)) {
    phrases.push(/\bnext\s+week\b/i);
    base = addDays(now, timeZone, 7);
    explicit = true;
  }

  let match = /\bin\s+(\d{1,3})\s+(day|days|week|weeks)\b/i.exec(work);
  if (!explicit && match) {
    const amount = Number(match[1]) * (/week/i.test(match[2]) ? 7 : 1);
    base = addDays(now, timeZone, amount);
    phrases.push(match[0]);
    explicit = true;
  }

  if (!explicit) {
    // "12 August", "12th of August"
    match = /\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/i.exec(work);
    if (match) {
      const monthIndex = MONTH_WORDS.findIndex((month) => month.startsWith(match[2].toLowerCase().slice(0, 3)));
      const day = Number(match[1]);
      if (monthIndex >= 0 && day >= 1 && day <= 31) {
        return { base: explicitDateFromWords(match, day, monthIndex, now, timeZone), phrases: [match[0]], explicit: true };
      }
    }
    // "August 12"
    match = /\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(work);
    if (match) {
      const monthIndex = MONTH_WORDS.findIndex((month) => month.startsWith(match[1].toLowerCase().slice(0, 3)));
      const day = Number(match[2]);
      if (monthIndex >= 0 && day >= 1 && day <= 31) {
        return { base: explicitDateFromWords(match, day, monthIndex, now, timeZone), phrases: [match[0]], explicit: true };
      }
    }
    // "12/08" or "12-08-2026" — interpreted as day/month.
    match = /\b(?:on\s+)?(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/.exec(work);
    if (match) {
      const day = Number(match[1]);
      const month = Number(match[2]);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        const p = zonedParts(now, timeZone);
        let year = match[3] ? (match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])) : p.year;
        let candidate = zonedToUtc({ year, month, day, hour: 9 }, timeZone);
        if (candidate < startOfDay(now, timeZone)) {
          year += 1;
          candidate = zonedToUtc({ year, month, day, hour: 9 }, timeZone);
        }
        return { base: candidate, phrases: [match[0]], explicit: true };
      }
    }
  }

  // Weekday names: "on Friday", "next Monday", "this Tuesday"
  const weekdayMatch = /\b(next|this|coming|on)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(work);
  if (weekdayMatch && !insideEveryPhrase(work, weekdayMatch.index)) {
    const target = WEEKDAY_WORDS.indexOf(weekdayMatch[2].toLowerCase());
    const targetIso = target === 0 ? 7 : target;
    let candidate = base;
    let guard = 0;
    while (isoWeekday(candidate, timeZone) !== targetIso && guard < 8) {
      candidate = addDays(candidate, timeZone, 1);
      guard += 1;
    }
    if (/\bnext\b/i.test(weekdayMatch[1] || '') && isSameDay(candidate, base, timeZone)) {
      candidate = addDays(candidate, timeZone, 7);
    }
    return { base: candidate, phrases: [weekdayMatch[0].trim()], explicit: true };
  }

  return { base, phrases, explicit };
}

/** Detect a time of day or a relative offset. */
function detectTime(work) {
  let match = /\bin\s+(\d{1,4})\s*(?:min|mins|minute|minutes)\b/i.exec(work);
  if (match) return { relativeMinutes: Number(match[1]), phrase: match[0] };
  match = /\bin\s+(\d{1,3})\s*(?:hour|hours|hr|hrs)\b/i.exec(work);
  if (match) return { relativeMinutes: Number(match[1]) * 60, phrase: match[0] };
  match = /\bin\s+(?:half\s+an?\s+hour)\b/i.exec(work);
  if (match) return { relativeMinutes: 30, phrase: match[0] };
  match = /\bin\s+an?\s+hour\b/i.exec(work);
  if (match) return { relativeMinutes: 60, phrase: match[0] };

  match = /\b(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?\b/i.exec(work);
  if (match) {
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const meridiem = (match[3] || '').toLowerCase().replace(/\./g, '');
    if (meridiem.startsWith('p') && hour < 12) hour += 12;
    if (meridiem.startsWith('a') && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) return { hour, minute, hadMeridiem: Boolean(meridiem), phrase: match[0] };
  }

  match = /\b(?:at\s+)?(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/i.exec(work);
  if (match) {
    let hour = Number(match[1]);
    const meridiem = match[2].toLowerCase().replace(/\./g, '');
    if (meridiem.startsWith('p') && hour < 12) hour += 12;
    if (meridiem.startsWith('a') && hour === 12) hour = 0;
    if (hour <= 23) return { hour, minute: 0, hadMeridiem: true, phrase: match[0] };
  }

  match = /\b(?:at|by)\s+(\d{1,2})\b(?!\s*(?:st|nd|rd|th))/i.exec(work);
  if (match) {
    const hour = Number(match[1]);
    if (hour <= 23) return { hour, minute: 0, hadMeridiem: false, phrase: match[0] };
  }

  match = /\b(noon|midday)\b/i.exec(work);
  if (match) return { hour: 12, minute: 0, hadMeridiem: true, phrase: match[0] };
  match = /\bmidnight\b/i.exec(work);
  if (match) return { hour: 0, minute: 0, hadMeridiem: true, phrase: match[0] };

  match = /\b(?:this\s+|in\s+the\s+|the\s+)?morning\b/i.exec(work);
  if (match) return { hour: 9, minute: 0, vague: true, phrase: match[0] };
  match = /\b(?:this\s+|in\s+the\s+|the\s+)?afternoon\b/i.exec(work);
  if (match) return { hour: 14, minute: 0, vague: true, phrase: match[0] };
  match = /\b(?:this\s+|in\s+the\s+|the\s+)?evening\b/i.exec(work);
  if (match) return { hour: 19, minute: 0, vague: true, phrase: match[0] };
  match = /\b(?:at\s+)?night\b/i.exec(work);
  if (match) return { hour: 21, minute: 0, vague: true, phrase: match[0] };

  return { relativeMinutes: null, hour: null, minute: null, phrase: '' };
}

/**
 * Turn an un-anchored rule ("every week", "monthly") into a concrete one using
 * today's date, so the stored rule keeps the weekday/day the user expects.
 */
function anchorRule(rule, now, timeZone) {
  if (!rule) return rule;
  const p = zonedParts(now, timeZone);
  const iso = (() => {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    return day === 0 ? 7 : day;
  })();
  if (rule === 'weekly') return `weekly:${iso}`;
  if (rule === 'biweekly') return `biweekly:${iso}`;
  if (rule === 'monthly') return `monthly:${String(p.day).padStart(2, '0')}`;
  if (rule === 'yearly') return `yearly:${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return rule;
}

function detectPriority(work) {
  if (URGENT_WORDS.test(work)) return 'urgent';
  if (HIGH_WORDS.test(work)) return 'high';
  if (LOW_WORDS.test(work)) return 'low';
  return 'normal';
}

const PREFIX_PATTERNS = [
  /^(?:please\s+|hey\s+|hi\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:remind|reminder)\s+(?:me|us)\s+(?:to\s+|about\s+|that\s+|for\s+)?/i,
  /^(?:please\s+)?(?:remind|reminder)\s*[:,-]?\s*(?:me|us)?\s*(?:to\s+|about\s+|that\s+|for\s+)?/i,
  // Note: the time preposition is intentionally left in place so the time
  // phrase ("at 6 am") can still be stripped from the title afterwards.
  /^(?:please\s+)?(?:wake\s+me\s+up|wake\s+me|wake\s+up|set\s+(?:an?\s+)?alarm(?:\s+for)?)\s*/i,
  /^(?:please\s+)?(?:add|create|schedule|set\s+up|set|make|new|note\s+down|note|log|record)\s+(?:a\s+|an\s+|the\s+|my\s+)?(?:new\s+)?(?:task|reminder|event|todo|to-do|appointment)?\s*(?:to\s+|for\s+|called\s+|about\s+|:)?\s*/i,
  /^(?:i\s+(?:need|have|want)\s+to\s+|i\s+must\s+|don'?t\s+forget\s+to\s+|remember\s+to\s+|let'?s\s+)/i,
];

/**
 * Parse a natural-language reminder command without an AI provider.
 * @param {string} message
 * @param {{now?:number, timeZone?:string}} [options]
 */
export function parseTaskCommand(message, options = {}) {
  const now = options.now ?? Date.now();
  const timeZone = safeTimezone(options.timeZone);
  const raw = String(message || '').trim();
  const work = raw.toLowerCase();
  const defaultHour = 9;

  if (!work) {
    return {
      intent: 'unsupported',
      source: 'offline-parser',
      reply: 'Type a reminder such as “Remind me to call Arun in 30 minutes”.',
      task: null,
      needsConfirmation: false,
    };
  }

  const recurrence = detectRecurrence(work);
  const { base, phrases: dayPhrases, explicit: hasExplicitDay } = detectDay(work, now, timeZone);
  const time = detectTime(work);
  const priority = detectPriority(work);

  let dueAt = null;
  let allDay = false;
  let confidence = 0.55;

  if (time.relativeMinutes !== null && time.relativeMinutes !== undefined) {
    dueAt = now + Number(time.relativeMinutes) * 60_000;
    confidence = 0.95;
  } else if (time.hour !== null && time.hour !== undefined) {
    const p = zonedParts(base, timeZone);
    dueAt = zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: time.hour, minute: time.minute || 0 }, timeZone);
    if (!hasExplicitDay && dueAt <= now) {
      // "at 6" has already passed today, so the user means tomorrow.
      dueAt = addDays(dueAt, timeZone, 1);
    }
    confidence = time.hadMeridiem === false && !time.vague ? 0.7 : 0.9;
  } else if (recurrence.rule) {
    // A repeat rule with no stated time uses a sensible default hour rather than
    // silently becoming an all-day task at midnight.
    recurrence.rule = anchorRule(recurrence.rule, now, timeZone);
    dueAt =
      nextOccurrenceFromNow(recurrence.rule, now, timeZone, { hour: defaultHour, minute: 0 }) ??
      addDays(now, timeZone, 1);
    confidence = 0.8;
  } else if (hasExplicitDay) {
    allDay = true;
    dueAt = startOfDay(base, timeZone);
    confidence = 0.75;
  }

  let titleSource = raw;
  for (const pattern of PREFIX_PATTERNS) titleSource = titleSource.replace(pattern, ' ');
  if (recurrence.phrase) titleSource = stripPhrases(titleSource, [recurrence.phrase]);
  const removable = [];
  if (time.phrase) removable.push(time.phrase);
  for (const pattern of dayPhrases) removable.push(pattern);
  titleSource = stripPhrases(titleSource, removable);
  titleSource = titleSource.replace(/\b(?:today|tomorrow|tonight)\b/gi, ' ');

  let title = cleanTitle(titleSource);
  if (!title && /\b(wake|alarm)\b/i.test(work)) title = 'Wake up';
  if (!title && recurrence.rule) title = 'Recurring reminder';

  const looksLikeTask = Boolean(title) && (TASK_VERBS.test(work) || Boolean(dueAt) || Boolean(recurrence.rule));

  if (!title || !looksLikeTask) {
    return {
      intent: 'unsupported',
      source: 'offline-parser',
      reply:
        'I could not find a reminder in that message. Try “Remind me to submit my assignment tomorrow at 8 PM” or check the AI configuration in Settings.',
      task: null,
      needsConfirmation: false,
    };
  }

  const parts = [];
  if (dueAt) {
    parts.push(
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(dueAt)),
    );
  }
  if (recurrence.rule) parts.push(describeRecurrence(recurrence.rule).toLowerCase());

  return {
    intent: 'create_task',
    source: 'offline-parser',
    reply: `Added “${title}”${parts.length ? ` — ${parts.join(', ')}` : ''}.`,
    needsConfirmation: false,
    task: {
      title,
      description: '',
      dueAt,
      allDay,
      recurrence: recurrence.rule,
      priority,
      confidence,
    },
  };
}
