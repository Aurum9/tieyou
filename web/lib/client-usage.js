const ID = 'tieyou.anonymous-install.v1', DISABLED = 'tieyou.usage-disabled.v1', SENT = 'tieyou.usage-reported.v1';
function randomId() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16)); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const text = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export function appVersion() {
  try {
    if (globalThis.window?.tieyouAndroid !== true) return null;
    const version = window.TieyouUpdates?.versionName();
    return /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version || '') ? version : null;
  } catch { return null; }
}

export function clientHeaders(headers = {}) {
  const version = appVersion();
  return { ...headers, 'X-Tieyou-Protocol': '1', ...(version ? { 'X-Tieyou-App-Version': version } : {}) };
}

export function createClientReporter({ storage, version, fetcher = globalThis.fetch, now = Date.now, uuid = randomId }) {
  let busy = false, retryAt = 0, inflight;
  const enabled = () => { try { return storage.getItem(DISABLED) !== '1'; } catch { return false; } };
  return {
    enabled,
    setEnabled(value) { try { storage.setItem(DISABLED, value ? '0' : '1'); if (!value) inflight?.abort(); else retryAt = 0; } catch { /* Unavailable storage disables reporting. */ } },
    async report() {
      if (busy || !version || !enabled() || now() < retryAt) return;
      busy = true;
      let timer;
      try {
        const day = new Date(now() + 8 * 3600000).toISOString().slice(0, 10), stamp = day + ':' + version;
        if (storage.getItem(SENT) === stamp) return;
        retryAt = now() + 5 * 60000;
        let installId = storage.getItem(ID);
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(installId || '')) { installId = uuid(); storage.setItem(ID, installId); }
        inflight = new AbortController(); timer = setTimeout(() => inflight?.abort(), 10000);
        const response = await fetcher('/api/client/heartbeat', {
          method: 'POST', credentials: 'omit', cache: 'no-store', signal: inflight.signal,
          headers: clientHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ installId, version }),
        });
        if (response.ok && enabled()) storage.setItem(SENT, stamp);
      } catch { /* Usage reporting never interrupts cards, sync or offline play. */ }
      finally { clearTimeout(timer); inflight = null; busy = false; }
    },
  };
}

export function initClientUsage() {
  const version = appVersion(); if (!version) return;
  let storage; try { storage = window.localStorage; } catch { return; }
  const reporter = createClientReporter({ storage, version });
  const option = document.getElementById('account-usage'), checkbox = option?.querySelector('input');
  if (checkbox) {
    option.hidden = false; checkbox.checked = reporter.enabled();
    checkbox.addEventListener('change', () => { reporter.setEnabled(checkbox.checked); if (checkbox.checked) void reporter.report(); });
  }
  const report = () => { if (!document.hidden) void reporter.report(); };
  report(); window.addEventListener('online', report); window.addEventListener('focus', report); document.addEventListener('visibilitychange', report);
}
