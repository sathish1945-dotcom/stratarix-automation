/**
 * Dashboard and task management. Manual task creation stays available here, but
 * the assistant is presented as the fastest way to add something.
 */
import {
  $,
  $$,
  closeDialog,
  openDialog,
  esc,
  icon,
  emptyState,
  formatDate,
  formatDateTime,
  relativeDayLabel,
  recurrenceLabel,
  skeletonList,
  skeletonStats,
  taskBadges,
} from '../ui.js';

export const FILTERS = [
  { id: 'today', label: 'Today', icon: 'clock' },
  { id: 'upcoming', label: 'Upcoming', icon: 'calendar' },
  { id: 'overdue', label: 'Overdue', icon: 'alert' },
  { id: 'completed', label: 'Completed', icon: 'check-circle' },
  { id: 'all', label: 'All', icon: 'inbox' },
];

export function taskRow(task, { compact = false } = {}) {
  const overdue = task.overdue && !task.completed;
  return `<article class="task ${task.completed ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}" data-task-id="${task.id}">
    <button class="task-check" type="button"
      data-action="${task.completed ? 'reopen' : 'complete'}" data-id="${task.id}"
      aria-label="${task.completed ? 'Mark as not done' : 'Mark as done'}: ${esc(task.title)}">
      ${icon('check')}
    </button>
    <div class="task-body">
      <p class="task-title">${esc(task.title)}</p>
      ${!compact && task.description ? `<p class="task-desc">${esc(task.description)}</p>` : ''}
      <div class="task-meta">${taskBadges(task)}</div>
    </div>
    <div class="task-actions">
      <button class="icon-btn icon-btn-sm" type="button" data-action="edit-task" data-id="${task.id}" aria-label="Edit ${esc(task.title)}" title="Edit">${icon('edit')}</button>
      <button class="icon-btn icon-btn-sm" type="button" data-action="reschedule-menu" data-id="${task.id}" aria-label="Reschedule ${esc(task.title)}" title="Reschedule">${icon('clock')}</button>
      <button class="icon-btn icon-btn-sm is-danger" type="button" data-action="delete-task" data-id="${task.id}" aria-label="Delete ${esc(task.title)}" title="Delete">${icon('trash')}</button>
    </div>
  </article>`;
}

function statCard({ label, value, iconName, tone = '', action, filter }) {
  const tag = action ? 'button' : 'div';
  return `<${tag} class="stat ${action ? 'card-hover' : ''}" ${action ? `type="button" data-action="filter" data-filter="${esc(filter)}"` : ''}>
    <div class="stat-top">
      <span class="stat-icon ${tone}">${icon(iconName)}</span>
    </div>
    <span class="stat-value">${value}</span>
    <span class="stat-label">${esc(label)}</span>
  </${tag}>`;
}

function quickComposer(ctx) {
  const aiConfigured = ctx.store.get().aiConfigured;
  return `<div class="card card-accent">
    <div class="row-between mb-2">
      <div class="row">
        <span class="chat-avatar chat-avatar-sm">${icon('spark')}</span>
        <div>
          <h3 class="card-title">Ask the assistant</h3>
          <p class="card-sub">${aiConfigured ? 'Understands natural language and creates the task for you.' : 'The built-in parser handles reminders while the AI is not configured.'}</p>
        </div>
      </div>
      <span class="badge ${aiConfigured ? 'badge-brand' : 'badge-warn'}">${aiConfigured ? 'AI online' : 'Parser mode'}</span>
    </div>
    <form class="composer composer-inline" id="quick-form">
      <label class="visually-hidden" for="quick-input">Message the assistant</label>
      <textarea class="input" id="quick-input" rows="1" maxlength="1500" placeholder="Remind me to call Arun in 30 minutes"></textarea>
      <button class="send-btn" type="submit" aria-label="Send message">${icon('send')}</button>
    </form>
    <div class="suggestions mt-2">
      ${['Remind me to submit my assignment tomorrow at 8 PM', 'Wake me at 6 AM', 'Add gym at 6 PM']
        .map((text) => `<button class="chip-btn" type="button" data-action="suggest" data-text="${esc(text)}">${esc(text)}</button>`)
        .join('')}
    </div>
  </div>`;
}

