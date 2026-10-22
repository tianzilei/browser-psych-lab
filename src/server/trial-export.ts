// One row per replayed trial. Ratings keep their dedicated ratings.csv rows;
// fixed/text tasks use this table so the light export still carries outcomes.
export const TRIAL_LAYOUT='one-trial-per-row-v1';
export const trialColumns=['snapshot_id','study_id','study_title','session_id','version_id','session_state','group_id','scope','permit_state','historical','replay_error','trial_index','instance_id','root_id','number','onset_ms','clear_ms','end_ms','isi_ms','first_rt_ms','submit_rt_ms','change_count','answer','input_time_ms','correct','rt_ms','software_quality','actual_gap_ms','familiarity','familiarity_label','familiarity_rt_ms','rating','rating_label','ratings_json','rating_labels_json','asset_id','category'] as const;
