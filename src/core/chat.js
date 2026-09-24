/**
 * Chat orchestration.
 *
 * Responsibilities
 *  - keep the conversation in the database (so a refresh does not lose it)
 *  - ask the model what the user meant, then apply the change through the task
 *    service (which enforces ownership and validation)
 *  - degrade gracefully: if the AI provider fails, try the deterministic parser
 *    and label the answer honestly; if that fails too, return a friendly error
 *    state instead of a broken interface
 *  - never trust the model with anything security relevant
 */
import { AppError, logError } from './errors.js';
import { normaliseTaskProposal, matchTaskByTitle, buildSystemInstruction, buildUserContent } from './ai.js';
import { parseTaskCommand } from './nlp.js';
import { assertChatMessage, safeMessage } from './validate.js';
import { safeTimezone } from './time.js';

const HISTORY_TURNS = 8;
const MAX_STORED_MESSAGES = 300;

const DEGRADED_MESSAGES = {
  ai_not_configured:
    'The AI assistant is not connected yet, so I used the built-in reminder parser. Add a Gemini API key in the environment variables for full natural-language understanding.',
  ai_timeout: 'The AI assistant took too long to reply. I used the built-in reminder parser for this message.',
  ai_rate_limited: 'The AI assistant is busy right now. I used the built-in reminder parser for this message.',
  ai_unavailable: 'The AI assistant is temporarily unavailable. I used the built-in reminder parser for this message.',
  ai_invalid_response: 'The AI reply could not be read, so I used the built-in reminder parser instead.',
  default: 'The AI assistant is unavailable right now. I used the built-in reminder parser instead.',
};

