/**
 * The AI assistant.
 *
 * Behaviour that matters here:
 *  - the user's message appears immediately, followed by an "AI is thinking"
 *    indicator, which is replaced by the real answer
 *  - sending is disabled while a reply is in flight, so a double tap cannot
 *    create the same task twice
 *  - every answer says whether it came from the AI model or the built-in parser
 *  - a task the assistant creates (or interprets) is shown as a card with its
 *    title, time, repeat rule and priority
 */
import { $, esc, icon, scrollToBottom, autoGrow, formatDateTime, taskBadges, toast } from '../ui.js';

const SUGGESTIONS = [
  'Remind me to submit my assignment tomorrow at 8 PM.',
  'Wake me at 6 AM.',
  'Remind me every Monday to check Buyora.',
  'Add gym at 6 PM.',
  'Remind me to call Arun in 30 minutes.',
];

function sourceTag(source) {
  if (source === 'gemini') return '<span class="source-tag is-ai">Gemini AI</span>';
  if (source === 'offline-parser') return '<span class="source-tag is-offline">Built-in parser</span>';
  return '';
}

function taskCard(task, { preview = false } = {}) {
  return `<div class="bubble-task" data-task-card="${task.id || 'preview'}">
    <div class="row-between">
      <span class="task-title">${esc(task.title)}</span>
      ${preview ? '<span class="badge badge-warn">Not saved yet</span>' : '<span class="badge badge-success">Saved</span>'}
    </div>
    <div class="task-meta">${taskBadges(task)}</div>
    ${task.description ? `<p class="task-desc">${esc(task.description)}</p>` : ''}
    <div class="bubble-actions">
      ${preview
        ? `<button class="btn btn-primary btn-sm" type="button" data-action="confirm-preview">Save task</button>
           <button class="btn btn-ghost btn-sm" type="button" data-action="discard-preview">Discard</button>`
        : `<button class="btn btn-ghost btn-sm" type="button" data-action="edit-task" data-id="${task.id}">Edit</button>
           <button class="btn btn-ghost btn-sm" type="button" data-action="undo-task" data-id="${task.id}">Undo</button>`}
    </div>
  </div>`;
}

function messageNode(message) {
  const mine = message.role === 'user';
  const time = message.createdAt
    ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt))
    : '';
  return `<div class="msg ${mine ? 'msg-me' : 'msg-bot'}" data-role="${mine ? 'user' : 'assistant'}">
    <span class="msg-avatar">${icon(mine ? 'user' : 'spark', 'ico ico-sm')}</span>
    <div class="bubble">
      <div class="bubble-text">${esc(message.content ?? message.reply ?? '')}</div>
      <div class="bubble-meta">
        ${time ? `<span>${esc(time)}</span>` : ''}
        ${!mine ? sourceTag(message.source) : ''}
      </div>
      ${message.task ? taskCard(message.task, { preview: Boolean(message.preview) }) : ''}
      ${message.notice ? `<div class="chat-notice ${message.notice.retryable ? '' : 'is-error'}">${icon('alert', 'ico ico-sm')}<span>${esc(message.notice.message)}</span></div>` : ''}
    </div>
  </div>`;
}

