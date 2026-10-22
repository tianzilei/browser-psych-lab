export const BACKGROUNDS = { gray: '#e5e5e5', dark: '#202020' } as const;

function channels(color:string){return color.slice(1).match(/../g)!.map(hex=>parseInt(hex,16));}
function luminance(color:string){
  const [r,g,b]=channels(color).map(value=>{const channel=value/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;});
  return .2126*r!+.7152*g!+.0722*b!;
}
function contrast(a:string,b:string){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
function mix(background:string,foreground:string,amount:number){
  const front=channels(foreground);
  return '#'+channels(background).map((value,i)=>Math.round(value+(front[i]!-value)*amount).toString(16).padStart(2,'0')).join('');
}
function readable(background:string,foreground:string,candidate:string,minimum:number){
  if(contrast(background,candidate)>=minimum)return candidate;
  for(let step=1;step<=100;step++){const color=mix(candidate,foreground,step/100);if(contrast(background,color)>=minimum)return color;}
  return foreground;
}
/** Calculate once, including custom frozen backgrounds; never follow OS theme changes. */
export function participantPalette(background:string){
  const dark=luminance(background)<.179,foreground=dark?'#ffffff':'#000000';
  const preset=background.toLowerCase()===(dark?BACKGROUNDS.dark:BACKGROUNDS.gray);
  const hover=preset?(dark?'#303030':'#d9d9d9'):mix(background,foreground,.05);
  return {
    background,foreground,dark,
    border:readable(background,foreground,dark?'#8c8c8c':'#787878',3),
    divider:preset?(dark?'#606060':'#b4b4b4'):mix(background,foreground,.25),
    muted:readable(background,foreground,dark?'#c2c2c2':'#535353',4.5),
    error:readable(background,foreground,dark?'#ffb4ab':'#9d2424',4.5),
    hover:contrast(hover,foreground)>=4.5?hover:background,
    disabled:readable(background,foreground,dark?'#a0a0a0':'#777777',3),
  };
}

// Apply once before mounting a page or measuring a group. The frozen protocol
// supplies the exact color; system preferences never change an ongoing study.
export function applyParticipantBackground(background: string) {
  const palette=participantPalette(background);
  const root = document.documentElement;
  root.style.backgroundColor = background;
  root.style.color = palette.foreground;
  root.style.colorScheme = palette.dark ? 'dark' : 'light';
  for(const [key,value]of Object.entries(palette))if(typeof value==='string')root.style.setProperty(`--q-${key==='background'?'bg':key==='foreground'?'fg':key}`,value);
  root.style.setProperty('--background',background);root.style.setProperty('--foreground',palette.foreground);root.style.setProperty('--line',palette.divider);
  root.dataset.theme = palette.dark ? 'dark' : 'gray';
}
