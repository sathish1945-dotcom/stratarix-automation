/**
 * Tiny observable store — enough for a single-page app without a framework.
 */
export function createStore(initialState) {
  let state = { ...initialState };
  const listeners = new Set();

  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const listener of listeners) listener(state);
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const appStore = createStore({
  ready: false,
  user: null,
  config: null,
  tasks: [],
  counts: { today: 0, upcoming: 0, overdue: 0, completed: 0, all: 0 },
  filter: 'today',
  search: '',
  loading: { tasks: false, chat: false, session: false },
  offline: false,
  aiConfigured: false,
  aiModel: null,
  // False when the frontend is served without its API behind it (for example a
  // static GitHub Pages copy, or a Node deployment that is down).
  backendReachable: true,
  backendError: null,
  push: { enabled: false, reason: '' },
});
