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
    {id:'eur',plantId:'p1',nurseryId:'n1',seedlingType:'Standard',circumference:'18–20',height:'300–350',price:65,currency:'EUR',unit:'kom',taxStatus:'Bez PDV-a',sourceDate:'2026-11-13'},
    {id:'wrong-size',plantId:'p1',nurseryId:'n2',seedlingType:'Standard',circumference:'12–14',height:'400–450',price:1,currency:'EUR',unit:'kom',taxStatus:'Bez PDV-a',sourceDate:'2026-11-13'},
    {id:'wrong-currency',plantId:'p1',nurseryId:'n2',seedlingType:'Standard',circumference:'18–20',height:'300–350',price:2,currency:'RSD',unit:'kom',taxStatus:'Bez PDV-a',sourceDate:'2026-11-13'}
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
  const headers=['Naziv biljke','Tip sadnice','Visina (cm)','Jedinica mere','Količina','Šifra'];
  const count=1205,rows=[['Spisak za proveru'],[],headers];
  for(let i=0;i<count;i++)rows.push([i===count-1?"Acer campestre 'Pogresan kultivar'":plant,'Standard','300–350','kom',3,String(i).padStart(5,'0')]);
  const notes=[['Napomena'],['Ovaj list mora ostati sačuvan.'],['00123']];
  const input=workbook([['Sadnice',rows],['Napomena',notes]]),instance=worker();
  const result=await instance.process(input);
  assert.equal(result.processed,count);assert.equal(result.matched,count-1);assert.equal(result.unmatched,0);assert.equal(result.notFound,1);
  assert.equal(result.preview.length,count,'All input rows must be available through paginated review');
  const output=await instance.download(),book=XLSX.read(output,{type:'array'});
  assert.deepEqual(book.SheetNames,['Pregled preporuke','Sadnice','Napomena']);
  const glance=XLSX.utils.sheet_to_json(book.Sheets['Pregled preporuke'],{header:1,defval:''});
  assert.deepEqual(glance[0],['Latinski naziv biljke','Parametri iz tvoje tabele','Spisak rasadnika','Nabavna cena (€)','Rezultat','Digitalna kartica']);
  assert.ok(glance.length>=count+1,'overview includes every original plant and all supplier rows');
  assert.equal(glance.filter(row=>row[0]===plant).length>=count-1,true,'multiple rasadnici are shown as separate rows, without hiding the input plants');
  assert.equal(glance[1][0],plant);
  assert.ok(glance[1][2].includes('Rasadnik A'),'nursery visible in its own cell');
  assert.equal(glance[1][3],65,'Supplier price in separate column');
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
  const rows=[[plant,'standard; visina 300–350'],[plant,'standard; visina 300–350']],notes=[['Napomena'],['Dva originalna reda bez zaglavlja.']];
  const input=workbook([['Bez zaglavlja',rows],['Napomena',notes]]),instance=worker();
  const result=await instance.process(input);
  assert.equal(result.processed,2);assert.equal(result.matched,2);assert.equal(result.preview[0].row,1);
  const output=await instance.download(),book=XLSX.read(output,{type:'array'});
  assert.equal(book.SheetNames.length,4);
  assert.equal(book.SheetNames[0],'Pregled preporuke');
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets['Bez zaglavlja'],{header:1,defval:''}),rows);
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets.Napomena,{header:1,defval:''}),notes);
  const added=book.SheetNames.find(name=>!['Pregled preporuke','Bez zaglavlja','Napomena'].includes(name));assert(added);
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
  assert.equal(result.processed,1);assert.equal(result.needsData,1);assert.equal(result.matched,0);
  assert.match(result.preview[0].message,/formula.*sačuvanu vrednost/i);
});

