/**
 * Application shell.
 *
 * Owns the hash router, session bootstrap, sidebar/topbar chrome, global
 * `data-action` handling (task modal, complete/reopen, reminders) and the
 * reminder ticker. Views are plain objects that render HTML into `#view`.
 */
import { createApi, ApiError } from './api.js';
import { appStore } from './state.js';
import {
  $,
  $$,
  icon,
  toast,
  confirmDialog,
  openDialog,
  closeDialog,
  debounce,
  throttle,
  readPrefs,
  writePrefs,
  trapFocus,
} from './ui.js';
import { createHomeView, createServicesView, createContactView, createNotFoundView } from './views/marketing.js';
import { createAuthView, signedOutNotice } from './views/auth.js';
import { createDashboardView, createTasksView, openTaskModal, rescheduleMenu } from './views/tasks.js';
import { createAssistantView } from './views/chat.js';
import { createSettingsView } from './views/settings.js';
import {
  registerServiceWorker,
  startReminderTicker,
  permissionState,
  dismissedBefore,
  rememberChoice,
  requestPermission,
} from './notifications.js';

const PROTECTED = new Set(['dashboard', 'assistant', 'tasks', 'settings']);
const DEFAULT_ROUTE = 'home';
const TASK_TTL_MS = 60_000;

const api = createApi();
let currentView = null;
let stopReminders = null;
let assistantPrefill = null;
let lastFetch = { filter: null, search: null, at: 0 };

const ctx = {
  api,
  store: appStore,
  toast: (message, variant = 'info') => toast(message, { variant }),
  navigate,
  render,
  debounce,
  openDialog,
  closeDialog,
  setFilter,
  setUser,
  deleteTask,
  clearChat,
  applyPrefs,
  onSignedIn,
  onTasksChanged,
  openAssistantWith,
  startReminders,
  consumeAssistantPrefill: () => {
    const value = assistantPrefill;
    assistantPrefill = null;
    return value;
  },
};

/* ------------------------------------------------------------------ prefs */

function applyPrefs(prefs = readPrefs()) {
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const theme = !prefs.theme || prefs.theme === 'system' ? (prefersDark ? 'dark' : 'light') : prefs.theme;
  document.body.dataset.theme = theme;
  document.body.dataset.compact = String(Boolean(prefs.compact));
  document.body.dataset.motion = String(Boolean(prefs.motion));
  $('#theme-icon use')?.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
}

function toggleTheme() {
  const prefs = readPrefs();
  prefs.theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
  writePrefs(prefs);
  applyPrefs(prefs);
}

/* --------------------------------------------------------------- session */

function setUser(user) {
  appStore.set({ user });
  updateAccountChrome(user);
  updateNavCounts();
}

function updateAccountChrome(user) {
  $('#account-name').textContent = user?.name || 'Your workspace';
  $('#account-detail').textContent = user ? user.email : 'Sign in to save tasks';

  const avatar = $('#account-avatar');
  if (avatar) {
    if (user?.name) avatar.textContent = user.name.trim().charAt(0).toUpperCase();
    else avatar.innerHTML = icon('user', 'ico');
  }

  $('#account-chip').setAttribute('href', user ? '#settings' : '#login');
  const cta = $('#header-cta');
  const signin = $('#header-signin');
  if (user) {
    cta.textContent = 'Open assistant';
    cta.setAttribute('href', '#assistant');
    signin.textContent = 'Settings';
    signin.setAttribute('href', '#settings');
  } else {
    cta.textContent = 'Create free account';
    cta.setAttribute('href', '#register');
    signin.textContent = 'Sign in';
    signin.setAttribute('href', '#login');
  }
}

function updateNavCounts() {
  const state = appStore.get();
  const badge = $('#nav-task-count');
  if (badge) {
    const open = (state.counts?.today || 0) + (state.counts?.overdue || 0);
    badge.textContent = String(open);
    badge.hidden = !(state.user && open > 0);
  }
  const aiPill = $('#nav-ai-state');
  if (aiPill) {
    aiPill.textContent = state.aiConfigured ? 'AI' : 'basic';
    aiPill.title = state.aiConfigured
      ? `Gemini is connected${state.aiModel ? ` (${state.aiModel})` : ''}`
      : 'The AI is not configured on this deployment — the built-in parser handles reminders.';
  }
}

