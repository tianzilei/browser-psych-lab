import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ratingLayout,ratingRows} from '../../src/server/rating-export.ts';
import {csvRow} from '../../src/server/export-csv.ts';
const rating={prompt:'印象',items:['可信','专业','亲切','吸引力','就诊意愿'],labels:Array.from({length:9},(_,i)=>String(i+1)),age_prompt:'估计年龄',age_min:0,age_max:120,familiarity:{prompt:'补充熟悉度',labels:['陌生','见过','多次见过','接触','多次接触','熟悉'],position:'before-age'}};
const plan={group_id:'doctors',scope:'group',rating,roots:[{root_id:'D1',asset_id:'a1',category:'female-glasses'},{root_id:'D2',asset_id:'a2',category:'male-glasses'}]};
const layout=ratingLayout([{version_id:'v2',protocol:{groups:[{id:'doctors',rating}]}},{version_id:'v1',protocol:{groups:[{id:'doctors',rating:{...rating,items:['旧可信','旧专业'],familiarity:undefined}}]}}]);
const result={root_id:'D1',ratings:[1,3,5,7,9,40],familiarity:6,familiarity_label:'熟悉',onset:1000,clear:2500,end:5500};
test('photo CSV separates five impressions, supplementary familiarity and age, retaining order and definitions',()=>{
  const rows=[...ratingRows(layout,plan,[result],'CLOSED_NORMAL',null)];assert.equal(rows.length,2);assert.equal(rows[0].answer_state,'ANSWERED');assert.equal(rows[1].answer_state,'NOT_REACHED');assert.equal(rows[1].photo_order,2);
  assert.deepEqual(layout.items.map(f=>rows[0][f.value]),[1,3,5,7,9]);assert.equal(rows[0].familiarity,6);assert.equal(rows[0].estimated_age,40);assert.equal(rows[0].photo_id,'D1');assert.equal(layout.definitions.length,2);assert.equal(new Set(layout.columns).size,layout.columns.length);
  const csv=csvRow(layout.columns,rows[0]);assert.match(csv,/"6","熟悉","40"/);
});
test('interrupted and replay-invalid photo answers are explicitly unconfirmed, never complete',()=>{
  assert.equal([...ratingRows(layout,plan,[result],'CLOSED_TERMINATED',null)][0].answer_state,'UNCONFIRMED');
  assert.equal([...ratingRows(layout,plan,[result],'CLOSED_NORMAL','INVALID_RATING_TRACE')][0].answer_state,'REPLAY_ERROR');
  assert.equal([...ratingRows(layout,plan,[{root_id:'D1',onset:1000}],'ISSUED',null)][0].answer_state,'UNANSWERED');
  const legacy={...plan,rating:{...rating,items:['旧可信','旧专业'],familiarity:undefined}};const row=[...ratingRows(layout,legacy,[{...result,ratings:[2,4,50],familiarity:undefined}],'CLOSED_NORMAL',null)][0];assert.equal(row.estimated_age,50);assert.equal(row[layout.items[2].value],null);
});

test('photo rows contain the exact filename and immutable resource identity',()=>{
  const assets=new Map([['a1',{name:'doctors.zip/images/female-glasses/D1.webp',hash:'a'.repeat(64)}],['a2',{name:'doctors.zip/images/male-glasses/D2.webp',hash:'b'.repeat(64)}]]);
  const rows=[...ratingRows(layout,plan,[result],'CLOSED_NORMAL',null,assets)];assert.equal(rows[0].photo_filename,'D1.webp');assert.equal(rows[0].photo_path,'doctors.zip/images/female-glasses/D1.webp');assert.equal(rows[0].photo_hash,'a'.repeat(64));assert.equal(rows[0].asset_id,'a1');assert.equal(rows[1].photo_filename,'D2.webp');assert.equal(rows[1].photo_order,2);
  assert.ok(layout.columns.includes('photo_filename'));assert.ok(layout.columns.includes('photo_id'));assert.ok(layout.columns.includes('photo_category'));
});