test('Plant specifications sheet drives procurement search instead of duplicated calculation rows',async()=>{
  const headers=['ID stavke','Dionica','Grupa','Izvorni naziv','Naziv za pretragu','Veličina i posuda','JM','Količina','Izvorni opis','Izvorna ćelija'];
  const source=[
    ['Sadni materijal iz važećeg priloga'],[],[],[],
    headers,
    ['D1-129','DIONICA-1','Drveće',plant,plant,'visina 300/350 cm, standard, kontejnirano','kom',25,plant+'; visina 300/350 cm, standard, kontejnirano','DIONICA-1!B129:F129'],
    ['D1-131','DIONICA-1','Drveće',plant,plant,'visina 400cm, kontejnirano, 3x presađivano','kom',151,plant+'; visina 400cm, kontejnirano, 3x presađivano','DIONICA-1!B131:F131'],
    ['D1-150','DIONICA-1','Travnjak sa semenom','Travnjak sa semenom','Travnjak sa semenom','seme, 25–30 g/m²','m²',170,null,null]
  ];
  const calc=[['ID stavke','Biljka / rad','JM','Količina'],['D1-129',plant,'kom',25],['D1-131',plant,'kom',151]];
  const input=workbook([['Kalkulacija',calc],['Specifikacije',source],['Napomena',[['Zadrži original']]]]);
  const instance=worker(),result=await instance.process(input);
  assert.equal(result.processed,2,'Repeated calculations and the lawn row are not additional plant requests');
  assert.equal(result.matched,1,'A specified Standard 300–350 plant finds exact nursery offers');
  assert.equal(result.needsData,1,'400 cm was extracted but no Standard/Multistem form was specified');
  assert.equal(result.preview[0].parameters.find(v=>v.key==='height')?.value,'300/350 cm');
  assert.equal(result.preview[1].parameters.find(v=>v.key==='height')?.value,'400cm');
  assert.equal(result.preview[1].parameters.find(v=>v.key==='seedlingType'),undefined);
  const output=await instance.download(),book=XLSX.read(output,{type:'array'});
  const overview=XLSX.utils.sheet_to_json(book.Sheets['Pregled preporuke'],{header:1,defval:''});
  assert.ok(overview.length>=3);
  assert.match(overview[1][1],/Visina sadnice: 300\/350 cm/);
  const candidate=overview.find(row=>String(row[1]).includes('400cm'));
  assert.ok(candidate);
  assert.equal(candidate[2],'—');
  assert.equal(candidate[3],'');
  assert.match(candidate[4],/Nedostaju|proveriti/);
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets.Kalkulacija,{header:1,defval:''}),calc);
});

test('rank by number of matching botanical fields, then by price; keep all eligible variants',()=>{
  const C=require(resolve(assets,'brza-preporuka-core.js'));
  const req={name:plant,seedlingType:'standard',height:'300-350',potSize:'50 L'};
  const base={plantId:'p1',nurseryId:'n1',currency:'EUR',unit:'kom',seedlingType:'standard',height:'300-350',potSize:'50 L'};
  const offers=[
    {...base,id:'full-expensive',price:120},
    {...base,id:'two-cheap',price:20,potSize:'70 L'},
    {...base,id:'two-next',price:30,height:'400-450'},
    {...base,id:'one',price:5,height:'500-550',potSize:'90 L'},
    {...base,id:'zero',price:2,seedlingType:'multistem',height:'500-550',potSize:'90 L'},
    {...base,id:'full-placeholder',price:1,nurseryId:'n2'},
    {...base,id:'other-plant',plantId:'other',price:3}
  ];
  const idx=C.makeIndex({...catalog,plants:[...catalog.plants,{id:'other',latinName:'Tilia cordata'}],offers});
  const r=C.recommendQuick(idx,req);
  assert.deepEqual(r.suppliers.map(s=>[s.offerIds[0],s.matchCount,s.price]),[['full-expensive',3,120],['two-cheap',2,20],['two-next',2,30],['one',1,5]]);
  assert.equal(r.suppliers[0].candidate,false);assert(r.suppliers.slice(1).every(s=>s.candidate));assert.equal(r.price,120);
  assert.equal(C.recommendQuick(idx,{name:plant}).suppliers.length,0);
  assert.equal(C.recommendQuick(idx,{name:plant,height:'999'}).suppliers.length,0);
});