function onSignedIn(user, { registered } = {}) {
  setUser(user);
  toast(registered
    ? `Welcome, ${user.name.split(' ')[0]} — your workspace is ready.`
    : `Signed in as ${user.name}.`, 'success');
  // Registration goes straight to the assistant: the fastest path to a first task.
  navigate(registered ? '#assistant' : '#dashboard');
  lastFetch = { filter: null, search: null, at: 0 };
  refreshTasks({ silent: true });
  startReminders();
}

async function signOut() {
  try {
    await api.logout();
  } catch {
    /* The local session is cleared below either way. */
  }
  stopReminders?.();
  stopReminders = null;
  lastFetch = { filter: null, search: null, at: 0 };
  setUser(null);
  appStore.set({ tasks: [], counts: { today: 0, upcoming: 0, overdue: 0, completed: 0, all: 0 } });
  toast('You are signed out.', 'info');
  navigate('#login');
}

/* ------------------------------------------------------------------ tasks */

async function refreshTasks({ silent = false } = {}) {
  const state = appStore.get();
  if (!state.user) return;

  lastFetch = { filter: state.filter, search: state.search, at: Date.now() };
  appStore.set({ loading: { ...appStore.get().loading, tasks: true } });
  currentView?.refresh?.($('#view'));

  try {
    const listing = await api.listTasks(state.filter, state.search);
    appStore.set({
      tasks: listing.tasks || [],
      counts: listing.counts || appStore.get().counts,
      loading: { ...appStore.get().loading, tasks: false },
    });
    updateNavCounts();
  } catch (error) {
    appStore.set({ loading: { ...appStore.get().loading, tasks: false } });
    if (!silent) toast(error.message, 'error');
  }
  currentView?.refresh?.($('#view'));
}

function onTasksChanged() {
  refreshTasks({ silent: true });
}

function setFilter(filter, search) {
  const state = appStore.get();
  appStore.set({
    filter: filter || state.filter,
    search: search === undefined ? state.search : search,
  });
  if (routeName() === 'tasks') refreshTasks({ silent: true });
  else navigate('#tasks');
}

async function findTask(id) {
  const cached = appStore.get().tasks.find((task) => task.id === id);
  if (cached) return cached;
  // The task exists but is outside the active filter (e.g. opened from chat).
  try {
    const listing = await api.listTasks('all', '');
    return listing.tasks.find((task) => task.id === id) || null;
  } catch {
    return null;
  }
}

