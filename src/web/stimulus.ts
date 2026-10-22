export function drawTextStimulus(ctx:CanvasRenderingContext2D,canvas:{width:number;height:number;dataset?:DOMStringMap},text:string,background:string){
  if(canvas.dataset)canvas.dataset.replayText=text;
  const values=typeof background!=='string'?null:background.startsWith('#')?background.slice(1).match(/[a-f0-9]{2}/gi)?.map(n=>parseInt(n,16)):background.match(/[\d.]+/g)?.slice(0,3).map(Number);
  const rgb=values&&values.length>=3&&values.every(Number.isFinite)?values:null;
  // Replay payloads are untrusted/legacy data; an unknown color must not throw.
  ctx.fillStyle=rgb&&.2126*rgb[0]!+.7152*rgb[1]!+.0722*rgb[2]!<128?'#ffffff':'#000000';
  ctx.textAlign='center';ctx.textBaseline='middle';
  // Plain text only. Wrap by Unicode character, fitting both width and height.
  let size=Math.min(canvas.width/10,canvas.height/5),lines:string[]=[];
  for(let attempt=0;attempt<60;attempt++){
    ctx.font=`${size}px system-ui,sans-serif`;lines=[];
    for(const paragraph of text.split('\n')){let line='';for(const char of paragraph){if(line&&ctx.measureText(line+char).width>canvas.width*.9){lines.push(line);line='';}line+=char;}lines.push(line);}
    if(lines.length*size*1.4<=canvas.height*.9)break;size*=.9;
  }
  lines.forEach((line,i)=>ctx.fillText(line,canvas.width/2,canvas.height/2+(i-(lines.length-1)/2)*size*1.4));
}
