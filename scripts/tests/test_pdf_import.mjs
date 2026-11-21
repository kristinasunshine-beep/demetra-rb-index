import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const C=require('../../assets/brza-preporuka-core.js');
const index=C.makeIndex({plants:[{id:'a',latinName:"Acer campestre 'Elsrijk'"},{id:'b',latinName:'Acer campestre'}],nurseries:[{id:'n',name:'Rasadnik'}],offers:[{id:'o',plantId:'a',nurseryId:'n',price:65,currency:'EUR',seedlingType:'standard',height:'300-350',unit:'kom'}]});
test('PDF multi-line table preserves cultivar and dimensions',()=>{
 const rows=C.pdfPlantRows([['Latinski naziv','Tip sadnice','Visina (cm)'],['Acer campestre Elsrijk','Standard',''],['','','300–350'],['Acer campestre Unknown','Standard','300–350']],index);
 assert.equal(rows.length,3);
 const good=C.recommendQuick(index,{name:rows[1][0],preferences:rows[1][1]});
 assert.equal(good.status,'matched');assert.equal(good.price,65);
 assert.equal(C.recommendQuick(index,{name:rows[2][0],preferences:rows[2][1]}).status,'not_found');
});
test('PDF real text layout retains empty column positions',async()=>{
 const {layoutRows}=await import('../../assets/pdf-import.mjs');
 const items=[{str:'Latinski naziv',x:20,y:100,width:60},{str:'Tip sadnice',x:230,y:100,width:55},{str:'Visina (cm)',x:350,y:100,width:55},{str:'Acer campestre Elsrijk',x:20,y:80,width:100},{str:'Standard',x:230,y:80,width:45},{str:'300–350',x:350,y:65,width:43}];
 const {rows}=layoutRows(items);
 assert.deepEqual(rows[2],['','','300–350']);
 assert.match(C.pdfPlantRows(rows,index)[1][1],/visina 300–350 cm/);
});
