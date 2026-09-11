// ==UserScript==
// @name         Teams Greens Everywhere
// @namespace    https://github.com/AIPEACBS/teams-greens-everywhere
// @version      2.1.13
// @description  Schedule Teams web presence with weekday windows and start/end variation.
// @author       AIPEACBS
// @homepageURL   https://github.com/AIPEACBS/teams-greens-everywhere
// @license       Unlicense
// @match        https://teams.microsoft.com/*
// @match        https://*.teams.microsoft.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @downloadURL  https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/dist/teams-greens-everywhere.user.js
// @updateURL    https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/dist/teams-greens-everywhere.user.js
// ==/UserScript==

// Bundled schedule engine. Source: web/schedule.js
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


(() => {
  'use strict';

  const POLL_MS = 30_000;
  const MENU_DELAY_MS = 250;
  const PRESENCE_REFRESH_DELAY_MS = 1_000;
  const LOOPBACK_PORT = 23920;
  const LOCAL_STORAGE_PREFIX = 'teams-greens-everywhere.';
  const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  const defaultSettings = () => ({
    version: 2,
    revision: 1,
    enabled: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    suppressWhenWindowsActive: true,
    showActivityBanner: true,
    schedule: Object.fromEntries(DAY_KEYS.map((key, index) => [key, {
      enabled: index < 5,
      periods: index < 5 ? [{ start: '09:00', end: '17:00', startJitter: 10, endJitter: 10 }] : [],
    }])),
  });

  const settings = loadSettings();
  let cache = loadCache();
  let timer;
  let toastTimeout;

  function loadLocalValue(key) {
    try {
      return localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${key}`);
    } catch (error) {
      console.error('[Teams Greens Everywhere] Unable to read the settings backup.', error);
      return null;
    }
  }

  function saveLocalValue(key, value) {
    try {
      localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${key}`, value);
    } catch (error) {
      console.error('[Teams Greens Everywhere] Unable to save the settings backup.', error);
    }
  }

  function loadPersistentValue(key, fallback) {
    const value = GM_getValue(key, null);
    if (value !== null) {
      saveLocalValue(key, value);
      return value;
    }
    return loadLocalValue(key) ?? fallback;
  }

  function savePersistentValue(key, value) {
    GM_setValue(key, value);
    saveLocalValue(key, value);
  }

  function loadSettings() {
    const value = loadPersistentValue('settings', null);
    if (!value) return defaultSettings();
    try {
      const parsed = JSON.parse(value);
      if (parsed.version !== 2) return defaultSettings();
      if (typeof parsed.showActivityBanner !== 'boolean') parsed.showActivityBanner = true;
      return parsed;
    } catch {
      return defaultSettings();
    }
  }

  function persistSettings() {
    savePersistentValue('settings', JSON.stringify(settings));
  }

  function saveScheduleSettings() {
    settings.revision = (settings.revision ?? 0) + 1;
    persistSettings();
    cache = {};
    savePersistentValue('resolvedSchedule', JSON.stringify(cache));
  }

  function loadCache() {
    try { return JSON.parse(loadPersistentValue('resolvedSchedule', '{}')); }
    catch { return {}; }
  }

  function saveCache() {
    const cutoff = TeamsGreenSchedule.addDays(TeamsGreenSchedule.dateKeyFor(new Date(), TeamsGreenSchedule.timezoneFor(settings)), -2);
    for (const key of Object.keys(cache)) {
      if (key < cutoff) delete cache[key];
    }
    savePersistentValue('resolvedSchedule', JSON.stringify(cache));
  }

  async function windowsNativeIsActive() {
    if (!settings.suppressWhenWindowsActive) return false;
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `http://127.0.0.1:${LOOPBACK_PORT}/status`,
        timeout: 750,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) return resolve(false);
          try {
            resolve(JSON.parse(response.responseText).active === true);
          } catch {
            resolve(false);
          }
        },
        onerror: () => resolve(false),
        ontimeout: () => resolve(false),
      });
    });
  }

  function presenceIsAway() {
    const avatar = document.querySelector('#idna-me-control-avatar-trigger, [data-tid="me-control-avatar-trigger"]');
    if (!avatar) return null;
    return /\baway\b/i.test(avatar.getAttribute('aria-label') ?? '');
  }

  function activityTarget() {
    return document.querySelector('#app, #root, [data-tid="app-layout"]') ?? document.body;
  }

  async function restoreAvailable() {
    const avatar = document.querySelector('#idna-me-control-avatar-trigger, [data-tid="me-control-avatar-trigger"]');
    if (!avatar || !/\baway\b/i.test(avatar.getAttribute('aria-label') ?? '')) return false;
    let menu = document.querySelector('[data-tid="set-presence-status-menu-item"]');
    if (!menu) {
      avatar.click();
      await delay(MENU_DELAY_MS);
      menu = document.querySelector('[data-tid="set-presence-status-menu-item"]');
    }
    if (!menu) return false;
    menu.click();
    await delay(MENU_DELAY_MS);
    const available = document.querySelector('[data-tid="me_control_presence_availability_available"]');
    if (!available) return false;
    available.click();
    return true;
  }

  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function tick() {
    try {
      if (!settings.enabled) return;
      if (await windowsNativeIsActive()) {
        showActivityBanner('Skipped: Windows native support is active.', 'gray');
        return;
      }
      const result = TeamsGreenSchedule.evaluate(settings, new Date(), cache);
      saveCache();
      if (!result.active) {
        showActivityBanner('Checked schedule: outside an active period.', 'gray');
        return;
      }

      const wasAway = presenceIsAway();
      if (wasAway === null) {
        showActivityBanner('Waiting for Teams to finish loading.', 'gray');
        return;
      }
      activityTarget().click();
      await delay(PRESENCE_REFRESH_DELAY_MS);
      const isAwayAfterClick = presenceIsAway();
      if (isAwayAfterClick === null) {
        showActivityBanner('Waiting for Teams to finish loading.', 'gray');
        return;
      }
      if (isAwayAfterClick === false) {
        showActivityBanner('Available refreshed.', wasAway ? 'blue' : 'green');
        return;
      }
      if (!await restoreAvailable()) {
        showActivityBanner('Available refresh failed.', 'red');
        return;
      }
      await delay(PRESENCE_REFRESH_DELAY_MS);
      const isAwayAfterFallback = presenceIsAway();
      if (isAwayAfterFallback === null) {
        showActivityBanner('Waiting for Teams to finish loading.', 'gray');
        return;
      }
      showActivityBanner(isAwayAfterFallback === false ? 'Available refreshed with fallback.' : 'Available refresh failed.', isAwayAfterFallback === false ? 'yellow' : 'red');
    } catch (error) {
      console.error('[Teams Greens Everywhere] Presence refresh failed.', error);
      showActivityBanner('Available refresh failed.', 'red');
    }
  }

  function restart() {
    clearInterval(timer);
    if (settings.enabled) {
      tick().catch((error) => console.debug('[Teams Greens Everywhere]', error));
      timer = setInterval(() => tick().catch((error) => console.debug('[Teams Greens Everywhere]', error)), POLL_MS);
    }
  }

  function currentStatusMessage() {
    const result = TeamsGreenSchedule.evaluate(settings, new Date(), cache);
    saveCache();
    if (!settings.enabled) return 'Stopped. No Teams presence checks are running.';
    return result.active
      ? 'Enabled. Active now; Teams is checked every 30 seconds.'
      : 'Enabled. Waiting for the next scheduled period.';
  }

  function showToast(message) {
    document.querySelector('.tge-toast')?.remove();
    clearTimeout(toastTimeout);
    const toast = document.createElement('div');
    toast.className = 'tge-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = `Teams Greens Everywhere: ${message}`;
    toast.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:360px;background:#1e1e1e;color:#fff;border:1px solid #666;border-radius:6px;padding:12px 16px;font:14px system-ui;box-shadow:0 4px 16px #0008;';
    document.body.append(toast);
    toastTimeout = setTimeout(() => toast.remove(), 5_000);
  }

  function showActivityBanner(message, color) {
    if (!settings.showActivityBanner) return;
    document.querySelector('.tge-activity-banner')?.remove();
    const colors = {
      blue: { background: '#0078d4', text: '#fff' },
      gray: { background: '#3b3a39', text: '#fff' },
      green: { background: '#107c10', text: '#fff' },
      red: { background: '#a4262c', text: '#fff' },
      yellow: { background: '#ffd335', text: '#1e1e1e' },
    };
    const selectedColor = colors[color] ?? colors.gray;
    const banner = document.createElement('div');
    banner.className = 'tge-activity-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = `Teams Greens Everywhere: ${message}`;
    banner.style.cssText = `position:fixed;left:20px;bottom:20px;z-index:2147483647;max-width:360px;background:${selectedColor.background};color:${selectedColor.text};border:1px solid #666;border-radius:6px;padding:8px 12px;font:13px system-ui;box-shadow:0 4px 16px #0008;`;
    document.body.append(banner);
    setTimeout(() => banner.remove(), 5_000);
  }

  function exportSchedule() {
    const exportedSettings = {
      version: settings.version,
      timezone: 'auto',
      showActivityBanner: settings.showActivityBanner,
      schedule: settings.schedule,
    };
    const download = document.createElement('a');
    download.href = URL.createObjectURL(new Blob([JSON.stringify(exportedSettings, null, 2)], { type: 'application/json' }));
    download.download = 'teams-greens-everywhere-schedule.json';
    download.style.display = 'none';
    document.body.append(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(download.href), 0);
  }

  function showSettings() {
    console.info('[Teams Greens Everywhere] Building Settings panel.');
    const overlay = document.createElement('div');
    overlay.className = 'tge-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0009;color:#f5f5f5;font:14px system-ui;overflow:auto;padding:24px;';
    const makeInput = (type, value, ariaLabel) => {
      const input = document.createElement('input');
      input.type = type;
      input.value = String(value);
      input.setAttribute('aria-label', ariaLabel);
      return input;
    };
    const makeButton = (label) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      return button;
    };
    const makeLabel = (label, input) => {
      const wrapper = document.createElement('label');
      wrapper.append(document.createTextNode(label), input);
      return wrapper;
    };
    const makePeriod = (period, dayName) => {
      const row = document.createElement('div');
      row.className = 'tge-period';
      const start = makeInput('text', period.start, `${dayName} start`);
      const end = makeInput('text', period.end, `${dayName} end`);
      const startJitter = makeInput('number', period.startJitter, `${dayName} start variation`);
      const endJitter = makeInput('number', period.endJitter, `${dayName} end variation`);
      for (const input of [startJitter, endJitter]) {
        input.min = '0';
        input.max = '120';
      }
      const remove = makeButton('Remove');
      remove.dataset.remove = '';
      row.append(start, document.createTextNode(' to '), end, makeLabel('Start variation ', startJitter), makeLabel('End variation ', endJitter), remove);
      return row;
    };

    const style = document.createElement('style');
    style.textContent = '.tge-overlay .tge-period{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap}.tge-overlay [data-day-row]{margin:16px 0;padding:12px;border:1px solid #444;border-radius:6px}.tge-overlay .tge-day-header{display:flex;justify-content:space-between;align-items:center;gap:12px}.tge-overlay .tge-day-actions{display:flex;align-items:center;gap:6px;position:relative}.tge-overlay .tge-apply-menu{display:none;position:absolute;right:0;top:calc(100% + 4px);z-index:1;min-width:150px;padding:8px;background:#2b2b2b;border:1px solid #666;border-radius:4px;box-shadow:0 4px 12px #0008}.tge-overlay .tge-apply-menu.tge-open{display:grid;gap:6px}.tge-overlay .tge-apply-option{display:flex;gap:6px;align-items:center;white-space:nowrap}.tge-overlay .tge-period input{max-width:120px}.tge-overlay button{cursor:pointer}';
    const main = document.createElement('main');
    main.style.cssText = 'max-width:820px;margin:auto;background:#1e1e1e;padding:24px;border-radius:8px';
    const heading = document.createElement('h2');
    heading.textContent = 'Teams Greens Everywhere';
    const enabled = makeInput('checkbox', '', 'Enabled');
    enabled.id = 'tge-enabled';
    enabled.checked = settings.enabled;
    const suppress = makeInput('checkbox', '', 'Pause while Windows native support is active');
    suppress.id = 'tge-suppress';
    suppress.checked = settings.suppressWhenWindowsActive;
    const activityBanner = makeInput('checkbox', '', 'Show activity banner for each 30-second check');
    activityBanner.id = 'tge-activity-banner';
    activityBanner.checked = settings.showActivityBanner === true;
    const enabledLabel = makeLabel(' Enabled', enabled);
    const suppressLabel = makeLabel(' Pause while Windows native support is active', suppress);
    suppressLabel.style.marginLeft = '16px';
    const activityBannerLabel = makeLabel(' Show activity banner for each 30-second check', activityBanner);
    activityBannerLabel.style.marginLeft = '16px';
    const timezone = makeInput('text', settings.timezone, 'Timezone');
    timezone.id = 'tge-timezone';
    const timezoneParagraph = document.createElement('p');
    timezoneParagraph.append(document.createTextNode('Timezone saved at setup: '), timezone);
    const explanation = document.createElement('p');
    explanation.textContent = 'Each day starts and ends at a separately randomized time within its configured variation.';
    main.append(heading, enabledLabel, suppressLabel, activityBannerLabel, timezoneParagraph, explanation);

    for (const [index, key] of DAY_KEYS.entries()) {
      const day = settings.schedule[key];
      const section = document.createElement('section');
      section.dataset.dayRow = key;
      const dayEnabled = makeInput('checkbox', '', `${DAY_NAMES[index]} enabled`);
      dayEnabled.checked = day.enabled;
      const dayLabel = document.createElement('label');
      const dayTitle = document.createElement('strong');
      dayTitle.textContent = DAY_NAMES[index];
      dayLabel.append(dayEnabled, document.createTextNode(' '), dayTitle);
      const dayHeader = document.createElement('div');
      dayHeader.className = 'tge-day-header';
      const dayActions = document.createElement('div');
      dayActions.className = 'tge-day-actions';
      const applyMenuButton = makeButton('Apply to...');
      applyMenuButton.setAttribute('aria-haspopup', 'true');
      applyMenuButton.setAttribute('aria-expanded', 'false');
      const applyMenu = document.createElement('div');
      applyMenu.className = 'tge-apply-menu';
      applyMenu.setAttribute('aria-label', `Apply ${DAY_NAMES[index]} settings to`);
      for (const [targetIndex, targetKey] of DAY_KEYS.entries()) {
        if (targetKey === key) continue;
        const option = document.createElement('label');
        option.className = 'tge-apply-option';
        const checkbox = makeInput('checkbox', '', `${DAY_NAMES[index]} settings to ${DAY_NAMES[targetIndex]}`);
        checkbox.dataset.applyTarget = targetKey;
        option.append(checkbox, document.createTextNode(DAY_NAMES[targetIndex]));
        applyMenu.append(option);
      }
      const apply = makeButton('Apply settings');
      apply.dataset.apply = key;
      apply.disabled = true;
      applyMenu.addEventListener('change', () => {
        apply.disabled = !applyMenu.querySelector('[data-apply-target]:checked');
      });
      applyMenuButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpen = applyMenu.classList.toggle('tge-open');
        applyMenuButton.setAttribute('aria-expanded', String(isOpen));
      });
      applyMenu.addEventListener('click', (event) => event.stopPropagation());
      dayActions.append(applyMenuButton, apply, applyMenu);
      dayHeader.append(dayLabel, dayActions);
      const periods = document.createElement('div');
      periods.className = 'tge-periods';
      for (const period of day.periods) periods.append(makePeriod(period, DAY_NAMES[index]));
      const add = makeButton('Add period');
      add.dataset.add = key;
      section.append(dayHeader, periods, add);
      main.append(section);
    }

    const actions = document.createElement('p');
    const save = makeButton('Save');
    save.id = 'tge-save';
    const importButton = makeButton('Import schedule JSON');
    importButton.id = 'tge-import';
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    importInput.style.display = 'none';
    importInput.id = 'tge-import-input';
    const exportButton = makeButton('Export schedule JSON');
    exportButton.id = 'tge-export';
    const close = makeButton('Cancel');
    close.id = 'tge-close';
    actions.append(save, document.createTextNode(' '), importButton, document.createTextNode(' '), exportButton, document.createTextNode(' '), close, importInput);
    main.append(actions);
    overlay.append(style, main);
    document.body.append(overlay);
    console.info('[Teams Greens Everywhere] Settings panel mounted.');

    const addPeriod = (key) => {
      const container = overlay.querySelector(`[data-day-row="${key}"] .tge-periods`);
      const dayIndex = DAY_KEYS.indexOf(key);
      container.append(makePeriod({ start: '09:00', end: '17:00', startJitter: 10, endJitter: 10 }, DAY_NAMES[dayIndex]));
    };
    const readDay = (key) => {
      const section = overlay.querySelector(`[data-day-row="${key}"]`);
      return {
        enabled: section.querySelector('input[type="checkbox"]').checked,
        periods: [...section.querySelectorAll('.tge-period')].map((field) => {
          const inputs = field.querySelectorAll('input');
          return { start: inputs[0].value, end: inputs[1].value, startJitter: Number(inputs[2].value), endJitter: Number(inputs[3].value) };
        }),
      };
    };
    const writeDay = (key, day) => {
      const section = overlay.querySelector(`[data-day-row="${key}"]`);
      section.querySelector('input[type="checkbox"]').checked = day.enabled;
      const periods = section.querySelector('.tge-periods');
      periods.replaceChildren(...day.periods.map((period) => makePeriod(period, DAY_NAMES[DAY_KEYS.indexOf(key)])));
    };
    overlay.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => addPeriod(button.dataset.add)));
    overlay.querySelectorAll('[data-apply]').forEach((button) => button.addEventListener('click', () => {
      const sourceKey = button.dataset.apply;
      const target = button.parentElement.querySelector('.tge-apply-menu');
      const targetKeys = [...target.querySelectorAll('[data-apply-target]:checked')].map((checkbox) => checkbox.dataset.applyTarget);
      if (targetKeys.length === 0) return;
      const sourceSchedule = { [sourceKey]: readDay(sourceKey) };
      for (const targetKey of targetKeys) {
        writeDay(targetKey, TeamsGreenSchedule.copyDay(sourceSchedule, sourceKey, targetKey));
      }
      showToast(`${DAY_NAMES[DAY_KEYS.indexOf(sourceKey)]} settings applied to ${targetKeys.map((key) => DAY_NAMES[DAY_KEYS.indexOf(key)]).join(', ')}.`);
      target.querySelectorAll('[data-apply-target]').forEach((checkbox) => { checkbox.checked = false; });
      target.classList.remove('tge-open');
      button.parentElement.querySelector('button[aria-haspopup="true"]').setAttribute('aria-expanded', 'false');
      button.disabled = true;
    }));
    overlay.addEventListener('click', (event) => {
      if (event.target.matches('[data-remove]')) event.target.closest('.tge-period').remove();
    });
    overlay.querySelector('#tge-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#tge-import').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const imported = TeamsGreenSchedule.validatePortableSettings(JSON.parse(await file.text()));
        overlay.querySelector('#tge-timezone').value = 'auto';
        overlay.querySelector('#tge-activity-banner').checked = imported.showActivityBanner;
        for (const key of DAY_KEYS) writeDay(key, imported.schedule[key]);
        showToast('Schedule JSON imported. Press Save to apply it.');
      } catch (error) {
        showToast(`Schedule JSON import failed: ${error.message}`);
      } finally {
        importInput.value = '';
      }
    });
    overlay.querySelector('#tge-export').addEventListener('click', exportSchedule);
    overlay.querySelector('#tge-save').addEventListener('click', () => {
      settings.enabled = overlay.querySelector('#tge-enabled').checked;
      settings.suppressWhenWindowsActive = overlay.querySelector('#tge-suppress').checked;
      settings.showActivityBanner = overlay.querySelector('#tge-activity-banner').checked;
      settings.timezone = overlay.querySelector('#tge-timezone').value.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
      for (const key of DAY_KEYS) {
        const section = overlay.querySelector(`[data-day-row="${key}"]`);
        const fields = [...section.querySelectorAll('.tge-period')];
        settings.schedule[key] = {
          enabled: section.querySelector('input[type="checkbox"]').checked,
          periods: fields.map((field) => {
            const inputs = field.querySelectorAll('input');
            return { start: inputs[0].value, end: inputs[1].value, startJitter: Number(inputs[2].value), endJitter: Number(inputs[3].value) };
          }),
        };
      }
      saveScheduleSettings();
      restart();
      overlay.remove();
    });
  }

  GM_registerMenuCommand('Start / Stop', () => {
    settings.enabled = !settings.enabled;
    persistSettings();
    restart();
    const message = currentStatusMessage();
    console.info(`[Teams Greens Everywhere] ${message}`);
    showToast(message);
  });
  GM_registerMenuCommand('Settings', () => {
    console.info('[Teams Greens Everywhere] Settings menu command selected.');
    try {
      showSettings();
    } catch (error) {
      console.error('[Teams Greens Everywhere] Settings panel failed to open.', error);
    }
  });
  GM_registerMenuCommand('Status', () => {
    const message = currentStatusMessage();
    console.info(`[Teams Greens Everywhere] ${message}`);
    showToast(message);
  });

  restart();
})();
