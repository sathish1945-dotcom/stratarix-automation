/**
 * The required natural-language examples must work even without an AI provider.
 * The reference instant is Tuesday 22 September 2026, 10:00 in Asia/Kolkata.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskCommand, detectRecurrence } from '../src/core/nlp.js';
import { dayKey, formatDateTime, zonedToUtc } from '../src/core/time.js';

const dayKeyOf = (ms) => dayKey(ms, TZ);

const TZ = 'Asia/Kolkata';
const NOW = zonedToUtc({ year: 2026, month: 9, day: 22, hour: 10, minute: 0 }, TZ);
const parse = (message) => parseTaskCommand(message, { now: NOW, timeZone: TZ });

test('the five example commands from the brief are understood', () => {
  const assignment = parse('Remind me to submit my assignment tomorrow at 8 PM.');
  assert.equal(assignment.intent, 'create_task');
  assert.equal(assignment.task.title, 'Submit my assignment');
  assert.equal(formatDateTime(assignment.task.dueAt, TZ), 'Wed 23 Sept, 08:00 pm');
  assert.equal(assignment.task.allDay, false);

  const wake = parse('Wake me at 6 AM.');
  assert.equal(wake.intent, 'create_task');
  assert.equal(wake.task.title, 'Wake up');
  assert.equal(formatDateTime(wake.task.dueAt, TZ), 'Wed 23 Sept, 06:00 am');

  const recurring = parse('Remind me every Monday to check Buyora.');
  assert.equal(recurring.task.title, 'Check Buyora');
  assert.equal(recurring.task.recurrence, 'weekly:1');
  assert.equal(formatDateTime(recurring.task.dueAt, TZ), 'Mon 28 Sept, 09:00 am');

  const gym = parse('Add gym at 6 PM.');
  assert.equal(gym.task.title, 'Gym');
  assert.equal(formatDateTime(gym.task.dueAt, TZ), 'Tue 22 Sept, 06:00 pm');

  const call = parse('Remind me to call Arun in 30 minutes.');
  assert.equal(call.task.title, 'Call Arun');
  assert.equal(call.task.dueAt, NOW + 30 * 60_000);
});

test('times that already passed today roll to tomorrow', () => {
  const result = parse('Remind me to water the plants at 6 AM');
  assert.equal(result.task.title, 'Water the plants');
  assert.equal(formatDateTime(result.task.dueAt, TZ), 'Wed 23 Sept, 06:00 am');
});

test('dates, repeats and priorities are recognised', () => {
  const bill = parse('Pay electricity bill on 5 October');
  assert.equal(bill.task.allDay, true);
  assert.equal(dayKeyOf(bill.task.dueAt), '2026-10-05');
  assert.equal(parse('Submit report every weekday at 9:30 am').task.recurrence, 'weekdays');
  assert.equal(parse('Standup every other Tuesday at 10am').task.recurrence, 'biweekly:2');
  assert.equal(parse('Take medicine every day at 8 am').task.recurrence, 'daily');
  assert.equal(parse('Rent on the 5th of every month').task.recurrence, 'monthly:05');
  assert.equal(parse('Weekly review every week').task.recurrence, 'weekly:2');
  assert.equal(parse('Call the bank urgently tomorrow at 11 am').task.priority, 'urgent');
  assert.equal(parse('Clean the desk someday').task.priority, 'low');
  assert.equal(parse('Remind me to buy milk tomorrow and call mum').task.title, 'Buy milk and call mum');
});

test('non-command messages are reported as unsupported instead of invented', () => {
  const result = parse('Hello, how are you?');
  assert.equal(result.intent, 'unsupported');
  assert.equal(result.task, null);
  assert.equal(result.source, 'offline-parser');
  assert.match(result.reply, /could not find/i);
});

test('recurrence detection covers the documented vocabulary', () => {
  assert.equal(detectRecurrence('every monday').rule, 'weekly:1');
  assert.equal(detectRecurrence('every sunday').rule, 'weekly:7');
  assert.equal(detectRecurrence('every other friday').rule, 'biweekly:5');
  assert.equal(detectRecurrence('every weekday').rule, 'weekdays');
  assert.equal(detectRecurrence('every 15th').rule, 'monthly:15');
  assert.equal(detectRecurrence('no repeat here').rule, null);
});

test('empty input is handled without throwing', () => {
  const result = parseTaskCommand('', { now: NOW, timeZone: TZ });
  assert.equal(result.intent, 'unsupported');
});
