/**
 * Shared UI helpers: escaping, icons, toasts, dialogs, formatting, skeletons.
 * Everything that renders user or model supplied text goes through `esc()` or
 * `text()` so the interface cannot be used to inject markup.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a value for safe interpolation into HTML. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/** Escape and keep line breaks. */
export function escLines(value) {
  return esc(value).replace(/\n/g, '<br>');
}

export function icon(name, className = 'ico') {
  return `<svg class="${className}" aria-hidden="true" focusable="false"><use href="#i-${esc(name)}"></use></svg>`;
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 200) {
  let last = 0;
  let timer;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn(...args);
      }, remaining);
    }
  };
}

/* ------------------------------------------------------------------ toasts */

const TOAST_ICONS = { success: 'check-circle', error: 'alert', warn: 'alert', info: 'info' };

export function toast(message, { variant = 'info', timeout = 4600 } = {}) {
  const stack = $('#toast-stack');
  if (!stack) return () => {};
  const node = document.createElement('div');
  node.className = `toast is-${variant}`;
  node.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  node.innerHTML = `${icon(TOAST_ICONS[variant] || 'info')}<span>${esc(message)}</span>`;
  stack.appendChild(node);
  const remove = () => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  };
  const timer = setTimeout(remove, timeout);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
  return remove;
}

/* ---------------------------------------------------------------- dialogs */

export function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

export function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function') {
    if (dialog.open) dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
}

/**
 * Confirmation dialog used before destructive actions.
 * Resolves true when the user confirms.
 */
export function confirmDialog({ title = 'Are you sure?', body = '', confirmLabel = 'Delete', cancelLabel = 'Cancel' } = {}) {
  const dialog = $('#confirm-modal');
  if (!dialog) return Promise.resolve(window.confirm(body || title));
  const titleNode = $('#confirm-title', dialog);
  const bodyNode = $('#confirm-body', dialog);
  const okNode = $('#confirm-ok', dialog);
  const cancelNode = $('#confirm-cancel', dialog);
  titleNode.textContent = title;
  bodyNode.textContent = body;
  okNode.textContent = confirmLabel;
  cancelNode.textContent = cancelLabel;

  return new Promise((resolve) => {
    const finish = (result) => {
      okNode.removeEventListener('click', onOk);
      cancelNode.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      closeDialog(dialog);
      resolve(result);
    };
    function onOk() { finish(true); }
    function onCancel() { finish(false); }
    function onClose() { finish(false); }
    okNode.addEventListener('click', onOk);
    cancelNode.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    openDialog(dialog);
    okNode.focus();
  });
}

/* ------------------------------------------------------------- formatting */

const DATE_OPTS = { weekday: 'short', day: 'numeric', month: 'short' };
const TIME_OPTS = { hour: '2-digit', minute: '2-digit', hour12: true };

export function formatDate(ms, timeZone) {
  if (!ms) return '';
  return new Intl.DateTimeFormat(undefined, timeZone ? { ...DATE_OPTS, timeZone } : DATE_OPTS).format(new Date(ms));
}

export function formatTime(ms, timeZone) {
  if (!ms) return '';
  return new Intl.DateTimeFormat(undefined, timeZone ? { ...TIME_OPTS, timeZone } : TIME_OPTS).format(new Date(ms));
}

export function formatDateTime(ms, timeZone) {
  if (!ms) return '';
  return `${formatDate(ms, timeZone)} · ${formatTime(ms, timeZone)}`;
}

export function dayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function relativeDayLabel(ms, now = Date.now()) {
  if (!ms) return '';
  const key = dayKey(ms);
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(now + 86400000)) return 'Tomorrow';
  if (key === dayKey(now - 86400000)) return 'Yesterday';
  return formatDate(ms);
}

export function relativeTime(ms, now = Date.now()) {
  if (!ms) return '';
  const diff = ms - now;
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 1) return 'now';
  if (Math.abs(minutes) < 60) return diff > 0 ? `in ${minutes} min` : `${Math.abs(minutes)} min ago`;
  const hours = Math.round(diff / 3600000);
  if (Math.abs(hours) < 24) return diff > 0 ? `in ${hours} h` : `${Math.abs(hours)} h ago`;
  const days = Math.round(diff / 86400000);
  return diff > 0 ? `in ${days} d` : `${Math.abs(days)} d ago`;
}

