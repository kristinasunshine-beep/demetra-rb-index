import fs from 'node:fs/promises';import assert from 'node:assert/strict';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createContext,Script} from 'node:vm';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),read=async p=>JSON.parse(await fs.readFile(path.join(root,p),'utf8'));
const html=await fs.readFile(path.join(root,'index.html'),'utf8'),core=html.match(/\/\/ BEGIN CATALOG CORE\n([\s\S]*?)\/\/ END CATALOG CORE/)[1],ui=html.slice(html.indexOf('const $ = (id)'),html.indexOf('function openRecord(id)'));
const elements=new Map(),document={baseURI:'https://example.test/',getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:''});return elements.get(id);}};
const ctx=createContext({URL,atob:globalThis.atob,document});const run=s=>new Script(s).runInContext(ctx,{timeout:5000});run(core+'\n'+ui);
const p=await read('data/biljke.json'),n=await read('data/rasadnici.json'),o=await read('data/kataloske-stavke.json');ctx.fixtureJSON=JSON.stringify({...o,plants:p.plants,nurseries:n.nurseries});run('state.catalog=validateImport(JSON.parse(fixtureJSON)).data');
for(const query of ['Ulmus New Horizon',"Ulmus 'New Horizon'",'Ulmus Resista New Horizon',"Ulmus Resista 'New Horizon'"]){ctx.query=query;assert.deepEqual(JSON.parse(run('JSON.stringify(searchPlants(state.catalog,query).map(p=>p.id))')),['plant-2d6ea78c9fc019']);}
assert.equal(run("plantById('plant-b3d791a8261438').id"),'plant-2d6ea78c9fc019');
run("renderRecord(plantById('plant-b3d791a8261438'))");const markup=elements.get('plant-dialog-content').innerHTML;
const target=o.offers.find(x=>x.id==='record-776b9160802f78');assert.equal(target.price,660);assert.equal(target.circumference,'30–35');assert.equal(target.sourceDate,'2026-01-20');assert.equal(target.priceEvidence.documentNumber,'S2526-02377');
assert(markup.includes('data-offer-picker-item data-offer-id="record-776b9160802f78"'), 'Existing quotation must remain selectable in the redesigned offer menu');assert(markup.includes('Obim') && markup.includes('30–35'), 'Original circumference must remain visible');assert(markup.includes('660,00'));assert(markup.includes('S2526-02377'));
assert.equal((markup.match(/<article[^>]*data-offer-id="record-776b9160802f78"/g)||[]).length,1);
assert.equal(o.offers.filter(x=>x.sourceEvidence?.sourceSha256==='5143e90df21bf5eea9d501626fdcc46843bab94370d39b11f70c09d2a28dd214').length,2);
console.log(JSON.stringify({passed:true,allNewHorizonQueriesOneCard:true,oldLinksPreserved:true,exactQuotationSelectable:true,quotedPrice660NotTotal14520:true,noDuplicateSourceRows:true}));

