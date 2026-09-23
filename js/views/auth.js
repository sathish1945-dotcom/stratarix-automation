/**
 * Sign in and registration.
 *
 * Registration signs the user straight in — the server creates the session in the
 * same request, so there is no "register then log in again" step. Form level
 * validation gives immediate feedback, while the server remains the authority.
 */
import { esc, icon, toast } from '../ui.js';
import { currentTimezone } from '../api.js';

const PASSWORD_MIN = 12;

function aside(mode) {
  const points = mode === 'register'
    ? [
        ['chat', 'Describe a task in one sentence — the AI fills in the details.'],
        ['bell', 'Reminders appear in your browser at the right time.'],
        ['shield', 'Your tasks are private to your account, always.'],
      ]
    : [
        ['check-circle', 'Everything you saved is exactly where you left it.'],
        ['spark', 'Your assistant remembers how you like to work.'],
        ['shield', 'Sessions are secured with HttpOnly cookies.'],
      ];
  return `<div class="auth-aside">
    <span class="eyebrow eyebrow-inverse">AI LIFE MANAGER</span>
    <h2>${mode === 'register' ? 'Start with one sentence.' : 'Welcome back.'}</h2>
    <p>${mode === 'register'
      ? 'Create your workspace and let the assistant organise your day.'
      : 'Sign in to pick up your tasks and reminders.'}</p>
    <div class="auth-points">
      ${points.map(([name, text]) => `<div class="auth-point">${icon(name, 'ico ico-sm')}<span>${esc(text)}</span></div>`).join('')}
    </div>
  </div>`;
}

export function createAuthView(ctx, mode = 'login') {
  const isRegister = mode === 'register';
  return {
    key: mode,
    title: isRegister ? 'Create account' : 'Sign in',
    html() {
      const signedIn = ctx.store.get().user;
      if (signedIn) {
        return `<section class="section"><div class="card"><h2 class="card-title">You are signed in as ${esc(signedIn.name)}</h2>
          <p class="card-sub mb-2">Head to your dashboard or the assistant to keep working.</p>
          <div class="row"><a class="btn btn-primary" href="#dashboard">Open dashboard</a><a class="btn btn-ghost" href="#assistant">Open assistant</a></div></div></section>`;
      }
      return `<section class="section"><div class="auth">
        ${aside(mode)}
        <div class="auth-form">
          <h1>${isRegister ? 'Create your workspace' : 'Sign in'}</h1>
          <p>${isRegister ? 'You will be signed in immediately — no second step.' : 'Use the email address you registered with.'}</p>
          <div class="banner banner-error" id="auth-error" role="alert" hidden></div>
          <form id="auth-form" novalidate>
            ${isRegister ? `<label class="field"><span class="field-label">Your name</span>
              <input class="input" name="name" required minlength="2" maxlength="80" autocomplete="name" placeholder="Satish Kumar"></label>` : ''}
            <label class="field"><span class="field-label">Email address</span>
              <input class="input" name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com"></label>
            <label class="field"><span class="field-label">Password</span>
              <input class="input" name="password" type="password" required minlength="${PASSWORD_MIN}" maxlength="128" autocomplete="${isRegister ? 'new-password' : 'current-password'}" placeholder="${PASSWORD_MIN}+ characters">
              <span class="field-hint">${isRegister ? `Use at least ${PASSWORD_MIN} characters. A short phrase is easier to remember and harder to guess.` : 'Your password is never stored in readable form.'}</span>
            </label>
            <button class="btn btn-primary btn-block btn-lg" type="submit" id="auth-submit">
              ${isRegister ? 'Create account and continue' : 'Sign in'} ${icon('arrow-right', 'ico ico-sm')}
            </button>
          </form>
          <p class="auth-switch">${isRegister
            ? 'Already have an account? <a href="#login">Sign in</a>'
            : 'New here? <a href="#register">Create an account</a>'}</p>
        </div>
      </div></section>`;
    },
    onMount(root) {
      const form = root.querySelector('#auth-form');
      if (!form) return;
      const error = root.querySelector('#auth-error');
      const submit = root.querySelector('#auth-submit');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (!form.reportValidity()) return;
        const data = Object.fromEntries(new FormData(form));
        data.timezone = currentTimezone();
        submit.disabled = true;
        const original = submit.innerHTML;
        submit.innerHTML = `<span class="spin">${icon('repeat')}</span> ${isRegister ? 'Creating your workspace…' : 'Signing in…'}`;
        try {
          const result = isRegister ? await ctx.api.register(data) : await ctx.api.login(data);
          ctx.onSignedIn(result.user, { registered: isRegister });
        } catch (requestError) {
          error.innerHTML = `${icon('alert', 'ico ico-sm')}<span>${esc(requestError.message)}</span>`;
          error.hidden = false;
          if (requestError.code === 'email_taken') {
            error.innerHTML += ' <a href="#login">Go to sign in</a>';
          }
          error.focus?.();
        } finally {
          submit.disabled = false;
          submit.innerHTML = original;
        }
      });
    },
  };
}

export function signedOutNotice(ctx, { title = 'Sign in to continue', body = 'Your assistant and tasks live inside your account.' } = {}) {
  return {
    key: 'auth-required',
    title,
    html: () => `<section class="section">${`
      <div class="card center">
        <span class="empty-icon">${icon('shield')}</span>
        <h2 class="card-title">${esc(title)}</h2>
        <p class="card-sub mb-2">${esc(body)}</p>
        <div class="row justify-center">
          <a class="btn btn-primary" href="#register">Create free account</a>
          <a class="btn btn-ghost" href="#login">Sign in</a>
        </div>
      </div>`}</section>`,
    onMount() {
      toast('Please sign in to open that page.', 'info');
    },
  };
}
