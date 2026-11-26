import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const baseline='5303f820450c691678121b07d16067e3d3612264';
const files=[['data/biljke.json','plants',['latinName']],['data/rasadnici.json','nurseries',[]],['data/kataloske-stavke.json','offers',['plantId','nurseryId']]];
function compare(before,after,key,fields){
 const ids=new Map(after.map(x=>[x.id,x]));
 assert.equal(ids.size,after.length,'Duplirani ID: '+key);
 for(const old of before){
  const current=ids.get(old.id);
  assert(current,'Nedostaje postojeći zapis: '+key+' '+old.id);
  for(const field of fields)assert.equal(current[field],old[field],'Promenjen identitet: '+old.id+' '+field);
 }
 return {before:before.length,after:after.length,added:after.length-before.length};
}
if(process.argv.includes('--self-test')){
 const before=[{id:'a',plantId:'p',nurseryId:'n',price:5}];
 assert.deepEqual(compare(before,[{...before[0],price:6},{id:'b'}],'offers',['plantId','nurseryId']),{before:1,after:2,added:1});
 assert.throws(()=>compare(before,[],'offers',[]));
 assert.throws(()=>compare(before,[{...before[0],plantId:'q'}],'offers',['plantId']));
 assert.throws(()=>compare(before,[before[0],before[0]],'offers',[]));
 console.log('Preservation tests passed');
}else{
 for(const [file,key,fields] of files){
  const old=JSON.parse(execFileSync('git',['show',baseline+':'+file],{encoding:'utf8',maxBuffer:100*1024*1024}));
  const current=JSON.parse(fs.readFileSync(file,'utf8'));
  console.log(key,compare(old[key],current[key],key,fields));
 }
 const n=JSON.parse(fs.readFileSync('data/rasadnici.json','utf8')).nurseries;
 assert.equal(n.find(x=>x.id==='rasadnik-jugoslav-unresolved')?.name,'Jugoslav');
}
