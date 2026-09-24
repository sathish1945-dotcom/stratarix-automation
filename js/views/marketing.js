/**
 * Marketing pages: overview, automation services and contact.
 * These are the public face of the product for signed-out visitors and keep the
 * behaviour of the original site (email draft is prepared locally, nothing is
 * sent or stored by the server).
 */
import { esc, icon, emptyState } from '../ui.js';

export const CONTACT_EMAIL = 'p.satish9988@gmail.com';

const SERVICES = [
  { name: 'Lead management', category: 'Sales & CRM', icon: 'workflow', tone: '', text: 'Capture enquiries, organise leads and keep every follow-up moving.' },
  { name: 'Email automation', category: 'Communication', icon: 'mail', tone: 'blue', text: 'Timely email workflows for onboarding, reminders and client updates.' },
  { name: 'Reports & insights', category: 'Data & reporting', icon: 'chart', tone: 'green', text: 'Bring your data together and turn routine reporting into a repeatable process.' },
  { name: 'App integrations', category: 'Connected tools', icon: 'repeat', tone: 'amber', text: 'Connect the tools you already use and remove duplicate data entry.' },
  { name: 'Task coordination', category: 'Operations', icon: 'clock', tone: '', text: 'Route work to the right person and keep recurring tasks on schedule.' },
  { name: 'Document workflows', category: 'Administration', icon: 'inbox', tone: 'blue', text: 'Streamline document preparation, approvals and organised handovers.' },
];

function serviceCard(service) {
  return `<article class="card card-hover service">
    <div class="service-top">
      <span class="service-icon ${esc(service.tone)}">${icon(service.icon)}</span>
      <span class="badge badge-muted">Example</span>
    </div>
    <h3 class="card-title">${esc(service.name)}</h3>
    <p>${esc(service.text)}</p>
    <div class="service-foot">
      <span>${esc(service.category)}</span>
      <a class="btn btn-ghost btn-sm" href="#contact?service=${encodeURIComponent(service.name)}">Enquire</a>
    </div>
  </article>`;
}

export function createHomeView(ctx) {
  const signedIn = Boolean(ctx.store.get().user);
  return {
    key: 'home',
    title: 'Overview',
    html() {
      return `
      <section class="section">
        <div class="hero">
          <div>
            <span class="eyebrow">${icon('spark', 'ico ico-sm')} AI LIFE MANAGER</span>
            <h1>Your day, handled by <span class="text-brand">one sentence</span>.</h1>
            <p>Tell the assistant what you need to remember — “remind me to call Arun in 30 minutes”, “every Monday check Buyora” — and it creates the task, the due time and the repeat rule for you.</p>
            <div class="hero-actions">
              <a class="btn btn-primary btn-lg" href="${signedIn ? '#assistant' : '#register'}">
                ${signedIn ? 'Open the assistant' : 'Create free account'} ${icon('arrow-right', 'ico ico-sm')}
              </a>
              <a class="btn btn-ghost btn-lg" href="#services">See automations</a>
            </div>
          </div>
          <div class="demo-panel" role="img" aria-label="Example conversation with the assistant">
            <div class="demo-row">${icon('chat')}<div><strong>“Remind me to submit my assignment tomorrow at 8 PM.”</strong><small>Understood in one pass</small></div></div>
            <div class="demo-connector"></div>
            <div class="demo-row">${icon('check-circle')}<div><strong>Submit my assignment</strong><small>Tomorrow · 8:00 PM · Normal priority</small></div></div>
            <div class="demo-connector"></div>
            <div class="demo-row">${icon('bell')}<div><strong>Reminder scheduled</strong><small>Notified at the exact time in this browser</small></div></div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>How it works</h2>
            <p>Three steps, no setup, no clutter.</p>
          </div>
        </div>
        <div class="grid grid-3">
          <article class="card"><span class="service-icon">${icon('chat')}</span><h3 class="card-title mt-2">Talk in your own words</h3><p class="card-sub">“Add gym at 6 PM”, “every weekday standup at 9:30”, “call Arun in 30 minutes”.</p></article>
          <article class="card"><span class="service-icon green">${icon('spark')}</span><h3 class="card-title mt-2">The AI structures it</h3><p class="card-sub">Title, date, time, repeat rule and priority are extracted and shown back to you before anything is saved.</p></article>
          <article class="card"><span class="service-icon amber">${icon('bell')}</span><h3 class="card-title mt-2">You get reminded</h3><p class="card-sub">Browser notifications fire when a task is due while the app is open, and the dashboard always shows what is next.</p></article>
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div><h2>A starting point for your next workflow</h2><p>Example services from Stratarix. Scope is agreed after we talk.</p></div>
          <a class="btn btn-ghost btn-sm" href="#services">View all ${icon('arrow-right', 'ico ico-sm')}</a>
        </div>
        <div class="grid grid-3">${SERVICES.slice(0, 3).map(serviceCard).join('')}</div>
      </section>

      <section class="section">
        <div class="card row-between">
          <div class="grow">
            <h3 class="card-title">Have a process that eats your week?</h3>
            <p class="card-sub">Tell us what you repeat every day — we will show you what can be automated.</p>
          </div>
          <a class="btn btn-primary" href="#contact">Discuss your project</a>
        </div>
      </section>`;
    },
  };
}

