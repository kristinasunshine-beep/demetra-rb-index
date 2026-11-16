import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Core=require('../../assets/brza-preporuka-core.js');
const load=path=>JSON.parse(readFileSync(new URL('../../data/'+path+'.json',import.meta.url),'utf8'));
const [plants,nurseries,offers]=['biljke','rasadnici','kataloske-stavke'].map(load);
const index=Core.makeIndex({plants:plants.plants,nurseries:nurseries.nurseries,offers:offers.offers});
for(const [name,description] of [
  ['Cupressus sempervirens','visina 300/400 cm, kontejnerirano, 3x presađivano'],
  ['Celtis australis','visina 400cm, kontejnerirano, 3x presađivano'],
  ['Fraxinus ornus','visina 400cm, kontejnerirano, 3x presađivano']
]){
 const found=Core.findPlant(index,name);
 const byPlant=found.id?(index.byPlant.get(found.id)||[]):[];
 const result=Core.recommend(index,{name,preferences:description});
 const resultNameOnly=Core.recommend(index,{name});
 const parsing=Core.parsePreferences(description);
 console.log('ARCHIVE_DIAGNOSTIC '+JSON.stringify({
  name,found,error:found.error,description,parsing,
  totalOffers:byPlant.length,uniqueNurseries:new Set(byPlant.map(x=>x.nurseryId)).size,
  actualParams:byPlant.slice(0,6).map(o=>({
   id:o.id,nurseryId:o.nurseryId,source:o.source,recordStatus:o.recordStatus,parameterRole:o.parameterRole,
   height:o.height,rootType:o.rootType,transplantCount:o.transplantCount,offerPrice:o.price,
   currency:o.currency,priceKind:o.priceKind,priceStatus:o.priceRefresh?.status,available:o.availability,
   additional:o.additionalParameters?.slice(0,4)
  })),result:{status:result.status,message:result.message,supplier:result.supplier,price:result.price},
  nameOnlyResult:{status:resultNameOnly.status,message:resultNameOnly.message,supplier:resultNameOnly.supplier,price:resultNameOnly.price}
 }));
}
for(const id of ['record-6792bed22c891f','record-volentis-484567ed89503abe4d','record-26f14cfe6d8225','record-386f70c062c2d0','record-29540b40d27b02','record-3ef0db334b98be','record-8966e3dbe80452']){
 const o=offers.offers.find(o=>o.id===id);console.log('ARCHIVE_ID '+JSON.stringify({id,found:!!o,offer:o?{plantId:o.plantId,height:o.height,rootType:o.rootType,transplantCount:o.transplantCount,price:o.price,currency:o.currency,source:o.source,recordStatus:o.recordStatus,priceKind:o.priceKind}:null}));
}
