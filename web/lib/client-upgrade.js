export const APP_DOWNLOAD_URL = 'https://sbwsz.cn/downloads/tieyou-android.apk';

export function showClientUpgrade() {
  if (typeof document === 'undefined' || !document.body || document.getElementById('client-upgrade-dialog')) return;
  const make = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  const dialog = make('dialog', '', 'app-dialog'); dialog.id = 'client-upgrade-dialog';
  const heading = make('div', '', 'dialog-header'), title = make('h2', '需要更新'); title.id = 'client-upgrade-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const close = make('button', '关闭', 'button button-quiet'); close.type = 'button'; close.addEventListener('click', () => dialog.close()); heading.append(title, close);
  const native = globalThis.window?.tieyouAndroid === true;
  const text = make('p', native ? '更新后继续查牌。' : '刷新页面后继续查牌。');
  const actions = make('div', '', 'deck-actions');
  if (!native) { const refresh = make('button', '刷新页面', 'button button-primary'); refresh.type = 'button'; refresh.addEventListener('click', () => window.location.reload()); actions.append(refresh); }
  const download = make('a', '下载新版 App', native ? 'button button-primary' : 'button'); download.href = APP_DOWNLOAD_URL; download.setAttribute('download', 'tieyou-android.apk'); actions.append(download);
  dialog.append(heading, text, actions); dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
}
