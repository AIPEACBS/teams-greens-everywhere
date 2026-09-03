(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.TeamsGreenSchedule = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  function timezoneFor(settings) {
    return settings.timezone === 'auto' || !settings.timezone
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : settings.timezone;
  }

  function zonedParts(date, timezone) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== 'literal') parts[part.type] = Number(part.value);
    }
    return parts;
  }

  function dateKeyFor(date, timezone) {
    const parts = zonedParts(date, timezone);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }

  function addDays(dateKey, days) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function dayKeyFor(dateKey) {
    const [year, month, day] = dateKey.split('-').map(Number);
    return DAY_KEYS[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
  }

  function parseTime(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
      throw new Error(`Invalid schedule time: ${value}`);
    }
    return { hour: Number(match[1]), minute: Number(match[2]) };
  }

  function zonedDateTime(dateKey, time, timezone) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const { hour, minute } = parseTime(time);
    const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    let candidate = targetUtc;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const actual = zonedParts(new Date(candidate), timezone);
      const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
      candidate += targetUtc - actualUtc;
    }
    return new Date(candidate);
  }

  function boundedJitter(minutes, random) {
    const range = Math.max(0, Number(minutes) || 0);
    if (range === 0) return 0;
    return Math.floor(random() * (range * 2 + 1)) - range;
  }

  function fingerprint(settings, dateKey) {
    const day = settings.schedule?.[dayKeyFor(dateKey)] ?? { enabled: false, periods: [] };
    return JSON.stringify({ revision: settings.revision ?? 0, day });
  }

  function resolveDate(settings, dateKey, cache, random = Math.random) {
    const key = dayKeyFor(dateKey);
    const day = settings.schedule?.[key];
    const signature = fingerprint(settings, dateKey);
    const existing = cache[dateKey];
    if (existing?.signature === signature) return existing.periods;

    const timezone = timezoneFor(settings);
    const periods = [];
    if (day?.enabled) {
      for (const period of day.periods ?? []) {
        const startOffset = boundedJitter(period.startJitter, random);
        const endOffset = boundedJitter(period.endJitter, random);
        const start = zonedDateTime(dateKey, period.start, timezone);
        let end = zonedDateTime(dateKey, period.end, timezone);
        if (end.getTime() <= start.getTime()) {
          end = zonedDateTime(addDays(dateKey, 1), period.end, timezone);
        }
        periods.push({
          start: start.getTime() + startOffset * 60_000,
          end: end.getTime() + endOffset * 60_000,
        });
      }
    }
    cache[dateKey] = { signature, periods };
    return periods;
  }

  function evaluate(settings, now, cache, random = Math.random) {
    if (!settings.enabled) return { active: false, periods: [] };

    const timezone = timezoneFor(settings);
    const today = dateKeyFor(now, timezone);
    const yesterday = addDays(today, -1);
    const periods = [
      ...resolveDate(settings, yesterday, cache, random),
      ...resolveDate(settings, today, cache, random),
    ];
    const instant = now.getTime();
    return { active: periods.some((period) => instant >= period.start && instant <= period.end), periods };
  }

  return { addDays, dateKeyFor, dayKeyFor, evaluate, resolveDate, timezoneFor };
});
