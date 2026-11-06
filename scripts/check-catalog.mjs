import {readFile,stat} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContext,Script} from 'node:vm';

const root=resolve(process.argv[2]||join(dirname(fileURLToPath(import.meta.url)),'..'));
const read=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
const fail=message=>{throw new Error(message);};
try{
  const html=await readFile(join(root,'index.html'),'utf8');
  const core=html.match(/\/\/ BEGIN CATALOG CORE\n([\s\S]*?)\/\/ END CATALOG CORE/);
  if(!core)fail('Nedostaje zajednička provera u index.html.');
  const [plants,nurseries,offers,scope,config]=await Promise.all([
    read('data/biljke.json'),read('data/rasadnici.json'),read('data/kataloske-stavke.json'),
    read('scripts/catalog-scope.json'),read('scripts/price-sources.json')
  ]);
  for(const envelope of [plants,nurseries,offers]){
    if(envelope.schemaVersion!==1||!Number.isFinite(Date.parse(envelope.updatedAt)))fail('Neispravna verzija ili datum datoteke.');
  }
  const catalog={schemaVersion:1,plants:plants.plants,nurseries:nurseries.nurseries,offers:offers.offers,updatedAt:plants.updatedAt};
  const context=createContext({URL,atob:globalThis.atob,catalogJSON:JSON.stringify(catalog)},{codeGeneration:{strings:false,wasm:false}});
  new Script(core[1]+'\nvalidateImport(JSON.parse(catalogJSON));').runInContext(context,{timeout:5000});
  const exact=(actual,expected,label)=>{
    const a=[...actual].sort(),b=[...expected].sort();
    if(JSON.stringify(a)!==JSON.stringify(b))fail(label+' se razlikuje od odobrenog obuhvata.');
  };
  exact(catalog.plants.map(p=>p.id),scope.plants.map(p=>p.id),'Spisak biljaka');
  exact(catalog.nurseries.map(n=>n.id),scope.nurseryIds,'Spisak rasadnika');
  exact(config.scope.allowedPlantIds,scope.plants.map(p=>p.id),'Obuhvat ažuriranja biljaka');
  exact(config.scope.allowedNurseryIds,scope.nurseryIds,'Obuhvat ažuriranja rasadnika');
  if(scope.origin!=='private_offer'||config.scope.origin!=='private_offer')fail('Biljke moraju poticati iz ponuda.');
  const proofs=new Map(scope.plants.map(p=>[p.id,p]));
  for(const plant of catalog.plants){
    const proof=proofs.get(plant.id);
    if(proof.latinName!==plant.latinName||!proof.offerEvidence?.length)fail('Nedostaje dokaz iz ponude: '+plant.latinName);
    if(plant.demo)fail('Demo biljke nisu dozvoljene.');
  }
  const offerMap=new Map(catalog.offers.map(o=>[o.id,o]));
  const localImage=/^assets\/biljke\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i;
  for(const offer of catalog.offers){
    if(offer.demo)fail('Demo zapis nije dozvoljen: '+offer.id);
    if(offer.price!==null&&!(offer.price>0))fail('Cena mora biti pozitivna ili null: '+offer.id);
    if(offer.image&&!localImage.test(offer.image))fail('Fotografija mora biti sačuvana u repozitorijumu: '+offer.id);
  }
  for(const path of new Set(catalog.offers.map(o=>o.image).filter(Boolean))){
    if(!(await stat(join(root,path))).isFile())fail('Nedostaje fotografija: '+path);
  }
  const sourceIds=new Set(),sourceOffers=new Set();
  for(const source of config.sources){
    if(sourceIds.has(source.id)||sourceOffers.has(source.offerId))fail('Dupliran izvor ažuriranja.');
    sourceIds.add(source.id);sourceOffers.add(source.offerId);
    const offer=offerMap.get(source.offerId);
    if(!offer||offer.plantId!==source.plantId||offer.nurseryId!==source.nurseryId||offer.sourceUrl!==source.offerSourceUrl)fail('Izvor nije vezan za tačan zapis: '+source.id);
    if(source.enabled&&(source.expected.currency!==offer.currency||source.expected.unit.label!==offer.unit||offer.priceKind!=='public'))fail('Neslaganje jedinice/valute/vrste cene: '+source.id);
    if(new URL(source.url).protocol!=='https:')fail('Izvor mora koristiti HTTPS.');
  }
  const sample=new Script('searchPlants(JSON.parse(catalogJSON),"A",{limit:5}).map(p=>p.id)').runInContext(context,{timeout:1000});
  if(sample.length>5)fail('Pretraga vraća više od pet predloga.');
  console.log(JSON.stringify({ok:true,plants:catalog.plants.length,nurseries:catalog.nurseries.length,records:catalog.offers.length,priceSources:config.sources.filter(s=>s.enabled).length,localPhotos:new Set(catalog.offers.map(o=>o.image).filter(Boolean)).size},null,2));
}catch(error){console.error('Provera nije prošla: '+error.message);process.exitCode=1;}
