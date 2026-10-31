import {normalizeBase, permissionFor, captureVideo, resumeVideo, callHandoff, callScript, REMOTE_COMMANDS, remotePayload} from './core.js';

const TV_ENTITY = 'media_player.samsung_tv';
const restrictStorage = chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
let running = false;
async function status(state, message) {
  await chrome.storage.local.set({lastStatus: {state, message, at: Date.now()}});
  await chrome.action.setBadgeBackgroundColor({color: state === 'error' ? '#b3261e' : state === 'busy' ? '#6c5ce7' : '#147d64'});
  await chrome.action.setBadgeText({text: state === 'error' ? '!' : state === 'busy' ? '…' : '✓'});
  await chrome.action.setTitle({title: message});
}
async function settingsForHA() {
  await restrictStorage;
  const settings = await chrome.storage.local.get(['haUrl', 'token', 'script', 'pause']);
  if (!settings.haUrl || !settings.token) throw new Error('Сначала сохраните адрес и токен Home Assistant в настройках.');
  settings.base = normalizeBase(settings.haUrl);
  if (!await chrome.permissions.contains({origins: [permissionFor(settings.base)]})) throw new Error('Разрешите доступ к Home Assistant в настройках расширения.');
  return settings;
}
async function handoff() {
  let snapshot, tab, pause = false;
  try {
    const settings = await settingsForHA();
    if (!/^[a-z0-9_]+$/.test(settings.script || '')) throw new Error('Некорректное имя скрипта.');
    [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !/^https:\/\/(www\.|m\.)?youtube\.com\//.test(tab.url || '')) throw new Error('Откройте текущий ролик на YouTube.');
    pause = settings.pause !== false;
    [snapshot] = (await chrome.scripting.executeScript({target: {tabId: tab.id}, func: captureVideo, args: [pause]})).map(x => x.result);
    if (!snapshot) throw new Error('Не удалось прочитать позицию YouTube.');
    await status('busy', `Включаю телевизор и жду Wi-Fi · с ${snapshot.position} с…`);
    await callHandoff(settings.base, settings.token, settings.script, {video_id: snapshot.video_id, position: snapshot.position});
    await chrome.storage.local.set({lastVideo: {video_id: snapshot.video_id, position: snapshot.position}});
    await status('success', `Команда отправлена YouTube на ТВ · с ${snapshot.position} с`);
  } catch (error) {
    if (snapshot && pause) await chrome.scripting.executeScript({target: {tabId: tab.id}, func: resumeVideo, args: [snapshot]}).catch(() => {});
    throw error;
  }
}
async function remote(command, volume) {
  const payload = remotePayload(command, volume);
  const label = command === 'volume_set' ? `Громкость ${volume}%` : REMOTE_COMMANDS[command];
  const settings = await settingsForHA();
  await status('busy', `${label}…`);
  await callScript(settings.base, settings.token, 'samsung_youtube_remote', payload, {timeoutMs: 45000});
  await status('success', `${label} · команда отправлена`);
}
async function tvStatus() {
  const {lastStatus} = await chrome.storage.local.get('lastStatus');
  const settings = await settingsForHA();
  const response = await fetch(`${settings.base}/api/states/${TV_ENTITY}`, {headers: {Authorization: `Bearer ${settings.token}`}, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000)});
  if (!response.ok) throw new Error(response.status === 401 ? 'Home Assistant отклонил токен. Откройте настройки.' : `Home Assistant: HTTP ${response.status}`);
  const state = await response.json();
  return {busy: running, lastStatus, tv: {state: state.state, volume: state.attributes?.volume_level, muted: state.attributes?.is_volume_muted}};
}
chrome.runtime.onInstalled.addListener(({reason}) => { if (reason === 'install') chrome.runtime.openOptionsPage(); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only our own popup may invoke commands; no content-script command bridge.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  (async () => {
    if (message?.type === 'tv_status') return tvStatus();
    if (!['handoff', 'remote'].includes(message?.type)) throw new Error('Неизвестный запрос.');
    if (running) throw new Error('Дождитесь выполнения предыдущей команды.');
    running = true;
    try {
      if (message.type === 'handoff') await handoff(); else await remote(message.command, message.volume);
      return {ok: true};
    } catch (error) {
      await status('error', error.message || 'Не удалось отправить команду.');
      throw error;
    } finally { running = false; }
  })().then(result => reply({ok: true, result}), error => reply({ok: false, error: error.message || 'Нет связи с Home Assistant.'}));
  // Commands continue in the worker even if the popup is closed.
  return true;
});
