export function drawTextStimulus(ctx:CanvasRenderingContext2D,canvas:HTMLCanvasElement,text:string,background:string){
  const rgb=background.slice(1).match(/../g)!.map(n=>parseInt(n,16));
  ctx.fillStyle=.2126*rgb[0]!+.7152*rgb[1]!+.0722*rgb[2]!<128?'#ffffff':'#000000';
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
