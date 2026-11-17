import { parseQuery } from './search.js';

const textOperators = [
  { value: ':', label: '包含文字' },
  { value: '=', label: '完整匹配' },
];
const exactOperators = [{ value: ':', label: '是' }];
const numberOperators = [
  { value: ':', label: '等于' },
  { value: '>=', label: '大于或等于' },
  { value: '<=', label: '小于或等于' },
  { value: '>', label: '大于' },
  { value: '<', label: '小于' },
];
const colorOperators = [
  { value: ':', label: '包含所选颜色' },
  { value: '=', label: '恰好为所选颜色' },
  { value: '<=', label: '仅使用所选颜色（含无色）' },
  { value: '>=', label: '包含所选颜色（可含其他色）' },
  { value: '<', label: '仅使用所选颜色，且少于所选颜色数' },
  { value: '>', label: '包含所选颜色，且多于所选颜色数' },
];
const colorOptions = [
  { value: 'W', label: '白' }, { value: 'U', label: '蓝' },
  { value: 'B', label: '黑' }, { value: 'R', label: '红' },
  { value: 'G', label: '绿' }, { value: 'C', label: '无色' },
];

export const CONDITION_FIELDS = [
  { value: 'name', label: '卡牌名称', input: 'text', operators: textOperators, placeholder: '中文名、英文名或别名' },
  { value: 'o', label: '规则文字', input: 'text', operators: textOperators, placeholder: '例如：抓一张牌', help: '同时查询中文和英文规则文字。' },
  { value: 't', label: '卡牌类别', input: 'text', operators: textOperators, placeholder: '例如：生物、传奇、精灵', help: '支持中文常用类别，也可以输入英文类别或副类别。' },
  { value: 'c', label: '颜色', input: 'colors', operators: colorOperators, options: colorOptions, help: '按卡牌自身颜色筛选；选择无色时不同时选择其他颜色。' },
  { value: 'ci', label: '标识色', input: 'colors', operators: colorOperators, options: colorOptions, help: '包含规则文字中的颜色信息。要找能加入主将卡组的牌，选择“仅使用所选颜色（含无色）”。' },
  { value: 'mv', label: '法术力值', input: 'number', operators: numberOperators, placeholder: '例如：0、3、0.5', help: '允许 0 和非负小数；添加两条条件可以设置上下限。' },
  { value: 'm', label: '法术力费用', input: 'text', operators: textOperators },
  { value: 'a', label: '画家', input: 'text', operators: textOperators },
  { value: 'pow', label: '力量', input: 'number', signed: true, operators: numberOperators, placeholder: '例如：-1、0、3', help: '允许负数和小数；数值筛选不包含 * 等未定值。' },
  { value: 'tou', label: '防御力', input: 'number', signed: true, operators: numberOperators, placeholder: '例如：0、4、6', help: '添加两条条件可以设置上下限；数值筛选不包含 * 等未定值。' },
  { value: 'set', label: '系列代码', input: 'text', operators: exactOperators, placeholder: '例如：m21', help: '系列、编号、稀有度和语言会共同匹配同一个印刷版本。' },
  { value: 'cn', label: '收藏编号', input: 'text', operators: exactOperators, placeholder: '例如：123、12a' },
  { value: 'r', label: '稀有度', input: 'select', operators: exactOperators, options: [
    { value: 'common', label: '普通' }, { value: 'uncommon', label: '非普通' },
    { value: 'rare', label: '稀有' }, { value: 'mythic', label: '秘稀' },
    { value: 'special', label: '特殊' }, { value: 'bonus', label: '额外' },
  ] },
  { value: 'lang', label: '印刷语言', input: 'select', operators: exactOperators, options: [
    { value: 'en', label: '英语' }, { value: 'zhs', label: '简体中文' },
    { value: 'zht', label: '繁体中文' }, { value: 'ja', label: '日语' },
    { value: 'de', label: '德语' }, { value: 'fr', label: '法语' },
    { value: 'it', label: '意大利语' }, { value: 'es', label: '西班牙语' },
    { value: 'pt', label: '葡萄牙语' }, { value: 'ko', label: '韩语' },
    { value: 'ru', label: '俄语' }, { value: 'ph', label: '非瑞克西亚语' },
    { value: 'he', label: '希伯来语' }, { value: 'grc', label: '古希腊语' },
    { value: 'la', label: '拉丁语' }, { value: 'ar', label: '阿拉伯语' },
    { value: 'sa', label: '梵语' },
  ], help: '按已收录的印刷版本筛选，当前卡库尚未收录所有语言版本。' },
  { value: 'f', label: '赛制合法性', input: 'select', operators: exactOperators, options: [{ value: 'commander', label: '指挥官赛制合法' }] },
  { value: 'tag', label: '功能标签', input: 'text', operators: exactOperators, placeholder: '例如：抓牌、加速、mana-rock', help: '支持已提供的中文功能词和英文标签；多个备选功能可以放进“任意满足”条件组。' },
];

