import type Database from 'better-sqlite3';
import type {GroupPlan} from '../shared/lab-contract.js';
import {photoIdentity,type PhotoIdentity} from '../shared/photo-identity.js';
export function recordingPhotos(db:Database.Database,session:string):PhotoIdentity[]{
  const assets=new Map((db.prepare('SELECT a.asset_id,a.name,a.hash FROM lab_assets a JOIN lab_sessions s USING(study_id) WHERE s.session_id=?').all(session) as {asset_id:string;name:string;hash:string}[]).map(a=>[a.asset_id,a]));
  return (db.prepare('SELECT plan FROM lab_permits WHERE session_id=? ORDER BY rowid').all(session) as {plan:string}[]).flatMap(row=>{const p=JSON.parse(row.plan) as GroupPlan;if(!p.rating)return [];return p.roots.flatMap((_,i)=>{const photo=photoIdentity(p,i,assets);return photo?[photo]:[];});});
}
