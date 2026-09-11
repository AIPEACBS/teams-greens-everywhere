(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.TeamsGreenSchedule = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const PORTABLE_DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

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

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validatePortableSettings(value) {
    if (!isRecord(value)) throw new Error('Imported JSON must contain an object.');
    if (value.version !== 2) throw new Error('Unsupported schedule JSON version.');
    if (typeof value.timezone !== 'string' || !value.timezone.trim()) throw new Error('Schedule JSON has an invalid timezone.');
    if (typeof value.showActivityBanner !== 'boolean') throw new Error('Schedule JSON has an invalid activity banner setting.');
    if (!isRecord(value.schedule)) throw new Error('Schedule JSON is missing the schedule.');

    for (const key of PORTABLE_DAY_KEYS) {
      const day = value.schedule[key];
      if (!isRecord(day) || typeof day.enabled !== 'boolean' || !Array.isArray(day.periods)) {
        throw new Error(`Schedule JSON has an invalid ${key} day.`);
      }
      for (const period of day.periods) {
        if (!isRecord(period) || typeof period.start !== 'string' || typeof period.end !== 'string') {
          throw new Error(`Schedule JSON has an invalid ${key} period.`);
        }
        try {
          parseTime(period.start);
          parseTime(period.end);
        } catch {
          throw new Error(`Schedule JSON has an invalid ${key} period.`);
        }
        for (const field of ['startJitter', 'endJitter']) {
          if (!Number.isInteger(period[field]) || period[field] < 0) {
            throw new Error(`Schedule JSON has an invalid ${key} variation.`);
          }
        }
      }
    }
    return value;
  }

  function copyDay(schedule, sourceKey, targetKey) {
    if (!isRecord(schedule) || !PORTABLE_DAY_KEYS.includes(sourceKey) || !PORTABLE_DAY_KEYS.includes(targetKey)) {
      throw new Error('Invalid source or target day.');
    }
    if (!schedule[sourceKey]) throw new Error(`Missing source day: ${sourceKey}`);
    if (sourceKey === targetKey) throw new Error('Source and target days must be different.');
    return JSON.parse(JSON.stringify(schedule[sourceKey]));
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

  return { addDays, copyDay, dateKeyFor, dayKeyFor, evaluate, resolveDate, timezoneFor, validatePortableSettings };
});
