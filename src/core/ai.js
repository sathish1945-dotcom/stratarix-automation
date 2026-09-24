/**
 * Task understanding layer.
 *
 * Turns a natural-language message into a structured instruction using the
 * Gemini API, then normalises and validates that structure server side. The
 * model never writes to the database directly: it returns a proposal, and this
 * module is the only place that converts it into task fields.
 */
import { aiNotConfigured, createGeminiClient, DEFAULT_MODEL } from './gemini.js';
import { WEEKDAYS, nextOccurrenceFromNow, safeTimezone, zonedParts, zonedToUtc, daysInMonth } from './time.js';
import { normalizeRecurrence } from './validate.js';

export const INTENTS = ['create_task', 'update_task', 'complete_task', 'delete_task', 'list_tasks', 'chat', 'unknown'];

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: {
      type: 'STRING',
      enum: INTENTS,
      description: 'What the user wants. Use create_task for any new reminder or to-do.',
    },
    reply: {
      type: 'STRING',
      description:
        'One or two short sentences in plain text, no markdown, confirming what you understood or answering a question.',
    },
    needs_confirmation: {
      type: 'BOOLEAN',
      description: 'True only when the request is ambiguous enough that the task should not be saved yet.',
    },
    title: { type: 'STRING', description: 'Short imperative task title without the date or time wording.' },
    description: { type: 'STRING', description: 'Optional extra detail, otherwise an empty string.' },
    due_date: { type: 'STRING', description: 'Local calendar date as YYYY-MM-DD, or an empty string when unknown.' },
    due_time: { type: 'STRING', description: 'Local 24-hour time as HH:MM, or an empty string when not specified.' },
    all_day: { type: 'BOOLEAN', description: 'True when only a date was given and no time of day.' },
    recurrence: {
      type: 'STRING',
      description:
        'One of: none, daily, weekdays, weekly:MONDAY..SUNDAY, biweekly:MONDAY..SUNDAY, monthly:DD, yearly:MM-DD. Use none when the task does not repeat.',
    },
    priority: { type: 'STRING', enum: ['low', 'normal', 'high', 'urgent'] },
    confidence: { type: 'NUMBER', description: 'Confidence from 0 to 1 that the extracted details are correct.' },
    target_task: {
      type: 'STRING',
      description: 'For update_task, complete_task or delete_task: the existing task title that is being referred to.',
    },
    new_due_date: {
      type: 'STRING',
      description: 'For update_task when the user changes the date: YYYY-MM-DD, otherwise an empty string.',
    },
    new_due_time: {
      type: 'STRING',
      description: 'For update_task when the user changes the time: HH:MM, otherwise an empty string.',
    },
  },
  required: ['intent', 'reply'],
  propertyOrdering: [
    'intent',
    'reply',
    'needs_confirmation',
    'title',
    'description',
    'due_date',
    'due_time',
    'all_day',
    'recurrence',
    'priority',
    'confidence',
    'target_task',
    'new_due_date',
    'new_due_time',
  ],
};

