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

function portableSettings() {
  return {
    version: 2,
    timezone: 'auto',
    showActivityBanner: true,
    schedule: {
      mon: { enabled: true, periods: [{ start: '09:00', end: '17:00', startJitter: 10, endJitter: 10 }] },
      tue: { enabled: false, periods: [] },
      wed: { enabled: false, periods: [] },
      thu: { enabled: false, periods: [] },
      fri: { enabled: false, periods: [] },
      sat: { enabled: false, periods: [] },
      sun: { enabled: false, periods: [] },
    },
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

test('validates the portable schedule format', () => {
  const settings = portableSettings();
  assert.equal(schedule.validatePortableSettings(settings), settings);
  assert.equal(schedule.validatePortableSettings({ ...settings, timezone: 'America/New_York' }).timezone, 'America/New_York');
  assert.throws(() => schedule.validatePortableSettings({ ...settings, timezone: '' }), /invalid timezone/);
  assert.throws(() => schedule.validatePortableSettings({ ...settings, schedule: { ...settings.schedule, tue: { enabled: true, periods: [{ start: '25:00', end: '17:00', startJitter: 0, endJitter: 0 }] } } }), /invalid tue period/);
});

test('copies a weekday as an independent day', () => {
  const settings = portableSettings();
  const copied = schedule.copyDay(settings.schedule, 'mon', 'tue');
  assert.deepEqual(copied, settings.schedule.mon);
  assert.notStrictEqual(copied, settings.schedule.mon);
  assert.notStrictEqual(copied.periods, settings.schedule.mon.periods);
  copied.periods[0].start = '10:00';
  assert.equal(settings.schedule.mon.periods[0].start, '09:00');
});

test('prunes activity logs by calendar day or rolling hours', () => {
  const now = new Date(2026, 8, 3, 12, 0, 0);
  const dates = [new Date(2026, 8, 1, 23), new Date(2026, 8, 2, 23), new Date(2026, 8, 3, 11)];
  const entries = dates.map((date, index) => ({ timestamp: date.toISOString(), date: schedule.localDateKey(date), message: String(index) }));
  assert.deepEqual(schedule.pruneActivityLog(entries, now, 1, 'days').map((entry) => entry.message), ['2']);
  assert.deepEqual(schedule.pruneActivityLog(entries, now, 2, 'days').map((entry) => entry.message), ['1', '2']);
  assert.deepEqual(schedule.pruneActivityLog(entries, now, 2, 'hours').map((entry) => entry.message), ['2']);
});
