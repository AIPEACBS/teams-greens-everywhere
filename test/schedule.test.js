const test = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('../web/schedule.js');

function settingsFor(scheduleByDay) {
  return {
    version: 2,
    revision: 1,
    enabled: true,
    timezone: 'UTC',
    schedule: scheduleByDay,
  };
}

function weekdaySchedule(periods) {
  return {
    sun: { enabled: false, periods: [] },
    mon: { enabled: true, periods },
    tue: { enabled: false, periods: [] },
    wed: { enabled: false, periods: [] },
    thu: { enabled: false, periods: [] },
    fri: { enabled: false, periods: [] },
    sat: { enabled: false, periods: [] },
  };
}

test('evaluates an enabled weekday period', () => {
  const settings = settingsFor(weekdaySchedule([{ start: '09:00', end: '17:00', startJitter: 0, endJitter: 0 }]));
  const result = schedule.evaluate(settings, new Date('2026-09-07T10:00:00Z'), {});
  assert.equal(result.active, true);
});

test('does not activate outside its period', () => {
  const settings = settingsFor(weekdaySchedule([{ start: '09:00', end: '17:00', startJitter: 0, endJitter: 0 }]));
  const result = schedule.evaluate(settings, new Date('2026-09-07T08:59:00Z'), {});
  assert.equal(result.active, false);
});

test('supports multiple periods on one weekday', () => {
  const settings = settingsFor(weekdaySchedule([
    { start: '09:00', end: '12:00', startJitter: 0, endJitter: 0 },
    { start: '13:00', end: '17:00', startJitter: 0, endJitter: 0 },
  ]));
  assert.equal(schedule.evaluate(settings, new Date('2026-09-07T10:00:00Z'), {}).active, true);
  assert.equal(schedule.evaluate(settings, new Date('2026-09-07T12:30:00Z'), {}).active, false);
  assert.equal(schedule.evaluate(settings, new Date('2026-09-07T14:00:00Z'), {}).active, true);
});

test('supports an overnight period from the previous weekday', () => {
  const settings = settingsFor(weekdaySchedule([{ start: '22:00', end: '02:00', startJitter: 0, endJitter: 0 }]));
  const result = schedule.evaluate(settings, new Date('2026-09-08T01:00:00Z'), {});
  assert.equal(result.active, true);
});

test('uses independent start and end variation and persists them for the date', () => {
  const settings = settingsFor(weekdaySchedule([{ start: '09:00', end: '17:00', startJitter: 10, endJitter: 10 }]));
  const cache = {};
  const first = schedule.resolveDate(settings, '2026-09-07', cache, (() => {
    const values = [0, 0.999];
    return () => values.shift();
  })());
  const second = schedule.resolveDate(settings, '2026-09-07', cache, () => 0.5);
  assert.equal(first[0].start, Date.parse('2026-09-07T08:50:00Z'));
  assert.equal(first[0].end, Date.parse('2026-09-07T17:10:00Z'));
  assert.deepEqual(second, first);
});

test('invalidates persisted variation when the schedule revision changes', () => {
  const settings = settingsFor(weekdaySchedule([{ start: '09:00', end: '17:00', startJitter: 0, endJitter: 0 }]));
  const cache = {};
  schedule.resolveDate(settings, '2026-09-07', cache);
  settings.revision = 2;
  const next = schedule.resolveDate(settings, '2026-09-07', cache);
  assert.equal(next.length, 1);
  assert.match(cache['2026-09-07'].signature, /"revision":2/);
});

test('respects the top-level Start / Stop setting', () => {
  const settings = settingsFor(weekdaySchedule([{ start: '09:00', end: '17:00', startJitter: 0, endJitter: 0 }]));
  settings.enabled = false;
  assert.equal(schedule.evaluate(settings, new Date('2026-09-07T10:00:00Z'), {}).active, false);
});
