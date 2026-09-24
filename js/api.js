/**
 * API client.
 *
 * Every request is same-origin, sends the app's CSRF header, and is bounded by a
 * timeout so a stalled network cannot leave the interface spinning forever.
 * Network failures are turned into a typed error with `offline: true` so views
 * can show a clear "you are offline" state instead of a raw fetch rejection.
 */

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed', retryAfter, offline = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.offline = offline;
  }
}

export function currentTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function createApi({ base = './api', timeoutMs = 15_000, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  async function request(path, { method = 'GET', body, signal, timeout = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-Stratarix-Request'] = '1';

    let response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      throw new ApiError(
        aborted
          ? 'That request took too long. Please check your connection and try again.'
          : 'We could not reach the server. Check your internet connection and try again.',
        { code: aborted ? 'timeout' : 'offline', offline: !aborted },
      );
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    const raw = await response.text();
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const message = payload?.error || (response.status >= 500
        ? 'Something went wrong on our side. Please try again in a moment.'
        : 'That request could not be completed.');
      throw new ApiError(message, {
        status: response.status,
        code: payload?.code || 'http_error',
        retryAfter: Number(response.headers.get('retry-after')) || undefined,
      });
    }

    return payload ?? {};
  }

  return {
    request,
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body: body ?? {} }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body: body ?? {} }),
    delete: (path, options) => request(path, { ...options, method: 'DELETE' }),

    /* ---- domain helpers ---- */
    config: () => request('/config'),
    me: () => request('/me'),
    register: (data) => request('/register', { method: 'POST', body: data }),
    login: (data) => request('/login', { method: 'POST', body: data }),
    logout: () => request('/logout', { method: 'POST', body: {} }),
    updateProfile: (data) => request('/profile', { method: 'POST', body: data }),
    changePassword: (data) => request('/password', { method: 'POST', body: data }),

    listTasks: (filter = 'all', search = '') =>
      request(`/tasks?filter=${encodeURIComponent(filter)}&timezone=${encodeURIComponent(currentTimezone())}&search=${encodeURIComponent(search)}`),
    createTask: (task) => request('/tasks', { method: 'POST', body: { ...task, timezone: currentTimezone() } }),
    updateTask: (id, patch) => request(`/tasks/${id}`, { method: 'PATCH', body: { ...patch, timezone: currentTimezone() } }),
    deleteTask: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),
    completeTask: (id) => request(`/tasks/${id}/complete`, { method: 'POST', body: { timezone: currentTimezone() } }),
    reopenTask: (id) => request(`/tasks/${id}/reopen`, { method: 'POST', body: {} }),
    rescheduleTask: (id, data) => request(`/tasks/${id}/reschedule`, { method: 'POST', body: { ...data, timezone: currentTimezone() } }),
    markNotified: (id) => request(`/tasks/${id}/notified`, { method: 'POST', body: {} }),
    dueReminders: () => request(`/reminders/due?timezone=${encodeURIComponent(currentTimezone())}`),

    chatHistory: () => request('/chat'),
    sendChat: (message, options) =>
      request('/chat', { method: 'POST', body: { message, timezone: currentTimezone() }, timeout: 25_000, ...options }),
    clearChat: () => request('/chat', { method: 'DELETE' }),

    pushConfig: () => request('/push/config'),
    pushSubscribe: (subscription) => request('/push/subscribe', { method: 'POST', body: subscription }),
  };
}
