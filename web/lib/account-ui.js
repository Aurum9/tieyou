import { clientHeaders } from './client-usage.js';

async function accountRequest(action, body) {
  let response;
  try {
    response = await fetch('/api/auth/' + action, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
      headers: clientHeaders(body ? { 'Content-Type': 'application/json' } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error('无法连接账户服务，请重试');
  }
  if (action === 'session' && response.status === 404) return null;
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message || '账户请求失败，请重试');
  if (action !== 'logout' && !(typeof result?.username === 'string' || action === 'session' && result?.username === null)) {
    throw new Error('账户状态暂时无法读取');
  }
  return result;
}

export function wireAccount({ flushDecks }) {
  const get = id => document.getElementById('account-' + id);
  const open = get('open'), dialog = get('dialog'), close = get('close');
  const title = get('title'), form = get('form'), mode = get('mode'), submit = get('submit');
  const usernameInput = get('username'), password = get('password'), error = get('error');
  const signedIn = get('signed-in'), logout = get('logout');
  let username = null;
  let hasSession = false;
  let accountAvailable = true;
  let checking = false;
  let registering = false;
  let busy = false;

  function showError(message = '') {
    error.textContent = message;
    error.hidden = !message;
  }

  function setBusy(next) {
    busy = next;
    for (const control of [close, mode, submit, usernameInput, password, logout]) control.disabled = busy;
  }

  function showLogin(register = false) {
    registering = register;
    title.textContent = register ? '注册账号' : '登录';
    submit.textContent = register ? '注册并登录' : '登录';
    mode.textContent = register ? '返回登录' : '注册账号';
    password.autocomplete = register ? 'new-password' : 'current-password';
    password.value = '';
    get('register-hint').hidden = !register;
    showError();
  }

  async function updateSession() {
    if (checking || busy || !accountAvailable || document.hidden) return;
    checking = true;
    try {
      const session = await accountRequest('session');
      if (busy) return;
      if (!session) {
        accountAvailable = false;
        return;
      }
      if (hasSession && username !== session.username) {
        location.reload();
        return;
      }
      hasSession = true;
      username = session.username;
      open.textContent = username ? '账号' : '登录';
      open.setAttribute('aria-label', username ? `账号 ${username}` : '登录');
      open.hidden = false;
    } catch { /* An unavailable account service does not block use of the local library. */ }
    finally { checking = false; }
  }

  open.addEventListener('click', () => {
    if (busy || dialog.open) return;
    form.hidden = Boolean(username);
    signedIn.hidden = !username;
    showError();
    if (username) {
      title.textContent = '账号';
      get('name').textContent = username;
    } else showLogin();
    dialog.showModal();
    if (!username) usernameInput.focus();
  });
  close.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { password.value = ''; });
  mode.addEventListener('click', () => { showLogin(!registering); usernameInput.focus(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const entered = { username: usernameInput.value.trim(), password: password.value };
    showError();
    setBusy(true);
    try {
      await accountRequest(registering ? 'register' : 'login', entered);
      password.value = '';
      location.reload();
    } catch (failure) {
      setBusy(false);
      showError(failure.message);
    }
  });
  logout.addEventListener('click', async () => {
    if (busy) return;
    showError();
    setBusy(true);
    try {
      await flushDecks();
      await accountRequest('logout', {});
      location.reload();
    } catch (failure) {
      setBusy(false);
      showError(failure.message);
    }
  });
  void updateSession();
  const updates = window.tieyouAndroid && window.TieyouUpdates;
  const updateButton = get('update');
  if (updates && updateButton) {
    updateButton.hidden = false;
    updateButton.textContent = '检查更新 · ' + updates.versionName();
    updateButton.addEventListener('click', () => {
      if (!busy) {
        dialog.close();
        updates.checkForUpdates();
      }
    });
  }
  window.addEventListener('online', updateSession);
  window.addEventListener('focus', updateSession);
  window.addEventListener('pageshow', event => { if (event.persisted) void updateSession(); });
  document.addEventListener('visibilitychange', updateSession);
}
