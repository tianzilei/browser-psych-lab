export interface ScreenBox {x:number;y:number;width:number;height:number}
export interface ScreenNode extends ScreenBox {tag:string;text:string;style:Record<string,string>;value?:string;asset_id?:string|undefined;disabled?:boolean;checked?:boolean;
  clip?:ScreenBox;input_type?:string;placeholder?:string;canvas_width?:number;canvas_height?:number}
export interface InteractionContext {page_id?:string|undefined;question_id?:string|undefined;instance_id?:string|undefined;item?:number|undefined;phase?:string|undefined;stimulus_text?:string|undefined;asset_id?:string|undefined;
  group_id?:string;photo_id?:string;photo_order?:number;photo_category?:string|null;photo_filename?:string|null;photo_path?:string|null;photo_hash?:string|null;stimulus_visible?:boolean}
export interface InteractionSample {type:string;at:number;rt_ms?:number;raw_timestamp:number;context:InteractionContext;target:string;box:ScreenBox|null;x:number|null;y:number|null;pointer_id?:number;pointer_type?:string;button?:number;buttons?:number;pressure?:number;key?:string;code?:string;value?:string;input_type?:string;trusted:boolean;
  page_x?:number;page_y?:number;movement_x?:number;movement_y?:number;width?:number;height?:number;tilt_x?:number;tilt_y?:number;twist?:number;tangential_pressure?:number;is_primary?:boolean;coalesced?:boolean;
  alt_key?:boolean;ctrl_key?:boolean;meta_key?:boolean;shift_key?:boolean;repeat?:boolean;location?:number;is_composing?:boolean;data?:string|null;detail?:number;delta_x?:number;delta_y?:number;delta_z?:number;delta_mode?:number;state?:Record<string,unknown>}
export interface InteractionScreen {type:'screen';at:number;context:InteractionContext;width:number;height:number;dpr:number;scroll_x:number;scroll_y:number;visual_viewport:{x:number;y:number;width:number;height:number;scale:number}|null;background:string;nodes:ScreenNode[];capture?:'explicit'|'microtask'|'animation-frame';nodes_truncated?:boolean;render_version?:2;language?:string}
export interface InteractionBatch {schema:'interaction-v1';time_origin:number;samples:(InteractionSample|InteractionScreen)[]}
export function validInteractionBatch(value:unknown):value is InteractionBatch {
  if(!value||typeof value!=='object')return false;const b=value as InteractionBatch;
  return b.schema==='interaction-v1'&&Number.isFinite(b.time_origin)&&Array.isArray(b.samples)&&b.samples.length>0&&b.samples.length<=64&&b.samples.every(s=>!!s&&Number.isFinite(s.at)&&s.at>=0&&typeof s.type==='string'&&!!s.context&&typeof s.context==='object'&&(s.type!=='screen'||(Number.isFinite((s as InteractionScreen).width)&&Number.isFinite((s as InteractionScreen).height)&&Array.isArray((s as InteractionScreen).nodes)&&(s as InteractionScreen).nodes.length<=2000)));
}
