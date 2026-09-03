// ==UserScript==
// @name         Teams Greens Everywhere
// @namespace    https://github.com/AIPEACBS/teams-greens-everywhere
// @version      2.1.2
// @description  Schedule Teams web presence with weekday windows and start/end variation.
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
// @require      https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/web/schedule.js
// @downloadURL  https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/dist/teams-greens-everywhere.user.js
// @updateURL    https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/dist/teams-greens-everywhere.user.js
// ==/UserScript==

(() => {
  'use strict';

  const POLL_MS = 30_000;
  const MENU_DELAY_MS = 250;
  const LOOPBACK_PORT = 23920;
  const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  const defaultSettings = () => ({
    version: 2,
    revision: 1,
    enabled: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    suppressWhenWindowsActive: true,
    schedule: Object.fromEntries(DAY_KEYS.map((key, index) => [key, {
      enabled: index < 5,
      periods: index < 5 ? [{ start: '09:00', end: '17:00', startJitter: 10, endJitter: 10 }] : [],
    }])),
  });

  const settings = loadSettings();
  let cache = loadCache();
  let timer;

  function loadSettings() {
    const value = GM_getValue('settings', null);
    if (!value) return defaultSettings();
    try {
      const parsed = JSON.parse(value);
      return parsed.version === 2 ? parsed : defaultSettings();
    } catch {
      return defaultSettings();
    }
  }

  function persistSettings() {
    GM_setValue('settings', JSON.stringify(settings));
  }

  function saveScheduleSettings() {
    settings.revision = (settings.revision ?? 0) + 1;
    persistSettings();
    cache = {};
    GM_setValue('resolvedSchedule', JSON.stringify(cache));
  }

  function loadCache() {
    try { return JSON.parse(GM_getValue('resolvedSchedule', '{}')); }
    catch { return {}; }
  }

  function saveCache() {
    const cutoff = TeamsGreenSchedule.addDays(TeamsGreenSchedule.dateKeyFor(new Date(), TeamsGreenSchedule.timezoneFor(settings)), -2);
    for (const key of Object.keys(cache)) {
      if (key < cutoff) delete cache[key];
    }
    GM_setValue('resolvedSchedule', JSON.stringify(cache));
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

  async function restoreAvailable() {
    const avatar = document.querySelector('#idna-me-control-avatar-trigger, [data-tid="me-control-avatar-trigger"]');
    if (!avatar || !/\baway\b/i.test(avatar.getAttribute('aria-label') ?? '')) return;
    avatar.click();
    await delay(MENU_DELAY_MS);
    const menu = document.querySelector('[data-tid="set-presence-status-menu-item"]');
    if (!menu) return;
    menu.click();
    await delay(MENU_DELAY_MS);
    document.querySelector('[data-tid="me_control_presence_availability_available"]')?.click();
  }

  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function tick() {
    if (!settings.enabled || await windowsNativeIsActive()) return;
    const result = TeamsGreenSchedule.evaluate(settings, new Date(), cache);
    saveCache();
    if (result.active) await restoreAvailable();
  }

  function restart() {
    clearInterval(timer);
    if (settings.enabled) {
      tick().catch((error) => console.debug('[Teams Greens Everywhere]', error));
      timer = setInterval(() => tick().catch((error) => console.debug('[Teams Greens Everywhere]', error)), POLL_MS);
    }
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
    style.textContent = '.tge-overlay .tge-period{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap}.tge-overlay [data-day-row]{margin:16px 0;padding:12px;border:1px solid #444;border-radius:6px}.tge-overlay .tge-period input{max-width:120px}.tge-overlay button{cursor:pointer}';
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
    const enabledLabel = makeLabel(' Enabled', enabled);
    const suppressLabel = makeLabel(' Pause while Windows native support is active', suppress);
    suppressLabel.style.marginLeft = '16px';
    const timezone = makeInput('text', settings.timezone, 'Timezone');
    timezone.id = 'tge-timezone';
    const timezoneParagraph = document.createElement('p');
    timezoneParagraph.append(document.createTextNode('Timezone saved at setup: '), timezone);
    const explanation = document.createElement('p');
    explanation.textContent = 'Each day starts and ends at a separately randomized time within its configured variation.';
    main.append(heading, enabledLabel, suppressLabel, timezoneParagraph, explanation);

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
      const periods = document.createElement('div');
      periods.className = 'tge-periods';
      for (const period of day.periods) periods.append(makePeriod(period, DAY_NAMES[index]));
      const add = makeButton('Add period');
      add.dataset.add = key;
      section.append(dayLabel, periods, add);
      main.append(section);
    }

    const actions = document.createElement('p');
    const save = makeButton('Save');
    save.id = 'tge-save';
    const close = makeButton('Cancel');
    close.id = 'tge-close';
    actions.append(save, document.createTextNode(' '), close);
    main.append(actions);
    overlay.append(style, main);
    document.body.append(overlay);
    console.info('[Teams Greens Everywhere] Settings panel mounted.');

    const addPeriod = (key) => {
      const container = overlay.querySelector(`[data-day-row="${key}"] .tge-periods`);
      const dayIndex = DAY_KEYS.indexOf(key);
      container.append(makePeriod({ start: '09:00', end: '17:00', startJitter: 10, endJitter: 10 }, DAY_NAMES[dayIndex]));
    };
    overlay.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => addPeriod(button.dataset.add)));
    overlay.addEventListener('click', (event) => {
      if (event.target.matches('[data-remove]')) event.target.closest('.tge-period').remove();
    });
    overlay.querySelector('#tge-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#tge-save').addEventListener('click', () => {
      settings.enabled = overlay.querySelector('#tge-enabled').checked;
      settings.suppressWhenWindowsActive = overlay.querySelector('#tge-suppress').checked;
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

  GM_registerMenuCommand('Start / Stop', () => { settings.enabled = !settings.enabled; persistSettings(); restart(); });
  GM_registerMenuCommand('Settings', () => {
    console.info('[Teams Greens Everywhere] Settings menu command selected.');
    try {
      showSettings();
    } catch (error) {
      console.error('[Teams Greens Everywhere] Settings panel failed to open.', error);
    }
  });
  GM_registerMenuCommand('Status', () => {
    const result = TeamsGreenSchedule.evaluate(settings, new Date(), cache);
    saveCache();
    alert(`Teams Greens Everywhere is ${settings.enabled ? 'enabled' : 'stopped'} and ${result.active ? 'active now' : 'outside its schedule'}.`);
  });

  restart();
})();
