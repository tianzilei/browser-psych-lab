const clock=new Intl.DateTimeFormat('en-GB',{
  timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
});
const utf8=new TextEncoder();

export function downloadName(title:string,extension:'csv'|'json'|'json.gz'|'mp4'|'html',now=new Date()){
  const cleaned=new TextDecoder().decode(utf8.encode(title))
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'_').trim().replace(/^[. ]+|[. ]+$/g,'');
  let stem='',bytes=0;
  for(const character of cleaned){const length=utf8.encode(character).length;if(bytes+length>180)break;stem+=character;bytes+=length;}
  stem=stem.trim().replace(/[. ]+$/g,'')||'问卷';
  const parts=Object.fromEntries(clock.formatToParts(now).map(part=>[part.type,part.value]));
  return `${stem}_${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}.${extension}`;
}

export function downloadDisposition(name:string){
  const fallback=name.replace(/[^\x20-\x7e]|["\\]/g,'_');
  const encoded=encodeURIComponent(name).replace(/['()*]/g,character=>`%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
