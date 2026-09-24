/**
 * Task storage and queries.
 *
 * Ownership rule: every statement below filters on `user_id`. A task that belongs
 * to somebody else is reported as "not found", which is both correct and
 * non-revealing.
 */
import { assertDescription, assertId, assertPriority, assertTaskTitle, normalizeRecurrence, assertRecurrence } from './validate.js';
import { badRequest, notFound } from './errors.js';
import {
  addDays,
  dayKey,
  endOfDay,
  isSameDay,
  nextOccurrence,
  safeTimezone,
  startOfDay,
} from './time.js';

export const FILTERS = ['today', 'upcoming', 'overdue', 'completed', 'all'];

const MAX_TITLE = 160;
const MAX_DESCRIPTION = 2000;
/** Guard rails so a typo like "in 99999 days" cannot poison the list. */
const MAX_FUTURE_MS = 1000 * 60 * 60 * 24 * 365 * 10;

export function serializeTask(row, { timeZone = 'UTC', now = Date.now() } = {}) {
  if (!row) return null;
  const dueAt = row.due_at === null || row.due_at === undefined ? null : Number(row.due_at);
  const completed = row.status === 'completed';
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description || '',
    dueAt,
    allDay: Number(row.all_day) === 1,
    timezone: row.timezone,
    recurrence: row.recurrence || null,
    priority: row.priority || 'normal',
    status: row.status,
    completed: completed,
    completedAt: row.completed_at ? Number(row.completed_at) : null,
    reminderOffset: Number(row.reminder_offset || 0),
    notifiedAt: row.notified_at ? Number(row.notified_at) : null,
    source: row.source || 'manual',
    aiConfidence: row.ai_confidence === null || row.ai_confidence === undefined ? null : Number(row.ai_confidence),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    overdue: !completed && dueAt !== null && dueAt < now,
    dueToday: !completed && dueAt !== null && isSameDay(dueAt, now, timeZone),
    dueDayKey: dueAt === null ? null : dayKey(dueAt, timeZone),
  };
}

function normalizeDueAt(value, timeZone) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(number)) {
    throw badRequest('That date or time could not be understood. Try “tomorrow at 8 PM”.', 'invalid_due_at');
  }
  const now = Date.now();
  if (number < now - 1000 * 60 * 60 * 24 * 365 * 5) {
    throw badRequest('That date is too far in the past.', 'invalid_due_at');
  }
  if (number > now + MAX_FUTURE_MS) {
    throw badRequest('That date is too far in the future.', 'invalid_due_at');
  }
  void timeZone;
  return Math.round(number);
}