export function recurrenceLabel(rule) {
  if (!rule) return '';
  if (rule === 'daily') return 'Every day';
  if (rule === 'weekdays') return 'Every weekday';
  if (rule === 'weekly') return 'Every week';
  if (rule === 'biweekly') return 'Every 2 weeks';
  if (rule === 'monthly') return 'Every month';
  if (rule === 'yearly') return 'Every year';
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  let match = /^(bi)?weekly:([1-7])$/.exec(rule);
  if (match) return `${match[1] ? 'Every other' : 'Every'} ${names[Number(match[2]) % 7]}`;
  match = /^monthly:(\d{1,2})$/.exec(rule);
  if (match) return `Day ${Number(match[1])} of the month`;
  return 'Repeats';
}

export const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const PRIORITY_CLASS = { low: 'badge-muted', normal: 'badge', high: 'badge-brand', urgent: 'badge-danger' };

export function priorityBadge(priority) {
  if (!priority || priority === 'normal') return '';
  return `<span class="badge ${PRIORITY_CLASS[priority] || 'badge'}">${icon('flame', 'ico ico-sm')}${esc(PRIORITY_LABEL[priority] || priority)}</span>`;
}

/** Badge set shared by the task list and the chat reply card. */
export function taskBadges(task) {
  const parts = [];
  if (task.dueAt) {
    const late = !task.completed && task.dueAt < Date.now();
    parts.push(
      `<span class="badge ${late ? 'badge-danger' : 'badge-brand'}">${icon(late ? 'alert' : 'clock', 'ico ico-sm')}${
        task.allDay ? esc(relativeDayLabel(task.dueAt)) : esc(`${relativeDayLabel(task.dueAt)} ${formatTime(task.dueAt)}`)
      }</span>`,
    );
  }
  if (task.recurrence) parts.push(`<span class="badge badge-muted">${icon('repeat', 'ico ico-sm')}${esc(recurrenceLabel(task.recurrence))}</span>`);
  if (task.priority && task.priority !== 'normal') parts.push(priorityBadge(task.priority));
  if (task.source === 'gemini') parts.push('<span class="badge badge-muted">Added by AI</span>');
  else if (task.source === 'offline-parser') parts.push('<span class="badge badge-muted">Added by parser</span>');
  return parts.join('');
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/* ---------------------------------------------------------------- skeleton */

export function skeletonList(rows = 4) {
  return `<div class="stack">${Array.from({ length: rows }, () => '<div class="skeleton skeleton-row"></div>').join('')}</div>`;
}

export function skeletonStats() {
  return `<div class="skeleton-grid">${Array.from({ length: 4 }, () => '<div class="skeleton skeleton-card"></div>').join('')}</div>`;
}

/* ------------------------------------------------------------------- misc */

export function emptyState({ iconName = 'inbox', title, body, actions = '' }) {
  return `<div class="empty">
    <span class="empty-icon">${icon(iconName)}</span>
    <h3>${esc(title)}</h3>
    <p>${esc(body)}</p>
    ${actions ? `<div class="empty-actions">${actions}</div>` : ''}
  </div>`;
}

export function scrollToBottom(node, smooth = true) {
  if (!node) return;
  if (typeof node.scrollTo === 'function') {
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    return;
  }
  node.scrollTop = node.scrollHeight;
}

export function autoGrow(textarea, max = 148) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
}

/** Keep keyboard focus inside a container (used by the mobile drawer). */
export function focusables(root) {
  return $$('a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])', root).filter(
    (node) => node.offsetParent !== null || node === document.activeElement,
  );
}

export function trapFocus(root, event) {
  const nodes = focusables(root);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem('stratarix-preferences') || '{}');
  } catch {
    return {};
  }
}

export function writePrefs(prefs) {
  try {
    localStorage.setItem('stratarix-preferences', JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}
