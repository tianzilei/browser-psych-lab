import {ContractError} from './contract.js';
import type {Page,Question} from './protocol.js';
import {QUESTIONNAIRE_CAPACITY} from './questionnaire-capacity.js';

const encoder=new TextEncoder(),jsonBytes=(value:unknown)=>encoder.encode(JSON.stringify(value)).length;
function numericBytes(min:number,max:number){return Math.max(jsonBytes(min),jsonBytes(max),4);}
function answerBytes(q:Question):number {
  // A UTF-16 code unit can require six JSON bytes (controls/lone surrogates).
  if(q.type==='text')return 2+6*q.max_length!;
  if(q.type==='single')return Math.max(4,...q.choices!.map(jsonBytes));
  if(q.type==='multi')return Math.max(4,jsonBytes(q.choices!));
  if(q.type==='scale')return numericBytes(q.min!,q.max!);
  return 2+q.axes!.reduce((n,a,i)=>n+(i?1:0)+jsonBytes(a.id)+1+numericBytes(a.min,a.max),0);
}
/** Upper bound for every valid answer, including the largest legal envelope. */
export function snapshotEventBytes(page:Pick<Page,'id'|'questions'>):number {
  const long='x'.repeat(100);
  const envelope={event_schema_version:'lab-events-v1',event_id:long,session_id:long,version_id:long,protocol_hash:'a'.repeat(64),
    writer_id:long,writer_epoch:Number.MAX_SAFE_INTEGER,scope:page.id,sequence:4999,previous:{event_id:long,hash:'a'.repeat(64)},
    clock_epoch:long,time_ms:Number.MAX_VALUE,kind:'PAGE_SNAPSHOT',payload:{answers:{}}};
  // Small decimals can serialize longer than MAX_VALUE; reserve a whole
  // binary64 number token in addition to the representative clock above.
  return jsonBytes(envelope)+32+page.questions.reduce((n,q,i)=>n+(i?1:0)+jsonBytes(q.id)+1+answerBytes(q),0);
}
export function validateSnapshotBudgets(pages:readonly Page[]){
  for(const page of pages){const bytes=snapshotEventBytes(page);
    if(bytes>QUESTIONNAIRE_CAPACITY.event_bytes)throw new ContractError('PAGE_SNAPSHOT_BUDGET_EXCEEDED',400,
      {page_id:page.id,maximum_bytes:QUESTIONNAIRE_CAPACITY.event_bytes,maximum_snapshot_bytes:bytes});
  }
}
/** Only for new simplified sources; never change frozen page/scope identities. */
export function splitSnapshotPage(page:Page):Page[]{
  const chunks:Question[][]=[[]];
  for(const q of page.questions){let chunk=chunks.at(-1)!;
    // Reserve the full scope ID length before generated suffixes are known.
    if(chunk.length&&(chunk.length===30||snapshotEventBytes({id:'x'.repeat(100),questions:[...chunk,q]})>QUESTIONNAIRE_CAPACITY.event_bytes)){
      chunk=[];chunks.push(chunk);
    }
    chunk.push(q);
  }
  if(chunks.length===1)return [page];
  const suffix=`_part_${chunks.length}`;
  if(page.id.length+suffix.length>100)throw new ContractError('QUESTIONNAIRE_SEGMENT_ID_TOO_LONG',400,{maximum_source_id_length:100-suffix.length});
  return chunks.map((questions,index)=>({...page,id:`${page.id}_part_${index+1}`,questions,
    title:index===0?page.title:'',instruction:index===0?page.instruction:''}));
}
