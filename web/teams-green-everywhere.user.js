// ==UserScript==
// @name         Teams Greens Everywhere
// @namespace    https://github.com/AIPEACBS/teams-greens-everywhere
// @version      2.1.11
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
// @require      https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/web/schedule.js
// @downloadURL  https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/dist/teams-greens-everywhere.user.js
// @updateURL    https://raw.githubusercontent.com/AIPEACBS/teams-greens-everywhere/main/dist/teams-greens-everywhere.user.js
// ==/UserScript==

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
    style.textContent = '.tge-overlay .tge-period{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap}.tge-overlay [data-day-row]{margin:16px 0;padding:12px;border:1px solid #444;border-radius:6px}.tge-overlay .tge-day-header{display:flex;justify-content:space-between;align-items:center;gap:12px}.tge-overlay .tge-period input{max-width:120px}.tge-overlay button{cursor:pointer}';
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
      const applyTarget = document.createElement('select');
      applyTarget.setAttribute('aria-label', `Apply ${DAY_NAMES[index]} settings to`);
      const applyPlaceholder = document.createElement('option');
      applyPlaceholder.textContent = 'Choose target day';
      applyPlaceholder.value = '';
      applyPlaceholder.disabled = true;
      applyPlaceholder.selected = true;
      applyTarget.append(applyPlaceholder);
      for (const [targetIndex, targetKey] of DAY_KEYS.entries()) {
        if (targetKey === key) continue;
        const option = document.createElement('option');
        option.value = targetKey;
        option.textContent = DAY_NAMES[targetIndex];
        applyTarget.append(option);
      }
      const apply = makeButton('Apply settings');
      apply.dataset.apply = key;
      apply.disabled = true;
      applyTarget.addEventListener('change', () => { apply.disabled = !applyTarget.value; });
      dayHeader.append(dayLabel, applyTarget, apply);
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
      const target = button.parentElement.querySelector('select');
      if (!target.value) return;
      writeDay(target.value, TeamsGreenSchedule.copyDay({ [sourceKey]: readDay(sourceKey) }, sourceKey, target.value));
      showToast(`${DAY_NAMES[DAY_KEYS.indexOf(sourceKey)]} settings applied to ${DAY_NAMES[DAY_KEYS.indexOf(target.value)]}.`);
      target.value = '';
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