export function createServicesView() {
  return {
    key: 'services',
    title: 'Automations',
    html() {
      return `
      <section class="section">
        <div class="section-head">
          <div>
            <h1>Built around the way you work</h1>
            <p>Example automation services. No third-party app is connected in this preview and no automation runs by itself.</p>
          </div>
        </div>
        <div class="grid grid-3">${SERVICES.map(serviceCard).join('')}</div>
      </section>
      <section class="section">
        <div class="card">
          <h3 class="card-title">What happens next</h3>
          <p class="card-sub">Send an enquiry with the process you want to improve. We will reply with a scope, the tools involved and a realistic timeline. Nothing is charged or promised before that conversation.</p>
          <a class="btn btn-primary mt-2" href="#contact">Start a conversation ${icon('arrow-right', 'ico ico-sm')}</a>
        </div>
      </section>`;
    },
  };
}

export function createContactView(ctx) {
  return {
    key: 'contact',
    title: 'Contact us',
    html() {
      const user = ctx.store.get().user;
      return `
      <section class="section">
        <div class="split split-2">
          <div class="card card-ai">
            <span class="eyebrow eyebrow-inverse">CONTACT US</span>
            <h2>Good automation starts with a conversation.</h2>
            <p>Tell us about your process, the tools you use and the result you want.</p>
            <p class="mt-3"><a class="btn btn-soft" href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a></p>
            <div class="row mt-2">
              <a class="btn btn-ghost" href="https://mail.google.com/mail/?view=cm&amp;fs=1&amp;to=${esc(CONTACT_EMAIL)}" target="_blank" rel="noopener noreferrer">Open in Gmail ${icon('external', 'ico ico-sm')}</a>
              <button class="btn btn-ghost" type="button" data-action="copy-email">Copy email</button>
            </div>
            <hr>
            <h3>What to include</h3>
            <ul>
              <li>The task you want to automate</li>
              <li>The apps your team uses</li>
              <li>Your preferred timeline</li>
            </ul>
          </div>

          <div class="card">
            <h2 class="card-title">Tell us about your project</h2>
            <p class="card-sub mb-2">A few details help us understand your needs.</p>
            <form id="contact-form" novalidate>
              <div class="field-row">
                <label class="field"><span class="field-label">Your name</span>
                  <input class="input" name="name" required maxlength="80" autocomplete="name" placeholder="Full name" value="${esc(user?.name || '')}">
                </label>
                <label class="field"><span class="field-label">Email address</span>
                  <input class="input" name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com" value="${esc(user?.email || '')}">
                </label>
              </div>
              <label class="field"><span class="field-label">What would you like to automate?</span>
                <select class="input" name="service" id="contact-service">
                  <option>Custom automation</option>
                  ${SERVICES.map((service) => `<option>${esc(service.name)}</option>`).join('')}
                </select>
              </label>
              <label class="field"><span class="field-label">Project details</span>
                <textarea class="input" name="message" required minlength="10" maxlength="3000" placeholder="Describe your current process and what you would like to improve"></textarea>
              </label>
              <button class="btn btn-primary btn-block" type="submit">Prepare email ${icon('arrow-right', 'ico ico-sm')}</button>
              <p class="field-hint mt-2">This opens your email app with the message ready to review — nothing is sent or stored by this site.</p>
              <div class="banner banner-success" id="contact-result" role="status" hidden></div>
            </form>
          </div>
        </div>
      </section>`;
    },
    onMount(root) {
      const form = root.querySelector('#contact-form');
      const select = root.querySelector('#contact-service');
      const hashQuery = location.hash.split('?')[1] || '';
      const requested = new URLSearchParams(hashQuery).get('service');
      if (requested && select) {
        const match = Array.from(select.options).find((option) => option.value === requested);
        if (match) select.value = requested;
      }
      form?.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const data = new FormData(form);
        const subject = `Automation enquiry — ${data.get('service')}`;
        const body = `Hello Stratarix,\n\nName: ${data.get('name')}\nEmail: ${data.get('email')}\nService: ${data.get('service')}\n\n${data.get('message')}\n\nRegards,\n${data.get('name')}`;
        location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        const result = root.querySelector('#contact-result');
        result.innerHTML = `${icon('mail', 'ico ico-sm')}<span>Your email draft is ready. If your email app did not open, use “Open in Gmail” or copy the address above.</span>`;
        result.hidden = false;
      });
    },
    onAction(action) {
      if (action !== 'copy-email') return false;
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(CONTACT_EMAIL);
          ctx.toast('Email address copied.', 'success');
        } catch {
          ctx.toast(`Email us at ${CONTACT_EMAIL}`, 'info');
        }
      };
      copy();
      return true;
    },
  };
}

export function createNotFoundView() {
  return {
    key: 'not-found',
    title: 'Not found',
    html: () => `<section class="section">${emptyState({
      iconName: 'alert',
      title: 'That page does not exist',
      body: 'The link may be out of date. Head back to your dashboard to continue.',
      actions: '<a class="btn btn-primary" href="#dashboard">Go to dashboard</a><a class="btn btn-ghost" href="#home">Overview</a>',
    })}</section>`,
  };
}
