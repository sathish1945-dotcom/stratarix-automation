/**
 * Settings: profile, appearance, reminders, security and account.
 * Notification permission is only ever requested from the button here (or the
 * dashboard banner) — never on page load, and never again after a refusal.
 */
import { esc, icon, toast, readPrefs, writePrefs } from '../ui.js';
import { currentTimezone } from '../api.js';
import { NOTIFICATION_HELP, permissionState, preparePush, requestPermission } from '../notifications.js';

function permissionBlock(ctx) {
  const state = permissionState();
  if (state === 'unsupported') {
    return `<div class="setting-row">
      <div><strong>Browser notifications</strong><p>This browser does not support notifications. Reminders still appear inside the app.</p></div>
      <span class="badge badge-muted">Unsupported</span>
    </div>`;
  }
  if (state === 'granted') {
    return `<div class="setting-row">
      <div><strong>Browser notifications</strong><p>Enabled. You will be notified when a task reaches its time while the app is open.</p></div>
      <span class="badge badge-success">${icon('check', 'ico ico-sm')} Allowed</span>
    </div>`;
  }
  if (state === 'denied') {
    return `<div class="setting-row">
      <div><strong>Browser notifications</strong><p>Blocked in this browser. To change it, open your browser's site settings for this page, allow notifications, then reload. We will not ask again.</p></div>
      <span class="badge badge-danger">Blocked</span>
    </div>`;
  }
  return `<div class="setting-row">
    <div><strong>Browser notifications</strong><p>${esc(NOTIFICATION_HELP)}</p></div>
    <button class="btn btn-primary btn-sm" type="button" data-action="enable-notifications">${icon('bell', 'ico ico-sm')} Allow notifications</button>
  </div>`;
}

