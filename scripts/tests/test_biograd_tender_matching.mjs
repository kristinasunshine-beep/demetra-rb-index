import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';

const require=createRequire(import.meta.url);
const Core=require('../../assets/brza-preporuka-core.js');
const read=n=>JSON.parse(readFileSync(new URL('../../data/'+n+'.json',import.meta.url),'utf8'));
const [plants,nurseries,offers]=['biljke','rasadnici','kataloske-stavke'].map(read);
const index=Core.makeIndex({plants:plants.plants,nurseries:nurseries.nurseries,offers:offers.offers});
const headers=[
  'Naziv biljke','Kultivar','Količina','Visina sadnice','Obim sadnice','Širina krošnje',
  'Veličina saksije','Način isporuke','Broj presađivanja','Prečnik sadnice (cm)',
  'Prečnik saksije (cm)','Visina do krošnje (cm)','Jedinica mere','Dionica',
  'Grupa biljaka','Dodatni uslovi iz troškovnika','Izvorni opis stavke','Izvor'
];
const note='I. klasa; pravilno oblikovana krošnja; kvalitetno, školovano, kompaktno, potpuno prorašten kontejner.';
function sample(name,quantity,height,root='Kontejner',description='',cultivar=''){
  return [name,cultivar,quantity,height,'','','',root,3,'','','','kom','DIONICA-1','Drveće',note,description,'Izvorni troškovnik | DIONICA-1!B128:D129'];
}
const cases=[
  sample('Cupressus semprevirens',25,'300/400 cm','Kontejner','Cupressus semprevirens - talijanski čempres; visina 300/400 cm, kontejnirano, 3x presađivano'),
  sample('Celtis australis',151,'400 cm','Kontejner','Celtis australis - obični koprivić; visina 400cm, kontejnirano, 3x presađivano'),
  sample('Fraxinus ornus',36,'400 cm','Kontejner','Fraxinus ornus - crni jasen; visina 400cm, kontejnirano, 3x presađivano'),
  sample('Tilia platyphyllos',3,'400 cm','Balirano ili kontejnirano','Tilia platyphyllos - velelisna lipa; visina 400cm'),
];
const config=Core.detectSheet([headers,...cases],index);

test('Real 18-column procurement layout maps fields without treating project metadata as specifications',()=>{
  assert.equal(config.enabled,true);
  assert.equal(config.headerRow,0);
  assert.equal(config.map.name,0);
  assert.equal(config.map.cultivar,1);
  assert.equal(config.map.quantity,2);
  assert.equal(config.map.height,3);
  assert.equal(config.map.rootType,7);
  assert.equal(config.map.transplantCount,8);
  assert.equal(config.map.preferences,15);
  assert.equal(config.map.sourceDescription,16);
  assert.ok(!Object.values(config.map).flat().includes(13),'project section is not a plant dimension');
  assert.ok(!Object.values(config.map).flat().includes(17),'source pointer is evidence not a matching filter');
});
test('Spelling correction is suggested, never silently substituted as the priced species',()=>{
  const row=Core.requestFromRow(cases[0],config.map,config.headers);
  const result=Core.recommend(index,row,{tenderMode:true});
  assert.equal(result.status,'unmatched');
  assert.equal(result.recognized,false);
  assert.ok(result.candidates.includes('Cupressus sempervirens'));
  assert.equal(result.values[2],'');
});
test('Existing species yields archival references and no unsupported confirmed price',()=>{
  const row=Core.requestFromRow(cases[1],config.map,config.headers);
  const result=Core.recommend(index,row,{tenderMode:true});
  assert.equal(result.recognized,true);
  assert.equal(result.status,'unmatched');
  assert.equal(result.archival,true);
  assert.equal(result.values[2],'');
  assert.ok(result.values[0].includes('ARHIVA'));
  assert.ok(result.message.includes('Kvalitativni uslovi'));
  assert.ok(result.message.includes('aktuelna'));
});
test('Species and cultivar are never interchangeable',()=>{
  const row=Core.requestFromRow(cases[2],config.map,config.headers);
  const result=Core.recommend(index,row,{tenderMode:true});
  assert.equal(result.recognized,false);
  assert.equal(result.status,'unmatched');
  assert.ok(result.candidates.includes("Fraxinus ornus 'Mecsek'"));
});
test('An alternative delivery option must be marked for manual checking',()=>{
  const row=Core.requestFromRow(cases[3],config.map,config.headers);
  const result=Core.recommend(index,row,{tenderMode:true});
  assert.equal(result.recognized,true);
  assert.equal(result.alternatives,true);
  assert.equal(result.status,'unmatched');
  assert.equal(result.values[2],'');
  assert.ok(result.message.includes('balirano ili kontejnirano'));
});
test('A current truly verified plant can still be matched if qualitative risks are absent',()=>{
  const one={id:'p1',latinName:'Celtis australis',synonyms:[]};
  const checked={id:'v1',plantId:'p1',nurseryId:'n1',unit:'kom',rootType:'Kontejner',
    height:'400',price:120,currency:'EUR',sourceCurrency:'EUR',sourceAmount:120,
    priceKind:'current',priceRefresh:{checkedAt:'2026-11-16',status:'verified'}};
  const catalogue=Core.makeIndex({plants:[one],nurseries:[{id:'n1',name:'Supplier'}],offers:[checked]});
  const result=Core.recommend(catalogue,{name:'Celtis australis',height:'400',rootType:'Kontejner'},{tenderMode:true});
  assert.equal(result.status,'matched');
  assert.equal(result.price,120);
});

