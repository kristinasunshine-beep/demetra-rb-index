import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
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
  plants:[{id:'p1',latinName:plant,synonyms:[]},{id:'p2',latinName:'Fraxinus excelsior',synonyms:[]},{id:'p3',latinName:'Tamarix ramosissima',synonyms:[]},{id:'p4',latinName:'Celtis occidentalis',synonyms:[]}],
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
function worker(testCatalog=catalog){
  const messages=[],commands=[];
  const sandbox={console,setTimeout,clearTimeout,TextEncoder,TextDecoder,ArrayBuffer,Uint8Array,DataView,
    postMessage(message){messages.push(structuredClone(message));},
    async fetch(url){
      assert(['test-template.xlsx','shared-template.xlsx'].includes(url));
      const bytes=readFileSync(resolve(assets,url==='shared-template.xlsx'?'moja-ponuda-template.xlsx':'brza-preporuka-template.xlsx'));
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
      await context.onmessage({data:{type:'process',file:{name:'input.xlsx',arrayBuffer:async()=>input},catalog:structuredClone(testCatalog)}});
      assert.equal(messages.filter(m=>m.type==='error').length,0,JSON.stringify(messages.filter(m=>m.type==='error')));
      const result=messages.findLast(m=>m.type==='results');
      assert(result,'A single process command must produce results');
      assert.deepEqual(commands,['process'],'No separate read/run or mapping command is needed');
      assert(messages.every(m=>['progress','results'].includes(m.type)),'No loaded/mapping intermediate response is allowed');
      return result;
    },
    async processPdf(pdfRows){
      commands.push('process');
      await context.onmessage({data:{type:'process',file:{name:'plants.pdf'},pdfRows,catalog:structuredClone(testCatalog)}});
      assert.equal(messages.filter(m=>m.type==='error').length,0,JSON.stringify(messages.filter(m=>m.type==='error')));
      const result=messages.findLast(m=>m.type==='results');
      assert(result,'PDF import must yield results');
      return result;
    },
    async download(excludedIds=[],shared=false,excludedOffers=[]){
      commands.push('export');
      await context.onmessage({data:{type:'export',excludedIds,excludedOffers,templateUrl:'test-template.xlsx',...(shared?{sharedTemplateUrl:'shared-template.xlsx'}:{})}});
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
  assert.deepEqual(book.SheetNames,['Pregled preporuke','Sadnice','Napomena','Prepoznate biljke']);
  const recognized=XLSX.utils.sheet_to_json(book.Sheets['Prepoznate biljke'],{header:1,defval:''});
  assert.deepEqual(recognized[0],['Latinski naziv biljke','Prepoznati parametri sadnice']);
  assert.equal(recognized.length,count+1);
  assert.equal(recognized[1][0],plant);
  assert.match(recognized[1][1],/Tip sadnice: Standard/);
  assert.match(recognized[1][1],/Visina sadnice: 300–350/);
  assert(!recognized[1].join(' ').includes('Količina'));
  assert.equal(recognized.at(-1)[0],"Acer campestre 'Pogresan kultivar'");
  const glance=XLSX.utils.sheet_to_json(book.Sheets['Pregled preporuke'],{header:1,defval:''});
  assert.deepEqual(glance[0],['Latinski naziv biljke','Parametri iz tvoje tabele','Spisak rasadnika','Nabavna cena (€)','Rezultat','Digitalna kartica','Količina']);
  assert.ok(glance.length>=count+1,'overview includes every original plant and all supplier rows');
  assert.equal(glance.filter(row=>row[0]===plant).length>=count-1,true,'multiple rasadnici are shown as separate rows, without hiding the input plants');
  assert.equal(glance[1][0],plant);
  assert.ok(glance[1][2].includes('Rasadnik A'),'nursery visible in its own cell');
  assert.equal(glance[1][3],65,'Supplier price in separate column');assert.equal(glance[1][6],3,'Visible source quantity');
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
  assert.equal(book.SheetNames.length,5);
  assert.equal(book.SheetNames[0],'Pregled preporuke');
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets['Bez zaglavlja'],{header:1,defval:''}),rows);
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets.Napomena,{header:1,defval:''}),notes);
  const added=book.SheetNames.find(name=>!['Pregled preporuke','Bez zaglavlja','Napomena','Prepoznate biljke'].includes(name));assert(added);
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
  assert.equal(result.matched,0,'A missing requested delivery type cannot count as an exact match');
  assert.equal(result.unmatched,1);
  assert.equal(result.preview[0].suppliers[0].price,65);
  assert.equal(result.preview[0].suppliers[0].candidate,true);
  assert.equal(result.preview[0].suppliers[0].matchCount,2);
  assert.equal(result.preview[0].suppliers[0].requestedCount,3);
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
  const nameOnly=C.recommendQuick(idx,{name:plant});
  assert.equal(nameOnly.status,'needs_data');assert.equal(nameOnly.suppliers.length,5);assert(nameOnly.suppliers.every(s=>s.nameOnly&&s.candidate&&s.matchCount===0&&s.requestedCount===0));
  assert.deepEqual(nameOnly.suppliers.map(s=>s.price),[2,5,20,30,120]);
  assert.equal(C.recommendQuick(idx,{name:plant,height:'999'}).suppliers.length,0);
});

