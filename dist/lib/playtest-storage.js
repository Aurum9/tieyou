import { PLAYTEST_FORMAT } from './playtest.js';
export const PLAYTEST_STORAGE_PREFIX = 'edh.playtest.v1:';
export class PlaytestStorage {
  constructor({ storage } = {}) { this.storage = storage; }
  #backend() { const storage = this.storage === undefined ? globalThis.localStorage : this.storage; if (!storage) throw new Error('浏览器本地存储不可用，测试进度暂未保存'); return storage; }
  #key(deckId) { if (typeof deckId !== 'string' || !deckId || deckId.length > 200) throw new Error('测试卡组 ID 无效'); return PLAYTEST_STORAGE_PREFIX + deckId; }
  #validate(deckId, value) { if (!value || value.format !== PLAYTEST_FORMAT || value.version !== 1 || value.state?.deck?.id !== deckId || !Array.isArray(value.past) || !Array.isArray(value.future)) throw new Error('测试进度损坏或版本不受支持；原始进度已保留'); return value; }
  raw(deckId) { try { return this.#backend().getItem(this.#key(deckId)); } catch (error) { throw new Error(`无法读取测试进度：${error.message}`); } }
  load(deckId) {
    const raw = this.raw(deckId); if (raw === null) return null;
    try { return this.#validate(deckId, JSON.parse(raw)); } catch (error) { throw new Error(`无法恢复测试进度：${error.message}`); }
  }
  save(deckId, value) {
    this.#validate(deckId, value); const raw = JSON.stringify(value);
    if (raw.length > 2000000) throw new Error('测试进度过大，暂未保存；可继续当前测试');
    try { this.#backend().setItem(this.#key(deckId), raw); } catch (error) { throw new Error(`测试进度保存失败：${error.message}。当前测试仍保留在页面中`); }
  }
  remove(deckId) { try { this.#backend().removeItem(this.#key(deckId)); } catch (error) { throw new Error(`无法清除测试进度：${error.message}`); } }
}
