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
  const catalog={schemaVersion:1,sourcePolicy:offers.sourcePolicy,plants:plants.plants,nurseries:nurseries.nurseries,offers:offers.offers,updatedAt:offers.updatedAt};
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
  const localImage=/^assets\/biljke\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i;
  for(const offer of catalog.offers){
    if(offer.demo)fail('Demo zapis nije dozvoljen: '+offer.id);
    if(offer.dataOrigin!=='rasadnici-ponude-zip')fail('Podaci nisu vezani za ZIP ponude: '+offer.id);
    if(offer.priceKind==='public')fail('Online cenovni zapis nije dozvoljen: '+offer.id);
    if(!['','standard','multistem'].includes(offer.seedlingType ?? ''))fail('Nepoznat tip sadnice: '+offer.id);
    if(offer.matureHeight||offer.matureCrownWidth||offer.parameterObservation)fail('Online botanički parametri nisu dozvoljeni: '+offer.id);
    if(offer.transplantCount!==undefined&&offer.transplantCount!==null&&!offer.transplantNote)fail('Broj presađivanja mora biti objašnjen u napomeni: '+offer.id);
    if(offer.price!==null&&!(offer.price>0))fail('Cena mora biti pozitivna ili null: '+offer.id);
    if(offer.image&&!localImage.test(offer.image))fail('Fotografija mora biti sačuvana u repozitorijumu: '+offer.id);
  }
  for(const path of new Set(catalog.offers.map(o=>o.image).filter(Boolean))){
    if(!(await stat(join(root,path))).isFile())fail('Nedostaje fotografija: '+path);
  }
  const sourceIds=new Set(),sourceOffers=new Set();
  if(!Array.isArray(config.sources))fail('Konfiguracija cenovnih izvora mora sadržati listu.');
  for(const source of config.sources){
    if(sourceIds.has(source.id)||sourceOffers.has(source.offerId))fail('Dupliran izvor ažuriranja.');
    sourceIds.add(source.id);sourceOffers.add(source.offerId);
    if(source.enabled!==false)fail('Online osvežavanje cena mora biti isključeno: '+source.id);
  }
  const sample=new Script('searchPlants(JSON.parse(catalogJSON),"A",{limit:5}).map(p=>p.id)').runInContext(context,{timeout:1000});
  if(sample.length>5)fail('Pretraga vraća više od pet predloga.');
  const {verifyPanels}=await import('./check-panels.mjs');
  const panels=await verifyPanels(root);
  console.log(JSON.stringify({ok:true,plants:catalog.plants.length,nurseries:catalog.nurseries.length,records:catalog.offers.length,nonPhotoSource:catalog.sourcePolicy.nonPhoto,onlineUpdates:catalog.sourcePolicy.onlineUpdates,priceSources:config.sources.filter(s=>s.enabled).length,localPhotos:new Set(catalog.offers.map(o=>o.image).filter(Boolean)).size,panels},null,2));
}catch(error){console.error('Provera nije prošla: '+error.message);process.exitCode=1;}