export function createChatService({ db, tasks, ai }) {
  async function historyFor(userId) {
    const rows = await db.all('SELECT role, content FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?', [
      userId,
      HISTORY_TURNS,
    ]);
    return rows
      .reverse()
      .map((row) => ({ role: row.role === 'assistant' ? 'assistant' : 'user', text: String(row.content || '') }));
  }

  async function persist(userId, role, content, meta = {}) {
    const now = Date.now();
    const result = await db.run(
      'INSERT INTO chat_messages (user_id, role, content, source, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, role, String(content || '').slice(0, 4000), meta.source || null, meta.taskId ?? null, now],
    );
    return { id: Number(result.lastInsertRowid), role, content, createdAt: now, ...meta };
  }

  async function prune(userId) {
    const row = await db.get('SELECT COUNT(*) AS total FROM chat_messages WHERE user_id = ?', [userId]);
    const total = Number(row?.total || 0);
    if (total <= MAX_STORED_MESSAGES) return;
    await db.run(
      `DELETE FROM chat_messages WHERE user_id = ? AND id NOT IN (
         SELECT id FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?
       )`,
      [userId, userId, MAX_STORED_MESSAGES],
    );
  }

  function friendlyAiError(error) {
    const code = error instanceof AppError ? error.code : 'default';
    return {
      code,
      message: DEGRADED_MESSAGES[code] || DEGRADED_MESSAGES.default,
      retryable: ['ai_timeout', 'ai_rate_limited', 'ai_unavailable', 'ai_invalid_response'].includes(code),
    };
  }

  /** Apply an interpreted instruction. Returns the payload sent to the client. */
  async function applyIntent({ user, interpretation, timeZone }) {
    const { intent, task: proposal, targetHint, reply } = interpretation;
    const zone = safeTimezone(timeZone, user.timezone || 'UTC');
    const result = { intent, reply, task: null, tasks: null, counts: null, needsConfirmation: false, preview: null };

    if (intent === 'create_task') {
      if (!proposal) {
        return {
          ...result,
          intent: 'chat',
          reply:
            reply ||
            'I could not tell what to remind you about. Try “Remind me to submit my assignment tomorrow at 8 PM”.',
        };
      }
      if (interpretation.needsConfirmation) {
        return { ...result, needsConfirmation: true, preview: proposal };
      }
      const created = await tasks.create(user.id, proposal, { timeZone: zone, source: interpretation.source });
      return { ...result, task: created };
    }

    if (['update_task', 'complete_task', 'delete_task'].includes(intent)) {
      const listing = await tasks.list(user.id, { filter: 'all', timeZone: zone, limit: 200 });
      const candidates = listing.tasks.filter((task) => !task.completed);
      const target = matchTaskByTitle(candidates.length ? candidates : listing.tasks, targetHint);
      if (!target) {
        return {
          ...result,
          intent: 'chat',
          reply: targetHint
            ? `I could not find a task called “${String(targetHint).slice(0, 80)}”. Tell me the exact title, or ask me to list your tasks.`
            : 'Tell me which task you mean, for example “mark submit my assignment as done”.',
        };
      }
      if (intent === 'complete_task') {
        const outcome = await tasks.complete(user.id, target.id, { timeZone: zone });
        return { ...result, task: outcome.task, reply: reply || `Marked “${target.title}” as done.` };
      }
      if (intent === 'delete_task') {
        await tasks.remove(user.id, target.id);
        return { ...result, reply: reply || `Deleted “${target.title}”.`, task: { ...target, deleted: true } };
      }
      const patch = {};
      if (proposal) {
        if (proposal.dueAt) patch.dueAt = proposal.dueAt;
        if (proposal.allDay !== undefined) patch.allDay = proposal.allDay;
        if (proposal.priority && proposal.priority !== 'normal') patch.priority = proposal.priority;
        if (proposal.recurrence !== null && proposal.recurrence !== undefined) patch.recurrence = proposal.recurrence;
        if (proposal.title && proposal.title.toLowerCase() !== target.title.toLowerCase()) patch.title = proposal.title;
        if (proposal.description) patch.description = proposal.description;
      }
      if (!Object.keys(patch).length) {
        return { ...result, reply: reply || `I have not changed “${target.title}” — tell me what to update.` };
      }
      const updated = await tasks.update(user.id, target.id, patch, { timeZone: zone });
      return { ...result, task: updated, reply: reply || `Updated “${target.title}”.` };
    }

    if (intent === 'list_tasks') {
      const listing = await tasks.list(user.id, { filter: 'all', timeZone: zone });
      const open = listing.tasks.filter((task) => !task.completed).slice(0, 8);
      return {
        ...result,
        tasks: open,
        counts: listing.counts,
        reply:
          reply ||
          (open.length
            ? `You have ${listing.counts.all} open task${listing.counts.all === 1 ? '' : 's'}, ${listing.counts.overdue} overdue and ${listing.counts.today} due today.`
            : 'You have no tasks yet. Tell me something to remember and I will add it.'),
      };
    }

    return { ...result, reply: reply || 'I am here. Tell me what you would like to remember.' };
  }

  return {
    async list(userId, { limit = 60 } = {}) {
      const rows = await db.all(
        'SELECT id, role, content, source, task_id, created_at FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?',
        [userId, Math.min(Math.max(Number(limit) || 60, 1), 200)],
      );
      return rows.reverse().map((row) => ({
        id: Number(row.id),
        role: row.role,
        content: row.content,
        source: row.source || null,
        taskId: row.task_id === null || row.task_id === undefined ? null : Number(row.task_id),
        createdAt: Number(row.created_at),
      }));
    },

    async clear(userId) {
      await db.run('DELETE FROM chat_messages WHERE user_id = ?', [userId]);
      return { ok: true };
    },

    /**
     * Handle one user message.
     * @param {object} user     authenticated user row
     * @param {{message:string,timeZone?:string}} input
     */
    async handleMessage(user, { message, timeZone }) {
      const clean = assertChatMessage(message);
      const zone = safeTimezone(timeZone, user.timezone || 'UTC');
      const now = Date.now();

      await persist(user.id, 'user', clean, { source: 'user' });

      let interpretation = null;
      let notice = null;

      if (ai.configured) {
        try {
          const client = ai.requireClient();
          const history = await historyFor(user.id);
          const [listing] = await Promise.all([
            tasks.list(user.id, { filter: 'all', timeZone: zone, limit: 60 }),
          ]);
          const { data, model } = await client.generateJson({
            systemInstruction: buildSystemInstruction({
              now,
              timeZone: zone,
              tasks: listing.tasks,
              userName: String(user.name || '').split(' ')[0],
            }),
            userContent: buildUserContent(clean, { timeZone: zone, now }),
            schema: ai.RESPONSE_SCHEMA,
            history,
          });
          interpretation = {
            intent: data.intent,
            reply: safeMessage(data.reply, 600) || '',
            needsConfirmation: data.needs_confirmation === true,
            task: ['create_task', 'update_task'].includes(data.intent)
              ? normaliseTaskProposal(data, { timeZone: zone, now })
              : null,
            targetHint: safeMessage(data.target_task, 120) || '',
            source: 'gemini',
            model,
          };
        } catch (error) {
          logError(error, { route: '/api/chat', method: 'POST' });
          notice = friendlyAiError(error);
        }
      } else {
        notice = friendlyAiError(new AppError('not configured', { status: 503, code: 'ai_not_configured' }));
      }

      // Deterministic fallback so a provider outage never blocks reminders.
      let fallbackText = null;
      if (!interpretation && ai.fallbackEnabled) {
        const parsed = parseTaskCommand(clean, { now, timeZone: zone });
        if (parsed.intent !== 'unsupported') {
          interpretation = {
            intent: parsed.intent,
            reply: parsed.reply,
            needsConfirmation: false,
            task: parsed.task,
            targetHint: '',
            source: 'offline-parser',
          };
          fallbackText = parsed.reply;
        }
      }

      if (!interpretation) {
        const reply =
          notice?.message ||
          'I could not understand that message. Try “Remind me to call Arun in 30 minutes”.';
        const stored = await persist(user.id, 'assistant', reply, { source: 'none' });
        await prune(user.id);
        return {
          ok: true,
          degraded: true,
          notice,
          reply,
          source: 'none',
          intent: 'unsupported',
          task: null,
          message: stored,
        };
      }

      let applied;
      try {
        applied = await applyIntent({ user, interpretation, timeZone: zone });
      } catch (error) {
        logError(error, { route: '/api/chat', method: 'POST' });
        const reply =
          error instanceof AppError
            ? error.message
            : 'I could not save that task because of a temporary problem. Please try again.';
        const stored = await persist(user.id, 'assistant', reply, { source: 'error' });
        await prune(user.id);
        return {
          ok: true,
          degraded: true,
          notice: { code: 'action_failed', message: reply, retryable: true },
          reply,
          source: interpretation.source,
          intent: interpretation.intent,
          task: null,
          message: stored,
        };
      }

      const stored = await persist(user.id, 'assistant', applied.reply, {
        source: interpretation.source,
        taskId: applied.task?.id ?? null,
      });
      await prune(user.id);

      return {
        ok: true,
        degraded: Boolean(notice),
        notice,
        reply: applied.reply,
        fallbackUsed: Boolean(fallbackText),
        source: interpretation.source,
        model: interpretation.model || null,
        intent: applied.intent,
        task: applied.task,
        tasks: applied.tasks,
        counts: applied.counts,
        preview: applied.preview,
        needsConfirmation: applied.needsConfirmation,
        message: stored,
      };
    },
  };
}
