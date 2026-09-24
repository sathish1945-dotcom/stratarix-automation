/**
 * jsdom harness for the browser bundle.
 *
 * This runs the *real* frontend modules (js/main.js and friends) inside jsdom
 * against the *real* backend router — the only substitutions are the browser
 * APIs jsdom does not implement (fetch, matchMedia, Notification, dialog) and
 * the network hop, which calls the router in-process through `fetch`.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createTestApp, ORIGIN } from './helpers.mjs';

const INDEX_PATH = fileURLToPath(new URL('../index.html', import.meta.url));
const MAIN_PATH = new URL('../js/main.js', import.meta.url).href;

let mountCount = 0;

/** Minimal MediaQueryList so `(min|max)-width` checks behave sensibly. */
function mediaQueryList(query, view) {
  const max = /max-width:\s*(\d+)px/.exec(query);
  const min = /min-width:\s*(\d+)px/.exec(query);
  const matches = max || min
    ? (max ? view.innerWidth <= Number(max[1]) : true) && (min ? view.innerWidth >= Number(min[1]) : true)
    : /dark/.test(query)
      ? false
      : false;
  return {
    media: query,
    matches,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  };
}

class FakeNotification {
  static permission = 'default';
  static shown = [];
  static asks = 0;

  static async requestPermission() {
    FakeNotification.asks += 1;
    FakeNotification.permission = 'granted';
    return 'granted';
  }

  constructor(title, options = {}) {
    FakeNotification.shown.push({ title, options });
  }

  close() {}
}

