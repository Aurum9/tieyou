import { applyTagOverrides, applyTagAliases, canonicalTagSlug } from './tag-names.js';

const key = 'tieyou.tag-settings.v1';
let revision = -1, lastRead = 0, pending;
let descriptions = {};
let analysisExcluded = new Set();
export function tagIncludedInAnalysis(slug) { return !analysisExcluded.has(canonicalTagSlug(slug)); }
export function getTagDescription(slug) { const value = descriptions[canonicalTagSlug(slug)]; return typeof value === 'string' ? value : ''; }
export function applyTagSettings(settings) {
  if (!settings || !Number.isSafeInteger(settings.revision) || !settings.overrides || typeof settings.overrides !== 'object') throw new Error('标签设置格式无效');
  if (settings.revision < revision) return;
  const changed = revision !== settings.revision;
  applyTagAliases(settings.aliases || {}); applyTagOverrides(settings.overrides); revision = settings.revision;
  descriptions = Object.fromEntries(Object.entries(settings.overrides).filter(([, value]) => typeof value.descriptionZh === 'string').map(([slug, value]) => [slug, value.descriptionZh]));
  analysisExcluded = new Set(Object.entries(settings.overrides).filter(([, value]) => value.includeInAnalysis === false).map(([slug]) => slug));
  try { localStorage.setItem(key, JSON.stringify(settings)); } catch { /* Offline caching is optional. */ }
  if (changed && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('tag-settings-changed'));
}
try { if (typeof window !== 'undefined') { const saved = localStorage.getItem(key); if (saved) applyTagSettings(JSON.parse(saved)); } } catch { /* Use built-in labels until settings are available. */ }

export function refreshTagSettings({ force = false } = {}) {
  if (!force && Date.now() - lastRead < 30000) return Promise.resolve();
  pending ??= fetch('/api/tag-settings', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8000) }).then(async response => {
    if (!response.ok) throw new Error('标签设置暂时无法读取');
    applyTagSettings(await response.json()); lastRead = Date.now();
  }).catch(() => { /* Keep saved or built-in labels while offline. */ }).finally(() => { pending = null; });
  return pending;
}