export function createTaskService({ db }) {
  async function getOwnedTask(userId, taskId) {
    const id = assertId(taskId);
    const row = await db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [id, userId]);
    if (!row) throw notFound('That task no longer exists.', 'task_not_found');
    return row;
  }

  return {
    serializeTask,
    getOwnedTask,

    async create(userId, input, { timeZone = 'UTC', source = 'manual' } = {}) {
      const zone = safeTimezone(input.timezone || timeZone);
      const title = assertTaskTitle(input.title);
      const description = assertDescription(input.description || '');
      const priority = assertPriority(input.priority);
      const recurrence = input.recurrence ? assertRecurrence(input.recurrence) : null;
      const dueAt = normalizeDueAt(input.dueAt ?? input.due_at ?? null, zone);
      const allDay = Boolean(input.allDay) && dueAt !== null;
      const reminderOffset = Number.isFinite(Number(input.reminderOffset)) ? Math.max(0, Math.min(1440, Number(input.reminderOffset))) : 0;
      const now = Date.now();

      const result = await db.run(
        `INSERT INTO tasks (user_id, title, description, due_at, all_day, timezone, recurrence, priority, status,
                            source, ai_confidence, reminder_offset, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        [
          userId,
          title.slice(0, MAX_TITLE),
          description.slice(0, MAX_DESCRIPTION),
          dueAt,
          allDay ? 1 : 0,
          zone,
          recurrence,
          priority,
          source,
          Number.isFinite(Number(input.aiConfidence)) ? Number(input.aiConfidence) : null,
          reminderOffset,
          now,
          now,
        ],
      );
      const row = await db.get('SELECT * FROM tasks WHERE id = ?', [Number(result.lastInsertRowid)]);
      return serializeTask(row, { timeZone: zone });
    },

    async update(userId, taskId, input, { timeZone = 'UTC' } = {}) {
      const existing = await getOwnedTask(userId, taskId);
      const zone = safeTimezone(input.timezone || existing.timezone || timeZone);
      const fields = [];
      const params = [];

      if (input.title !== undefined) {
        fields.push('title = ?');
        params.push(assertTaskTitle(input.title).slice(0, MAX_TITLE));
      }
      if (input.description !== undefined) {
        fields.push('description = ?');
        params.push(assertDescription(input.description).slice(0, MAX_DESCRIPTION));
      }
      if (input.priority !== undefined) {
        fields.push('priority = ?');
        params.push(assertPriority(input.priority));
      }
      if (input.recurrence !== undefined) {
        fields.push('recurrence = ?');
        params.push(input.recurrence ? assertRecurrence(input.recurrence) : null);
      }
      if (input.dueAt !== undefined || input.due_at !== undefined) {
        fields.push('due_at = ?', 'notified_at = NULL');
        params.push(normalizeDueAt(input.dueAt ?? input.due_at, zone));
      }
      if (input.allDay !== undefined) {
        fields.push('all_day = ?');
        params.push(input.allDay ? 1 : 0);
      }
      if (input.reminderOffset !== undefined) {
        fields.push('reminder_offset = ?');
        params.push(Math.max(0, Math.min(1440, Number(input.reminderOffset) || 0)));
      }
      if (input.status !== undefined) {
        if (!['open', 'completed'].includes(input.status)) throw badRequest('Unknown task status.', 'invalid_status');
        fields.push('status = ?', 'completed_at = ?');
        params.push(input.status, input.status === 'completed' ? Date.now() : null);
      }
      if (input.timezone !== undefined) {
        fields.push('timezone = ?');
        params.push(zone);
      }

      if (!fields.length) throw badRequest('Nothing to update.', 'empty_update');
      fields.push('updated_at = ?');
      params.push(Date.now(), Number(existing.id), userId);

      await db.run(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, params);
      const row = await db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [Number(existing.id), userId]);
      return serializeTask(row, { timeZone: zone });
    },

    /**
     * Mark a task complete. Repeating tasks are not closed: their due date moves
     * to the next occurrence so the reminder keeps working.
     */
    async complete(userId, taskId, { timeZone = 'UTC' } = {}) {
      const existing = await getOwnedTask(userId, taskId);
      const zone = safeTimezone(existing.timezone || timeZone);
      const now = Date.now();

      if (existing.recurrence && existing.due_at) {
        const from = Math.max(Number(existing.due_at), now);
        let next = nextOccurrence(existing.recurrence, from, zone, now);
        let guard = 0;
        while (next !== null && next <= now && guard < 60) {
          next = nextOccurrence(existing.recurrence, next, zone, now);
          guard += 1;
        }
        await db.run(
          `UPDATE tasks SET due_at = ?, notified_at = NULL, updated_at = ?, status = 'open', completed_at = NULL
           WHERE id = ? AND user_id = ?`,
          [next ?? null, now, Number(existing.id), userId],
        );
      } else {
        await db.run(`UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [
          now,
          now,
          Number(existing.id),
          userId,
        ]);
      }
      const row = await db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [Number(existing.id), userId]);
      return { task: serializeTask(row, { timeZone: zone }), repeated: Boolean(existing.recurrence) };
    },

    async reopen(userId, taskId, { timeZone = 'UTC' } = {}) {
      const existing = await getOwnedTask(userId, taskId);
      const now = Date.now();
      await db.run(
        `UPDATE tasks SET status = 'open', completed_at = NULL, notified_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?`,
        [now, Number(existing.id), userId],
      );
      const row = await db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [Number(existing.id), userId]);
      return serializeTask(row, { timeZone: safeTimezone(existing.timezone || timeZone) });
    },

    /** Reschedule: quick buttons ("+1 hour", "tomorrow 9am") or an explicit time. */
    async reschedule(userId, taskId, { dueAt, preset, timeZone = 'UTC' } = {}) {
      const existing = await getOwnedTask(userId, taskId);
      const zone = safeTimezone(existing.timezone || timeZone);
      const now = Date.now();
      let target = dueAt;

      if (!target && preset) {
        const p = safeTimezone(zone);
        switch (preset) {
          case 'in-10-min':
            target = now + 10 * 60_000;
            break;
          case 'in-30-min':
            target = now + 30 * 60_000;
            break;
          case 'in-1-hour':
            target = now + 60 * 60_000;
            break;
          case 'in-3-hours':
            target = now + 3 * 60 * 60_000;
            break;
          case 'tomorrow-morning':
            target = startOfDay(addDays(now, p, 1), p) + 9 * 60 * 60_000;
            break;
          case 'next-week':
            target = addDays(now, p, 7);
            break;
          case 'this-evening': {
            const evening = startOfDay(now, p) + 19 * 60 * 60_000;
            target = evening > now ? evening : addDays(evening, p, 1);
            break;
          }
          default:
            throw badRequest('That reschedule option is not supported.', 'invalid_preset');
        }
      }

      if (target === undefined || target === null) throw badRequest('Choose when to reschedule the task.', 'invalid_due_at');
      const due = normalizeDueAt(target, zone);
      await db.run('UPDATE tasks SET due_at = ?, notified_at = NULL, status = CASE WHEN status = \'completed\' THEN \'open\' ELSE status END, completed_at = CASE WHEN status = \'completed\' THEN NULL ELSE completed_at END, updated_at = ? WHERE id = ? AND user_id = ?', [
        due,
        now,
        Number(existing.id),
        userId,
      ]);
      const row = await db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [Number(existing.id), userId]);
      return serializeTask(row, { timeZone: zone });
    },

    async remove(userId, taskId) {
      const existing = await getOwnedTask(userId, taskId);
      await db.run('DELETE FROM tasks WHERE id = ? AND user_id = ?', [Number(existing.id), userId]);
      return { ok: true, id: Number(existing.id) };
    },

    /** Mark a reminder as delivered so multiple tabs do not notify twice. */
    async markNotified(userId, taskId) {
      const existing = await getOwnedTask(userId, taskId);
      await db.run('UPDATE tasks SET notified_at = ? WHERE id = ? AND user_id = ?', [Date.now(), Number(existing.id), userId]);
      return { ok: true };
    },

    async list(userId, { filter = 'all', timeZone = 'UTC', search = '', limit = 300 } = {}) {
      const zone = safeTimezone(timeZone);
      const now = Date.now();
      const rows = await db.all(
        `SELECT * FROM tasks WHERE user_id = ? ORDER BY (due_at IS NULL), due_at ASC, priority DESC, id DESC LIMIT ?`,
        [userId, Math.min(Math.max(Number(limit) || 300, 1), 500)],
      );
      const tasks = rows.map((row) => serializeTask(row, { timeZone: zone, now }));

      const buckets = {
        today: [],
        upcoming: [],
        overdue: [],
        completed: [],
        all: tasks,
      };
      const todayStart = startOfDay(now, zone);
      const todayEnd = endOfDay(now, zone);

      for (const task of tasks) {
        if (task.completed) {
          buckets.completed.push(task);
          continue;
        }
        if (task.dueAt === null) {
          // No due date: it can still be done, so it belongs with what is ahead.
          buckets.upcoming.push(task);
          continue;
        }
        // "Overdue" means past its due time (including earlier today), while
        // "today" is everything due on the current calendar day. The two overlap
        // on purpose so an unfinished morning task shows up in both places.
        if (task.dueAt < now) buckets.overdue.push(task);
        if (task.dueAt >= todayStart && task.dueAt <= todayEnd) buckets.today.push(task);
        else if (task.dueAt > todayEnd) buckets.upcoming.push(task);
      }

      let selected = buckets[FILTERS.includes(filter) ? filter : 'all'];
      if (search) {
        const needle = String(search).toLowerCase();
        selected = selected.filter(
          (task) => task.title.toLowerCase().includes(needle) || task.description.toLowerCase().includes(needle),
        );
      }

      return {
        filter: FILTERS.includes(filter) ? filter : 'all',
        counts: {
          today: buckets.today.length,
          upcoming: buckets.upcoming.length,
          overdue: buckets.overdue.length,
          completed: buckets.completed.length,
          all: tasks.filter((task) => !task.completed).length,
        },
        tasks: selected,
        timeZone: zone,
        generatedAt: now,
      };
    },

    /**
     * Tasks whose reminder time has arrived, used by the client-side reminder
     * ticker. `windowMs` looks slightly into the future so a slow tick cannot
     * skip a reminder.
     */
    async dueReminders(userId, { timeZone = 'UTC', windowMs = 90_000 } = {}) {
      const now = Date.now();
      const rows = await db.all(
        `SELECT * FROM tasks
         WHERE user_id = ? AND status = 'open' AND due_at IS NOT NULL AND notified_at IS NULL
           AND due_at <= ?
         ORDER BY due_at ASC LIMIT 20`,
        [userId, now + windowMs],
      );
      return rows
        .map((row) => serializeTask(row, { timeZone: safeTimezone(timeZone), now }))
        .filter((task) => task.dueAt - task.reminderOffset * 60_000 <= now + windowMs);
    },
  };
}