test('Excel recognition ignores quotation marks but retains precise cultivar identity and all original botanical fields',async()=>{
  const inputRows=[
    ['Latinski naziv biljke','Tip sadnice','Visina (cm)','Obim (cm)','Veličina saksije','Količina','Cena','Šifra'],
    [plant,'Standard','300–350','18–20','50 L',11,200,'ABC-1'],
    ['Acer campestre Elsrijk','Standard','300–350','18–20','50 L',17,205,'ABC-2'],
    ['"Acer campestre Elsrijk"','Standard','300–350','18–20','50 L',19,209,'ABC-3'],
    ["Acer campestre 'Pogresan kultivar'",'Standard','300–350','18–20','50 L',23,50,'ABC-4']
  ];
  const instance=worker();
  const result=await instance.process(workbook([['Ulaz',inputRows]]));
  assert.equal(result.processed,4);
  assert.equal(result.recognized,3);
  assert.equal(result.notFound,1);
  const output=await instance.download();
  const book=XLSX.read(output,{type:'array'});
  const recognized=XLSX.utils.sheet_to_json(book.Sheets['Prepoznate biljke'],{header:1,defval:''});
  assert.deepEqual(recognized[0],['Latinski naziv biljke','Prepoznati parametri sadnice']);
  assert.equal(recognized.length,5);
  for(const row of recognized.slice(1,4)){
    assert.equal(row[0],plant);
    assert.match(row[1],/Tip sadnice: Standard/);
    assert.match(row[1],/Visina sadnice: 300–350/);
    assert.match(row[1],/Obim sadnice: 18–20/);
    assert.match(row[1],/Veličina saksije: 50 L/);
    assert(!/ABC|Količina|Cena|200|205|209/.test(row.join(' ')));
  }
  assert.equal(recognized[4][0],"Acer campestre 'Pogresan kultivar'");
});

test('PDF initial recognition exports only canonical Latin name and recorded plant parameters',async()=>{
  const instance=worker();
  const result=await instance.processPdf([
    ['Latinski naziv','Tip sadnice','Visina (cm)','Obim (cm)'],
    ['"Acer campestre Elsrijk"','Standard','300–350','18–20'],
    ["Acer campestre 'Elsrijk'",'Standard','300–350','18–20'],
    ['Acer campestre Wrong','Standard','300–350','18–20']
  ]);
  assert.equal(result.processed,3);
  assert.equal(result.recognized,2);
  assert.equal(result.notFound,1);
  const book=XLSX.read(await instance.download(),{type:'array'});
  const rows=XLSX.utils.sheet_to_json(book.Sheets['Prepoznate biljke'],{header:1,defval:''});
  assert.equal(rows.length,4);
  assert.equal(rows[1][0],plant);
  assert.equal(rows[2][0],plant);
  assert.equal(rows[3][0],'Acer campestre Wrong');
  for(const row of rows.slice(1)){
    assert.match(row[1],/Tip sadnice: Standard/);
    assert.match(row[1],/Visina sadnice: 300[-–]350/);
    assert.match(row[1],/Obim sadnice: 18[-–]20/);
  }
  assert.equal(rows[0].length,2);
  assert(book.SheetNames.includes('Pregled preporuke'));
});