export function buildSystemInstruction({ now, timeZone, tasks = [], userName = '' }) {
  const p = zonedParts(now, timeZone);
  const stamp = `${WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]}, ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  const list = tasks
    .slice(0, 25)
    .map((task) => `- #${task.id} ${task.title}${task.dueAt ? ` (due ${new Date(task.dueAt).toISOString()})` : ' (no due date)'}${task.recurrence ? ` [repeats ${task.recurrence}]` : ''}`)
    .join('\n');

  return `You are the assistant inside "AI Life Manager", a personal task and reminder app.
You convert everyday language into structured reminders and answer short productivity questions.

Current date and time for this user: ${stamp} (${timeZone}).
${userName ? `The user's name is ${userName}.` : ''}

Rules:
1. Resolve every relative expression ("tomorrow", "in 30 minutes", "next Monday", "at 6") against the current date and time above, in the user's timezone.
2. Always return local wall-clock values: due_date as YYYY-MM-DD and due_time as HH:MM (24 hour). Never return UTC timestamps.
3. If the user gives a date but no time, set all_day true and due_time empty.
4. If the user gives a time but no date, use today when that time is still in the future, otherwise tomorrow.
5. "every Monday" → weekly:MONDAY, "every other Tuesday" → biweekly:TUESDAY, "every day" → daily, "every weekday" → weekdays, "every month on the 5th" → monthly:05.
6. Keep the title short, imperative and free of date or time words: "submit my assignment", "call Arun", "gym".
7. Use priority urgent only for explicit urgency (urgent, asap, immediately), high for important, otherwise normal.
8. Use update_task, complete_task or delete_task only when the user refers to an existing task from the list below; set target_task to that exact title. Otherwise answer with chat.
9. Set needs_confirmation true only when the message is too ambiguous to act on safely.
10. The reply is plain text, at most two short sentences, no markdown, no emoji. Never claim a task was saved — the app adds its own confirmation.
11. If the message is not about tasks, answer it briefly and helpfully as a productivity assistant.

Existing tasks for this user:
${list || '- (none yet)'}`;
}

export function buildUserContent(message, { timeZone, now }) {
  return `User timezone: ${safeTimezone(timeZone)}
Server time now: ${new Date(now).toISOString()}
User message: ${message}`;
}

/** Map a model-provided recurrence string onto our stored format. */
export function normaliseRecurrenceText(value, { dueAt, timeZone, now = Date.now() } = {}) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw || raw === 'none' || raw === 'null' || raw === 'no' || raw === 'false') return null;

  const direct = normalizeRecurrence(raw.replace(/\s+/g, ''));
  if (direct) {
    // Unanchored weekly/monthly rules are anchored to the resolved date so the
    // repeat keeps the weekday/day the user actually asked for.
    if (dueAt) {
      if (direct === 'weekly') return `weekly:${isoWeekdayOf(dueAt, timeZone)}`;
      if (direct === 'biweekly') return `biweekly:${isoWeekdayOf(dueAt, timeZone)}`;
      if (direct === 'monthly') return `monthly:${String(zonedParts(dueAt, timeZone).day).padStart(2, '0')}`;
      if (direct === 'yearly') {
        const p = zonedParts(dueAt, timeZone);
        return `yearly:${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
      }
    }
    return direct;
  }

  // "weekly:monday", "biweekly:tuesday", "every monday", "monthly:5"
  let match = /(?:bi)?weekly[:\s-]*([a-z]+)/.exec(raw);
  if (match) {
    const index = WEEKDAYS.findIndex((day) => day.toLowerCase().startsWith(match[1].slice(0, 3)));
    if (index >= 0) {
      const iso = index === 0 ? 7 : index;
      return `${/biweekly|every other|fortnight/.test(raw) ? 'biweekly' : 'weekly'}:${iso}`;
    }
  }
  match = /monthly[:\s-]*(\d{1,2})/.exec(raw);
  if (match) {
    const day = Number(match[1]);
    if (day >= 1 && day <= 31) return `monthly:${String(day).padStart(2, '0')}`;
  }
  if (/every\s+other\s+week/.test(raw) || /fortnight/.test(raw)) return 'biweekly';
  if (/every\s+day|each\s+day/.test(raw)) return 'daily';
  if (/weekday/.test(raw)) return 'weekdays';
  if (/every\s+week|weekly/.test(raw)) {
    return dueAt ? `weekly:${isoWeekdayOf(dueAt, timeZone)}` : 'weekly';
  }
  if (/every\s+month|monthly/.test(raw)) {
    return dueAt ? `monthly:${String(zonedParts(dueAt, timeZone).day).padStart(2, '0')}` : 'monthly';
  }
  if (/every\s+year|yearly|annually/.test(raw)) return 'yearly';
  void now;
  return null;
}

