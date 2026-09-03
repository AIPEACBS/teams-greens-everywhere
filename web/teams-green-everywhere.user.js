// ==UserScript==
// @name         Teams Greens Everywhere
// @namespace    https://github.com/AIPEACBS/teams-greens-everywhere
// @version      2.0.0
// @description  Schedule Teams web presence with weekday windows and start/end variation.
// @match        https://teams.microsoft.com/*
// @match        https://*.teams.microsoft.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @require      https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/web/schedule.js
// @downloadURL  https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/web/teams-green-everywhere.user.js
// @updateURL    https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/web/teams-green-everywhere.user.js
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    try {
      const response = await fetch(`http://127.0.0.1:${LOOPBACK_PORT}/status`, { signal: controller.signal });
      return response.ok && (await response.json()).active === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
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
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0009;color:#f5f5f5;font:14px system-ui;overflow:auto;padding:24px;';
    const rows = DAY_KEYS.map((key, index) => {
      const day = settings.schedule[key];
      const periods = day.periods.map((period, periodIndex) => `
        <div class="tge-period" data-day="${key}" data-index="${periodIndex}">
          <input value="${period.start}" aria-label="${DAY_NAMES[index]} start">
          <span>to</span><input value="${period.end}" aria-label="${DAY_NAMES[index]} end">
          <label>Start variation <input type="number" min="0" max="120" value="${period.startJitter}"></label>
          <label>End variation <input type="number" min="0" max="120" value="${period.endJitter}"></label>
          <button type="button" data-remove>Remove</button>
        </div>`).join('');
      return `<section data-day-row="${key}"><label><input type="checkbox" ${day.enabled ? 'checked' : ''}> <strong>${DAY_NAMES[index]}</strong></label><div class="tge-periods">${periods}</div><button type="button" data-add="${key}">Add period</button></section>`;
    }).join('');
    overlay.innerHTML = `<style>
      .tge-period { display:flex; gap:6px; align-items:center; margin:6px 0; flex-wrap:wrap; }
      [data-day-row] { margin:16px 0; padding:12px; border:1px solid #444; border-radius:6px; }
      .tge-period input { max-width:120px; }
      button { cursor:pointer; }
    </style><main style="max-width:820px;margin:auto;background:#1e1e1e;padding:24px;border-radius:8px">
      <h2>Teams Greens Everywhere</h2>
      <label><input id="tge-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}> Enabled</label>
      <label style="margin-left:16px"><input id="tge-suppress" type="checkbox" ${settings.suppressWhenWindowsActive ? 'checked' : ''}> Pause while Windows native support is active</label>
      <p>Timezone saved at setup: <input id="tge-timezone" value="${settings.timezone}" aria-label="Timezone"></p>
      <p>Each day starts and ends at a separately randomized time within its configured variation.</p>
      ${rows}
      <p><button id="tge-save">Save</button> <button id="tge-close">Cancel</button></p>
    </main>`;
    document.body.append(overlay);

    const addPeriod = (key) => {
      const container = overlay.querySelector(`[data-day-row="${key}"] .tge-periods`);
      const row = document.createElement('div');
      row.className = 'tge-period';
      row.innerHTML = '<input value="09:00"><span>to</span><input value="17:00"><label>Start variation <input type="number" min="0" max="120" value="10"></label><label>End variation <input type="number" min="0" max="120" value="10"></label><button type="button" data-remove>Remove</button>';
      container.append(row);
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
  GM_registerMenuCommand('Settings', showSettings);
  GM_registerMenuCommand('Status', () => {
    const result = TeamsGreenSchedule.evaluate(settings, new Date(), cache);
    saveCache();
    alert(`Teams Greens Everywhere is ${settings.enabled ? 'enabled' : 'stopped'} and ${result.active ? 'active now' : 'outside its schedule'}.`);
  });

  restart();
})();
