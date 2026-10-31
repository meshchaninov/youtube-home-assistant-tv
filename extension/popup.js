const $ = id => document.getElementById(id);
let localBusy = false, serverBusy = false, online = false, isYouTube = false;
let refreshing = false, editingVolume = false, volumeKnown = false;
function disableButtons() {
  $('volume').disabled = localBusy || serverBusy || !online || !volumeKnown;
  $('handoff').disabled = localBusy || serverBusy || !isYouTube;
  for (const button of document.querySelectorAll('[data-command]')) button.disabled = localBusy || serverBusy || !online;
}
function showStatus(message, state = '') { $('status').textContent = message; $('status').dataset.state = state; }
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Расширение не получило ответ.');
  return response.result;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = await request({type: 'tv_status'});
    serverBusy = data.busy;
    online = data.tv.state === 'on';
    volumeKnown = Number.isFinite(data.tv.volume) && data.tv.volume >= 0 && data.tv.volume <= 1;
    if (!editingVolume && !localBusy) {
      const percent = volumeKnown ? Math.round(data.tv.volume * 100) : 0;
      $('volume').value = percent;
      $('volumeValue').textContent = volumeKnown ? `${percent}%` : '—';
      $('volume').setAttribute('aria-valuetext', volumeKnown ? `${percent}%` : 'Неизвестна');
    }
    const volume = Number.isFinite(data.tv.volume) ? ` · громкость ${Math.round(data.tv.volume * 100)}%` : '';
    $('tvState').textContent = online ? `ТВ включён${volume}${data.tv.muted ? ' · без звука' : ''}` : data.tv.state === 'off' ? 'ТВ выключен · можно отправить ролик' : 'ТВ недоступен или подключается к Wi-Fi';
    $('mute').textContent = data.tv.muted ? 'Включить звук' : 'Выключить звук';
    if (data.lastStatus) showStatus(data.lastStatus.message, data.lastStatus.state);
  } catch (error) {
    online = false;
    $('tvState').textContent = 'Нет связи с Home Assistant';
    showStatus(error.message, 'error');
  } finally { refreshing = false; disableButtons(); }
}
async function run(message) {
  localBusy = true; disableButtons();
  showStatus(message.type === 'handoff' ? 'Включаю ТВ и жду подключения к Wi-Fi…' : 'Отправляю команду…');
  let failure;
  try { await request(message); }
  catch (error) { failure = error.message; }
  finally {
    localBusy = false; await refresh();
    if (failure) showStatus(failure, 'error');
  }
}
$('volume').addEventListener('pointerdown', () => { editingVolume = true; });
$('volume').addEventListener('pointerup', () => { editingVolume = false; });
$('volume').addEventListener('pointercancel', () => { editingVolume = false; refresh(); });
$('volume').addEventListener('input', () => {
  editingVolume = true;
  const volume = Number($('volume').value);
  $('volumeValue').textContent = `${volume}%`;
  $('volume').setAttribute('aria-valuetext', `${volume}%`);
});
$('volume').addEventListener('change', () => {
  editingVolume = false;
  run({type: 'remote', command: 'volume_set', volume: Number($('volume').value)});
});
$('volume').addEventListener('blur', () => { editingVolume = false; });
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('refresh').addEventListener('click', refresh);
$('handoff').addEventListener('click', () => run({type: 'handoff'}));
for (const button of document.querySelectorAll('[data-command]')) button.addEventListener('click', () => run({type: 'remote', command: button.dataset.command}));
const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
isYouTube = /^https:\/\/(www\.|m\.)?youtube\.com\//.test(tab?.url || '');
if (!isYouTube) $('videoHint').textContent = 'Для отправки откройте YouTube. Пульт доступен с любой вкладки.';
disableButtons();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lastStatus?.newValue) {
    const value = changes.lastStatus.newValue;
    serverBusy = value.state === 'busy';
    showStatus(value.message, value.state);
    disableButtons();
    if (!serverBusy && !localBusy) setTimeout(refresh, 200);
  }
});
await refresh();
setInterval(refresh, 10000);
