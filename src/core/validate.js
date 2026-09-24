/**
 * Input validation. Every value that reaches the database goes through here.
 * Rules are intentionally strict and produce user-facing messages only.
 */
import { badRequest } from './errors.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('The request body must be a JSON object.', 'invalid_body');
  }
  return value;
}

export function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value);
}

export function normalizeEmail(value) {
  return text(value).toLowerCase();
}

export function assertEmail(value) {
  const email = normalizeEmail(value);
  if (!isEmail(email)) throw badRequest('Enter a valid email address, for example you@example.com.', 'invalid_email');
  return email;
}

export function assertPassword(value, { field = 'Password' } = {}) {
  if (typeof value !== 'string') throw badRequest(`${field} is required.`, 'invalid_password');
  if (value.length < PASSWORD_MIN) {
    throw badRequest(`${field} must be at least ${PASSWORD_MIN} characters long.`, 'weak_password');
  }
  if (value.length > PASSWORD_MAX) {
    throw badRequest(`${field} must be ${PASSWORD_MAX} characters or fewer.`, 'weak_password');
  }
  // A weak-but-long password is still a weak password. Reject the obvious cases.
  if (/^(.)\1+$/.test(value)) throw badRequest('Choose a password that is not a single repeated character.', 'weak_password');
  if (COMMON_PASSWORDS.has(value.toLowerCase())) {
    throw badRequest('That password is too common. Please choose a different one.', 'weak_password');
  }
  return value;
}

const COMMON_PASSWORDS = new Set([
  'password1234',
  'passwordpassword',
  'qwertyuiop123',
  '123456789012',
  'letmeinletmein',
  'iloveyou1234',
]);

export function assertName(value) {
  const name = text(value).replace(/\s+/g, ' ');
  if (name.length < 2) throw badRequest('Your name must be at least 2 characters long.', 'invalid_name');
  if (name.length > 80) throw badRequest('Your name must be 80 characters or fewer.', 'invalid_name');
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\s'’.\-()&]*$/u.test(name)) {
    throw badRequest('Use letters, numbers, spaces and simple punctuation in your name.', 'invalid_name');
  }
  return name;
}

const TITLE_MAX = 160;
const DESCRIPTION_MAX = 2000;
const MESSAGE_MAX = 1500;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const RECURRENCES = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'];

export function assertTaskTitle(value) {
  const title = text(value).replace(/\s+/g, ' ');
  if (title.length < 2) throw badRequest('Give the task a title of at least 2 characters.', 'invalid_title');
  if (title.length > TITLE_MAX) throw badRequest(`Keep the title under ${TITLE_MAX} characters.`, 'invalid_title');
  return title;
}

export function assertDescription(value) {
  const description = typeof value === 'string' ? value.trim() : '';
  if (description.length > DESCRIPTION_MAX) {
    throw badRequest(`Keep the description under ${DESCRIPTION_MAX} characters.`, 'invalid_description');
  }
  return description;
}

/**
 * Sanitise model-provided text before it is stored or displayed.
 * Strips control characters, collapses whitespace and enforces a length cap.
 */
export function safeMessage(value, max = 600) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

export function assertChatMessage(value) {
  const message = typeof value === 'string' ? value.trim() : '';
  if (!message) throw badRequest('Type a message first.', 'empty_message');
  if (message.length > MESSAGE_MAX) {
    throw badRequest(`Messages are limited to ${MESSAGE_MAX} characters.`, 'message_too_long');
  }
  return message;
}

export function assertPriority(value, fallback = 'normal') {
  if (value === undefined || value === null || value === '') return fallback;
  const priority = text(value).toLowerCase();
  if (!PRIORITIES.includes(priority)) throw badRequest('Choose a valid priority.', 'invalid_priority');
  return priority;
}

/**
 * Recurrence is stored as a normalised string:
 *   daily | weekdays | weekly:1..7 | biweekly:1..7 | monthly:1..31 | yearly:MM-DD
 */
export function assertRecurrence(value) {
  if (value === undefined || value === null || value === '' || value === 'none') return null;
  const rule = text(value).toLowerCase();
  if (RECURRENCES.includes(rule)) return rule;
  let match = /^weekly:([1-7])$/.exec(rule);
  if (match) return `weekly:${match[1]}`;
  match = /^biweekly:([1-7])$/.exec(rule);
  if (match) return `biweekly:${match[1]}`;
  match = /^monthly:(\d{1,2})$/.exec(rule);
  if (match) {
    const day = Number(match[1]);
    if (day >= 1 && day <= 31) return `monthly:${String(day).padStart(2, '0')}`;
  }
  match = /^yearly:(\d{2})-(\d{2})$/.exec(rule);
  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `yearly:${match[1]}-${match[2]}`;
  }
  throw badRequest('That repeat rule is not supported.', 'invalid_recurrence');
}

export function normalizeRecurrence(value) {
  try {
    return assertRecurrence(value);
  } catch {
    return null;
  }
}

export function assertTimezone(value, fallback = 'UTC') {
  const zone = text(value);
  if (!zone) return fallback;
  if (zone.length > 64) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}

/** Task ids are positive integers. Anything else is a 404, never a 500. */
export function assertId(value, label = 'task') {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id > Number.MAX_SAFE_INTEGER) {
    throw badRequest(`That ${label} id is not valid.`, 'invalid_id');
  }
  return id;
}

export function clampNumber(value, { min, max, fallback }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
