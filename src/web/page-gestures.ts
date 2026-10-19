// Apply the same interaction policy to every entry, including offline replay.
const suppress=(event:Event)=>event.preventDefault();
for(const type of ['contextmenu','selectstart','dragstart','copy','cut'])document.addEventListener(type,suppress,{capture:true});
document.addEventListener('keydown',event=>{
  if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'||(event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='a')event.preventDefault();
},{capture:true});
const style=document.createElement('style');style.id='page-gesture-style';
style.textContent='*{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important}img,a{-webkit-user-drag:none}';
document.head.append(style);
export {};
