export type NetworkNavigator = Navigator & {connection?:EventTarget & {
  effectiveType?:string;type?:string;downlink?:number;downlinkMax?:number;rtt?:number;saveData?:boolean;
}};
export const finite = (value:number|undefined) => value !== undefined && Number.isFinite(value) ? value : null;
export function networkState() {
  const n = navigator as NetworkNavigator, c = n.connection;
  return {online:n.onLine, connection:c ? {type:c.type ?? null, effective_type:c.effectiveType ?? null,
    downlink_mbps:finite(c.downlink), downlink_max_mbps:finite(c.downlinkMax), rtt_ms:finite(c.rtt), save_data:c.saveData ?? null} : null};
}
export function browserState() {
  const v = visualViewport;
  return {visibility:document.visibilityState, focused:document.hasFocus(),
    fullscreen:!!document.fullscreenElement, picture_in_picture:!!document.pictureInPictureElement,
    online:navigator.onLine, width:innerWidth, height:innerHeight, dpr:devicePixelRatio,
    scroll_x:scrollX, scroll_y:scrollY, orientation_type:screen.orientation?.type ?? null,
    orientation_angle:screen.orientation?.angle ?? null,
    visual_viewport:v ? {x:v.offsetLeft,y:v.offsetTop,width:v.width,height:v.height,scale:v.scale} : null};
}