export function createDashboardView(ctx) {
  const store = ctx.store;
  return {
    key: 'dashboard',
    title: 'Dashboard',
    html() {
      const state = store.get();
      const user = state.user;
      const counts = state.counts;
      const firstName = (user?.name || 'there').split(' ')[0];
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

      return `
      <section class="section">
        <div class="row-between">
          <div>
            <h1>${esc(greeting)}, ${esc(firstName)}</h1>
            <p class="muted" id="dash-summary">${summaryLine(counts)}</p>
          </div>
          <div class="row">
            <button class="btn btn-ghost" type="button" data-action="open-task-modal">${icon('plus', 'ico ico-sm')} New task</button>
            <a class="btn btn-primary" href="#assistant">${icon('chat', 'ico ico-sm')} Open assistant</a>
          </div>
        </div>
      </section>

      <section class="section">${quickComposer(ctx)}</section>

      <section class="section"><div id="stat-grid">${statGrid(state)}</div></section>

      <section class="section">
        <div class="section-head">
          <div><h2>Today</h2><p>${esc(formatDate(Date.now()))}</p></div>
          <a class="btn btn-ghost btn-sm" href="#tasks">All tasks ${icon('arrow-right', 'ico ico-sm')}</a>
        </div>
        <div id="today-list">${renderToday(ctx)}</div>
      </section>`;
    },
    onMount(root) {
      bindQuickComposer(ctx, root);
    },
    /**
     * Re-render the numbers and the list after a data change: the first paint
     * can only show skeletons, so the counts must be able to catch up.
     */
    refresh(root) {
      const state = store.get();
      const todayList = $('#today-list', root);
      if (todayList) todayList.innerHTML = renderToday(ctx);
      const grid = $('#stat-grid', root);
      if (grid) grid.innerHTML = statGrid(state);
      const summary = $('#dash-summary', root);
      if (summary) summary.textContent = summaryLine(state.counts);
    },
  };
}

function summaryLine(counts) {
  if (!counts.today && !counts.overdue) return 'Nothing is due today. Tell your assistant what to remember.';
  return `You have ${counts.today} task${counts.today === 1 ? '' : 's'} today${counts.overdue ? ` and ${counts.overdue} overdue` : ''}.`;
}

function statGrid(state) {
  if (state.loading.tasks && !state.tasks.length) return skeletonStats();
  const counts = state.counts;
  return `<div class="grid grid-4">
    ${statCard({ label: 'Due today', value: counts.today, iconName: 'clock', tone: '', action: true, filter: 'today' })}
    ${statCard({ label: 'Overdue', value: counts.overdue, iconName: 'alert', tone: 'is-danger', action: true, filter: 'overdue' })}
    ${statCard({ label: 'Upcoming', value: counts.upcoming, iconName: 'calendar', tone: 'is-warn', action: true, filter: 'upcoming' })}
    ${statCard({ label: 'Completed', value: counts.completed, iconName: 'check-circle', tone: 'is-success', action: true, filter: 'completed' })}
  </div>`;
}

function renderToday(ctx) {
  const state = ctx.store.get();
  if (state.loading.tasks && !state.tasks.length) return skeletonList(3);
  const tasks = state.tasks.filter((task) => !task.completed).slice(0, 6);
  if (!tasks.length) {
    return emptyState({
      iconName: 'spark',
      title: state.tasks.length ? 'Nothing left for today' : 'No tasks yet',
      body: state.tasks.length
        ? 'Everything on today’s list is done. Your assistant can add the next one.'
        : 'Tell your AI assistant what you need to remember — it will create the task, the time and any repeat rule.',
      actions: `<button class="btn btn-primary" type="button" data-action="focus-composer">${icon('chat', 'ico ico-sm')} Create your first task</button>
                <button class="btn btn-ghost" type="button" data-action="open-task-modal">${icon('plus', 'ico ico-sm')} Add manually</button>`,
    });
  }
  return `<div class="task-list">${tasks.map((task) => taskRow(task)).join('')}</div>`;
}

