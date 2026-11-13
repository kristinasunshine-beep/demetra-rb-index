#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {refreshFolder} from './refresh_folder_prices.mjs';
const args=process.argv.slice(2),get=flag=>{const i=args.indexOf(flag);return i>=0?args[i+1]:undefined;};
const repository='kristinasunshine-beep/demetra-rb-index',work=get('--work'),source=get('--source')||process.env.DEMETRA_SOURCE_FOLDER;
if(!work||!source)throw new Error('Navedite lokalni radni folder i folder ponuda.');
const headers={'User-Agent':'DemetraRB-Price-Sync/1.0','Accept':'application/vnd.github+json','Content-Type':'application/json'};
const token=process.env.GITHUB_TOKEN;if(token)headers.Authorization='Bearer '+token;
async function request(url,options={}){const response=await fetch(url,{...options,headers:{...headers,...options.headers}});if(!response.ok)throw new Error('GitHub pristup nije uspeo: HTTP '+response.status);return response.json();}
const api='https://api.github.com/repos/'+repository;
await fs.mkdir(work,{recursive:true});
const lockFile=path.join(work,'morning.lock');let lock;
try{lock=await fs.open(lockFile,'wx');}catch{throw new Error('Prethodna jutarnja obrada još traje.');}
try{
 const head=await request(api+'/git/ref/heads/main'),commit=await request(api+'/git/commits/'+head.object.sha);
 const run=path.join(work,'prepared'),dataDir=path.join(run,'data');await fs.mkdir(dataDir,{recursive:true});
 const response=await fetch(`https://raw.githubusercontent.com/${repository}/${head.object.sha}/data/kataloske-stavke.json`,{headers});if(!response.ok)throw new Error('Aktuelni katalog nije mogao da se preuzme.');
 const original=await response.text();await fs.writeFile(path.join(dataDir,'kataloske-stavke.json'),original);
 const {report}=await refreshFolder({source,repo:run,stateFile:path.join(work,'private-price-state.json'),reportFile:path.join(work,'last-price-report.json'),apply:true});
 const before=JSON.parse(original),after=JSON.parse(await fs.readFile(path.join(dataDir,'kataloske-stavke.json'),'utf8'));
 if(before.offers.length!==after.offers.length)throw new Error('Promenjen broj zapisa tokom cenovnog ažuriranja.');
 const strip=o=>Object.fromEntries(Object.entries(o).filter(([k])=>!['price','priceEvidence','priceRefresh'].includes(k)));
 for(let i=0;i<before.offers.length;i++)if(JSON.stringify(strip(before.offers[i]))!==JSON.stringify(strip(after.offers[i])))throw new Error('Ažuriranje pokušava da promeni podatke izvan cene: '+before.offers[i].id);
 const manifest={preparedAt:new Date().toISOString(),repository,baseCommit:head.object.sha,files:['data/kataloske-stavke.json','data/price-sync-status.json'],verified:report.verified,changed:report.updated,pending:report.pending.length,newSources:report.newFiles.length,published:false};
 await fs.writeFile(path.join(work,'prepared-update.json'),JSON.stringify(manifest,null,2)+'\n');
 if(args.includes('--publish')){
   if(!token)throw new Error('Potvrđene cene su pripremljene, ali GitHub nije povezan za objavljivanje.');
   const tree=[];for(const name of manifest.files){const content=await fs.readFile(path.join(run,name),'utf8');const blob=await request(api+'/git/blobs',{method:'POST',body:JSON.stringify({content,encoding:'utf-8'})});tree.push({path:name,mode:'100644',type:'blob',sha:blob.sha});}
   const newTree=await request(api+'/git/trees',{method:'POST',body:JSON.stringify({base_tree:commit.tree.sha,tree})});
   const newCommit=await request(api+'/git/commits',{method:'POST',body:JSON.stringify({message:'Osveži potvrđene cene iz poslovnih ponuda',tree:newTree.sha,parents:[head.object.sha]})});
   // Fast-forward only: a concurrent manual upload is never overwritten.
   await request(api+'/git/refs/heads/main',{method:'PATCH',body:JSON.stringify({sha:newCommit.sha,force:false})});
   manifest.published=true;manifest.commit=newCommit.sha;
 }
 await fs.writeFile(path.join(work,'prepared-update.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest,null,2));
}finally{await lock.close();await fs.unlink(lockFile);}
