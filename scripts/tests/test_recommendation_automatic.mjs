import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import vm from 'node:vm';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),assets=resolve(root,'assets');
const require=createRequire(import.meta.url);
const XLSX=require(resolve(assets,'vendor/xlsx-0.20.3.full.min.js'));
const Zip=require(resolve(assets,'vendor/jszip-3.10.1.min.js'));
const plant="Acer campestre 'Elsrijk'";
const catalog={
  plants:[{id:'p1',latinName:plant,synonyms:[]}],
  nurseries:[{id:'n1',name:'Rasadnik A'},{id:'n2',name:'Rasadnik B'}],
  offers:[
    {id:'eur',plantId:'p1',nurseryId:'n1',circumference:'18–20',height:'300–350',price:65,currency:'EUR',unit:'kom',taxStatus:'Bez PDV-a',sourceDate:'2026-11-13'},
    {id:'wrong-size',plantId:'p1',nurseryId:'n2',circumference:'12–14',height:'300–350',price:1,currency:'EUR',unit:'kom',taxStatus:'Bez PDV-a',sourceDate:'2026-11-13'},
    {id:'wrong-currency',plantId:'p1',nurseryId:'n2',circumference:'18–20',height:'300–350',price:2,currency:'RSD',unit:'kom',taxStatus:'Bez PDV-a',sourceDate:'2026-11-13'}
  ]
};

function workbook(sheets){
  const book=XLSX.utils.book_new();
  for(const [name,rows] of sheets)XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),name);
  return XLSX.write(book,{type:'array',bookType:'xlsx'});
}

