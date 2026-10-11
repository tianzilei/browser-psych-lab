// Human-readable CSVs are separate from the exact evidence cells in data.csv.
export function csvCell(value:unknown):string {
  if(value===null||value===undefined)return '""';
  let text=String(value);
  // Preserve numeric negatives; escape untrusted text that spreadsheets interpret as formulas.
  if(typeof value==='string'&&(/^[\t\r\n]/.test(text)||/^[\s\uFEFF]*[=+\-@]/.test(text)))text=`'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
export const answerColumns=['snapshot_id','study_id','study_title','session_id','version_id','protocol_title','session_state','session_created_at','page_id','question_id','question_title','question_type','axis_id','axis_title','answer_state','answer_numeric','answer_text','answer_json','scale_label'] as const;
export const trajectoryColumns=['snapshot_id','study_id','session_id','version_id','session_state','event_id','scope','sequence','sample_index','writer_epoch','clock_epoch','event_kind','disposition','reason','received_at','event_time_ms','time_origin','clock_origin','at','event_type','page_id','question_id','target','x','y','key','code','value','payload_json'] as const;
export function csvRow(columns:readonly string[],row:Record<string,unknown>):string {
  return columns.map(key=>csvCell(row[key])).join(',')+'\r\n';
}