export async function mountUI({
  app: providedApp = null,
  env = {},
  fetchImpl = fetch,
  cookie = null,
  hash = null,
  windowSize = 1280,
} = {}) {
  const { app, origin, db } = providedApp
    ? { app: providedApp, origin: ORIGIN, db: null }
    : await createTestApp({ env, fetchImpl });
  const html = await readFile(INDEX_PATH, 'utf8');

  // main.js is re-imported per mount, but its module graph (including the app
  // store) is cached — a real page load would start from a clean slate.
  const { appStore } = await import('../js/state.js');
  appStore.set({
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
    push: { enabled: false, reason: '' },
  });

  FakeNotification.permission = 'default';
  FakeNotification.shown = [];
  FakeNotification.asks = 0;

  const dom = new JSDOM(html, {
    url: `${origin}/${hash ? `#${hash}` : ''}`,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    virtualConsole: new (await import('jsdom')).VirtualConsole(),
  });
  const win = dom.window;
  const doc = win.document;

  Object.defineProperty(win, 'innerWidth', { value: windowSize, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: 900, configurable: true });

  // --- jsdom gaps -----------------------------------------------------------------
  win.scrollTo = () => {};
  win.matchMedia = (query) => mediaQueryList(query, win);
  win.confirm = () => true;
  win.Notification = FakeNotification;

  if (typeof win.HTMLFormElement.prototype.reportValidity !== 'function') {
    win.HTMLFormElement.prototype.reportValidity = function reportValidity() {
      return true;
    };
  }

  // --- network bridge -------------------------------------------------------------
  let jar = cookie;
  const requests = [];

  async function bridge(input, init = {}) {
    const url = new URL(String(input), win.location.href);
    const headers = new Headers(init.headers || {});
    headers.set('origin', origin);
    if (jar) headers.set('cookie', jar);
    const request = new Request(url.href, {
      method: init.method || 'GET',
      headers,
      body: init.body === undefined ? undefined : init.body,
      duplex: init.body === undefined ? undefined : 'half',
    });

    requests.push({ method: request.method, path: url.pathname + url.search });
    const response = await app.handle(request);

    const setCookies = response.headers.getSetCookie?.() || [];
    for (const value of setCookies) {
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(value)) jar = null;
      else jar = value.split(';')[0];
    }
    return response;
  }

  // --- globals --------------------------------------------------------------------
  const saved = new Map();
  const install = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };

  const noop = () => {};
  install('window', win);
  install('document', doc);
  install('navigator', win.navigator);
  install('location', win.location);
  install('history', win.history);
  install('localStorage', win.localStorage);
  install('sessionStorage', win.sessionStorage);
  install('FormData', win.FormData);
  install('Notification', FakeNotification);
  install('fetch', bridge);
  install('getComputedStyle', win.getComputedStyle.bind(win));
  install('matchMedia', win.matchMedia);
  install('requestAnimationFrame', win.requestAnimationFrame.bind(win));
  install('cancelAnimationFrame', win.cancelAnimationFrame.bind(win));
  install('Event', win.Event);
  install('CustomEvent', win.CustomEvent);
  install('KeyboardEvent', win.KeyboardEvent);
  install('MouseEvent', win.MouseEvent);
  install('HTMLElement', win.HTMLElement);
  install('Element', win.Element);
  install('Node', win.Node);
  install('IntersectionObserver', undefined);
  install('ResizeObserver', undefined);
  install('print', noop);

  // --- capture anything the UI would show as a broken screen -----------------------
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => {
    const line = args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ');
    // The backend runs in-process here, so its structured logs also arrive on
    // console.error. They are server-side by design, not UI failures.
    if (line.startsWith('[stratarix]')) return;
    errors.push(line);
  };
  win.addEventListener('error', (event) => errors.push(`window.onerror: ${event.message}`));
  const onRejection = (reason) => errors.push(`unhandledRejection: ${reason?.message || reason}`);
  process.on('unhandledRejection', onRejection);

  // --- boot the real bundle -------------------------------------------------------
  const main = await import(`${MAIN_PATH}?ui=${(mountCount += 1)}-${Date.now()}`);

  const helpers = {
    app,
    db,
    origin,
    win,
    doc,
    main,
    ctx: main.ctx,
    store: () => main.ctx.store.get(),
    errors,
    requests,
    notifications: FakeNotification,
    jar: () => jar,
    setCookie: (value) => {
      jar = value;
    },

    $(selector, root = doc) {
      return root.querySelector(selector);
    },

    $$(selector, root = doc) {
      return Array.from(root.querySelectorAll(selector));
    },

    text(selector, root = doc) {
      const node = typeof selector === 'string' ? helpers.$(selector, root) : selector;
      return node ? node.textContent.replace(/\s+/g, ' ').trim() : '';
    },

    click(target, init = {}) {
      const node = typeof target === 'string' ? helpers.$(target) : target;
      if (!node) throw new Error(`click: no element for ${typeof target === 'string' ? target : target?.outerHTML?.slice(0, 80)}`);
      node.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
      return node;
    },

    async submit(selector, submitter = null) {
      const form = typeof selector === 'string' ? helpers.$(selector) : selector;
      if (!form) throw new Error(`submit: no form for ${selector}`);
      if (submitter) form.requestSubmit(submitter);
      else form.requestSubmit();
      await helpers.tick();
    },

    type(target, value) {
      const node = typeof target === 'string' ? helpers.$(target) : target;
      if (!node) throw new Error(`type: no field for ${typeof target === 'string' ? target : '<element>'}`);
      node.value = value;
      node.dispatchEvent(new win.Event('input', { bubbles: true }));
      return node;
    },

    key(target, key) {
      const node = typeof target === 'string' ? helpers.$(target) : target;
      node.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    },

    /** Let queued microtasks, timers and DOM updates settle. */
    async tick(ms = 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await Promise.resolve();
    },

    async waitFor(predicate, { timeout = 4000, interval = 15, label = 'condition' } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (await predicate()) return true;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    },

    /** Call the API directly with the browser's cookie, for assertions. */
    async api(path, options = {}) {
      const headers = new Headers(options.headers || {});
      headers.set('origin', origin);
      headers.set('x-stratarix-request', '1');
      if (jar) headers.set('cookie', jar);
      if (options.body !== undefined) headers.set('content-type', 'application/json');
      const response = await app.handle(new Request(`${origin}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        duplex: options.body === undefined ? undefined : 'half',
      }));
      const text = await response.text();
      return { status: response.status, data: text ? JSON.parse(text) : null };
    },

    async goto(hashTarget) {
      win.location.hash = hashTarget;
      await helpers.waitFor(() => win.location.hash === hashTarget, { label: `hash ${hashTarget}` });
      await helpers.tick(30);
    },

    teardown() {
      console.error = originalError;
      process.removeListener('unhandledRejection', onRejection);
      try {
        main.dispose?.();
      } catch {
        /* ignore */
      }
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      win.close();
    },
  };

  // Wait for boot() to finish before handing control back.
  await helpers.waitFor(() => main.ctx.store.get().ready, { label: 'app boot', timeout: 8000 });
  await helpers.tick(30);

  return helpers;
}
