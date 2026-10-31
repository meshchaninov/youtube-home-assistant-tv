export function normalizeBase(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Укажите адрес Home Assistant без пути, пароля и параметров.');
  }
  return url.origin;
}
export function permissionFor(base) {
  const url = new URL(base);
  // Chromium host permissions cover all ports on a host.
  return `${url.protocol}//${url.hostname}/*`;
}

// Serialized by chrome.scripting; deliberately independent of module scope.
export function captureVideo(pause) {
  const url = new URL(location.href);
  if (!['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) throw new Error('Откройте ролик на YouTube.');
  const videoId = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})(?:\/|$)/)?.[1];
  if (!/^[\w-]{11}$/.test(videoId || '')) throw new Error('Откройте страницу ролика YouTube.');
  const player = document.querySelector('#movie_player');
  if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) throw new Error('Дождитесь окончания рекламы.');
  const video = player?.querySelector('video') || document.querySelector('video');
  if (!video || video.readyState < 1) throw new Error('Дождитесь загрузки ролика.');
  if (!Number.isFinite(video.duration)) throw new Error('Прямые трансляции пока не поддерживаются.');
  if (!Number.isFinite(video.currentTime) || video.currentTime > 604800) throw new Error('Недопустимая позиция ролика.');
  const snapshot = {video_id: videoId, position: Math.floor(video.currentTime), wasPlaying: !video.paused, url: url.href};
  if (pause && snapshot.wasPlaying) video.pause();
  return snapshot;
}
export function resumeVideo(snapshot) {
  const url = new URL(location.href);
  const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})(?:\/|$)/)?.[1];
  const video = document.querySelector('#movie_player video') || document.querySelector('video');
  if (id === snapshot.video_id && snapshot.wasPlaying && video?.paused && Math.abs(video.currentTime - snapshot.position) < 2) video.play().catch(() => {});
}

export function callScript(base, token, script, payload, {WebSocketClass = WebSocket, timeoutMs = 210000} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/websocket', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocketClass(url.href);
    let ping;
    let authenticated = false;
    let nextId = 10;
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(authTimer); clearInterval(ping);
      socket.close();
      if (error) reject(error); else resolve(result);
    };
    const authTimer = setTimeout(() => finish(new Error('Home Assistant не завершил авторизацию. Проверьте адрес и токен.')), 10000);
    const timer = setTimeout(() => finish(new Error('Home Assistant не ответил вовремя. Команда могла выполниться; проверьте телевизор перед повтором.')), timeoutMs);
    socket.onopen = () => {
      // Chrome 116+: traffic keeps the service worker alive during TV startup.
      ping = setInterval(() => { if (authenticated && socket.readyState === 1) socket.send(JSON.stringify({id: nextId++, type: 'ping'})); }, 20000);
    };
    socket.onmessage = ({data}) => {
      try {
        const message = JSON.parse(data);
        if (message.type === 'auth_required') socket.send(JSON.stringify({type: 'auth', access_token: token}));
        else if (message.type === 'auth_invalid') finish(new Error('Home Assistant отклонил токен. Откройте настройки расширения.'));
        else if (message.type === 'auth_ok') {
          authenticated = true;
          clearTimeout(authTimer);
          socket.send(JSON.stringify({id: 1, type: 'call_service', domain: 'script', service: script, service_data: payload, return_response: true}));
        } else if (message.type === 'result' && message.id === 1) {
          if (!message.success) finish(new Error(message.error?.message || 'Скрипт Home Assistant завершился с ошибкой.'));
          else if (message.result?.response?.ok !== true) finish(new Error('Скрипт не подтвердил выполнение команды. Возможно, ТВ выключен или ещё подключается.'));
          else finish(null, message.result.response);
        }
      } catch { finish(new Error('Не удалось разобрать ответ Home Assistant.')); }
    };
    socket.onerror = () => finish(new Error('Нет соединения с Home Assistant. Проверьте домашнюю сеть, адрес и сертификат HTTPS.'));
    socket.onclose = () => { if (!done) finish(new Error('Соединение прервалось. Команда могла выполниться; проверьте ТВ перед повтором.')); };
  });
}

// Kept for handoff callers and regression tests.
export const callHandoff = callScript;

export const REMOTE_COMMANDS = Object.freeze({
  play: "Продолжить", pause: "Пауза", volume_up: "Громче", volume_down: "Тише", volume_set: "Громкость", mute: "Переключить звук", power_off: "Выключить телевизор"
});
export function remotePayload(command, volume) {
  if (!Object.hasOwn(REMOTE_COMMANDS, command)) throw new Error("Неизвестная команда пульта.");
  if (command === 'volume_set') {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error('Громкость должна быть целым числом от 0 до 100.');
    return {command, volume};
  }
  return {command};
}
