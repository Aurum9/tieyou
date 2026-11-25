"""Backfill loyalty/defense from the matching frozen Oracle snapshot; no account data changes."""
import argparse,json,sqlite3
p=argparse.ArgumentParser()
p.add_argument('--database',required=True)
p.add_argument('--source',required=True)
p.add_argument('--apply',action='store_true')
a=p.parse_args()
source=json.load(open(a.source,encoding='utf-8'))
with sqlite3.connect(a.database) as db:
 rows=db.execute("SELECT version,meta_json FROM catalog_snapshots WHERE status='active'").fetchall()
 if len(rows)!=1: raise ValueError('Expected exactly one active snapshot')
 version,meta=rows[0]
 if json.loads(meta)['snapshot']['oracleDate']!=source['oracleDate']: raise ValueError('Oracle snapshot date mismatch')
 changes=[]
 for cid,faces in source['cards'].items():
  row=db.execute('SELECT core_json FROM catalog_cards WHERE version=? AND id=?',(version,cid)).fetchone()
  if not row: continue
  card=json.loads(row[0])
  if [f['name'] for f in card['faces']]!=[f['name'] for f in faces]: raise ValueError('Face order mismatch: '+cid)
  changed=False
  for face,extra in zip(card['faces'],faces):
   for field in ('loyalty','defense'):
    if field in extra:
     value=extra[field]
     if not isinstance(value,str) or not value or len(value)>64: raise ValueError('Invalid characteristic')
     if face.get(field)!=value: face[field]=value;changed=True
  if changed: changes.append((json.dumps(card,ensure_ascii=False,separators=(',',':')),version,cid))
 if a.apply: db.executemany('UPDATE catalog_cards SET core_json=? WHERE version=? AND id=?',changes)
 print(json.dumps({'snapshot':version,'changedCards':len(changes),'applied':a.apply}))