test('Nearest same-species sources rank by dimensional fit, not by lowest archival price',()=>{
  const plants=[{id:'p1',latinName:'Cupressus sempervirens',synonyms:[]},{id:'p2',latinName:"Cupressus sempervirens 'Stricta'",synonyms:[]}];
  const offers=[
    {id:'too-short',plantId:'p1',nurseryId:'n1',height:'100-150 cm',rootType:'Kontejner',price:10,currency:'EUR',sourceCurrency:'EUR',sourceAmount:10,priceKind:'historical'},
    {id:'close',plantId:'p1',nurseryId:'n2',height:'300-350 cm',rootType:'Kontejner',price:200,currency:'EUR',sourceCurrency:'EUR',sourceAmount:200,priceKind:'historical'},
    {id:'unknown-size',plantId:'p1',nurseryId:'n3',rootType:'Kontejner',price:30,currency:'EUR',sourceCurrency:'EUR',sourceAmount:30,priceKind:'historical'},
    {id:'cultivar',plantId:'p2',nurseryId:'n4',height:'300-350 cm',rootType:'Kontejner',price:1,currency:'EUR',sourceCurrency:'EUR',sourceAmount:1,priceKind:'historical'}
  ];
  const catalog=Core.makeIndex({plants,nurseries:['n1','n2','n3','n4'].map(id=>({id,name:id})),offers});
  const request={name:'Cupressus sempervirens',height:'300-350 cm',rootType:'Kontejner'};
  const ranked=Core.nearestOffers(catalog,request,3);
  assert.equal(ranked[0].id,'close','closest matching dimensions beats cheaper wrong dimensions');
  assert.ok(ranked.every(r=>r.id!=='cultivar'),'cultivar substitution is forbidden');
  assert.equal(ranked[0].historical,true,'historical source still clearly identified');
  assert.equal(ranked[0].currentPrice,false,'not an actual verified price');
  const conservative=Core.recommend(catalog,{...request,preferences:'I. klasa'},{tenderMode:true});
  assert.equal(conservative.bestCandidate.id,'close');
  assert.equal(conservative.values[2],'','historical candidate must not become a verified purchase price');
  assert.equal(conservative.alternatives,undefined,'existing delivery alternative semantic is preserved');
  assert.equal(conservative.nearbyOffers[0].id,'close');
});
test('Tender choice with two acceptable delivery forms retains the existing boolean flag',()=>{
  const row=Core.requestFromRow(cases[3],config.map,config.headers);
  const result=Core.recommend(index,row,{tenderMode:true});
  assert.equal(result.alternatives,true,'delivery-forms ambiguity is still tracked');
  assert.ok(Array.isArray(result.nearbyOffers),'closest supplier candidates remain a separate field');
});