test('Excel input excludes tender comments and column captions from preview and all generated sheets',async()=>{
  const prose='Za D6-136, D6-171 i D6-172 izdvojen je samo sadni materijal uz izvornu površinu. Te cene nisu cene kompletnih kombinovanih stavki tendera.';
  const src=[
    ['Latinski naziv biljke','Tip sadnice','Visina (cm)'],
    [prose,'',''],
    ['Biljka / sadni materijal','',''],
    ['Biljka sadni materijal','',''],
    ['Latinski naziv biljke','',''],
    [plant,'Standard','300–350'],
    ['Fraxinus ornus','Standard','300–350']
  ];
  const instance=worker(),result=await instance.process(workbook([['Biljke',src]]));
  assert.equal(result.processed,2);
  assert.deepEqual(result.preview.map(r=>r.canonicalName),[plant,'Fraxinus ornus']);
  const book=XLSX.read(await instance.download(),{type:'array'});
  for(const name of ['Pregled preporuke','Prepoznate biljke']){
    const rows=XLSX.utils.sheet_to_json(book.Sheets[name],{header:1,defval:''});
    const text=JSON.stringify(rows);
    assert(!text.includes('Za D6-136'));
    assert(!text.includes('Biljka / sadni materijal'));
    assert(!text.includes('Biljka sadni materijal'));
    assert(text.includes('Fraxinus ornus'));
  }
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Prepoznate biljke'],{header:1,defval:''}).length,3);
});
test('Headerless Excel excludes tender notes and preserves unknown botanical names',async()=>{
  const text='Za D6-136, D6-171 i D6-172 izdvojen je samo sadni materijal';
  const rows=[[text,''],['Biljka / sadni materijal',''],[plant,'Standard; visina 300–350'],['Tamarix gallica','Standard; visina 300–350']];
  const instance=worker();
  const result=await instance.process(workbook([['Bez zaglavlja',rows]]));
  assert.equal(result.processed,2);
  assert.deepEqual(result.preview.map(r=>r.canonicalName),[plant,'Tamarix gallica']);
});
test('PDF-to-Excel excludes tender prose, even inside mapped Latin name columns',async()=>{
  const prose='Za D6-136, D6-171 i D6-172 izdvojen je samo sadni materijal uz izvornu površinu.';
  const instance=worker();
  const result=await instance.processPdf([
    ['Latinski naziv','Tip sadnice','Visina (cm)'],
    [prose,'',''],
    ['Biljka / sadni materijal','',''],
    ['"Acer campestre Elsrijk"','Standard','300–350'],
    ['Celtis australis','Standard','300–350']
  ]);
  assert.equal(result.processed,2);
  const book=XLSX.read(await instance.download(),{type:'array'});
  const recognized=XLSX.utils.sheet_to_json(book.Sheets['Prepoznate biljke'],{header:1,defval:''});
  assert.deepEqual(recognized.map(r=>r[0]),['Latinski naziv biljke',plant,'Celtis australis']);
});

test('all sheets and arbitrary cells are scanned; unrelated text never enters the recommendation; exclusions apply to export',async()=>{
  const input=workbook([
    ['Specifikacije',[['ID stavke','Naziv za pretragu','Veličina i posuda','Količina'],['A1',plant,'standard; visina 300–350',7]]],
    ['Drugi list',[['Opis','Količina'],['Sadnja: Acer campestre Elsrijk; Standard; visina 300–350',9],['Ukupno radovi',123],['Napomena o dokumentu',5]]],
    ['Treći list',[['Nije biljka'],['Administrativni tekst'],['','',plant,'Standard; visina 300–350']]]
  ]);
  const instance=worker(),result=await instance.process(input);
  assert.equal(result.preview.length,3);
  assert(result.preview.every(row=>row.canonicalName===plant));
  assert.equal(result.preview[0].quantity,7);
  const removedItem=result.preview[1];
  assert.equal(removedItem.quantity,9,'Explicit quantity header must survive Latin-name extraction from the description');
  assert(removedItem.suppliers.length>0,'The target must actually have offers before deletion');
  const book=XLSX.read(await instance.download([removedItem.id],false,removedItem.suppliers.map(s=>JSON.stringify([removedItem.id,s.offerIds[0]]))),{type:'array'});
  const recognition=XLSX.utils.sheet_to_json(book.Sheets['Prepoznate biljke'],{header:1,defval:''});
  assert.equal(recognition.length,4);
  const overview=XLSX.utils.sheet_to_json(book.Sheets['Pregled preporuke'],{header:1,defval:''});
  assert(overview.slice(1).every(row=>row[0]===plant));
  assert(overview.slice(1).some(row=>row[6]===9&&row[2]==='—'&&row[4]==='Sve ponude su uklonjene'));
});

