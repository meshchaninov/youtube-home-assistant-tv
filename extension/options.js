import {normalizeBase, permissionFor} from './core.js';
const $ = id => document.getElementById(id);
await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
const saved = await chrome.storage.local.get(['haUrl','token','script','pause']);
$('haUrl').value = saved.haUrl || 'http://homeassistant.local:8123';
$('token').value = saved.token || '';
$('script').value = saved.script || 'samsung_youtube_handoff';
$('pause').checked = saved.pause !== false;
function message(text) { $('message').textContent = text; }
$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const haUrl = normalizeBase($('haUrl').value);
    const token = $('token').value.trim();
    const script = $('script').value.trim().replace(/^script\./,'');
    if (!token || !/^[a-z0-9_]+$/.test(script)) throw new Error('Проверьте токен и имя скрипта.');
    if (!await chrome.permissions.request({origins: [permissionFor(haUrl)]})) throw new Error('Доступ к адресу Home Assistant не разрешён.');
    await chrome.storage.local.set({haUrl, token, script, pause: $('pause').checked});
    // Remove access to a previous server after changing the address.
    const granted = await chrome.permissions.getAll();
    for (const origin of granted.origins || []) if (origin !== permissionFor(haUrl)) await chrome.permissions.remove({origins: [origin]});
    message('Сохранено. Откройте YouTube, нажмите значок расширения и отправьте ролик из пульта.');
  } catch (error) { message(error.message); }
});
$('test').addEventListener('click', async () => {
  $('test').disabled = true;
  try {
    const settings = await chrome.storage.local.get(['haUrl','token','script']);
    const base = normalizeBase(settings.haUrl || '');
    if (!await chrome.permissions.contains({origins: [permissionFor(base)]})) throw new Error('Сначала сохраните настройки и разрешите доступ.');
    for (const script of [settings.script, 'samsung_youtube_remote']) {
      const response = await fetch(`${base}/api/states/script.${script}`, {headers: {Authorization: `Bearer ${settings.token}`}, signal: AbortSignal.timeout(10000), redirect: 'error', credentials: 'omit'});
      if (!response.ok) throw new Error(response.status === 401 ? 'Неверный или отозванный токен.' : response.status === 404 ? `Скрипт ${script} не найден в Home Assistant.` : `Home Assistant: HTTP ${response.status}`);
      const state = await response.json();
      if (!state.entity_id) throw new Error('Ответ не похож на Home Assistant. Проверьте адрес.');
    }
    message('Связь есть, сценарии отправки и пульта найдены. Телевизор не включался.');
  } catch (error) { message(error.message === 'Failed to fetch' ? 'Нет связи. Проверьте адрес, сеть и доверие к сертификату HTTPS.' : error.message); }
  finally { $('test').disabled = false; }
});
async function showStatus() {
  const {lastStatus} = await chrome.storage.local.get('lastStatus');
  if (lastStatus) $('lastStatus').textContent = `${new Date(lastStatus.at).toLocaleString('ru-RU')} · ${lastStatus.message}`;
}
await showStatus();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.lastStatus) showStatus(); });
