/**
 * Reminder notifications.
 *
 * What actually works today:
 *  - Notification permission is requested from a user gesture, with an
 *    explanation, and never asked again after a denial.
 *  - While the app is open (any tab), a lightweight ticker asks the server which
 *    of the user's tasks have reached their reminder time and shows a browser
 *    notification containing the task title. The task is marked as notified so
 *    other tabs do not repeat it.
 *
 * What is scaffolded but NOT delivered yet, and is labelled as such in the
 * interface: delivery while the browser or device is completely closed. That
 * needs Web Push (VAPID keys), a service-worker `push` handler and a server-side
 * scheduler. The service worker already contains the `push` and
 * `pushsubscriptionchange` handlers, and /api/push/config reports
 * `enabled: false` until the keys and scheduler exist — so nothing here claims
 * more than it can do.
 */

const DISMISS_KEY = 'stratarix-notification-choice';
const TICK_MS = 20_000;

export function permissionState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export function dismissedBefore() {
  try {
    return localStorage.getItem(DISMISS_KEY) !== null;
  } catch {
    return false;
  }
}

export function rememberChoice(choice) {
  try {
    localStorage.setItem(DISMISS_KEY, choice);
  } catch {
    /* storage disabled: the permission state itself still prevents re-prompting */
  }
}

/** Ask for permission. Must be called from a click handler. */
export async function requestPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') {
    rememberChoice('denied');
    return 'denied';
  }
  const result = await Notification.requestPermission();
  rememberChoice(result);
  return result;
}

async function activeRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) || null;
  } catch {
    return null;
  }
}

/**
 * Show a reminder. Prefers the service worker (works when the tab is in the
 * background and supports click-to-focus) and falls back to the constructor.
 */
export async function showReminder(task, { body } = {}) {
  const title = task?.title ? String(task.title).slice(0, 120) : 'Reminder';
  const options = {
    body: body || (task?.description ? String(task.description).slice(0, 180) : 'Tap to open AI Life Manager.'),
    tag: `task-${task?.id ?? 'unknown'}`,
    renotify: false,
    data: { url: `${location.origin}${location.pathname}#tasks`, taskId: task?.id ?? null },
    icon: './icons/icon-192.png',
    badge: './icons/badge-72.png',
  };

  const registration = await activeRegistration();
  if (registration?.showNotification) {
    await registration.showNotification(title, options);
    return;
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const notification = new Notification(title, options);
    notification.onclick = () => {
      window.focus();
      location.hash = '#tasks';
    };
  }
}

/** Register the service worker. Fails quietly when unsupported. */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch {
    return null;
  }
}

/**
 * Poll for tasks that have come due and notify once per task.
 * Returns a stop function.
 */
export function startReminderTicker({ api, onDue, intervalMs = TICK_MS, logger = console }) {
  let stopped = false;
  let running = false;
  const notified = new Set();

  async function tick() {
    if (stopped || running || document.hidden === true) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    running = true;
    try {
      const { tasks } = await api.dueReminders();
      for (const task of tasks || []) {
        const key = `${task.id}:${task.dueAt}`;
        if (notified.has(key)) continue;
        notified.add(key);
        await showReminder(task);
        onDue?.(task);
        try {
          await api.markNotified(task.id);
        } catch (error) {
          logger.warn?.('Could not mark reminder as delivered', error?.message);
        }
      }
      if (notified.size > 200) notified.clear();
    } catch (error) {
      // Offline or unauthenticated: skip this tick, the next one retries.
      logger.warn?.('Reminder check failed', error?.message);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  setTimeout(tick, 1500);
  document.addEventListener('visibilitychange', tick);

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
  };
}

/**
 * Push subscription scaffolding. Returns a truthful status object: the caller
 * must show `message` when `delivering` is false.
 */
export async function preparePush({ api }) {
  try {
    const config = await api.pushConfig();
    if (!config.enabled) return { supported: 'serviceWorker' in navigator, delivering: false, message: config.reason };
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return { supported: false, delivering: false, message: 'This browser does not support push notifications.' };
    }
    const registration = await activeRegistration();
    const existing = await registration?.pushManager?.getSubscription();
    return {
      supported: true,
      delivering: true,
      subscription: existing || null,
      message: existing ? 'Push notifications are active on this device.' : 'Enable push notifications to be reminded when the app is closed.',
    };
  } catch (error) {
    return { supported: false, delivering: false, message: 'Could not check push notification support.', error };
  }
}

export const NOTIFICATION_HELP =
  'Notifications let AI Life Manager remind you the moment a task is due — even when you are working in another tab. ' +
  'Your browser asks for permission once; the app never asks again after you decline.';