test('Italian availability heading and OCR fragments never become botanical recommendations',async()=>{
  const instance=worker();
  const result=await instance.processPdf([
    ["VIVAI NORD YOUNG PLANT AVAILABILITY 20_04_2026"],
    ["Disponibilita isponibilita g giovani p piante a l"],
    ["Disponibilità giovani piante"],
    ["Jedinica mere"],
    ["Acer campestre Elsrijk","Standard","visina 300–350"],
    ["Acer campestre 'Pogresan kultivar'","Standard","visina 300–350"]
  ]);
  assert.equal(result.processed,2);
  assert.equal(result.preview[0].canonicalName,plant);
  assert.equal(result.preview[1].status,'not_found');
  const output=XLSX.read(await instance.download(),{type:'array'});
  const names=XLSX.utils.sheet_to_json(output.Sheets['Prepoznate biljke'],{header:1}).map(row=>row[0]);
  assert.deepEqual(names,['Latinski naziv biljke',plant,"Acer campestre 'Pogresan kultivar'"]);
});
test('heading-only PDF returns zero recommendations, not a fabricated plant',async()=>{
  const instance=worker();
  const result=await instance.processPdf([['Disponibilita giovani piante'],['Jedinica mere'],['Young plant availability']]);
  assert.equal(result.processed,0);assert.deepEqual(result.preview,[]);
});

test('final panel selection filters the actual shared memorandum download and recognition sheet, and can be restored',async()=>{
  const instance=worker();
  const result=await instance.process(workbook([['Biljke',[
    ['Latinski naziv biljke','Tip sadnice','Visina (cm)','Količina'],
    [plant,'Standard','300–350',7],
    ['Fraxinus ornus','Standard','300–350',12]
  ]]]));
  assert.equal(result.preview.length,2);
  const excluded=[result.preview[0].id];
  const output=XLSX.read(await instance.download(excluded,true,result.preview[0].suppliers.map(s=>JSON.stringify([result.preview[0].id,s.offerIds[0]]))),{type:'array'});
  const report=XLSX.utils.sheet_to_json(output.Sheets['Brza preporuka'],{header:1,defval:''});
  assert(report[17].includes('Količina'));
  assert(report.slice(18).some(row=>row.includes('Fraxinus ornus')&&row.includes(12)));
  assert(report.slice(18).some(row=>row.includes(plant)&&row.includes('Ponude uklonjene')));
  const recognized=XLSX.utils.sheet_to_json(output.Sheets['Prepoznate biljke'],{header:1});
  assert.deepEqual(recognized.map(row=>row[0]),['Latinski naziv biljke',plant,'Fraxinus ornus']);
  const restored=XLSX.read(await instance.download([],true),{type:'array'});
  assert(XLSX.utils.sheet_to_json(restored.Sheets['Brza preporuka'],{header:1}).some(row=>row.includes(plant)&&row.includes(7)));
});