async function deleteTask(id, { silent = false } = {}) {
  const task = appStore.get().tasks.find((item) => item.id === id);
  if (!silent) {
    const confirmed = await confirmDialog({
      title: 'Delete this task?',
      body: task ? `“${task.title}” will be removed. This cannot be undone.` : 'This task will be removed.',
      confirmLabel: 'Delete task',
    });
    if (!confirmed) return;
  }
  try {
    await api.deleteTask(id);
    appStore.set({ tasks: appStore.get().tasks.filter((item) => item.id !== id) });
    currentView?.refresh?.($('#view'));
    await refreshTasks({ silent: true });
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openAssistantWith(message) {
  assistantPrefill = message || null;
  if (routeName() === 'assistant') render();
  else navigate('#assistant');
}

async function clearChat() {
  const confirmed = await confirmDialog({
    title: 'Clear the conversation?',
    body: 'Your tasks stay exactly as they are — only the chat history is removed.',
    confirmLabel: 'Clear chat',
  });
  if (!confirmed) return;
  try {
    await api.clearChat();
    if (currentView?.key === 'assistant' && currentView.state) currentView.state.messages = [];
    toast('Conversation cleared.', 'success');
    render();
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* -------------------------------------------------------------- reminders */

function startReminders() {
  if (stopReminders || !appStore.get().user) return;
  stopReminders = startReminderTicker({
    api,
    onDue: (task) => {
      toast(`Reminder: ${task.title}`, 'info');
      refreshTasks({ silent: true });
    },
  });
}

function notificationPrompt() {
  if (permissionState() !== 'default' || dismissedBefore()) return '';
  return `<div class="banner banner-info" id="notify-prompt">
    ${icon('bell')}
    <div class="grow">
      <strong>Turn on reminders</strong>
      <p class="text-sm">Allow browser notifications and AI Life Manager will alert you the moment a task is due while the app is open. Your browser asks once — we never ask again if you decline.</p>
    </div>
    <button class="btn btn-primary btn-sm" type="button" data-action="enable-notifications">Enable</button>
    <button class="btn btn-ghost btn-sm" type="button" data-action="dismiss-notify">Not now</button>
  </div>`;
}

function syncNotificationPrompt() {
  const view = $('#view');
  if (!view) return;
  const existing = $('#notify-prompt');
  const markup = ['dashboard', 'tasks', 'assistant'].includes(routeName()) && appStore.get().user
    ? notificationPrompt()
    : '';
  if (!markup) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const host = view.querySelector('.section') || view;
  host.insertAdjacentHTML('beforebegin', `<section class="section">${markup}</section>`);
}

/* ---------------------------------------------------------------- routing */

function routeName() {
  return (location.hash.replace(/^#/, '').split('?')[0].trim()) || DEFAULT_ROUTE;
}

const VIEWS = {
  home: () => createHomeView(ctx),
  services: () => createServicesView(ctx),
  contact: () => createContactView(ctx),
  login: () => createAuthView(ctx, 'login'),
  register: () => createAuthView(ctx, 'register'),
  dashboard: () => createDashboardView(ctx),
  tasks: () => createTasksView(ctx),
  assistant: () => createAssistantView(ctx),
  settings: () => createSettingsView(ctx),
};

function buildView(route) {
  const factory = VIEWS[route];
  if (!factory) return createNotFoundView(ctx);
  if (PROTECTED.has(route) && !appStore.get().user) return signedOutNotice(ctx);
  return factory();
}

function tasksAreStale() {
  const state = appStore.get();
  if (!state.tasks.length) return true;
  if (lastFetch.filter !== state.filter || lastFetch.search !== state.search) return true;
  return Date.now() - lastFetch.at > TASK_TTL_MS;
}

async function render() {
  const route = routeName();
  const view = $('#view');
  if (!view) return;

  const protectedRoute = PROTECTED.has(route) && Boolean(appStore.get().user);
  if (protectedRoute && tasksAreStale()) {
    appStore.set({ loading: { ...appStore.get().loading, tasks: true } });
  }

  currentView = buildView(route);
  view.innerHTML = currentView.html();
  $('#page-title').textContent = currentView.title || route;
  document.title = `${currentView.title || 'AI Life Manager'} · AI Life Manager`;

  $$('.nav a').forEach((link) => {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  await currentView.onMount?.(view);
  syncNotificationPrompt();
  closeMenu();
  window.scrollTo(0, 0);

  if (protectedRoute && tasksAreStale()) refreshTasks({ silent: true });
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/* ------------------------------------------------------------ navigation */

function openMenu() {
  $('#app').dataset.nav = 'open';
  $('#scrim').hidden = false;
  $('#sidebar-open')?.setAttribute('aria-expanded', 'true');
  $('#sidebar-close')?.focus();
}

function closeMenu() {
  const app = $('#app');
  if (app.dataset.nav !== 'open') return;
  app.dataset.nav = 'closed';
  $('#scrim').hidden = true;
  $('#sidebar-open')?.setAttribute('aria-expanded', 'false');
}

function wireChrome() {
  $('#sidebar-open')?.addEventListener('click', openMenu);
  $('#sidebar-close')?.addEventListener('click', closeMenu);
  $('#scrim')?.addEventListener('click', closeMenu);
  $('#theme-toggle')?.addEventListener('click', toggleTheme);
  $('#nav')?.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      return;
    }
    if (event.key === 'Tab' && $('#app').dataset.nav === 'open' && window.matchMedia('(max-width: 1023px)').matches) {
      trapFocus($('#sidebar'), event);
    }
  });

  window.addEventListener('resize', throttle(() => {
    if (window.innerWidth >= 1024) closeMenu();
  }, 200));

  window.addEventListener('offline', () => {
    appStore.set({ offline: true });
    $('#offline-bar').hidden = false;
  });

  window.addEventListener('online', () => {
    appStore.set({ offline: false });
    $('#offline-bar').hidden = true;
    toast('Back online.', 'success');
    refreshTasks({ silent: true });
  });

  $('#year').textContent = String(new Date().getFullYear());
}

/**
 * Service worker: reminder clicks focus the Tasks screen, and a refreshed
 * worker shows a small “reload” bar instead of silently serving old code.
 */
async function wireServiceWorker() {
  const hadController = Boolean(navigator.serviceWorker?.controller);
  const registration = await registerServiceWorker();
  if (!registration) return;

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'reminder-clicked') {
      navigate('#tasks');
      refreshTasks({ silent: true });
    }
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || $('#sw-update')) return;
    $('.main-col')?.insertAdjacentHTML('afterbegin', `<div class="app-update" id="sw-update" role="status">
      <span class="grow">A newer version of AI Life Manager is ready.</span>
      <button class="btn btn-primary btn-sm" type="button" data-action="reload-app">Reload</button>
    </div>`);
  });
}

/* --------------------------------------------------------------- actions */

async function handleAction(action, element) {
  if (currentView?.onAction?.(action, element)) return;

  switch (action) {
    case 'filter':
      setFilter(element.dataset.filter);
      break;

    case 'open-task-modal': {
      const saved = await openTaskModal(ctx);
      if (saved) {
        toast(`“${saved.title}” created.`, 'success');
        await refreshTasks({ silent: true });
        render();
      }
      break;
    }

    case 'edit-task': {
      const task = await findTask(Number(element.dataset.id));
      if (!task) {
        toast('That task is no longer available.', 'warn');
        refreshTasks({ silent: true });
        break;
      }
      const saved = await openTaskModal(ctx, { task });
      if (saved) {
        toast('Task updated.', 'success');
        await refreshTasks({ silent: true });
        render();
      }
      break;
    }

    case 'complete': {
      try {
        const result = await api.completeTask(Number(element.dataset.id));
        toast(result.repeated ? 'Done — the next occurrence is scheduled.' : 'Task completed.', 'success');
        await refreshTasks({ silent: true });
      } catch (error) {
        toast(error.message, 'error');
      }
      break;
    }

    case 'reopen': {
      try {
        await api.reopenTask(Number(element.dataset.id));
        await refreshTasks({ silent: true });
      } catch (error) {
        toast(error.message, 'error');
      }
      break;
    }

    case 'delete-task':
      await deleteTask(Number(element.dataset.id));
      break;

    case 'reschedule-menu': {
      const task = await findTask(Number(element.dataset.id));
      if (!task) break;
      rescheduleMenu(task, async (preset) => {
        try {
          const result = await api.rescheduleTask(task.id, { preset });
          const when = result?.task?.dueAt
            ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(result.task.dueAt))
            : 'the new time';
          toast(`Moved to ${when}.`, 'success');
          await refreshTasks({ silent: true });
          render();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      break;
    }

    case 'focus-composer':
      openAssistantWith('');
      setTimeout(() => $('#chat-input')?.focus(), 80);
      break;

    case 'suggest':
      openAssistantWith(element.dataset.text || '');
      break;

    case 'logout':
      await signOut();
      break;

    case 'clear-chat':
      await clearChat();
      break;

    case 'enable-notifications': {
      const result = await requestPermission();
      if (result === 'granted') {
        toast('Notifications enabled. Reminders will appear at the exact time.', 'success');
        startReminders();
      } else if (result === 'denied') {
        toast('Notifications stay off. You can enable them in your browser site settings.', 'warn');
      } else {
        toast('No change — you can enable notifications later.', 'info');
      }
      $('#notify-prompt')?.remove();
      break;
    }

    case 'reload-app':
      location.reload();
      break;

    case 'dismiss-notify':
      rememberChoice('dismissed');
      $('#notify-prompt')?.remove();
      break;

    default:
      break;
  }
}

/**
 * Stop background work (reminder ticker, timers). Used by the automated UI
 * tests and whenever the document is being torn down.
 */
function dispose() {
  stopReminders?.();
  stopReminders = null;
  assistantPrefill = null;
  currentView = null;
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  applyPrefs();
  wireChrome();
  wireServiceWorker();

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    Promise.resolve(handleAction(target.dataset.action, target)).catch((error) => {
      if (!(error instanceof ApiError) || error.code !== 'offline') console.error(error);
      toast(error?.message || 'Something went wrong. Please try again.', 'error');
    });
  });

  window.addEventListener('hashchange', () => render());

  try {
    const config = await api.config();
    appStore.set({
      config,
      aiConfigured: Boolean(config.ai?.configured),
      aiModel: config.ai?.model || null,
      push: config.push || { enabled: false, reason: '' },
    });
  } catch {
    appStore.set({ aiConfigured: false });
  }

  try {
    const { user } = await api.me();
    appStore.set({ user });
    setUser(user);
  } catch {
    setUser(null);
  }

  appStore.set({ ready: true });

  if (!location.hash) location.hash = appStore.get().user ? '#dashboard' : '#home';

  await render();

  if (appStore.get().user) {
    refreshTasks({ silent: true });
    startReminders();
  }

  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason instanceof ApiError) {
      toast(event.reason.message, 'error');
      event.preventDefault();
    }
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

export { ctx, render, refreshTasks, dispose };