let nextId = 0;
const fields = new Map(CONDITION_FIELDS.map(field => [field.value, field]));
const id = () => `query-condition-${++nextId}`;

export function createCondition(field = 'o') {
  return { id: id(), kind: 'rule', field, op: ':', value: '', exclude: false };
}

export function createGroup() {
  return { id: id(), kind: 'group', mode: 'all', exclude: false, children: [] };
}

const quote = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function buildConditionQuery(group) {
  let count = 0;
  const path = new Set();
  try {
    function visit(node, depth) {
      if (!node || typeof node !== 'object' || !['rule', 'group'].includes(node.kind)) throw new Error('搜索条件结构无效，请重新添加条件。');
      if (path.has(node)) throw new Error('条件组包含循环，请重新添加条件组。');
      if (node.kind === 'rule') {
        if (node.value === null || node.value === undefined || node.value === '') return '';
        if (!['string', 'number'].includes(typeof node.value)) throw new Error('搜索条件的值无效，请重新输入。');
        let value = String(node.value).trim();
        if (!value) return '';
        count++;
        if (count > 16) throw new Error('高级搜索最多支持 16 个非空条件，请减少条件。');
        const field = fields.get(node.field);
        if (!field) throw new Error('搜索字段无效，请重新选择字段。');
        if (!field.operators.some(operator => operator.value === node.op)) throw new Error(`“${field.label}”不支持当前比较方式，请重新选择。`);
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error(`“${field.label}”包含无法搜索的控制字符，请重新输入。`);
        if (field.input === 'number') {
          const pattern = field.signed ? /^-?(?:\d+(?:\.\d*)?|\.\d+)$/ : /^(?:\d+(?:\.\d*)?|\.\d+)$/;
          if (!pattern.test(value) || !Number.isFinite(Number(value))) throw new Error(field.signed ? `${field.label}请输入数字，例如 -1、0、3 或 0.5。` : '法术力值请输入非负数字，例如 0、3 或 0.5。');
        } else if (field.input === 'colors') {
          value = value.toUpperCase();
          if (value === 'C') value = '无色';
          else if (/^[WUBRG]+$/.test(value)) value = [...new Set(value)].join('');
          else throw new Error(`“${field.label}”请选择白、蓝、黑、红、绿，或单独选择无色。`);
        } else if (field.input === 'select') {
          value = value.toLowerCase();
          if (!field.options.some(option => option.value === value)) throw new Error(`“${field.label}”的选项无效，请重新选择。`);
        }
        const term = `${field.value}${node.op}${quote(value)}`;
        return node.exclude ? `NOT (${term})` : term;
      }
      if (depth > 6) throw new Error('高级搜索最多支持 6 层条件组，请减少嵌套。');
      if (!['all', 'any'].includes(node.mode) || !Array.isArray(node.children)) throw new Error('条件组设置无效，请重新添加条件组。');
      path.add(node);
      const children = node.children.map(child => visit(child, child?.kind === 'group' ? depth + 1 : depth)).filter(Boolean);
      path.delete(node);
      if (!children.length) return '';
      const expression = `(${children.join(node.mode === 'any' ? ' OR ' : ' AND ')})`;
      return node.exclude ? `NOT ${expression}` : expression;
    }
    if (!group || group.kind !== 'group') throw new Error('搜索条件需要放在条件组中。');
    const query = visit(group, 1);
    if (query.length > 1024) throw new Error('高级搜索生成的条件超过 1024 个字符，请缩短文字或减少条件。');
    parseQuery(query);
    return { query, error: null, count };
  } catch (error) {
    return { query: '', error: error.message || '搜索条件无效，请检查后重试。', count };
  }
}