test('remove one nursery offer without removing other offers or the botanical identity; actual shared download honors edits',async()=>{
 // Keep the baseline placeholder and wrong-currency regression fixtures intact.
 // This scenario requires a second independently eligible, partially matching EUR offer.
 const eligible={...catalog.offers.find(o=>o.id==='wrong-size'),id:'eligible-second',price:95};
 const instance=worker({...catalog,offers:[...catalog.offers,eligible]});
 const result=await instance.process(workbook([['Biljke',[
  ['Latinski naziv biljke','Tip sadnice','Visina (cm)','Količina'],
  [plant,'Standard','300–350',7]
 ]]]));
 const item=result.preview[0];assert.deepEqual(item.suppliers.map(s=>s.offerIds[0]),['eur','eligible-second']);
 const [first,second]=item.suppliers;
 assert.equal(first.matchCount,2);assert.equal(second.matchCount,1);
 const key=JSON.stringify([item.id,first.offerIds[0]]);
 const output=XLSX.read(await instance.download([],true,[key]),{type:'array'});
 const report=XLSX.utils.sheet_to_json(output.Sheets['Brza preporuka'],{header:1,defval:''});
 assert(report[17].includes('Poklapanje'));
 assert(!report.slice(18).some(row=>row.includes(first.name)));
 assert(report.slice(18).some(row=>row.includes(second.name)&&row.includes(second.price)&&row.includes(second.matchCount+'/'+second.requestedCount)));
 assert(report.slice(18).some(row=>row.join(' ').includes(second.offeredParameters.split('; ')[0])));
 assert.equal(XLSX.utils.sheet_to_json(output.Sheets['Prepoznate biljke'],{header:1}).length,2);
 const restored=XLSX.read(await instance.download([],true),{type:'array'});
 assert(XLSX.utils.sheet_to_json(restored.Sheets['Brza preporuka'],{header:1}).some(row=>row.includes(first.name)));
});

test('PDF names without dimensions return same-taxon archive offers; remove offers only, preserve all recognized names',async()=>{
 const fixture={...catalog,plants:[...catalog.plants,{id:'pal',latinName:'Acer palmatum'}],offers:[...catalog.offers,
 {id:'pal-old',plantId:'pal',nurseryId:'n1',price:35,currency:'EUR',unit:'kom',height:'100–125',priceKind:'historical',validUntil:'2020-01-01'},
 {id:'pal-other',plantId:'pal',nurseryId:'n2',price:55,currency:'EUR',unit:'kom',height:'150–175',priceKind:'historical'}]};
 const instance=worker(fixture);
 const result=await instance.processPdf([['Latinski naziv'],['Acer palmatum']]);
 const item=result.preview[0];assert.equal(item.canonicalName,'Acer palmatum');
 assert.deepEqual(item.suppliers.map(s=>s.offerIds[0]),['pal-old','pal-other']);
 assert(item.suppliers.every(s=>s.nameOnly&&s.candidate&&s.historical&&s.requestedCount===0));
 const output=XLSX.read(await instance.download([item.id],true,item.suppliers.map(s=>JSON.stringify([item.id,s.offerIds[0]]))),{type:'array'});
 const rows=XLSX.utils.sheet_to_json(output.Sheets['Brza preporuka'],{header:1,defval:''});
 assert(rows.some(row=>row.includes('Acer palmatum')&&row.includes('Ponude uklonjene')));
 assert.deepEqual(XLSX.utils.sheet_to_json(output.Sheets['Prepoznate biljke'],{header:1}).map(r=>r[0]),['Latinski naziv biljke','Acer palmatum']);
});


function verifyPagination(source){
 const els=new Map();function element(id){if(!els.has(id))els.set(id,{id,hidden:false,disabled:false,innerHTML:"",textContent:"",handlers:{},classList:{toggle(){},add(){},remove(){}},setAttribute(){},scrollIntoView(){},focus(){},addEventListener(n,fn){this.handlers[n]=fn},querySelector(q){return element(q.slice(1))}});return els.get(id)}
 let worker;class FakeWorker{constructor(){worker=this;}postMessage(){} terminate(){}}
 const win={},doc={baseURI:"https://example.invalid/",getElementById:element,body:{dataset:{}}};
 new Function("window","document","Worker","URL",source)(win,doc,FakeWorker,function(){});
 win.DemetraRecommendation.create({getCatalog:()=>({})});
 element("recommend-file").handlers.change({target:{files:[{name:"test.xlsx"}],value:""}});
 if(!worker)throw Error("Worker not initialized");
 const result=n=>worker.onmessage({data:{type:"results",processed:n,recognized:n,matched:0,unmatched:n,preview:Array.from({length:n},(_,i)=>({id:String(i),name:"Plant "+i,suppliers:Array.from({length:24},(_,j)=>({offerIds:[i+"-"+j],name:"Nursery",price:30,matchCount:1,requestedCount:1,candidate:true})),parameters:[]}))}});
 result(7);if(!element("recommend-pagination").hidden||element("recommend-page-label").textContent!==""||!element("recommend-next-page").disabled)throw Error("Single page failure");
 result(26);if(element("recommend-pagination").hidden||element("recommend-next-page").disabled)throw Error("Multiple page failure");
 element("recommend-next-page").handlers.click();if(!element("recommend-results-body").innerHTML.includes('data-result-id="25"')||!element("recommend-next-page").disabled)throw Error("Second page failure");
 element("recommend-prev-page").handlers.click();if(!element("recommend-results-body").innerHTML.includes('data-result-id="0"'))throw Error("Previous page failure");
 result(25);if(!element("recommend-pagination").hidden)throw Error("25-row boundary failure");
}

