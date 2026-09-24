/**
 * Timezone maths. These are the tests that keep "today", "overdue" and repeat
 * rules correct for a user in India while the server runs in UTC.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  addMonths,
  dayKey,
  daysInMonth,
  describeRecurrence,
  endOfDay,
  formatDateTime,
  isSameDay,
  isoWeekday,
  nextOccurrence,
  nextOccurrenceFromNow,
  safeTimezone,
  startOfDay,
  weekdayToRule,
  zonedParts,
  zonedToUtc,
} from '../src/core/time.js';

const IST = 'Asia/Kolkata';
const NEW_YORK = 'America/New_York';
/** Tuesday 22 September 2026, 10:00 IST. */
const NOW = zonedToUtc({ year: 2026, month: 9, day: 22, hour: 10, minute: 0 }, IST);

test('wall-clock conversions are timezone correct', () => {
  assert.equal(new Date(NOW).toISOString(), '2026-09-22T04:30:00.000Z');
  const parts = zonedParts(NOW, IST);
  assert.deepEqual({ ...parts, second: 0 }, { year: 2026, month: 9, day: 22, hour: 10, minute: 0, second: 0 });
  assert.equal(formatDateTime(NOW, IST), 'Tue 22 Sept, 10:00 am');
  assert.equal(formatDateTime(NOW, 'UTC'), 'Tue 22 Sept, 04:30 am');
});

test('day boundaries follow the requested timezone, not the server clock', () => {
  const start = startOfDay(NOW, IST);
  assert.equal(new Date(start).toISOString(), '2026-09-21T18:30:00.000Z');
  assert.equal(dayKey(start, IST), '2026-09-22');
  const end = endOfDay(NOW, IST);
  assert.equal(new Date(end).toISOString(), '2026-09-22T18:29:59.999Z');
  // 00:30 IST is still the previous day in UTC.
  const lateNight = zonedToUtc({ year: 2026, month: 9, day: 22, hour: 0, minute: 30 }, IST);
  assert.equal(isSameDay(lateNight, NOW, IST), true);
  assert.equal(isSameDay(lateNight, NOW, 'UTC'), false);
});

test('adding days and months preserves the local wall-clock time', () => {
  const plusOne = addDays(NOW, IST, 1);
  assert.equal(formatDateTime(plusOne, IST), 'Wed 23 Sept, 10:00 am');
  const plusMonth = addMonths(NOW, IST, 1);
  assert.equal(formatDateTime(plusMonth, IST), 'Thu 22 Oct, 10:00 am');
  // 31 January + 1 month clamps to the last day of February.
  const jan31 = zonedToUtc({ year: 2026, month: 1, day: 31, hour: 9 }, IST);
  assert.equal(dayKey(addMonths(jan31, IST, 1), IST), '2026-02-28');
  assert.equal(daysInMonth(2028, 2), 29);
});

test('DST transitions keep the local time stable', () => {
  // US clocks move forward on 8 March 2026.
  const beforeDst = zonedToUtc({ year: 2026, month: 3, day: 7, hour: 9 }, NEW_YORK);
  const afterDst = addDays(beforeDst, NEW_YORK, 1);
  assert.equal(zonedParts(afterDst, NEW_YORK).hour, 9);
  assert.equal(afterDst - beforeDst, 23 * 60 * 60 * 1000);
  // A non-existent local time (02:30 during the spring-forward gap) still resolves.
  const gap = zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NEW_YORK);
  assert.ok(Number.isFinite(gap));
});

test('weekdays and repeat rules advance as documented', () => {
  assert.equal(isoWeekday(NOW, IST), 2); // Tuesday
  assert.equal(weekdayToRule('Monday'), 'weekly:1');
  assert.equal(weekdayToRule('Sunday'), 'weekly:7');

  const weekly = nextOccurrence('weekly:1', NOW, IST, NOW);
  assert.equal(dayKey(weekly, IST), '2026-09-28');
  // A drifted anchor still lands on the requested weekday...
  assert.equal(dayKey(nextOccurrence('biweekly:1', NOW, IST, NOW), IST), '2026-09-28');
  // ...while a correctly anchored Monday keeps its 14-day rhythm.
  const monday = zonedToUtc({ year: 2026, month: 9, day: 28, hour: 9 }, IST);
  assert.equal(dayKey(nextOccurrence('biweekly:1', monday, IST, monday), IST), '2026-10-12');
  const monthlyFifth = zonedToUtc({ year: 2026, month: 9, day: 5, hour: 9 }, IST);
  assert.equal(dayKey(nextOccurrence('monthly:05', monthlyFifth, IST, monthlyFifth), IST), '2026-10-05');
  const daily = nextOccurrence('daily', NOW, IST, NOW);
  assert.equal(dayKey(daily, IST), '2026-09-23');

  // Friday + weekdays skips the weekend.
  const friday = zonedToUtc({ year: 2026, month: 9, day: 25, hour: 18 }, IST);
  assert.equal(dayKey(nextOccurrence('weekdays', friday, IST, friday), IST), '2026-09-28');

  const fromNow = nextOccurrenceFromNow('weekly:5', NOW, IST, { hour: 9, minute: 0 });
  assert.equal(dayKey(fromNow, IST), '2026-09-25');
  assert.equal(zonedParts(fromNow, IST).hour, 9);
});

test('invalid timezones fall back instead of throwing', () => {
  assert.equal(safeTimezone('Mars/Olympus'), 'UTC');
  assert.equal(safeTimezone('<script>'), 'UTC');
  assert.equal(safeTimezone(undefined), 'UTC');
  assert.equal(safeTimezone(IST), IST);
  assert.equal(safeTimezone('a'.repeat(200)), 'UTC');
});

test('repeat descriptions are human readable', () => {
  assert.equal(describeRecurrence('weekly:1'), 'Every Monday');
  assert.equal(describeRecurrence('biweekly:5'), 'Every other Friday');
  assert.equal(describeRecurrence('weekdays'), 'Every weekday');
  assert.equal(describeRecurrence(null), '');
});