/** Serialize visual filters into the same public query language used by the search box. */
export function buildFilterQuery(filters = {}) {
  const parts = [];
  let count = 0;
  let explicitCount = 0;
  const add = (value, explicit = true) => { parts.push(value); count++; if (explicit) explicitCount++; };
  const has = value => value !== '' && value !== null && value !== undefined;
  try {
    for (const [key, field, relationKey] of [['colors', 'c', 'colorRelation'], ['identities', 'ci', 'identityRelation']]) {
      const colors = filters[key] || [];
      if (!colors.length) continue;
      const relation = filters[relationKey] || (key === 'identities' ? 'within' : 'any');
      if (!['any', 'all', 'exact', 'within'].includes(relation)) throw new Error('颜色匹配方式无效，请重新选择。');
      if (colors.includes('C')) {
        if (colors.length !== 1) throw new Error('无色请单独选择。');
        add(`${field}=无色`);
      } else {
        if (colors.some(color => !/^[WUBRG]$/.test(color))) throw new Error('颜色选项无效，请重新选择。');
        const unique = [...new Set(colors)].join('').toLowerCase();
        add(relation === 'any' ? `(${[...unique].map(color => `${field}:${color}`).join(' OR ')})` : `${field}${{ all: '>=', exact: '=', within: '<=' }[relation]}${unique}`);
      }
    }
    const manaValues = filters.manaValues || [];
    if (manaValues.length) {
      if (manaValues.some(value => !Number.isInteger(value) || value < 0 || value > 9)) throw new Error('法术力值选项无效。');
      const clauses = [...new Set(manaValues)].sort((a, b) => a - b).map(value => value === 9 ? 'mv>=9' : `mv=${value}`);
      add(clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`);
    }
    for (const key of ['types', 'supertypes']) {
      const values = filters[key] || [];
      if (values.length) add(`(${values.map(value => `t:${quote(String(value).toLowerCase())}`).join(' OR ')})`);
    }
    if (String(filters.subtype || '').trim()) add(`t:${quote(String(filters.subtype).trim())}`);
    for (const [minKey, maxKey, field, label, signed] of [
      ['minManaValue', 'maxManaValue', 'mv', '法术力值', false],
      ['minPower', 'maxPower', 'pow', '力量', true],
      ['minToughness', 'maxToughness', 'tou', '防御力', true],
    ]) {
      const min = filters[minKey], max = filters[maxKey];
      const pattern = signed ? /^-?(?:\d+(?:\.\d*)?|\.\d+)$/ : /^(?:\d+(?:\.\d*)?|\.\d+)$/;
      for (const [value, op] of [[min, '>='], [max, '<=']]) {
        if (!has(value)) continue;
        if (!pattern.test(String(value)) || !Number.isFinite(Number(value))) throw new Error(`${label}需要填写${signed ? '' : '非负'}数字，留空表示不限。`);
        add(`${field}${op}${value}`);
      }
      if (has(min) && has(max) && Number(min) > Number(max)) throw new Error(`${label}下限不能大于上限。`);
    }
    if (filters.commanderOnly) add('f:commander', false);
    if (filters.translation && filters.translation !== 'all') {
      if (!['translated', 'missing'].includes(filters.translation)) throw new Error('中文内容选项无效，请重新选择。');
      add(filters.translation === 'translated' ? 'is:translated' : 'is:untranslated');
    }
    return { query: parts.join(' AND '), error: null, count, explicitCount };
  } catch (error) {
    return { query: parts.join(' AND '), error: error.message || '筛选条件无效，请检查后重试。', count, explicitCount };
  }
}
