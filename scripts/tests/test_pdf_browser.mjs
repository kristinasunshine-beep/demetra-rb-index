import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PDF_PLAYWRIGHT_PATH);
const root=resolve('.');
const mime={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.js':'text/javascript','.wasm':'application/wasm','.pdf':'application/pdf','.json':'application/json'};
const server=createServer((req,res)=>{try{const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!path.startsWith(root+'/'))throw Error('path');res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.end(readFileSync(path));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();
 await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
 const output=await page.evaluate(async()=>{
  const {extractPdfRows}=await import('/assets/pdf-import.mjs');
  const C=window.DemetraRecommendCore;
  const index=C.makeIndex({plants:[{id:'a',latinName:"Acer campestre 'Elsrijk'"}],nurseries:[{id:'n',name:'Rasadnik A'}],offers:[{id:'o',plantId:'a',nurseryId:'n',price:65,currency:'EUR',seedlingType:'standard',height:'300-350',unit:'kom'}]});
  const result=[];
  for(const path of ['/scripts/tests/fixtures/pdf-text.pdf','/scripts/tests/fixtures/pdf-scan.pdf']){
   const bytes=await fetch(path).then(r=>r.arrayBuffer());
   const rows=await extractPdfRows(bytes);
   const parsed=C.pdfPlantRows(rows,index);
   result.push({path,rows,parsed,match:parsed.slice(1).map(r=>C.recommendQuick(index,{name:r[0],preferences:r[1]}).status)});
  }
  return result;
 });
 console.log(JSON.stringify(output));
 for(const r of output)assert.ok(r.match.includes('matched'),r.path+': '+JSON.stringify(r));
 for(const width of [390,1440]){
   await page.setViewportSize({width,height:900});
   const colors=await page.evaluate(()=>{
     document.body.classList.add('control-room');
     const group=document.createElement('details');group.className='supplier-variants';
     group.innerHTML='<summary>Prikaži ostale varijante (2)</summary><div>Test</div>';
     document.body.append(group);const summary=group.firstElementChild;
     const get=()=>{const s=getComputedStyle(summary);return [s.backgroundColor,s.color];};
     const closed=get();group.open=true;const opened=get();group.remove();
     return {closed,opened};
   });
   assert.deepEqual(colors.closed,['rgb(95, 119, 74)','rgb(255, 255, 255)'],'Closed selector '+width);
   assert.deepEqual(colors.opened,colors.closed,'Open selector '+width);
 }

 // Exercise the actual portal styles and browser pointer/focus states, not a source-string assertion.
 await page.setViewportSize({width:1440,height:900});
 await page.evaluate(()=>{
   const dialog=document.getElementById('plant-dialog'),root=document.getElementById('plant-dialog-content');
   root.innerHTML='<h2 id="plant-detail-title">Test</h2><div class="record-offer-pickers"><details class="supplier-offer-picker" open><summary class="offer-picker-trigger">Arbor</summary><div class="offer-picker-menu"><div class="offer-picker-options">'+[1,2,3].map(i=>'<article class="offer-picker-option'+(i===1?' is-selected':'')+'" data-test-row="'+i+'"><button class="offer-picker-select'+(i===1?' is-selected':'')+'" type="button" aria-pressed="'+(i===1)+'">Ponuda '+i+'</button><div class="offer-picker-ledger-meta"><button class="offer-picker-quote-add">Moja ponuda</button></div></article>').join('')+'</div></div></details></div>';
   if(!dialog.open)dialog.showModal();
 });
 const row=i=>page.locator('[data-test-row="'+i+'"]');
 const highlights=()=>page.locator('[data-test-row]').evaluateAll(rows=>rows.map(el=>({bg:getComputedStyle(el).backgroundColor,bar:getComputedStyle(el,'::before').transform})));
 const verify=async active=>{
   const state=await highlights();
   for(let i=0;i<state.length;i++){
     assert.equal(state[i].bg,i+1===active?'rgb(248, 237, 233)':'rgb(255, 255, 255)',JSON.stringify(state));
     assert.equal(state[i].bar,i+1===active?'matrix(1, 0, 0, 1, 0, 0)':'matrix(0, 0, 0, 1, 0, 0)',JSON.stringify(state));
   }
 };
 await page.locator('#plant-detail-title').hover();await verify(0);
 await row(1).hover();await verify(1);
 await row(1).locator('.offer-picker-select').focus();
 await row(2).hover();await verify(2);
 await row(3).locator('.offer-picker-quote-add').hover();await verify(3);
 await page.locator('#plant-detail-title').hover();await verify(0);
 console.log('Single pointer highlight verified: no default or retained selection color.');
 await page.evaluate(()=>{
   document.getElementById('plant-dialog').close();
   const catalog={plants:[{id:'a',latinName:'Acer campestre'}],nurseries:[],offers:[]};
   window.Worker=class{
     postMessage(data){
       if(data.type==='export'){window.testExport=data;return;}
       const base={matchCount:1,requestedCount:2,candidate:true,matchedParameters:['Visina'],offeredParameters:'Visina: 300; Saksija: 50 L',historical:false};
       const supplier=(id,name)=>({...base,offerIds:[id],name,price:30});
       const preview=[{id:'a',name:'Acer campestre',parameters:[],quantity:5,suppliers:[supplier('1','Arbor'),supplier('2','Volentis')]},{id:'b',name:'Tilia cordata',parameters:[],quantity:1,suppliers:[supplier('3','Lorberg')]}];
       queueMicrotask(()=>this.onmessage({data:{type:'results',processed:2,recognized:2,matched:0,unmatched:2,preview}}));
     }
     terminate(){}
   };
   window.DemetraRecommendation.create({getCatalog:()=>catalog}).open();
 });
 await page.locator('#recommend-file').setInputFiles({name:'test.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('fixture')});
 await page.locator('[data-result-offer="1"]').waitFor();
 assert.equal(await page.locator('.recommend-preselection').count(),0);
 assert.equal(await page.locator('[data-result-offer]').count(),3);
 await page.locator('[data-result-offer="1"] [data-remove-kind="offer"]').click();
 assert.equal(await page.locator('[data-result-offer]').count(),2);
 await page.locator('[data-result-id="b"] [data-remove-kind="plant"]').click();
 assert.equal(await page.locator('[data-result-offer]').count(),1);
 await page.locator('#recommend-restore-plant').click();
 assert.equal(await page.locator('[data-result-offer]').count(),2);
 await page.locator('#recommend-download').click();
 assert.deepEqual(await page.evaluate(()=>window.testExport.excludedOffers),[JSON.stringify(['a','1'])]);
 assert.deepEqual(await page.evaluate(()=>window.testExport.excludedIds),[]);
 console.log('Editable recommendation results panel verified.');
}finally{await browser.close();server.close();}
