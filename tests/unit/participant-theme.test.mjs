import test from 'node:test';
import assert from 'node:assert/strict';
import {participantPalette} from '../../src/web/participant-theme.ts';

function luminance(hex){
  const rgb=hex.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
  return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
}
function ratio(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}

test('participant presets keep frozen colors and distinguish boundaries from dividers',()=>{
  const gray=participantPalette('#e5e5e5'),dark=participantPalette('#202020');
  assert.equal(gray.background,'#e5e5e5');assert.equal(gray.foreground,'#000000');
  assert.equal(dark.background,'#202020');assert.equal(dark.foreground,'#ffffff');
  assert.notEqual(gray.border,gray.divider);assert.notEqual(dark.border,dark.divider);
  assert.equal(participantPalette('#E5E5E5').background,'#E5E5E5');
});

test('custom frozen backgrounds retain readable text, errors, borders and hover text',()=>{
  for(const background of ['#000000','#ffffff','#777777','#808080','#123456','#008800','#ff00ff','#ffeeaa','#eeeeee','#292929']){
    const p=participantPalette(background);
    assert.equal(p.background,background);
    for(const color of [p.foreground,p.muted,p.error])assert.ok(ratio(background,color)>=4.5,`${background} / ${color}`);
    assert.ok(ratio(background,p.border)>=3,`${background} / border ${p.border}`);
    assert.ok(ratio(p.hover,p.foreground)>=4.5,`${background} / hover ${p.hover}`);
  }
});
