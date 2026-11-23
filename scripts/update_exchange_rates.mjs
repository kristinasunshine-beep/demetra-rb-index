// Retired on 2026-11-23: new supplier inputs are EUR. No network or file writes.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export async function updateExchangeRates(_repo,_options={}){
  return {enabled:false,skipped:true,reason:'Automatsko osvežavanje kursa je isključeno. Novi unosi su u EUR; istorijske cene i dokazi ostaju nepromenjeni.'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await updateExchangeRates(),null,2));
