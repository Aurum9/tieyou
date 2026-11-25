export { LAND_TAG_NAMES, TAG_NAMES, visibleTagLabel, localizedTagSlugs, canonicalTagSlug } from './tag-names.js';
export { getTagDescription } from './tag-settings.js';
import { refreshTagSettings } from './tag-settings.js';

let request;

export function loadTagVocabulary() {
  request ??= fetch(new URL('../data/tag-vocabulary.json', import.meta.url)).then(async response => {
    if (!response.ok) throw new Error('标签词表暂时无法载入');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('标签词表格式无效');
    await refreshTagSettings();
    return rows;
  }).catch(error => {
    request = undefined;
    throw error;
  });
  return request;
}