export function createTasksView(ctx) {
  return {
    key: 'tasks',
    title: 'Tasks',
    html() {
      const state = ctx.store.get();
      return `
      <section class="section">
        <div class="row-between">
          <div>
            <h1>Your tasks</h1>
            <p class="muted">Create, edit, reschedule and complete — all in one place.</p>
          </div>
          <div class="row">
            <button class="btn btn-ghost" type="button" data-action="open-task-modal">${icon('plus', 'ico ico-sm')} New task</button>
            <a class="btn btn-primary" href="#assistant">${icon('chat', 'ico ico-sm')} Ask assistant</a>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="row-between mb-2">
          <div class="filters" role="tablist" aria-label="Task filters">
            ${FILTERS.map((filter) => `
              <button class="seg" type="button" role="tab" data-action="filter" data-filter="${filter.id}"
                aria-selected="${state.filter === filter.id}">
                ${icon(filter.icon, 'ico ico-sm')}<span>${esc(filter.label)}</span>
                <span class="seg-count" data-count="${filter.id}">${state.counts[filter.id] ?? 0}</span>
              </button>`).join('')}
          </div>
          <label class="field field-inline">
            <span class="visually-hidden">Search tasks</span>
            <input class="input" id="task-search" type="search" placeholder="Search tasks" value="${esc(state.search)}">
          </label>
        </div>
        <div id="task-list-region">${renderList(ctx)}</div>
      </section>`;
    },
    onMount(root) {
      const search = $('#task-search', root);
      search?.addEventListener('input', ctx.debounce((event) => {
        ctx.setFilter(ctx.store.get().filter, event.target.value);
      }, 320));
    },
    refresh(root) {
      const region = $('#task-list-region', root);
      if (region) region.innerHTML = renderList(ctx);
      $$('[data-count]', root).forEach((node) => {
        const value = ctx.store.get().counts[node.dataset.count];
        node.textContent = value ?? 0;
      });
      $$('.seg', root).forEach((node) => {
        node.setAttribute('aria-selected', String(node.dataset.filter === ctx.store.get().filter));
      });
    },
  };
}

function renderList(ctx) {
  const state = ctx.store.get();
  if (state.loading.tasks && !state.tasks.length) return skeletonList(5);

  const tasks = state.tasks;
  if (!tasks.length) {
    const filtered = state.filter !== 'all';
    return emptyState({
      iconName: filtered ? 'check-circle' : 'spark',
      title: state.search ? 'No matches' : filtered ? 'Nothing here right now' : 'No tasks yet',
      body: state.search
        ? `No task matches “${state.search}”. Try a different word or clear the search.`
        : filtered
          ? 'Switch to “All” to see everything, or ask the assistant to add something new.'
          : 'Tell your AI assistant what you need to remember — it will create the task, the time and any repeat rule.',
      actions: `<button class="btn btn-primary" type="button" data-action="focus-composer">${icon('chat', 'ico ico-sm')} Create your first task</button>
                <button class="btn btn-ghost" type="button" data-action="open-task-modal">${icon('plus', 'ico ico-sm')} Add manually</button>`,
    });
  }

  if (state.filter === 'all') return `<div class="task-list">${tasks.map((task) => taskRow(task)).join('')}</div>`;

  // Group by day so the list reads like a plan rather than a table.
  const groups = new Map();
  for (const task of tasks) {
    const key = task.completed ? 'Completed' : task.dueAt ? relativeDayLabel(task.dueAt) : 'No due date';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return Array.from(groups.entries())
    .map(([label, items]) => `<h3 class="day-group-title">${esc(label)} <span class="muted">· ${items.length}</span></h3>
      <div class="task-list">${items.map((task) => taskRow(task)).join('')}</div>`)
    .join('');
}

function bindQuickComposer(ctx, root) {
  const form = $('#quick-form', root);
  if (!form) return;
  const input = $('#quick-input', form);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    ctx.openAssistantWith(message);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}

/* ------------------------------------------------------------- task modal */

/**
 * Open the manual task dialog. Resolves with the saved task, or null when
 * cancelled.
 */
export function openTaskModal(ctx, { task = null, defaults = {} } = {}) {
  const dialog = $('#task-modal');
  const form = $('#task-form');
  const error = $('#task-form-error');
  const submit = $('#task-form-submit');
  if (!dialog || !form) return Promise.resolve(null);

  $('#task-modal-title').textContent = task ? 'Edit task' : 'New task';
  submit.textContent = task ? 'Save changes' : 'Create task';
  error.hidden = true;
  form.elements.title.value = task?.title || defaults.title || '';
  form.elements.description.value = task?.description || '';
  form.elements.priority.value = task?.priority || 'normal';
  form.elements.recurrence.value = task?.recurrence ? task.recurrence.split(':')[0] : '';

  const due = task?.dueAt ?? defaults.dueAt ?? null;
  if (due) {
    const date = new Date(due);
    form.elements.date.value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (!task?.allDay) {
      form.elements.time.value = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    } else {
      form.elements.time.value = '';
    }
  } else {
    form.elements.date.value = '';
    form.elements.time.value = '';
  }

  const previousRecurrence = task?.recurrence || '';
  const hint = $('#task-form-hint');
  hint.textContent = task?.recurrence
    ? `Currently repeats: ${recurrenceLabel(previousRecurrence)}.`
    : 'Leave the date empty for a task without a deadline.';

  return new Promise((resolve) => {
    const close = (result) => {
      cleanup();
      ctx.closeDialog(dialog);
      resolve(result);
    };
    async function onSubmit(event) {
      event.preventDefault();
      error.hidden = true;
      if (!form.reportValidity()) return;
      const title = form.elements.title.value.trim();
      const dateValue = form.elements.date.value;
      const timeValue = form.elements.time.value;
      let dueAt = null;
      let allDay = false;
      if (dateValue) {
        const [year, month, day] = dateValue.split('-').map(Number);
        if (timeValue) {
          const [hour, minute] = timeValue.split(':').map(Number);
          dueAt = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
        } else {
          dueAt = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
          allDay = true;
        }
      } else if (timeValue) {
        const [hour, minute] = timeValue.split(':').map(Number);
        const when = new Date();
        when.setHours(hour, minute, 0, 0);
        if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
        dueAt = when.getTime();
      }

      let recurrence = form.elements.recurrence.value || null;
      // Keep the weekday/day anchor of an existing repeat rule when the user has
      // not changed the repeat setting.
      if (recurrence && previousRecurrence.startsWith(`${recurrence}:`)) recurrence = previousRecurrence;

      const payload = {
        title,
        description: form.elements.description.value.trim(),
        dueAt,
        allDay,
        priority: form.elements.priority.value,
        recurrence,
      };

      submit.disabled = true;
      const original = submit.textContent;
      submit.textContent = 'Saving…';
      try {
        const saved = task ? (await ctx.api.updateTask(task.id, payload)).task : (await ctx.api.createTask(payload)).task;
        cleanup();
        ctx.closeDialog(dialog);
        resolve(saved);
      } catch (requestError) {
        error.innerHTML = `${icon('alert', 'ico ico-sm')}<span>${esc(requestError.message)}</span>`;
        error.hidden = false;
      } finally {
        submit.disabled = false;
        submit.textContent = original;
      }
    }
    function onCancel() { close(null); }
    function onDialogClose() { close(null); }
    function cleanup() {
      form.removeEventListener('submit', onSubmit);
      $('#task-form-cancel')?.removeEventListener('click', onCancel);
      $('#task-modal-close')?.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onDialogClose);
    }
    form.addEventListener('submit', onSubmit);
    $('#task-form-cancel')?.addEventListener('click', onCancel);
    $('#task-modal-close')?.addEventListener('click', onCancel);
    dialog.addEventListener('close', onDialogClose);
    ctx.openDialog(dialog);
    setTimeout(() => form.elements.title.focus(), 30);
  });
}