function isoWeekdayOf(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Combine a local date + time into an instant, tolerating model formats. */
export function resolveDueAt({ dueDate, dueTime, allDay }, { timeZone, now = Date.now() }) {
  const zone = safeTimezone(timeZone);
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dueDate || '').trim());
  const timeMatch = /^(\d{1,2}):(\d{2})/.exec(String(dueTime || '').trim());

  if (!dateMatch && !timeMatch) return { dueAt: null, allDay: false };

  let year;
  let month;
  let day;
  if (dateMatch) {
    year = Number(dateMatch[1]);
    month = Number(dateMatch[2]);
    day = Number(dateMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return { dueAt: null, allDay: false };
  } else {
    const p = zonedParts(now, zone);
    year = p.year;
    month = p.month;
    day = p.day;
  }

  let hour = 9;
  let minute = 0;
  let hasTime = false;
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2]);
    if (hour > 23 || minute > 59) return { dueAt: null, allDay: false };
    hasTime = true;
  }

  if (allDay && !hasTime) {
    hour = 0;
    minute = 0;
  }

  let dueAt = zonedToUtc({ year, month, day, hour, minute, second: 0 }, zone);

  // A date-less time that already passed today means tomorrow.
  if (!dateMatch && hasTime && dueAt <= now) {
    const next = zonedParts(dueAt + 24 * 60 * 60 * 1000, zone);
    dueAt = zonedToUtc({ year: next.year, month: next.month, day: next.day, hour, minute, second: 0 }, zone);
  }

  return { dueAt, allDay: !hasTime };
}

/**
 * Normalise a model proposal into the shape the task service accepts.
 * Returns null when there is not enough information to build a task.
 */
export function normaliseTaskProposal(data, { timeZone, now = Date.now() }) {
  const zone = safeTimezone(timeZone);
  const title = String(data?.title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const recurrenceRaw = data?.recurrence;
  const { dueAt, allDay } = resolveDueAt(
    { dueDate: data?.due_date, dueTime: data?.due_time, allDay: Boolean(data?.all_day) },
    { timeZone: zone, now },
  );

  let due = dueAt;
  let allDayFinal = dueAt ? allDay : false;
  const recurrence = normaliseRecurrenceText(recurrenceRaw, { dueAt, timeZone: zone, now });

  // A repeating task with only a rule and no date anchors on the next match.
  if (!due && recurrence) {
    due = nextOccurrenceFromNow(recurrence, now, zone, { hour: 9, minute: 0 });
    allDayFinal = false;
  }

  if (!title) return null;

  const priority = ['low', 'normal', 'high', 'urgent'].includes(String(data?.priority || '').toLowerCase())
    ? String(data.priority).toLowerCase()
    : 'normal';
  const confidence = Number.isFinite(Number(data?.confidence)) ? Math.max(0, Math.min(1, Number(data.confidence))) : 0.6;

  return {
    title,
    description: String(data?.description || '').slice(0, 2000),
    dueAt: due,
    allDay: allDayFinal,
    recurrence,
    priority,
    confidence,
    timezone: zone,
  };
}

/** Fuzzy match a spoken task title against the user's open tasks. */
export function matchTaskByTitle(tasks, spoken) {
  const needle = String(spoken || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!needle) return null;
  const words = needle.split(' ').filter((word) => word.length > 2);
  let best = null;
  let bestScore = 0;
  for (const task of tasks) {
    const haystack = task.title.toLowerCase();
    if (haystack === needle) return task;
    let score = 0;
    if (haystack.includes(needle)) score = needle.length / Math.max(haystack.length, 1) + 0.4;
    for (const word of words) if (haystack.includes(word)) score += 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = task;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

export function createAiService({ env = process.env, fetchImpl = fetch, logger = console } = {}) {
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY || '';
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const configured = Boolean(apiKey);
  const allowFallback = env.AI_OFFLINE_FALLBACK !== 'false';

  let client = null;
  if (configured) {
    client = createGeminiClient({
      apiKey,
      model,
      fetchImpl,
      timeoutMs: Number(env.GEMINI_TIMEOUT_MS) || 15_000,
      maxRetries: env.GEMINI_MAX_RETRIES === undefined ? 2 : Number(env.GEMINI_MAX_RETRIES),
      logger,
    });
  }

  return {
    configured,
    fallbackEnabled: allowFallback,
    model,
    get client() {
      return client;
    },
    requireClient() {
      if (!client) throw aiNotConfigured();
      return client;
    },
    buildSystemInstruction,
    buildUserContent,
    RESPONSE_SCHEMA,
  };
}
