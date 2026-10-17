export const QUESTIONNAIRE_CAPACITY={
  maximum_events:5000,maximum_bytes:32*1024*1024,event_bytes:128*1024,
  warning_events:4500,warning_bytes:31*1024*1024
} as const;
export interface ScopeUsage {events:number;bytes:number}
export class QuestionnaireEditLimitError extends Error {
  constructor(){super('LOCAL_QUESTIONNAIRE_EDIT_LIMIT');}
}
export function questionnaireCapacity(usage:ScopeUsage){
  const remaining_events=QUESTIONNAIRE_CAPACITY.maximum_events-usage.events-1;
  const remaining_bytes=QUESTIONNAIRE_CAPACITY.maximum_bytes-usage.bytes-QUESTIONNAIRE_CAPACITY.event_bytes;
  return {remaining_events,remaining_bytes,
    warning:usage.events>=QUESTIONNAIRE_CAPACITY.warning_events||usage.bytes>=QUESTIONNAIRE_CAPACITY.warning_bytes,
    readonly:remaining_events<=0||remaining_bytes<1024};
}
/** Leave one full-size final snapshot available; rejected edits write nothing. */
export function requireQuestionnaireEditCapacity(usage:ScopeUsage,incoming_bytes:number){
  const capacity=questionnaireCapacity(usage);
  if(capacity.remaining_events<=0||incoming_bytes>capacity.remaining_bytes)throw new QuestionnaireEditLimitError();
}