// Execute the production browser worker and every real import, without a DOM,
// a fake matcher, network access, or files outside this repository.
function worker(){
  const messages=[],commands=[];
  const sandbox={console,setTimeout,clearTimeout,TextEncoder,TextDecoder,ArrayBuffer,Uint8Array,DataView,
    postMessage(message){messages.push(structuredClone(message));},
    async fetch(url){
      assert.equal(url,'test-template.xlsx');
      const bytes=readFileSync(resolve(assets,'brza-preporuka-template.xlsx'));
      return {ok:true,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
    }
  };
  const context=vm.createContext(sandbox);
  sandbox.self=context;
  sandbox.importScripts=(...urls)=>{
    for(const url of urls){
      const path=resolve(assets,url.split(/[?#]/,1)[0]);
      assert(path.startsWith(assets+sep),'Worker import must remain inside assets');
      vm.runInContext(readFileSync(path,'utf8'),context,{filename:path});
    }
  };
  vm.runInContext(readFileSync(resolve(assets,'brza-preporuka-worker.js'),'utf8'),context,{filename:'brza-preporuka-worker.js'});
  return {
    messages,commands,
    async process(input){
      commands.push('process');
      await context.onmessage({data:{type:'process',file:{name:'input.xlsx',arrayBuffer:async()=>input},catalog:structuredClone(catalog)}});
      assert.equal(messages.filter(m=>m.type==='error').length,0,JSON.stringify(messages.filter(m=>m.type==='error')));
      const result=messages.findLast(m=>m.type==='results');
      assert(result,'A single process command must produce results');
      assert.deepEqual(commands,['process'],'No separate read/run or mapping command is needed');
      assert(messages.every(m=>['progress','results'].includes(m.type)),'No loaded/mapping intermediate response is allowed');
      return result;
    },
    async download(){
      commands.push('export');
      await context.onmessage({data:{type:'export',templateUrl:'test-template.xlsx'}});
      assert.equal(messages.filter(m=>m.type==='error').length,0,JSON.stringify(messages.filter(m=>m.type==='error')));
      const result=messages.findLast(m=>m.type==='download');assert(result,'Export must produce a download');
      return result.bytes;
    }
  };
}

test('one upload processes every input row and preserves the notes sheet',async()=>{
  const headers=['Naziv biljke','Obim (cm)','Jedinica mere','Količina','Šifra'];
  const count=1205,rows=[['Spisak za proveru'],[],headers];
  for(let i=0;i<count;i++)rows.push([i===count-1?"Acer campestre 'Pogresan kultivar'":plant,'18–20','kom',3,String(i).padStart(5,'0')]);
  const notes=[['Napomena'],['Ovaj list mora ostati sačuvan.'],['00123']];
  const input=workbook([['Sadnice',rows],['Napomena',notes]]),instance=worker();
  const result=await instance.process(input);
  assert.equal(result.processed,count);assert.equal(result.matched,count-1);assert.equal(result.unmatched,1);
  assert.equal(result.preview.length,40,'Preview limit must not limit processing or export');
  const output=await instance.download(),book=XLSX.read(output,{type:'array'});
  assert.deepEqual(book.SheetNames,['Sadnice','Napomena']);
  const actual=XLSX.utils.sheet_to_json(book.Sheets.Sadnice,{header:1,defval:''});
  assert.equal(actual.length,rows.length);
  for(let r=0;r<rows.length;r++)for(let c=0;c<rows[r].length;c++)assert.equal(actual[r][c],rows[r][c],`Original cell ${r+1}:${c+1}`);
  const priceColumn=actual[2].indexOf('Najniža nabavna cena (€)'),supplierColumn=actual[2].indexOf('Rasadnik sa najnižom cenom'),statusColumn=actual[2].indexOf('Rezultat preporuke');
  assert(priceColumn>=headers.length&&supplierColumn>=headers.length&&statusColumn>=headers.length);
  for(let r=3;r<rows.length-1;r++){assert.equal(actual[r][priceColumn],65);assert.equal(actual[r][supplierColumn],'Rasadnik A');}
  assert.equal(actual.at(-1)[priceColumn],'');assert(actual.at(-1)[statusColumn],'Unknown cultivar must retain an explicit result');
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets.Napomena,{header:1,defval:''}),notes);
  const before=await Zip.loadAsync(input),after=await Zip.loadAsync(output);
  assert.equal(await after.file('xl/worksheets/sheet2.xml').async('string'),await before.file('xl/worksheets/sheet2.xml').async('string'),'Unprocessed notes worksheet must remain byte-for-byte intact');
});

test('headerless first row is processed and the source is retained beside its recommendation sheet',async()=>{
  const rows=[[plant,'obim 18–20'],[plant,'obim 18–20']],notes=[['Napomena'],['Dva originalna reda bez zaglavlja.']];
  const input=workbook([['Bez zaglavlja',rows],['Napomena',notes]]),instance=worker();
  const result=await instance.process(input);
  assert.equal(result.processed,2);assert.equal(result.matched,2);assert.equal(result.preview[0].row,1);
  const output=await instance.download(),book=XLSX.read(output,{type:'array'});
  assert.equal(book.SheetNames.length,3);
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets['Bez zaglavlja'],{header:1,defval:''}),rows);
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets.Napomena,{header:1,defval:''}),notes);
  const added=book.SheetNames.find(name=>!['Bez zaglavlja','Napomena'].includes(name));assert(added);
  const results=XLSX.utils.sheet_to_json(book.Sheets[added],{header:1,defval:''});
  assert.equal(results.length,3);assert.equal(results[1][0],plant);assert.equal(results[2][0],plant);
  const priceColumn=results[0].indexOf('Najniža nabavna cena (€)');assert(priceColumn>=2);
  assert.equal(results[1][priceColumn],65);assert.equal(results[2][priceColumn],65);
  const before=await Zip.loadAsync(input),after=await Zip.loadAsync(output);
  assert.equal(await after.file('xl/worksheets/sheet1.xml').async('string'),await before.file('xl/worksheets/sheet1.xml').async('string'),'Original headerless worksheet must not be rewritten');
});

test('a formula without a cached value receives an explicit result instead of disappearing',async()=>{
  const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([['Naziv biljke','Visina (cm)'],[plant]]);
  sheet.B2={t:'n',f:'300+0'};sheet['!ref']='A1:B2';XLSX.utils.book_append_sheet(book,sheet,'Sadnice');
  const instance=worker(),result=await instance.process(XLSX.write(book,{type:'array',bookType:'xlsx'}));
  assert.equal(result.processed,1);assert.equal(result.unmatched,1);assert.equal(result.matched,0);
  assert.match(result.preview[0].message,/formula.*sačuvanu vrednost/i);
});
