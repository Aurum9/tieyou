import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const fields = ['label', 'visible', 'descriptionZh', 'includeInAnalysis'];
export function validateTagLocalization(bundle) {
  if (bundle?.version !== 1 || !Array.isArray(bundle.entries) || bundle.entries.length !== bundle.summary?.total) throw new Error('Invalid localization bundle');
  const seen = new Set();
  for (const row of bundle.entries) {
    if (!row || typeof row.slug !== 'string' || !row.slug || row.slug.length > 200 || /[\u0000-\u001f\u007f]/u.test(row.slug) || seen.has(row.slug)) throw new Error('Invalid or duplicate slug');
    if (typeof row.label !== 'string' || row.label.length > 100 || /[\u0000-\u001f\u007f]/u.test(row.label) || typeof row.visible !== 'boolean' || row.visible && !row.label.trim()) throw new Error('Invalid tag label');
    if (typeof row.descriptionZh !== 'string' || row.descriptionZh.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(row.descriptionZh) || typeof row.includeInAnalysis !== 'boolean') throw new Error('Invalid tag description or analysis preference');
    if (!Array.isArray(row.parentSlugs) || !Number.isSafeInteger(row.cardCount) || row.cardCount < 0) throw new Error('Invalid tag hierarchy or card count');
    if (row.decision === '低数量且偏考据或特殊玩法' && (row.cardCount > 10 || row.visible)) throw new Error('Rare exclusion exceeds ten cards');
    if (['普通循环标记','卡名与文字游戏'].includes(row.decision) && row.visible) throw new Error('Excluded tag is visible');
    seen.add(row.slug);
  }
  const bySlug = new Map(bundle.entries.map(row => [row.slug, row]));
  for (const [slug, before] of Object.entries(bundle.preservedOverrides || {})) {
    const after = bySlug.get(slug);
    if (!after || before.label && after.label !== before.label || before.descriptionZh && after.descriptionZh !== before.descriptionZh || before.includeInAnalysis !== after.includeInAnalysis || !before.visible && after.visible) throw new Error('Existing manual setting changed: ' + slug);
  }
  for (const slug of bundle.protectedLandCycles || []) if (!bySlug.has(slug) || bySlug.get(slug).decision === '普通循环标记') throw new Error('Important land cycle excluded');
  return bundle.entries;
}

export async function importTagLocalization({ database, bundle, expectedRevision, backup, apply = false }) {
  const entries = validateTagLocalization(bundle);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Expected revision required');
  await stat(database); // Never create an empty database because of a path typo.
  const db = new DatabaseSync(database);
  db.exec('PRAGMA busy_timeout=5000');
  try {
    db.exec('BEGIN IMMEDIATE');
    const state = db.prepare('SELECT revision,mutation FROM tag_settings_state WHERE id=1').get();
    if (state?.revision !== expectedRevision) throw new Error(`Settings changed: expected ${expectedRevision}, found ${state?.revision}; no changes applied`);
    const before = db.prepare('SELECT slug,label,visible,description_zh,include_in_analysis FROM tag_label_overrides ORDER BY slug').all();
    const existing = new Map(before.map(row => [row.slug,{label:row.label,visible:!!row.visible,descriptionZh:row.description_zh,includeInAnalysis:!!row.include_in_analysis}]));
    const changes = entries.filter(row => fields.some(field => existing.get(row.slug)?.[field] !== row[field]));
    if (!apply || !changes.length) { db.exec('ROLLBACK'); return { applied:false, revision:state.revision, changes:changes.length }; }
    if (!backup) throw new Error('Backup path required');
    await writeFile(backup, JSON.stringify({ version:1, createdAt:new Date().toISOString(), state, overrides:before },null,2)+'\n', { flag:'wx' });
    const upsert = db.prepare(`INSERT INTO tag_label_overrides(slug,label,visible,description_zh,include_in_analysis) VALUES(?,?,?,?,?)
      ON CONFLICT(slug) DO UPDATE SET label=excluded.label,visible=excluded.visible,description_zh=excluded.description_zh,include_in_analysis=excluded.include_in_analysis`);
    for (const row of changes) upsert.run(row.slug,row.label,Number(row.visible),row.descriptionZh,Number(row.includeInAnalysis));
    db.prepare('UPDATE tag_settings_state SET revision=?,mutation=? WHERE id=1').run(state.revision+1,randomUUID());
    db.exec('COMMIT');
    return { applied:true, revision:state.revision+1, changes:changes.length, backup };
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args=process.argv.slice(2), option=name=>args[args.indexOf(name)+1];
  if (!args.includes('--database') || !args.includes('--file') || !args.includes('--expect-revision')) throw new Error('Use --database PATH --file BUNDLE --expect-revision N [--apply --backup PATH]');
  const bundle=JSON.parse((await readFile(option('--file'),'utf8')).replace(/^\uFEFF/u,''));
  console.log(JSON.stringify(await importTagLocalization({ database:resolve(option('--database')),bundle,expectedRevision:Number(option('--expect-revision')),apply:args.includes('--apply'),backup:args.includes('--backup')?resolve(option('--backup')):undefined })));
}