export function createSettingsView(ctx) {
  return {
    key: 'settings',
    title: 'Settings',
    html() {
      const store = ctx.store.get();
      const user = store.user;
      const prefs = readPrefs();
      const timezone = user?.timezone || currentTimezone();
      const aiConfigured = store.aiConfigured;

      return `
      <section class="section">
        <h1>Settings</h1>
        <p class="muted">Everything here is stored on your account or in this browser only.</p>
      </section>

      <section class="section">
        <div class="card">
          <h2 class="card-title">Profile</h2>
          <p class="card-sub mb-2">Your name appears in the interface; your timezone decides when “today” and “tomorrow” start.</p>
          <div class="banner banner-error" id="profile-error" hidden></div>
          <form id="profile-form">
            <div class="field-row">
              <label class="field"><span class="field-label">Name</span>
                <input class="input" name="name" value="${esc(user?.name || '')}" required minlength="2" maxlength="80" autocomplete="name">
              </label>
              <label class="field"><span class="field-label">Email</span>
                <input class="input" value="${esc(user?.email || '')}" disabled>
              </label>
            </div>
            <div class="field-row">
              <label class="field"><span class="field-label">Timezone</span>
                <input class="input" name="timezone" value="${esc(timezone)}" maxlength="64" placeholder="Asia/Kolkata">
                <span class="field-hint">Detected from this device. Change it if you travel or plan for another region.</span>
              </label>
            </div>
            <button class="btn btn-primary" type="submit">Save profile</button>
          </form>
        </div>
      </section>

      <section class="section">
        <div class="card">
          <h2 class="card-title">Appearance</h2>
          <div class="setting-row">
            <div><strong>Theme</strong><p>Follow your system, or pick a fixed theme.</p></div>
            <select class="input input-auto" id="pref-theme">
              <option value="system"${prefs.theme === 'system' ? ' selected' : ''}>Match system</option>
              <option value="light"${prefs.theme === 'light' ? ' selected' : ''}>Light</option>
              <option value="dark"${prefs.theme === 'dark' ? ' selected' : ''}>Dark</option>
            </select>
          </div>
          <div class="setting-row">
            <div><strong>Compact spacing</strong><p>Fit more tasks on screen.</p></div>
            <label class="switch"><input type="checkbox" id="pref-compact"${prefs.compact ? ' checked' : ''}></label>
          </div>
          <div class="setting-row">
            <div><strong>Reduce animations</strong><p>Turn off motion effects across the app.</p></div>
            <label class="switch"><input type="checkbox" id="pref-motion"${prefs.motion ? ' checked' : ''}></label>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="card">
          <h2 class="card-title">Reminders</h2>
          <div class="setting-row">
            <div><strong>App is open</strong><p>Reminders fire at the exact task time while AI Life Manager is open in a tab.</p></div>
            <span class="badge badge-success">Working</span>
          </div>
          ${permissionBlock(ctx)}
          <div class="setting-row">
            <div><strong>App fully closed</strong><p id="push-status">${esc(store.push?.reason || 'Checking push notifications…')}</p></div>
            <span class="badge ${store.push?.enabled ? 'badge-success' : 'badge-warn'}">${store.push?.enabled ? 'Active' : 'Not enabled'}</span>
          </div>
          <p class="field-hint mt-2">Delivery while the browser or device is completely closed needs Web Push (VAPID keys) and a scheduling service. Those are not configured on this deployment — the app will not pretend otherwise.</p>
        </div>
      </section>

      <section class="section">
        <div class="card">
          <h2 class="card-title">AI assistant</h2>
          <div class="setting-row">
            <div><strong>Gemini API</strong><p>${aiConfigured
              ? `Connected${store.aiModel ? ` · model ${esc(store.aiModel)}` : ''}. Requests are made from the server only, so the key never reaches this browser.`
              : 'Not configured on this deployment. The built-in parser still handles reminder commands such as “Remind me to call Arun in 30 minutes”.'}</p></div>
            <span class="badge ${aiConfigured ? 'badge-success' : 'badge-warn'}">${aiConfigured ? 'Connected' : 'Offline'}</span>
          </div>
          <div class="setting-row">
            <div><strong>Conversation history</strong><p>Clear the saved conversation. Tasks are not affected.</p></div>
            <button class="btn btn-ghost btn-sm" type="button" data-action="clear-chat">Clear chat history</button>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="card">
          <h2 class="card-title">Security</h2>
          <div class="banner banner-error" id="password-error" hidden></div>
          <div class="banner banner-success" id="password-ok" hidden></div>
          <form id="password-form">
            <div class="field-row">
              <label class="field"><span class="field-label">Current password</span>
                <input class="input" name="currentPassword" type="password" required autocomplete="current-password">
              </label>
              <label class="field"><span class="field-label">New password</span>
                <input class="input" name="newPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password">
                <span class="field-hint">At least 12 characters. Other devices will be signed out.</span>
              </label>
            </div>
            <button class="btn btn-primary" type="submit">Update password</button>
          </form>
        </div>
      </section>

      <section class="section">
        <div class="card">
          <h2 class="card-title">Account</h2>
          <div class="setting-row">
            <div><strong>Session</strong><p>Signed in as ${esc(user?.email || '')}. Sessions last 7 days and end immediately when you sign out.</p></div>
            <button class="btn btn-ghost btn-sm" type="button" data-action="logout">${icon('logout', 'ico ico-sm')} Sign out</button>
          </div>
          <div class="setting-row">
            <div><strong>Delete account</strong><p>Account deletion is handled by support so that your data is removed safely. Email us and we will confirm.</p></div>
            <a class="btn btn-ghost btn-sm" href="#contact">Contact support</a>
          </div>
        </div>
      </section>`;
    },

    onMount(root) {
      const profile = root.querySelector('#profile-form');
      const profileError = root.querySelector('#profile-error');
      profile?.addEventListener('submit', async (event) => {
        event.preventDefault();
        profileError.hidden = true;
        if (!profile.reportValidity()) return;
        const data = Object.fromEntries(new FormData(profile));
        try {
          await ctx.api.updateProfile({ name: data.name, timezone: data.timezone });
          ctx.setUser({ ...ctx.store.get().user, name: data.name, timezone: data.timezone });
          toast('Profile updated.', 'success');
        } catch (error) {
          profileError.innerHTML = `${icon('alert', 'ico ico-sm')}<span>${esc(error.message)}</span>`;
          profileError.hidden = false;
        }
      });

      const password = root.querySelector('#password-form');
      password?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorNode = root.querySelector('#password-error');
        const okNode = root.querySelector('#password-ok');
        errorNode.hidden = true;
        okNode.hidden = true;
        if (!password.reportValidity()) return;
        const data = Object.fromEntries(new FormData(password));
        try {
          const result = await ctx.api.changePassword(data);
          okNode.innerHTML = `${icon('check-circle', 'ico ico-sm')}<span>${esc(result.message || 'Password updated.')}</span>`;
          okNode.hidden = false;
          password.reset();
        } catch (error) {
          errorNode.innerHTML = `${icon('alert', 'ico ico-sm')}<span>${esc(error.message)}</span>`;
          errorNode.hidden = false;
        }
      });

      const theme = root.querySelector('#pref-theme');
      const compact = root.querySelector('#pref-compact');
      const motion = root.querySelector('#pref-motion');
      const persist = () => {
        const prefs = { theme: theme.value, compact: compact.checked, motion: motion.checked };
        ctx.applyPrefs(prefs);
        toast(writePrefs(prefs) ? 'Preference saved.' : 'Preference applied for this visit only.', 'success');
      };
      theme?.addEventListener('change', persist);
      compact?.addEventListener('change', persist);
      motion?.addEventListener('change', persist);

      // Report the truthful push status once the config is available.
      preparePush({ api: ctx.api }).then((status) => {
        const node = root.querySelector('#push-status');
        if (node && status?.message) node.textContent = status.message;
      }).catch(() => {});
    },

    onAction(action) {
      if (action !== 'enable-notifications') return false;
      requestPermission().then(async (result) => {
        if (result === 'granted') {
          toast('Notifications enabled. Reminders will appear at the exact time.', 'success');
          ctx.startReminders?.();
        } else if (result === 'denied') {
          toast('Notifications stay off. You can enable them in your browser site settings.', 'warn');
        } else {
          toast('No change — you can enable notifications later.', 'info');
        }
        ctx.render();
      });
      return true;
    },
  };
}
