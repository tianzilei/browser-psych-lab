import type Database from 'better-sqlite3';
import {parseLabEvent} from '../shared/lab-contract.js';
import {recordingStats} from '../shared/replay-recording.js';

const updateSQL=`INSERT INTO lab_replay_index VALUES (?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
 batches=batches+excluded.batches,samples=samples+excluded.samples,screens=screens+excluded.screens,
 first_at=min(first_at,excluded.first_at),last_at=max(last_at,excluded.last_at)`;
export function indexRecording(db:Database.Database,session:string,interaction:unknown){
  const stats=recordingStats(interaction);if(stats)db.prepare(updateSQL).run(session,stats.batches,stats.samples,stats.screens,stats.first_at,stats.last_at);
}
export function prepareReplayIndex(db:Database.Database){
  const latest=(db.prepare('SELECT coalesce(max(rowid),0) AS n FROM lab_events').get() as {n:number}).n,marker=`valid-screen-v1:${latest}`;
  if((db.prepare("SELECT value FROM lab_meta WHERE key='replay_index'").get() as {value:string}|undefined)?.value===marker)return;
  // Rebuild only derived metadata, outside request transaction budgets. Bound memory to one event and one row per session.
  db.transaction(()=>{
    const stats=new Map<string,NonNullable<ReturnType<typeof recordingStats>>>();
    for(const row of db.prepare("SELECT session_id,envelope FROM lab_event_evidence WHERE kind='INPUT_DIAGNOSTIC' AND scope LIKE 'd-ui-%' ORDER BY evidence_rowid").iterate() as Iterable<{session_id:string;envelope:string}>){
      const next=recordingStats(parseLabEvent(row.envelope).payload.interaction);if(!next)continue;const old=stats.get(row.session_id);
      stats.set(row.session_id,old?{batches:old.batches+next.batches,samples:old.samples+next.samples,screens:old.screens+next.screens,first_at:Math.min(old.first_at,next.first_at),last_at:Math.max(old.last_at,next.last_at)}:next);
    }
    db.prepare('DELETE FROM lab_replay_index').run();const insert=db.prepare(updateSQL);
    for(const [sid,s]of stats)insert.run(sid,s.batches,s.samples,s.screens,s.first_at,s.last_at);
    db.prepare("INSERT INTO lab_meta VALUES ('replay_index',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(marker);
  }).immediate();
}