/** Quick reschedule options shown when the clock button is used. */
export const RESCHEDULE_PRESETS = [
  { preset: 'in-10-min', label: 'In 10 minutes' },
  { preset: 'in-30-min', label: 'In 30 minutes' },
  { preset: 'in-1-hour', label: 'In 1 hour' },
  { preset: 'this-evening', label: 'This evening (7 PM)' },
  { preset: 'tomorrow-morning', label: 'Tomorrow morning (9 AM)' },
  { preset: 'next-week', label: 'In one week' },
];

export function rescheduleMenu(task, onChoose) {
  const dialog = $('#confirm-modal');
  if (!dialog) return;
  $('#confirm-title').textContent = 'Reschedule task';
  const body = $('#confirm-body');
  body.innerHTML = `<span class="muted text-sm">${esc(task.title)}${task.dueAt ? ` — currently ${esc(formatDateTime(task.dueAt))}` : ' — no due date'}</span>
    <div class="stack mt-2">${RESCHEDULE_PRESETS.map((option) =>
      `<button class="btn btn-ghost btn-block" type="button" data-preset="${esc(option.preset)}">${esc(option.label)}</button>`).join('')}</div>`;
  const ok = $('#confirm-ok');
  ok.hidden = true;
  const cancel = $('#confirm-cancel');
  cancel.textContent = 'Close';

  const finish = () => {
    body.removeEventListener('click', onClick);
    cancel.removeEventListener('click', onCancel);
    cancel.textContent = 'Cancel';
    ok.hidden = false;
    dialog.removeEventListener('close', onCancel);
    closeDialog(dialog);
  };
  const onClick = (event) => {
    const button = event.target.closest('[data-preset]');
    if (!button) return;
    const preset = button.dataset.preset;
    finish();
    onChoose(preset);
  };
  const onCancel = () => finish();
  body.addEventListener('click', onClick);
  cancel.addEventListener('click', onCancel);
  dialog.addEventListener('close', onCancel);
  // Escape and backdrop clicks are handled by the native dialog element.
  openDialog(dialog);
}
