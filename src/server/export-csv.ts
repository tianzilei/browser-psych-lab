import type {Protocol} from '../shared/protocol.js';
// Human-readable CSVs are separate from the exact evidence cells in data.csv.
export function csvCell(value:unknown):string {
  if(value===null||value===undefined)return '""';
  let text=String(value);
  // Preserve numeric negatives; escape untrusted text that spreadsheets interpret as formulas.
  if(typeof value==='string'&&(/^[\t\r\n]/.test(text)||/^[\s\uFEFF]*[=+\-@]/.test(text)))text=`'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
export const ANSWER_LAYOUT='one-session-per-row-v1';
export const ANSWER_TIME_ZONE='Asia/Shanghai';
const dateTime=new Intl.DateTimeFormat('en-GB',{timeZone:ANSWER_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23'});
export function exportDateTime(value:number|null):string|null {
  if(value===null)return null;
  const parts=Object.fromEntries(dateTime.formatToParts(new Date(value)).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
}
export const answerMetadataColumns=['snapshot_id','study_id','study_title','session_id','version_id','protocol_title','session_state','session_created_at','consent_accepted_at','last_received_at','time_zone'] as const;
export interface AnswerColumn {
  key:string;question_id:string;axis_id:string;value_column:string;state_column:string;label_column:string|null;json_column:string|null;
  definitions:{version_id:string;page_id:string;question_title:string;question_type:string;axis_title:string|null;choices?:string[];labels?:string[];min?:number;max?:number}[];
}
export function answerLayout(versions:{version_id:string;protocol:Protocol}[]){
  const byKey=new Map<string,AnswerColumn>();
  for(const version of versions)for(const page of version.protocol.pages)for(const q of page.questions){
    for(const axis of q.type==='scales'?q.axes!:[null]){
      const key=q.id+(axis?`:${axis.id}`:'');let column=byKey.get(key);
      if(!column){column={key,question_id:q.id,axis_id:axis?.id??'',value_column:`answer:${key} | ${q.title}${axis?` / ${axis.title}`:''}`,state_column:`state:${key}`,label_column:null,json_column:null,definitions:[]};byKey.set(key,column);}
      if(axis||q.type==='scale')column.label_column=`label:${key}`;
      if(['single','multi','text'].includes(q.type))column.json_column=`json:${key}`;
      const scale=axis??q;
      column.definitions.push({version_id:version.version_id,page_id:page.id,question_title:q.title,question_type:q.type,axis_title:axis?.title??null,...(q.choices?{choices:q.choices}:{}),...(scale.labels?{labels:scale.labels,min:scale.min!,max:scale.max!}:{})});
    }
  }
  const fields=[...byKey.values()],columns:string[]=[...answerMetadataColumns];
  for(const field of fields){columns.push(field.value_column,field.state_column);if(field.label_column)columns.push(field.label_column);if(field.json_column)columns.push(field.json_column);}
  return {columns,fields,byKey};
}
export const trajectoryColumns=['snapshot_id','study_id','session_id','version_id','session_state','event_id','scope','sequence','sample_index','writer_epoch','clock_epoch','event_kind','disposition','reason','received_at','event_time_ms','time_origin','clock_origin','at','event_type','page_id','question_id','group_id','instance_id','photo_order','photo_id','photo_filename','photo_path','photo_category','asset_id','photo_hash','target','x','y','key','code','value','payload_json'] as const;
export function csvRow(columns:readonly string[],row:Record<string,unknown>):string {
  return columns.map(key=>csvCell(row[key])).join(',')+'\r\n';
}