test('pagination appears only above 25 recognized plants, independent of offer count',()=>verifyPagination(readFileSync(resolve(assets,'brza-preporuka.js'),'utf8')));

test('large real worker export has valid workbook package for strict XML checks',async()=>{
 const instance=worker();
 const input=workbook([['Biljke',[['Latinski naziv biljke','Količina'],...Array.from({length:168},()=>[plant,7])]]]);
 const result=await instance.process(input);assert.equal(result.preview.length,168);
 const bytes=await instance.download([],true);
 const workbookFile=XLSX.read(bytes,{type:'array'});
 assert.deepEqual(workbookFile.SheetNames,['Brza preporuka','Prepoznate biljke']);
 assert.equal(XLSX.utils.sheet_to_json(workbookFile.Sheets['Prepoznate biljke'],{header:1}).length,169);
 const dir=process.env.DEMETRA_QUOTE_TEST_OUTPUT;
 if(dir){mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,'provera-brza-preporuka.xlsx'),Buffer.from(bytes));}
});

test('identical archive offers are shown once; preserve different prices, nurseries, specifications and source requests',async()=>{
 const C=require(resolve(assets,'brza-preporuka-core.js'));
 const base={id:'dup-a',plantId:'liriope',nurseryId:'n1',price:4.5,currency:'EUR',unit:'kom',potSize:'CLT 3 (oznaka izvora)',rootType:'Kontejner (CLT)',sourceDate:'2026-04-20',priceKind:'historical'};
 const fixture={...catalog,plants:[{id:'liriope',latinName:'Liriope muscari'}],offers:[base,{...base,id:'dup-b'},{...base,id:'higher',price:5},{...base,id:'different-pot',potSize:'CLT 5'},{...base,id:'different-nursery',nurseryId:'n2'},{...base,id:'different-form',additionalParameters:[{label:'Forma sadnice',value:'Soliter'}]}]};
 const res=C.recommendQuick(C.makeIndex(fixture),{name:'Liriope muscari'});
 assert.equal(res.suppliers.length,5);
 assert.equal(res.suppliers.filter(s=>s.offerIds[0]==='dup-a'||s.offerIds[0]==='dup-b').length,1);
 assert(res.suppliers.some(s=>s.offeredParameters.includes('Soliter')));
 const instance=worker(fixture);
 const result=await instance.process(workbook([['Biljke',[['Latinski naziv biljke','Količina'],['Liriope muscari',3],['Liriope muscari',7]]]]));
 assert.equal(result.preview.length,2);
 assert(result.preview.every(r=>r.suppliers.length===5));
 const item=result.preview[0], offer=item.suppliers.find(s=>s.offerIds[0]==='dup-a'||s.offerIds[0]==='dup-b');
 const bytes=await instance.download([],true,[JSON.stringify([item.id,offer.offerIds[0]])]);
 const output=XLSX.read(bytes,{type:'array'});
 const rows=XLSX.utils.sheet_to_json(output.Sheets['Brza preporuka'],{header:1,defval:''});
 assert.equal(rows.slice(18).filter(row=>row.includes('Liriope muscari')).length,9);
 assert.equal(rows.slice(18).filter(row=>row.includes('Liriope muscari')&&row.includes(3)).length,4);
 assert.equal(rows.slice(18).filter(row=>row.includes('Liriope muscari')&&row.includes(7)).length,5);
});