export function createAssistantView(ctx) {
  const state = {
    pending: false,
    preview: null,
    historyLoaded: false,
    messages: [],
    prefill: null,
  };

  function takePrefill() {
    const value = ctx.consumeAssistantPrefill?.();
    if (value) state.prefill = value;
  }

  return {
    key: 'assistant',
    title: 'AI assistant',
    state,
    html() {
      const store = ctx.store.get();
      const configured = store.aiConfigured;
      return `
      <section class="chat">
        <div class="chat-shell">
          <header class="chat-head">
            <span class="chat-avatar">${icon('spark')}</span>
            <span class="chat-head-text">
              <strong>AI Life Manager assistant</strong>
              <small>${configured ? 'Gemini is connected · understands full sentences' : 'Built-in parser mode · the AI is not configured on this deployment'}</small>
            </span>
            <span class="chat-head-actions">
              <button class="btn btn-ghost btn-sm" type="button" data-action="clear-chat">${icon('trash', 'ico ico-sm')} Clear</button>
            </span>
          </header>
          <div class="chat-log" id="chat-log" aria-live="polite" aria-relevant="additions text"></div>
          <div class="chat-notice m-0" id="chat-banner" hidden></div>
          <form class="composer" id="chat-form">
            <label class="visually-hidden" for="chat-input">Message the assistant</label>
            <textarea class="input" id="chat-input" rows="1" maxlength="1500"
              placeholder="Tell me what to remember… e.g. “Remind me to call Arun in 30 minutes”"
              autocomplete="off"></textarea>
            <button class="send-btn" id="chat-send" type="submit" aria-label="Send message">${icon('send')}</button>
          </form>
        </div>
        <div class="suggestions" aria-label="Example commands">
          ${SUGGESTIONS.map((text) => `<button class="chip-btn" type="button" data-action="suggest" data-text="${esc(text)}">${esc(text)}</button>`).join('')}
        </div>
      </section>`;
    },

    async onMount(root) {
      takePrefill();
      const log = $('#chat-log', root);
      const form = $('#chat-form', root);
      const input = $('#chat-input', root);

      renderMessages(ctx, log, state);

      if (!state.historyLoaded) {
        try {
          const { messages } = await ctx.api.chatHistory();
          state.messages = messages || [];
          state.historyLoaded = true;
          renderMessages(ctx, log, state);
        } catch {
          state.historyLoaded = true;
        }
      }

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        send(ctx, root, state, input.value);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          form.requestSubmit();
        }
      });
      input.addEventListener('input', () => autoGrow(input));

      if (state.prefill) {
        input.value = state.prefill;
        state.prefill = null;
        autoGrow(input);
        input.focus();
        send(ctx, root, state, input.value);
      } else {
        input.focus();
      }
    },

    onAction(action, element) {
      if (action === 'suggest') {
        const input = $('#chat-input');
        if (input) {
          input.value = element.dataset.text || '';
          input.focus();
          autoGrow(input);
        }
        return true;
      }
      if (action === 'clear-chat') {
        ctx.clearChat();
        return true;
      }
      if (action === 'confirm-preview') {
        savePreview(ctx, state);
        return true;
      }
      if (action === 'discard-preview') {
        state.preview = null;
        const bubble = element.closest('.bubble');
        bubble?.querySelector('.bubble-task')?.remove();
        toast('Nothing was saved.', 'info');
        return true;
      }
      if (action === 'undo-task') {
        ctx.deleteTask(Number(element.dataset.id), { silent: true });
        return true;
      }
      return false;
    },
  };

  async function send(ctx, root, state, value) {
    const message = String(value || '').trim();
    if (!message || state.pending) return;
    const store = ctx.store.get();
    if (!store.user) {
      ctx.navigate('#login');
      return;
    }

    const log = $('#chat-log', root);
    const input = $('#chat-input', root);
    const sendButton = $('#chat-send', root);

    // 1. The user's message appears immediately.
    const mine = { role: 'user', content: message, createdAt: Date.now() };
    state.messages.push(mine);
    log.insertAdjacentHTML('beforeend', messageNode(mine));
    input.value = '';
    autoGrow(input);
    scrollToBottom(log);

    // 2. Loading state, and no duplicate submissions while it is showing.
    state.pending = true;
    if (sendButton) sendButton.disabled = true;
    input.disabled = true;
    const typing = document.createElement('div');
    typing.className = 'msg msg-bot';
    typing.dataset.typing = 'true';
    typing.innerHTML = `<span class="msg-avatar">${icon('spark', 'ico ico-sm')}</span>
      <div class="bubble"><div class="typing"><span class="typing-text">AI is thinking</span>
      <span class="dots" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div></div>`;
    log.appendChild(typing);
    scrollToBottom(log);

    try {
      // 3. The real answer replaces the indicator.
      const result = await ctx.api.sendChat(message);
      typing.remove();

      const assistant = {
        role: 'assistant',
        content: result.reply,
        createdAt: result.message?.createdAt || Date.now(),
        source: result.source,
        task: result.needsConfirmation ? result.preview : result.task,
        preview: Boolean(result.needsConfirmation),
        notice: result.notice || null,
      };
      state.messages.push(assistant);
      log.insertAdjacentHTML('beforeend', messageNode(assistant));
      if (assistant.preview) state.preview = result.preview;
      scrollToBottom(log);

      if (result.task && !result.needsConfirmation) ctx.onTasksChanged();
      if (result.tasks) ctx.onTasksChanged();
    } catch (error) {
      typing.remove();
      const offline = error.offline;
      const assistant = {
        role: 'assistant',
        content: offline
          ? 'I could not reach the server. Your message is still in the box — check your connection and send it again.'
          : error.message,
        createdAt: Date.now(),
        source: 'none',
        notice: { code: error.code || 'failed', message: offline ? 'You appear to be offline.' : 'The message was not delivered.', retryable: true },
      };
      state.messages.push(assistant);
      log.insertAdjacentHTML('beforeend', messageNode(assistant));
      if (input) input.value = message; // keep the text so it can be retried
      scrollToBottom(log);
    } finally {
      state.pending = false;
      if (sendButton) sendButton.disabled = false;
      if (input) {
        input.disabled = false;
        input.focus();
      }
    }
  }

  async function savePreview(ctx, state) {
    const preview = state.preview;
    if (!preview) return;
    try {
      await ctx.api.createTask(preview);
      state.preview = null;
      $('#chat-log')?.querySelector('[data-task-card="preview"]')?.closest('.bubble')?.remove();
      const log = $('#chat-log');
      if (log) {
        log.insertAdjacentHTML('beforeend', messageNode({
          role: 'assistant',
          content: `Saved “${preview.title}”.`,
          createdAt: Date.now(),
          source: 'app',
          task: { ...preview, id: preview.id || 0 },
        }));
        scrollToBottom(log);
      }
      ctx.onTasksChanged();
      toast('Task saved.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }
}

function renderMessages(ctx, log, state) {
  if (!log) return;
  if (!state.messages.length) {
    const store = ctx.store.get();
    log.innerHTML = `<div class="msg msg-bot">
      <span class="msg-avatar">${icon('spark', 'ico ico-sm')}</span>
      <div class="bubble">
        <div class="bubble-text">Hi ${esc((store.user?.name || '').split(' ')[0] || 'there')} — tell me what you need to remember and I will set the date, the time and any repeat rule.

Try: “Remind me to submit my assignment tomorrow at 8 PM.”</div>
      </div>
    </div>`;
    return;
  }
  log.innerHTML = state.messages.map(messageNode).join('');
  scrollToBottom(log, false);
}
