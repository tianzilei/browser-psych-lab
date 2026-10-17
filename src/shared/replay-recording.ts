import {validInteractionBatch,type InteractionScreen,type InteractionBatch} from './interaction.js';

export function isReplayScreen(value:unknown):value is InteractionScreen {
  if(!value||typeof value!=='object')return false;const s=value as InteractionScreen;
  return s.type==='screen'&&Number.isFinite(s.width)&&s.width>0&&s.width<=16384&&Number.isFinite(s.height)&&s.height>0&&s.height<=16384
    &&Array.isArray(s.nodes)&&s.nodes.length<=2000&&s.nodes.every(n=>n&&typeof n.tag==='string'&&n.style&&typeof n.style==='object'
      &&[n.x,n.y,n.width,n.height].every(Number.isFinite));
}
export function recordingStats(value:unknown){
  if(!validInteractionBatch(value))return null;
  return {batches:1,samples:value.samples.length,screens:value.samples.filter(isReplayScreen).length,
    first_at:value.time_origin+Math.min(...value.samples.map(s=>s.at)),last_at:value.time_origin+Math.max(...value.samples.map(s=>s.at))};
}
export function replayBatch(value:unknown):value is InteractionBatch {return validInteractionBatch(value);}
