import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PDF_PLAYWRIGHT_PATH);
const root=resolve('.');
const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.wasm':'application/wasm','.pdf':'application/pdf','.json':'application/json'};
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
}finally{await browser.close();server.close();}
