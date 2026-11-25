(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DemetraRecommendCore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const FIELDS=[
    ['name','Naziv biljke'],['cultivar','Kultivar / sorta'],['circumference','Obim sadnice'],['height','Visina sadnice'],
    ['crownWidth','Širina krošnje'],['potSize','Veličina saksije'],['rootType','Način isporuke'],['seedlingType','Tip sadnice'],
    ['transplantCount','Broj presađivanja'],['rootBall','Busen'],['stemDiameter','Prečnik sadnice'],['potDiameter','Prečnik saksije'],['quantity','Količina'],['unit','Jedinica mere'],
    ['preferences','Ostali zahtevi'],['sourceDescription','Izvorni opis stavke'],['currency','Valuta']
  ];
  const EXTRA_HEADERS=['Spisak rasadnika','Rasadnik sa najnižom cenom','Najniža nabavna cena (€)','Ponuđeni parametri','Datum izvorne ponude','Rezultat preporuke'];
  const GENERATED_HEADERS=EXTRA_HEADERS.concat(['Preporučeni rasadnik','Nabavna cena','Valuta cene','Jedinica cene','PDV prema ponudi','Provera izvora']).map(v=>norm(v));
  function norm(v){return String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'dj').replace(/[×]/g,' x ').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
  const ALIASES={
    name:['naziv','biljka','naziv biljke','naziv sadnice','naziv sadnog materijala','sadni materijal','naziv za pretragu','izvorni naziv','biljka rad','latinski naziv','latinski naziv biljke','latinski naziv sadnice','botanicki naziv','botanicki naziv biljke','botanical name','plant name','plant','species','name','latin name','vrsta','vrsta biljke','botanischer name','bezeichnung','product'],
    cultivar:['kultivar','sorta','kultivar sorta','cultivar','variety'],circumference:['obim','obim sadnice','obim stabla','obim debla','opseg','opseg debla','opseg stabla','girth','circumference','stammumfang','st u'],
    height:['visina','visina sadnice','visina biljke','height','height cm','hoehe','hohe','visina do krosnje','visina cistog debla','clear stem height','stem height'],crownWidth:['sirina krosnje','precnik krosnje','crown width','crown spread'],
    potSize:['velicina saksije','saksija','zapremina saksije','pot','pot size','container size','litara','litres','clt'],
    rootType:['nacin isporuke','pakovanje','root type','root system','delivery','wurzel','rootball type'],seedlingType:['tip sadnice','forma','oblik','form','plant type','tip'],
    transplantCount:['broj presadjivanja','presadjivanja','transplants','transplant count'],rootBall:['busen','velicina busena','rootball','root ball'],
    stemDiameter:['precnik sadnice','promjer sadnice','stem diameter','precnik debla','promjer debla'],potDiameter:['precnik saksije','promjer saksije','promjer posude','pot diameter'],
    quantity:['kolicina','qty','quantity','komada','broj komada','amount','anzahl','kol'],unit:['jed','jm','j m','jed mj','jed mere','jed mjere','jedinica','jedinica mere','jedinica mjere','unit'],
    sourceDescription:['izvorni opis stavke','izvorni opis','original description','izvorni opis sadnice'],
    preferences:['preferencije','preference','preferences','zahtevi','zahtjevi','specifikacija','opis','description','specification','detalji','napomena','napomene','remarks','zahtevane karakteristike','dimenzije','velicina','velicina i posuda','velicina posuda','size','sizes','parametri','parametri sadnice','parametri biljke','opis sadnice','opis biljke','opis stavke','dodatni uslovi iz troskovnika','dodatni uvjeti iz troskovnika','karakteristike','kvalitet','kvaliteta'],
    currency:['valuta','currency']
  };
  function headerField(v){if(GENERATED_HEADERS.includes(norm(v)))return '';const n=norm(v).replace(/\b(?:cm|mm|m|lit|l|lt|ltr|litara|litre|litres|eur)\b/g,'').trim();for(const [key,list] of Object.entries(ALIASES))if(list.includes(n)||list.includes(norm(v)))return key;if(/^(?:latinski|botanicki|botanical|latin)\s+(?:naziv|name)\b/.test(n))return 'name';if(/\b(?:opis|specifikacija|specification|description|zahtevi|zahtjevi|uslovi|uvjeti|napomene?|preferencije|parametri|karakteristike)\b/.test(n))return 'preferences';return '';}
  function headerMap(headers){const map={};headers.forEach((v,c)=>{const f=headerField(v);if(!f)return;if(map[f]===undefined)map[f]=c;else if(f==='name'){const rank=name=>/naziv za pretragu/.test(norm(name))?4:/latinski|botanicki|botanical|latin/.test(norm(name))?3:/izvorni naziv/.test(norm(name))?1:2;if(rank(v)>rank(headers[map[f]]))map[f]=c;}else map[f]=[...new Set([].concat(map[f],c))];});return map;}
  function detectHeader(rows,index){
    let best={row:0,map:{},score:0,headers:[],dataStartRow:1,hasHeader:false};
    const limit=Math.min(rows.length,60);
    for(let start=0;start<limit;start++)for(let span=1;span<=3&&start+span<=limit;span++){
      const selected=rows.slice(start,start+span),columns=Math.max(0,...selected.map(r=>r?.length||0));
      if(span>1&&selected.some(row=>(row||[]).some(v=>typeof v==='number'||index&&index.names.has(norm(v)))))continue;
      const headers=Array.from({length:columns},(_,c)=>[...new Set(selected.map(row=>String(row?.[c]??'').trim()).filter(Boolean))].join(' ')),map=headerMap(headers);
      const score=Object.keys(map).length+(map.name!==undefined?5:0);
      if(score>best.score)best={row:start+span-1,map,score,headers,dataStartRow:start+span,hasHeader:map.name!==undefined};
    }
    return best;
  }
  function informationalHeader(value){return GENERATED_HEADERS.includes(norm(value))||/^(?:r b|r br|rb|redni broj|broj|id|sifra|oznaka|code|dionica|deonica|lokacija|grupa biljaka|kategorija|grupa|izvor|source|izvorni dokument|dokument|domaci naziv|narodni naziv|srpski naziv|hrvatski naziv|common name|cena|cijena|jedinicna cena|jedinicna cijena|nabavna cena|ukupno|iznos|total|price|rasadnik|dobavljac|supplier)(?:\s+(?:eur|euro|evra|evro|pdv|sa pdv|bez pdv))?$/.test(norm(value));}
  function looksBotanical(value){
    // A Latin binomial or hybrid (optionally followed by a cultivar).
    // Quotes may enclose the whole name or the cultivar. Do not mistake
    // prose, spreadsheet headings, invoices or tender references for plants.
    const raw=String(value??'').trim().replace(/^[\s"'“”‘’«»]+|[\s"'“”‘’«»]+$/g,'').trim();
    if(!raw||raw.length>160||/[\n\r:;\/\\!?€₹$]|(?:^|\s)[A-Z]\d+-\d+/u.test(raw))return false;
    if(!/^[A-Z][a-z]{2,}\s+(?:(?:×|x)\s+)?[a-z][a-z-]{2,}(?:\s+['"‘’“”]?[A-Za-z0-9][A-Za-z0-9'-]*['"‘’“”]?){0,6}$/.test(raw))return false;
    const parts=norm(raw).split(' ');
    const stop=new Set(['biljka','biljke','sadni','materijal','naziv','pretraga','ponuda','stavke','stavki','prilog','prilozi','povrsina','povrsinu','cena','cene','rasadnik','rasadnici','tender','tendera','kompletnih','izvorni','izvorna','dokument','dokumenta','ukupno','grad','adresa','napomena','podaci','dodatni','radovi','travnjak','stablo','sadnice','sadrzaj','kolona','parametri','izdvojen','izdvojeno','kombinovanih','tabele','tabela','reference','strana','stranica','serija','proizvod','sifra','pozicija']);
    return parts.length>=2&&!stop.has(parts[0])&&!stop.has(parts[1]);
  }
  function isBotanicalSource(index,input){
    const original=String(input?.name??'').trim(),cv=String(input?.cultivar??'').trim();
    if(!original)return false;
    // Exact catalog aliases also allow valid horticultural genus + cultivar
    // names that do not contain an explicit species epithet.
    const found=findPlant(index,original,cv);
    if(found.id)return Boolean(index.plants.get(found.id)?.latinName);
    const full=cv&&!norm(original).endsWith(' '+norm(cv))?original+' '+cv:original;
    return looksBotanical(full);
  }
  function isAdministrativeColumn(rows,column){
    const values=rows.map(row=>String(row?.[column]??'').trim()).filter(Boolean);
    if(!values.length)return false;
    return values.every(value=>
      /^(?:arhiva|archive|istorijska ponuda|istorijski cenovnik|aktuelno|active|current|izvor|source|ponuda)$/i.test(value)||
      /^(?:record|offer|plant|entry|row)-[\w-]+$/i.test(value)||
      /^\d{1,3}(?:[ .]\d{3})*(?:[.,]\d+)?\s*(?:EUR|€|RSD|din)\s*$/i.test(value)||
      /^\d+(?:[.,]\d+)?$/.test(value)
    );
  }
  function looksLikePlantRequirement(value){
    const n=norm(value);
    if(!n||n.length>2000)return false;
    // Standalone quantities, price figures, codes and categories are not specs.
    return /\b(?:standard|std|multistem|multi stem|visina|height|hohe|hoehe|obim|opseg|girth|circumference|sirina krosnje|crown width|precnik|pot|saksija|container|kontejner|wrb|busen|rootball|presadjivanja|presadjivano|transplant)\b/.test(n) ||
      /\b(?:h|c)\s+\d+(?:\s+\d+)?\b/.test(n);
  }
  function detectSheet(rows,index,options={}){
    const guess=detectHeader(rows,index),headers=guess.headers||[],tokens=headers.map(norm);
    const auxiliary=tokens.some(v=>/^(?:parametar|parameter|naziv parametra)$/.test(v))&&tokens.some(v=>/^(?:vrednost|vrijednost|value)$/.test(v));
    if(auxiliary)return {headerRow:guess.row,map:{},headers,dataStartRow:guess.dataStartRow,hasHeader:true,enabled:false,reason:'Pomoćni list sa pojedinačnim parametrima sačuvan je bez dupliranja biljaka.'};
    let hasHeader=guess.hasHeader,headerRow=guess.row,dataStartRow=guess.dataStartRow,map={...guess.map},effectiveHeaders=headers;
    // An explicit specification/quantity header is valid even if the Latin
    // identity is embedded in a description instead of a dedicated name column.
    if(!hasHeader&&index&&map.quantity!==undefined&&map.preferences!==undefined&&
      rows.slice(dataStartRow).some(row=>row.some(v=>typeof v==='string'&&sourceNames(index,v).some(hit=>!hit.identity.startsWith('unknown:'))))){
      hasHeader=true;
    }
    if(!hasHeader){
      const counts=new Map();for(let r=0;r<Math.min(rows.length,240);r++)(rows[r]||[]).forEach((v,c)=>{if(!index||!String(v??'').trim())return;const found=findPlant(index,v);if(found.id||looksBotanical(v)){const hit=counts.get(c)||{count:0,first:r};hit.count+=found.id?3:1;counts.set(c,hit);}});
      const ranked=[...counts.entries()].sort((a,b)=>b[1].count-a[1].count);
      if(!ranked.length||ranked[1]&&ranked[1][1].count===ranked[0][1].count)return {headerRow:-1,map:{},headers:[],dataStartRow:0,hasHeader:false,enabled:false,reason:'List ne sadrži jednoznačno prepoznat spisak biljaka.'};
      map={name:ranked[0][0]};hasHeader=false;headerRow=-1;dataStartRow=0;effectiveHeaders=Array(rows.reduce((width,row)=>Math.max(width,row?.length||0),0)).fill('');
    }
    // Unnamed columns are NOT planting parameters: they may be IDs, costs,
    // dionice, project categories, exchange rates or source calculations.
    const used=new Set(Object.values(map).flat()),sample=rows.slice(dataStartRow,dataStartRow+240),descriptions=[];
    for(let c=0;c<effectiveHeaders.length;c++){
      if(used.has(c)||informationalHeader(effectiveHeaders[c])||isAdministrativeColumn(sample,c))continue;
      const header=norm(effectiveHeaders[c]);
      const explicitDescription=/\b(?:opis|specifikacija|zahtevi|zahtjevi|uslovi|uvjeti|parametri|napomena|dimenzije|karakteristike)\b/.test(header);
      if(explicitDescription||sample.some(row=>looksLikePlantRequirement(row?.[c])))descriptions.push(c);
    }
    if(descriptions.length)map.preferences=[...new Set([].concat(map.preferences??[],descriptions))];
    return {headerRow,map,headers:effectiveHeaders,dataStartRow,hasHeader,enabled:true};
  }
  function form(v){const n=norm(v);if(/^(standard|std|stam|hochstanden|hochstaemmig|hochstaff|jednostablo|visoko stablo|hs)$/.test(n))return 'standard';if(/^(multistem|multi stem|multi|vise stablo|visestablo|visestablasica|zbun|bush|grm|ms)$/.test(n))return 'multistem';return n;}
  function rootType(v){const n=norm(v);if(/^(wrb|wire root ball|busen u zicanoj korpi(?: wrb| drkl| mdb| w b)?|wire basket|dr bal|db|zicana korpa)$/.test(n))return 'wrb';if(/^(cont|container|kontejner(?: cont| cg| clt)?|container grown|kontejnerska|kontejnerirano|kontejnerirana|kontejnirano|co|c)$/.test(n))return 'container';if(/^(br|bare root|goli koren(?: br)?|bare roots)$/.test(n))return 'bare-root';if(/^(rb|root ball|busen(?: rb| kl| zolla)?|balled|bal|b)$/.test(n))return 'root-ball';if(/^(woodbox|wood box|drvena kutija|drvena kutija woodbox)$/.test(n))return 'woodbox';if(/^(airpot|air pot|air pot kontejner airpot)$/.test(n))return 'airpot';return n;}
  function unit(v){const n=norm(v);return /^(kom|komad|komada|pc|pcs|piece|pieces|st|stuck|stuk)$/.test(n)?'kom':n;}
  function taxGroup(v){const n=norm(v);if(/bez pdv|excluding vat|excl vat|pdv 0|non imponibile/.test(n))return 'net';if(/sa pdv|ukljucen pdv|including vat|incl vat/.test(n))return 'gross';return 'unspecified';}
  function parseMeasure(value,field){
    let s=String(value??'').trim().toLowerCase().replace(/[–—−]/g,'-').replace(/,/g,'.');
    if(!s)return null;
    s=s.replace(/^\s*(?:h|height|visina|obim|girth|circ|clt|pot|c)\s*(?=\d)/,'').replace(/\s*(?:hs|std)\s*$/,'');
    const m=s.match(/^\s*(>=|≥|<=|≤|>|<|min\.?|max\.?)?\s*(\d+(?:\.\d+)?)\s*(?:[-/]\s*(\d+(?:\.\d+)?))?\s*(mm|cm|m|l|lt|ltr|lit|litara|litre|litres)?\s*(\+)?\s*$/);
    if(!m)return {valid:false,raw:s};
    const capacity=field==='potSize',u=m[4]|| (capacity?'l':'cm');
    if(capacity&&!/^l/.test(u)||!capacity&&/^l/.test(u))return {valid:false,raw:s};
    const scale=u==='m'?100:u==='mm'?.1:1;
    const lo=Number(m[2])*scale,hi=Number(m[3]||m[2])*scale;
    if(lo>hi)return {valid:false,raw:s};
    let op=m[1]|| (m[5]?'>=':'range');if(op==='min'||op==='min.'||op==='≥')op='>=';if(op==='max'||op==='max.'||op==='≤')op='<=';
    return {valid:true,lo,hi,op};
  }
  function measureMatches(request,offered,field){
    const a=parseMeasure(request,field),b=parseMeasure(offered,field);
    if(!a?.valid||!b?.valid)return norm(request)===norm(offered)&&!!norm(offered);
    // Every size allowed by the offered range must satisfy the requested range.
    // An offer such as 300+ does not confirm an upper limit of 350.
    const bounds=m=>m.op==='>='||m.op==='>'?{lo:m.lo,hi:Infinity,loOpen:m.op==='>',hiOpen:true}:m.op==='<='||m.op==='<'?{lo:-Infinity,hi:m.lo,loOpen:true,hiOpen:m.op==='<'}:{lo:m.lo,hi:m.hi,loOpen:false,hiOpen:false};
    const wanted=bounds(a),available=bounds(b),eps=.000001;
    const same=(x,y)=>x===y||Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<=eps;
    const lower=same(available.lo,wanted.lo)?!wanted.loOpen||available.loOpen:available.lo>wanted.lo;
    const upper=same(available.hi,wanted.hi)?!wanted.hiOpen||available.hiOpen:available.hi<wanted.hi;
    return lower&&upper;
  }
  function makeIndex(catalog){
    const plants=new Map(),names=new Map(),byPlant=new Map(),nurseries=new Map(catalog.nurseries.map(n=>[n.id,n]));
    for(const p of catalog.plants){plants.set(p.id,p);for(const name of [p.latinName,...(p.synonyms||[])]){const key=norm(name);if(!key)continue;if(!names.has(key))names.set(key,new Set());names.get(key).add(p.id);}}
    for(const o of catalog.offers){if(['needs_review','superseded'].includes(o.recordStatus))continue;if(!byPlant.has(o.plantId))byPlant.set(o.plantId,[]);byPlant.get(o.plantId).push(o);}
    return {plants,names,byPlant,nurseries};
  }
  function findPlant(index,value,cultivar=''){
    const full=norm(value),cv=norm(cultivar),complete=cv&&!full.endsWith(' '+cv)?norm(String(value??'')+' '+cultivar):full;const match=index.names.get(complete);
    if(match?.size===1)return {id:[...match][0],remainder:''};
    if(match?.size>1)return {error:'Naziv označava više biljaka u indeksu.'};
    if(cultivar)return {error:'Vrsta i kultivar nisu pronađeni u indeksu.'};
    // A size suffix is considered only after an exact complete botanical name.
    const prefixes=[...index.names.keys()].filter(n=>complete.startsWith(n+' ')).sort((a,b)=>b.length-a.length);
    for(const prefix of prefixes){const remainder=complete.slice(prefix.length+1);if(!/^(?:\d|h\s+\d|visina\b|obim\b|girth\b|height\b|c\s*\d|clt\b|pot\b|multistem\b|std\b|standard\b|wrb\b|container\b)/.test(remainder))continue;const ids=index.names.get(prefix);if(ids.size===1){const raw=String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/×/g,' x ');const tokens=[...raw.matchAll(/[\p{L}\p{N}]+/gu)],end=tokens[prefix.split(' ').length-1];return {id:[...ids][0],remainder:end?raw.slice(end.index+end[0].length).replace(/^[\s'"’‘]+/,''):remainder};}}
    return {error:'Tačna vrsta ili kultivar nisu pronađeni u indeksu.'};
  }
  const sourceNameMatchers=new WeakMap();
  function sourceMatcher(index){
    if(sourceNameMatchers.has(index))return sourceNameMatchers.get(index);
    const byFirst=new Map();
    for(const key of index.names.keys()){
      const words=key.split(' ');
      if(words.length<2)continue;
      if(!byFirst.has(words[0]))byFirst.set(words[0],[]);
      byFirst.get(words[0]).push({key,words});
    }
    for(const list of byFirst.values())list.sort((a,b)=>b.words.length-a.words.length);
    sourceNameMatchers.set(index,byFirst);return byFirst;
  }
  function sourceNames(index,value,explicit=false){
    const raw=String(value??'').trim();if(!raw)return [];
    const exact=findPlant(index,raw);
    if(exact.id)return [{name:raw,identity:exact.id,tail:exact.remainder||''}];
    // A complete unknown binomial/cultivar is review-only, never a known parent species.
    const genus=norm(raw).split(' ')[0];
    const knownGenus=sourceMatcher(index).has(genus);
    const standalone=knownGenus&&!headerField(raw)&&!informationalHeader(raw)&&looksBotanical(raw)&&(!/^(?:ovaj|ova|ovo|sve|svi|dva|tri|jedan|jedna|zadrzi|primer|napomena|izvor|spisak|lista|tabela|proveriti|ukupno|za|bez|sa|na|u|the|this|all|please|total|note)\b/i.test(raw));
    const unknownShape=/^[\s"'“”‘’]*[A-Z][a-z]{2,}\s+(?:[×x]\s+)?[a-z][a-z-]{2,}(?:\s+['"‘’“”]?[A-Z][A-Za-z0-9'-]*['"‘’“”]?){0,4}[\s"'“”‘’]*$/u;
    if(explicit&&standalone&&(unknownShape.test(raw)||/^[\s"'“”‘’]*[A-Z][a-z]{2,}\s+[a-z][a-z-]{2,}\s+['‘’][^'‘’]+['‘’]\s*$/.test(raw)))return [{name:raw,identity:'unknown:'+norm(raw),tail:''}];
    const tokens=[...raw.matchAll(/[\p{L}\p{N}]+|×/gu)].map(m=>({word:norm(m[0]),start:m.index,end:m.index+m[0].length}));
    const byFirst=sourceMatcher(index),hits=[];
    for(let i=0;i<tokens.length;i++){
      const match=(byFirst.get(tokens[i].word)||[]).find(({words})=>words.every((word,j)=>tokens[i+j]?.word===word));
      if(!match)continue;
      const end=tokens[i+match.words.length-1].end;
      const ids=index.names.get(match.key);
      // Do not fall back to a species when an explicit but unindexed cultivar follows.
      const suffix=raw.slice(end).match(/^\s*['‘’"]([^'‘’"]+)['‘’"]/);
      const following=raw.slice(end).match(/^\s+([A-Z][\p{L}-]+(?:\s+[A-Z][\p{L}-]+)?)/u);
      const nextStartsTaxon=following&&(byFirst.get(norm(following[1].split(/\s+/)[0]))||[]).length;
      const cultivar= suffix?.[1] || (following&&!nextStartsTaxon&&!/^(?:Standard|Multistem|Visina|Obim|Height|Girth|Container|Kontejner|Saksija|Busen|WRB|RB|Pot|Tip|Cena|Količina|Quantity|Isporuka)\b/i.test(following[1])?following[1]:'');
      if(cultivar){
        const name=raw.slice(tokens[i].start,end)+(suffix?" '"+cultivar+"'":' '+cultivar);
        hits.push({name,identity:'unknown:'+norm(name),start:tokens[i].start,end:end+(suffix||following)[0].length});
      }else if(ids?.size===1)hits.push({name:raw.slice(tokens[i].start,end),identity:[...ids][0],start:tokens[i].start,end});
      i+=match.words.length-1;
      while(tokens[i+1]&&hits.at(-1)?.end>tokens[i+1].start)i++;
    }
    if(hits.length)return hits.map((hit,i)=>({...hit,tail:raw.slice(hit.end,hits[i+1]?.start??raw.length).trim()}));
    // Unknown taxa in a standalone name cell are accepted for review only.
    if(standalone&&unknownShape.test(raw))
      return [{name:raw,identity:'unknown:'+norm(raw),tail:''}];
    return [];
  }
  function sourceRequests(index,row,map={},headers=[]){
    const base=requestFromRow(row,map,headers),nameColumns=new Set([].concat(map.name??[])),hits=[];
    // Explicit name/cultivar pairs are tested as a unit before the free-text pass.
    if(String(base.name??'').trim()&&String(base.cultivar??'').trim()){
      const full=norm(base.name).endsWith(' '+norm(base.cultivar))?String(base.name):String(base.name)+' '+base.cultivar;
      const found=findPlant(index,full);
      if(found.id||sourceNames(index,full,true).some(hit=>hit.identity.startsWith('unknown:')))hits.push({name:full,identity:found.id||'unknown:'+norm(full),tail:'',column:[...nameColumns][0]});
    }
    for(let column=0;column<row.length;column++){
      if(hits.some(h=>h.column===column)&&nameColumns.has(column))continue;
      const value=row[column];
      if(typeof value!=='string')continue;
      const explicit=nameColumns.has(column)||headerField(headers[column])==='name';
      // Administrative text cannot introduce heuristic unknown names; exact Latin names still count everywhere.
      const found=sourceNames(index,value,explicit).filter(hit=>!hit.identity.startsWith('unknown:')||explicit||
        !informationalHeader(headers[column])&&(looksLikePlantRequirement(row.filter((_,c)=>c!==column).join(' '))||hit.start!==undefined));
      for(const hit of found)hits.push({...hit,column});
    }
    const unique=new Map();
    for(const hit of hits){
      if(!unique.has(hit.identity))unique.set(hit.identity,hit);
      else if(hit.tail&&!unique.get(hit.identity).tail)unique.get(hit.identity).tail=hit.tail;
    }
    // A row with multiple different plants cannot lend its shared measurements to every plant.
    return [...unique.values()].map(hit=>{
      const one=unique.size===1;
      const request=one?{...base}:{};
      delete request.cultivar;request.name=hit.name;
      if(one&&nameColumns.has(hit.column)&&findPlant(index,hit.name).id&&findPlant(index,hit.name).remainder)
        request.name=hit.name;
      if(hit.tail)request.preferences=[request.preferences,hit.tail].filter(Boolean).join('; ');
      if(one&&!Object.keys(map).length){
        request.preferences=[request.preferences,...row.filter((v,i)=>i!==hit.column&&looksLikePlantRequirement(v))].filter(Boolean).join('; ');
      }
      if(!one)request._validationError='Više biljaka u istom redu: zajednički parametri i količina nisu automatski pripisani pojedinačnoj biljci.';
      return {request,identity:hit.identity,column:hit.column};
    }).filter(entry=>isBotanicalSource(index,entry.request)&&(!entry.identity.startsWith('unknown:')||sourceMatcher(index).has(norm(entry.request.name).split(' ')[0])));
  }
  function parsePreferences(value){
    let s=String(value??'').trim().replace(/[–—−]/g,'-');const fields={},conflicts=[];
    const take=(key,re,transform=x=>x)=>{s=s.replace(re,(whole,v)=>{const next=transform(v||whole);if(fields[key]&&!sameRequirement(key,fields[key],next))conflicts.push(key);else fields[key]=next;return ' ';});};
    const amount='((?:>=|<=|≥|≤|>|<|min\\.?|max\\.?)?\\s*\\d+(?:[.,]\\d+)?\\s*(?:[-/]\\s*\\d+(?:[.,]\\d+)?)?\\s*(?:litara|litres|litre|ltr|lt|cm|mm|m|l)?\\s*\\+?)';
    // More specific labels must be consumed before generic height/pot labels.
    take('height',new RegExp('(?:visina do krošnje|visina do krosnje|visina čistog debla|visina cistog debla|clear stem height)\\s*[:=]?\\s*'+amount,'gi'));
    take('potDiameter',new RegExp('(?:prečnik saksije|precnik saksije|promjer posude|pot diameter)\\s*[:=]?\\s*'+amount,'gi'));
    take('stemDiameter',new RegExp('(?:prečnik sadnice|precnik sadnice|prečnik debla|precnik debla|stem diameter)\\s*[:=]?\\s*'+amount,'gi'));
    take('rootBall',new RegExp('(?:veličina busena|velicina busena|busen|root ball|rootball)\\s*[:=]?\\s*'+amount,'gi'));
    take('height',new RegExp('(?:\\bheight|\\bvisin[ae](?:\\s+(?:sadnice|biljke|stabla))?|\\bh)\\s*[:=]?\\s*'+amount,'gi'));
    take('circumference',new RegExp('(?:\\b(?:obim|opseg)(?:\\s+(?:sadnice|stabla|debla))?|\\bgirth|\\bcircumference)\\s*[:=]?\\s*'+amount,'gi'));
    take('crownWidth',new RegExp('(?:sirina krosnje|širina krošnje|crown width)\\s*[:=]?\\s*'+amount,'gi'));
    take('potSize',new RegExp('(?:\\bpot|\\bsaksija|\\bclt|\\bc(?=\\s*\\d))\\s*[:=]?\\s*'+amount,'gi'));
    take('seedlingType',/\b(multistem|multi[- ]stem|standard|std)\b/gi);
    take('rootType',/\b(wrb|container|kontejner|kontejnerirano|kontejnerirana|kontejnirano|kontejnerski|bare root|goli koren|woodbox|rb)\b/gi,v=>/kontejnerirano|kontejnerirana|kontejnirano|kontejnerski/i.test(v)?'container':v);
    take('transplantCount',/\b(\d+)\s*(?:[x×]\s*v|[x×]\s*presa[đd]ivano|puta presađivana|puta presadjivana)\b/gi);
    const rest=s.replace(/[;,|:.()\s]+/g,' ').trim();
    return {fields,rest,conflicts};
  }
  function requestFromRow(row,map,headers=[]){
    const request={};
    for(const [key] of FIELDS){
      const columns=[].concat(map[key]??[]).filter(col=>Number.isInteger(col)&&col>=0),values=[];
      for(const col of columns){
      let value=row[col]??'';
      if(!String(value).trim())continue;
      if(MEASURES.includes(key)&&parseMeasure(value,key)?.valid&&!/(?:mm|cm|m|l|lt|ltr|lit|litara|litre|litres)\s*\+?$/i.test(String(value).trim())){
        const units=[...new Set((norm(headers[col]).match(/\b(?:mm|cm|m|l|lt|ltr|lit|litara|litre|litres)\b/g)||[]).map(u=>u.startsWith('l')?'l':u))];
        if(units.length===1)value=String(value).trim()+' '+units[0];
        else if(units.length>1)request._validationError='Jedinica mere u zaglavlju nije jednoznačna: '+headers[col];
      }
      values.push(value);
      }
      if(key==='preferences'||key==='sourceDescription'){if(values.length)request[key]=[...new Set(values.map(String))].join('; ');}
      else if(values.length){request[key]=values[0];if(values.some(v=>!sameRequirement(key,v,values[0])))request._validationError='Različiti zahtevi u kolonama: '+FIELDS.find(f=>f[0]===key)[1];}
    }
    return request;
  }
  const MEASURES=['circumference','height','crownWidth','potSize','rootBall','stemDiameter','potDiameter'];
  function euroPrice(offer){
    if(typeof offer.price!=='number'||!Number.isFinite(offer.price)||offer.price<0||offer.currency!=='EUR'||offer.currencyStatus==='unresolved'||offer.priceConversion?.status==='unresolved')return null;
    const source=offer.sourceCurrency||'',conversion=offer.priceConversion;
    if(!source&&!conversion)return offer.price;
    if(source==='EUR'&&!conversion)return offer.sourceAmount===undefined||offer.sourceAmount===offer.price?offer.price:null;
    if(!source||source==='EUR'||conversion?.status!=='converted'||conversion.fromCurrency!==source||conversion.toCurrency!=='EUR'||typeof offer.sourceAmount!=='number'||!Number.isFinite(offer.sourceAmount)||offer.sourceAmount<0||conversion.originalAmount!==offer.sourceAmount||typeof conversion.rate!=='number'||!Number.isFinite(conversion.rate)||conversion.rate<=0||!/^\d{4}-\d{2}-\d{2}$/.test(conversion.rateDate||''))return null;
    const expected=Math.round((offer.sourceAmount/conversion.rate+Number.EPSILON)*100)/100;
    return Math.abs(offer.price-expected)<1e-9?offer.price:null;
  }
  function sameRequirement(key,a,b){if(MEASURES.includes(key))return measureMatches(a,b,key)&&measureMatches(b,a,key);if(key==='rootType')return rootType(a)===rootType(b);if(key==='seedlingType')return form(a)===form(b);if(key==='unit')return unit(a)===unit(b);if(key==='transplantCount')return transplantNumber(a)===transplantNumber(b);return norm(a)===norm(b);}
  function transplantNumber(v){const match=String(v??'').trim().match(/^(\d+)(?:\s*[x×]\s*v?)?$/i);return match?Number(match[1]):null;}
  function offeredValue(o,key){if(o[key]!==null&&o[key]!==undefined&&o[key]!=='')return o[key];const values=(o.additionalParameters||[]).filter(p=>headerField(p.label)===key).map(p=>p.value);return values.length&&values.every(v=>sameRequirement(key,v,values[0]))?values[0]:'';}
  function variantKey(o){const measureKey=k=>{const value=offeredValue(o,k),m=parseMeasure(value,k);return m?.valid?[m.op,Number(m.lo.toFixed(6)),Number(m.hi.toFixed(6))].join(':'):norm(value);};return [o.plantId,o.nurseryId,...MEASURES.map(measureKey),form(o.seedlingType),rootType(o.rootType),String(o.transplantCount??''),unit(o.unit),taxGroup(o.taxStatus)].join('|');}
  function dateValue(o){return /^\d{4}-\d{2}-\d{2}/.test(o.sourceDate||'')?o.sourceDate.slice(0,10):'';}
  function newestVariants(offers){const stamp=o=>o.priceRefresh?.status==='verified'&&/^\d{4}-\d{2}-\d{2}/.test(o.priceRefresh.changedAt||'')?o.priceRefresh.changedAt.slice(0,10):dateValue(o);const groups=new Map();for(const o of offers){const key=variantKey(o);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(o);}return [...groups.values()].flatMap(rows=>{const dates=rows.map(stamp).filter(Boolean).sort();return dates.length?rows.filter(o=>stamp(o)===dates.at(-1)):rows;});}
  function parameters(o){const labels={seedlingType:'Tip',circumference:'Obim',height:'Visina',crownWidth:'Širina krošnje',potSize:'Saksija',rootBall:'Busen',stemDiameter:'Prečnik sadnice',potDiameter:'Prečnik saksije',rootType:'Isporuka',transplantCount:'Presađivanja'};return Object.entries(labels).map(([k,l])=>[l,offeredValue(o,k)]).filter(([,v])=>v!==''&&v!==null&&v!==undefined).map(([l,v])=>`${l}: ${v}`).join('; ');}
  function unavailable(o){return o.available===false||/^(?:nema na stanju|nije dostupno|out of stock|sold out|unavailable|not available)\b/i.test(String(o.availability||''));}
  function descriptionRequirements(value,requested){
    let text=String(value??'').trim();const name=norm(requested.name),cultivar=norm(requested.cultivar),complete=cultivar&&!name.endsWith(' '+cultivar)?name+' '+cultivar:name;
    if(norm(text)===complete)return '';
    if(complete&&norm(text).startsWith(complete+' ')){
      const tokens=[...text.matchAll(/[\p{L}\p{N}]+/gu)],last=tokens[complete.split(' ').length-1];
      if(last){text=text.slice(last.index+last[0].length).replace(/^[\s'"’‘]+/,'');const parts=text.split(';');
        // The vernacular name after a botanical name is a label, not a stock requirement.
        if(/^[-–—]/.test(parts[0])&&!/\d|klas|kvalitet|kvalitet|krošnj|krosnj|praviln|kompaktn|starost|školovan|skolovan/i.test(parts[0]))text=parts.slice(1).join(';');
      }
    }
    return text.replace(/^\s*[;,:]\s*/,'');
  }

  // Tender-specific mode keeps incomplete archival evidence visible without
  // presenting historical prices or unverified qualitative requirements as current.
  function editDistance(a,b){
    let previous=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){
      const row=[i];
      for(let j=1;j<=b.length;j++)row.push(Math.min(row[j-1]+1,previous[j]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1)));
      previous=row;
    }
    return previous[b.length];
  }
  function nameSuggestions(index,value){
    const name=norm(value),genus=name.split(' ')[0];
    const candidates=[...index.plants.values()]
      .filter(p=>norm(p.latinName).split(' ')[0]===genus)
      .map(p=>({name:p.latinName,distance:editDistance(norm(p.latinName),name)}))
      .sort((a,b)=>a.distance-b.distance||a.name.localeCompare(b.name));
    const close=candidates.filter(p=>p.distance<=2).slice(0,3).map(p=>p.name);
    if(close.length)return close;
    const related=candidates.filter(p=>norm(p.name).startsWith(name+' ')).slice(0,3).map(p=>p.name);
    if(related.length)return related;
    return /^[a-z]+ (?:spp?|ssp)\.?$/i.test(name)?candidates.slice(0,3).map(p=>p.name):[];
  }
  function tenderEvidence(index,plantId,reason,sourceSuppliers=[]){
    const evidence=(index.byPlant.get(plantId)||[]).filter(o=>
      (o.parameterRole||o.sourceEvidence?.parameterRole)!=='requested' &&
      !['needs_review','superseded'].includes(o.recordStatus));
    if(!evidence.length)return {status:'unmatched',recognized:true,archival:false,
      message:'Biljka je prepoznata u indeksu. '+reason+' Nema povezanih cenovničkih zapisa.',
      suppliers:[],values:['','','','','','Biljka je prepoznata, nema povezanih ponuda. '+reason]};
    const ordered=evidence.slice().sort((a,b)=>(euroPrice(a)??Infinity)-(euroPrice(b)??Infinity)||a.id.localeCompare(b.id));
    const rows=ordered.map(o=>{
      const nursery=index.nurseries.get(o.nurseryId)?.name||o.nurseryId;
      const price=euroPrice(o);
      const label=price===null?'cena nije potvrđena u EUR':price.toLocaleString('sr-Latn-RS',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
      const date=dateValue(o);
      return nursery+' — '+(o.priceKind==='historical'?'ARHIVA':'IZVOR')+' '+label+
        '; '+(parameters(o)||'bez potvrđenih parametara')+
        '; '+(o.source||o.id)+(date?'; datum '+date:'');
    });
    const suppliers=ordered.map(o=>({
      name:(index.nurseries.get(o.nurseryId)?.name||o.nurseryId)+
        (o.priceKind==='historical'?' · ARHIVA':' · ZA PROVERU'),
      price:euroPrice(o),offerIds:[o.id],nurseryId:o.nurseryId,
      historical:o.priceKind==='historical'
    }));
    const archived=ordered.some(o=>o.priceKind==='historical');
    const message='Biljka je prepoznata; izvori postoje. '+reason+
      ' Iznosi iz arhive i nepotpuno provereni izvori nisu predstavljeni kao sigurna aktuelna nabavna cena.';
    return {status:'unmatched',recognized:true,archival:archived,requiresReview:true,plantId,
      suppliers,message,price:null,
      values:[rows.join('\n'),'','','Nezavisno proveriti vrstu, parametre, kvalitet i današnju dostupnost.','',message]};
  }
  function recommendTender(index,input,options={}){
    const requested={...input},found=findPlant(index,requested.name,requested.cultivar);
    if(!String(requested.name??'').trim())
      return {status:'empty',message:'',values:Array(EXTRA_HEADERS.length).fill('')};
    if(found.error){
      const candidates=nameSuggestions(index,requested.name);
      const evidence=[];
      for(const candidate of candidates){
        const match=index.names.get(norm(candidate));
        if(!match||match.size!==1)continue;
        for(const offer of index.byPlant.get([...match][0])||[]){
          if(offer.priceKind!=='historical')continue;
          const nursery=index.nurseries.get(offer.nurseryId)?.name||offer.nurseryId;
          const amount=euroPrice(offer);
          evidence.push('MOGUĆI ARHIVSKI TRAG · '+candidate+' · '+nursery+' · '+
            (amount===null?'cena nije potvrđena u EUR':amount.toLocaleString('sr-Latn-RS',{minimumFractionDigits:2,maximumFractionDigits:2})+' €')+
            '; '+(offer.source||offer.id)+'; '+(parameters(offer)||'bez mera'));
        }
      }
      const message=found.error+(candidates.length?
        ' Predlozi za stručnu proveru (bez automatske zamene): '+candidates.join('; ')+'.':'')+
        (evidence.length?' Arhivske cene mogućih kandidata nisu ponude za traženu vrstu.':'');
      const evidenceText=evidence.slice(0,70).join('\n')+
        (evidence.length>70?'\nPrikazano je prvih 70 mogućih arhivskih tragova; ostatak proveriti u registru.':'');
      return {status:'unmatched',recognized:false,candidates,possibleArchive:evidence.length>0,
        message,suppliers:[],price:null,
        values:[evidenceText,'','','Identitet biljke nije potvrđen; ne koristiti cene mogućih kandidata za obračun.','',message]};
    }
    if(requested._validationError)
      return tenderEvidence(index,found.id,'Ulazni zahtev za proveru: '+requested._validationError);
    const qualitative=String(requested.preferences||'').trim();
    const sourceDescription=String(requested.sourceDescription||'').trim();
    const structured=MEASURES.some(k=>String(requested[k]??'').trim())||
      ['rootType','seedlingType','transplantCount'].some(k=>String(requested[k]??'').trim());
    const alternatives=/\b(?:balirano|balled)\s+ili\s+(?:kontejnirano|kontejnerirano|kontejner)\b/i.test(String(requested.rootType||''));
    const groupPriority=/\b(?:grupni|group)\b[\s\S]{0,150}\b(?:traže|traze|obavezno|require|mora)\b/i.test(qualitative);
    const safe={...requested,preferences:'',sourceDescription:structured?'':sourceDescription};
    if(alternatives)safe.rootType='Kontejner';
    const checked=recommend(index,safe,{...options,tenderMode:false});
    const matched=(index.byPlant.get(found.id)||[]).find(o=>o.id===checked.offerId);
    const historical=matched?.priceKind==='historical'||!matched?.priceRefresh?.checkedAt;
    const review=[];
    if(qualitative)review.push('Kvalitativni uslovi nisu potvrđeni u ponudi: '+qualitative);
    if(alternatives)review.push('Isporuka navodi dve mogućnosti (balirano ili kontejnirano). '+
      (groupPriority?'Grupni uslovi zahtevaju strožu proveru izvora.':'Izbor mora da potvrdi projektant.'));
    if(checked.status==='matched'&&!historical&&!review.length)
      return {...checked,status:'matched',qualitativeVerified:true};
    const reason=[checked.status==='matched'?
      'Dimenzije su uporedive, ali aktuelna cena, lager ili kvalitet nisu potvrđeni.':
      checked.message,...review].filter(Boolean).join(' ');
    const evidence=tenderEvidence(index,found.id,reason,checked.suppliers||[]);
    return {...evidence,recognized:true,requiresReview:review.length>0,
      alternatives,baseStatus:checked.status};
  }
  function recommend(index,input,options={}){
    if(options.tenderMode)return recommendTender(index,input,options);
    const requested={...input},found=findPlant(index,requested.name,requested.cultivar);
    const fail=(message,suppliers=[])=>({status:'unmatched',recognized:!!found.id,message,suppliers,values:[supplierText(suppliers),'','','','',message]});
    if(!String(requested.name??'').trim())return {status:'empty',message:'',values:Array(EXTRA_HEADERS.length).fill('')};
    if(requested._validationError)return fail(requested._validationError);
    if(found.error){
      const requestedName=norm(requested.name),related=[...index.plants.values()]
        .filter(plant=>norm(plant.latinName).startsWith(requestedName+' '))
        .map(plant=>plant.latinName).slice(0,5);
      return fail(found.error+(related.length?' U indeksu postoje povezani kultivari: '+related.join('; ')+'. Oni nisu isto što i tražena osnovna vrsta.':''));
    }
    const pref=parsePreferences([found.remainder,requested.preferences,descriptionRequirements(requested.sourceDescription,requested)].filter(Boolean).join('; '));
    if(pref.rest)return fail('Ponuda ne potvrđuje opisni zahtev: '+pref.rest);
    if(pref.conflicts.length)return fail('Različiti zahtevi za polja: '+pref.conflicts.join(', '));
    for(const [key,value] of Object.entries(pref.fields)){if(requested[key]!==undefined&&String(requested[key]).trim()&&!sameRequirement(key,requested[key],value))return fail('Različiti zahtevi za polje: '+FIELDS.find(f=>f[0]===key)?.[1]);requested[key]=value;}
    const currency='EUR';
    const requestedQuantity=Number(String(requested.quantity??'').replace(',','.'));
    if(String(requested.quantity??'').trim()&&(!Number.isFinite(requestedQuantity)||requestedQuantity<=0))return fail('Količina zahteva nije ispravan pozitivan broj.');
    const now=options.today||new Date().toISOString().slice(0,10);
    let offers=newestVariants((index.byPlant.get(found.id)||[]).filter(o=>(o.parameterRole||o.sourceEvidence?.parameterRole)!=='requested'));
    offers=offers.filter(o=>!unavailable(o)&&o.priceRefresh?.status!=='pending'&&!(o.validUntil&&o.validUntil<now));
    offers=offers.filter(o=>{
      for(const field of MEASURES)if(String(requested[field]??'').trim()&&!measureMatches(requested[field],offeredValue(o,field),field))return false;
      if(String(requested.seedlingType??'').trim()&&form(requested.seedlingType)!==form(offeredValue(o,'seedlingType')||o.seedlingTypeCode||''))return false;
      if(String(requested.rootType??'').trim()&&rootType(requested.rootType)!==rootType(o.rootType))return false;
      if(String(requested.transplantCount??'').trim()&&(transplantNumber(requested.transplantCount)===null||transplantNumber(requested.transplantCount)!==transplantNumber(o.transplantCount)))return false;
      if(String(requested.unit??'').trim()&&unit(requested.unit)!==unit(o.unit))return false;
      if(requested.quantity!==undefined&&String(requested.quantity).trim()&&Number.isFinite(o.availableQuantity)&&o.availableQuantity<Number(String(requested.quantity).replace(',','.')))return false;
      return true;
    });
    if(!offers.length)return historicalReference(index,found.id,'Nijedna ponuda ne potvrđuje sve tražene parametre.');
    offers=newestVariants(offers);
    const suppliers=supplierList(index,offers);
    offers=offers.filter(o=>euroPrice(o)!==null&&o.price>0);
    if(!offers.length)return historicalReference(index,found.id,'Za ove parametre nema potvrđene cene u valuti '+currency+'.',suppliers);
    const tax=new Set(offers.map(o=>taxGroup(o.taxStatus))),units=new Set(offers.map(o=>unit(o.unit)));
    // A price per pack, a gross amount and an unknown tax basis cannot silently win over a net unit price.
    if(tax.size>1||units.size>1)return historicalReference(index,found.id,'Cene nisu uporedive: '+[tax.size>1?'različita ili nepoznata osnova cene':'',units.size>1?'različite jedinice mere':''].filter(Boolean).join('; ')+'.',suppliers);
    offers.sort((a,b)=>a.price-b.price||(index.nurseries.get(a.nurseryId)?.name||'').localeCompare(index.nurseries.get(b.nurseryId)?.name||'')||a.id.localeCompare(b.id));
    const best=offers[0],supplier=index.nurseries.get(best.nurseryId)?.name||best.nurseryId;
    const ties=offers.filter(o=>o.price===best.price),names=[...new Set(ties.map(o=>index.nurseries.get(o.nurseryId)?.name||o.nurseryId))];
    let message='Najniža evidentirana cena za tražene parametre.';
    if(best.priceKind==='historical'||!best.priceRefresh?.checkedAt)message+=' Cena iz arhive; aktuelan lager nije potvrđen.';
    
    if(names.length>1)message+=' Ista cena: '+names.join(', ')+'.';
    if(best.unit)message+=' Jedinica cene: '+best.unit+'.';
    return {status:'matched',recognized:true,offerId:best.id,plantId:found.id,price:best.price,currency,supplier,suppliers,message,
      values:[supplierText(suppliers),supplier,best.price,parameters(best),dateValue(best),message]};
  }
  // Historical catalogue records are evidence of a source price, not evidence
  // that the supplier can currently deliver a plant meeting all requirements.
  // Never put a mismatching price in the "lowest price" output column.
  function historicalReference(index,plantId,reason,existingSuppliers=[]){
    const archived=(index.byPlant.get(plantId)||[])
      .filter(o=>o.priceKind==='historical' && o.priceRefresh?.status!=='pending')
      .sort((a,b)=>(euroPrice(a)??Infinity)-(euroPrice(b)??Infinity)||a.id.localeCompare(b.id));
    if(!archived.length)return {status:'unmatched',recognized:true,message:reason,suppliers:existingSuppliers,
      values:[supplierText(existingSuppliers),'','','','',reason]};
    const detailed=archived.map(o=>{
      const name=index.nurseries.get(o.nurseryId)?.name||o.nurseryId;
      const price=euroPrice(o),amount=price!==null?price.toLocaleString('sr-Latn-RS',{minimumFractionDigits:2,maximumFractionDigits:2})+' €':'bez potvrđene EUR cene';
      return name+' — ARHIVA '+amount+'; '+(parameters(o)||'parametri nisu navedeni')+
        '; izvor: '+(o.source||o.id)+(dateValue(o)?'; datum: '+dateValue(o):'');
    });
    const message='Biljka je prepoznata u indeksu. Postoje arhivski zapisi, ali nema potvrđene uporedive ponude za tražene parametre. '+reason+
      ' Arhivske cene nisu preporučene nabavne cene; proveriti specifikaciju i dostupnost.';
    const suppliers=archived.map(o=>({
      name:(index.nurseries.get(o.nurseryId)?.name||o.nurseryId)+' · ARHIVA',
      price:euroPrice(o),nurseryId:o.nurseryId,offerIds:[o.id],
      historical:true
    }));
    return {status:'unmatched',recognized:true,archival:true,plantId,price:null,suppliers,message,
      values:[detailed.join('\n'),'','', 'Arhivski parametri nisu potvrda tražene specifikacije.','',message]};
  }
  // Brza preporuka: botanical identity + form + ONE relevant measure.
  // Preserve all other submitted parameters as evidence, never use them as
  // unrequested substitutions or artificial rejection criteria.
  function recommendQuickExact(index,input,options={}){
    const requested={...input},found=findPlant(index,requested.name,requested.cultivar);
    const fail=(message,recognized=false,plantId=null,status='unmatched')=>({
      status,recognized,plantId,price:null,suppliers:[],message,
      values:['','','','','',message]
    });
    if(!String(requested.name??'').trim())
      return {status:'empty',message:'',values:Array(EXTRA_HEADERS.length).fill('')};
    if(found.error)return fail(found.error,false,null,'not_found');
    if(requested._validationError)return fail(requested._validationError,true,found.id,'needs_data');
    const parsed=parsePreferences([found.remainder,requested.preferences,
      descriptionRequirements(requested.sourceDescription,requested)].filter(Boolean).join('; '));
    if(parsed.conflicts.some(key=>['seedlingType','height','circumference'].includes(key)))
      return fail('Proveri protivrečne podatke o tipu ili dimenzijama sadnice.',true,found.id,'needs_data');
    const select=key=>{
      const a=String(requested[key]??'').trim(),b=String(parsed.fields[key]??'').trim();
      if(a&&b&&!sameRequirement(key,a,b))
        return {error:'Sukobljeni zahtevi za '+(FIELDS.find(field=>field[0]===key)?.[1]||key)+'.'};
      return {value:a||b};
    };
    const formValue=select('seedlingType');
    if(formValue.error)return fail(formValue.error,true,found.id,'needs_data');
    const plantForm=form(formValue.value);
    if(plantForm!=='standard'&&plantForm!=='multistem')
      return fail('Tip sadnice nije naveden: Standard ili Multistem. Biljka je prepoznata, ali nema dovoljno podataka za podudaranje.',true,found.id,'needs_data');
    const measureField=plantForm==='standard'?'height':'circumference';
    const measure=select(measureField);
    if(measure.error)return fail(measure.error,true,found.id,'needs_data');
    if(!String(measure.value??'').trim()||!parseMeasure(measure.value,measureField)?.valid)
      return fail('Za '+(plantForm==='standard'?'Standard nedostaje visina':'Multistem nedostaje obim')+
        ' sadnice, naveden kao tačna mera ili opseg.',true,found.id,'needs_data');
    const allowed=newestVariants((index.byPlant.get(found.id)||[]).filter(offer=>{
      const offeredForm=form(offeredValue(offer,'seedlingType')||offer.seedlingTypeCode||'');
      return offeredForm===plantForm&&sameRequirement(measureField,measure.value,offeredValue(offer,measureField));
    }));
    if(!allowed.length)return {...historicalReference(index,found.id,
      'Nema sadnice sa potpuno istim tipom i '+(plantForm==='standard'?'visinom':'obimom')+'.'),
      plantId:found.id,requestedForm:plantForm,primaryMeasure:measureField,primaryValue:measure.value};
    const narrowed={...index,byPlant:new Map(index.byPlant)};
    narrowed.byPlant.set(found.id,allowed);
    const precise={name:requested.name,cultivar:requested.cultivar,seedlingType:plantForm};
    precise[measureField]=measure.value;
    if(String(requested.quantity??'').trim())precise.quantity=requested.quantity;
    const result=recommend(narrowed,precise,options);
    return {...result,plantId:found.id,requestedForm:plantForm,primaryMeasure:measureField,primaryValue:measure.value};
  }
  // Public index: remove unusable placeholder offers, but retain original
  // source data in the repository for audit. A species with a valid variant stays.
  function validPurchasePrice(offer){
    const price=euroPrice(offer);
    return Number.isFinite(price)&&price>0&&price!==1;
  }
  function cleanCatalog(catalog){
    const offers=catalog.offers.filter(o=>validPurchasePrice(o)&&!['needs_review','superseded'].includes(o.recordStatus));
    const ids=new Set(offers.map(o=>o.plantId));
    return {...catalog,offers,plants:catalog.plants.filter(p=>ids.has(p.id))};
  }
  function requestedParameters(index,input){
    const found=findPlant(index,input.name,input.cultivar);
    const parsed=parsePreferences([found.remainder,input.preferences,
      descriptionRequirements(input.sourceDescription,input)].filter(Boolean).join('; '));
    const values={...parsed.fields};
    for(const [key] of FIELDS)if(String(input[key]??'').trim())values[key]=input[key];
    const fields=FIELDS.filter(([key])=>!['name','cultivar','preferences','sourceDescription','quantity','unit','currency'].includes(key));
    return fields.filter(([key])=>String(values[key]??'').trim()).map(([key,label])=>({key,label,value:String(values[key])}));
  }
  function recognizeSourceRow(index,input){
    const original=String(input?.name??'').trim(),cv=String(input?.cultivar??'').trim();
    const found=findPlant(index,original,cv);
    const latinName=found.id?index.plants.get(found.id).latinName:
      (cv&&!norm(original).endsWith(' '+norm(cv))?[original,cv].filter(Boolean).join(' '):original);
    return {valid:isBotanicalSource(index,input),latinName,plantId:found.id||null,parameters:requestedParameters(index,input)};
  }
  function recommendQuick(index,input,options={}){
    const recognizedSource=recognizeSourceRow(index,input);
    const found=findPlant(index,input.name,input.cultivar);
    const parameters=recognizedSource.parameters.filter(p=>{
      const val=String(p.value??'').trim();
      if(!val||/^(?:nije|nepoznat|unknown|unspecified|n a|none|-)$/i.test(norm(val))||/^(?:nije navedeno|nepoznat)/i.test(val))return false;
      if(MEASURES.includes(p.key))return Boolean(parseMeasure(val,p.key)?.valid);
      return true;
    });
    if(!found.id)return {...recommendQuickExact(index,input,options),canonicalName:recognizedSource.latinName,requestedParameters:parameters};
    const original=index.byPlant.get(found.id)||[];
    const today=options.today||new Date().toISOString().slice(0,10);
    const nameOnly=parameters.length===0;
    const available=newestVariants(original.filter(o=>(o.parameterRole||o.sourceEvidence?.parameterRole)!=='requested'))
      .filter(o=>validPurchasePrice(o)&&!unavailable(o)&&o.priceRefresh?.status!=='pending'&&(nameOnly||!(o.validUntil&&o.validUntil<today)));
    const narrowed={...index,byPlant:new Map(index.byPlant)};
    narrowed.byPlant.set(found.id,available);
    const exact=recommendQuickExact(narrowed,input,options);
    const compare=(offer,param)=>{
      const supplied=offeredValue(offer,param.key)||(param.key==='seedlingType'?offer.seedlingTypeCode:'');
      if(!String(supplied??'').trim()||/^(?:nije navedeno|nepoznat|unknown|unspecified)/i.test(String(supplied)))return 'unknown';
      return sameRequirement(param.key,param.value,supplied)?'match':'different';
    };
    // Equal weight per distinct, genuinely supplied botanical parameter.
    // Never substitute another taxon or pool parameters from different variants.
    const ranked=available.map(offer=>{
      const evaluated=parameters.map(p=>({...p,result:compare(offer,p)}));
      return {offer,evaluated,count:evaluated.filter(p=>p.result==='match').length};
    }).filter(r=>nameOnly||r.count>=1).sort((a,b)=>b.count-a.count||euroPrice(a.offer)-euroPrice(b.offer)||
      String(a.offer.nurseryId).localeCompare(String(b.offer.nurseryId))||String(a.offer.id).localeCompare(String(b.offer.id)));
    const exactIds=new Set(exact.status==='matched'?exact.suppliers.flatMap(s=>s.offerIds||[]):[]);
    const candidates=ranked.map(({offer,evaluated,count})=>({
      nurseryId:offer.nurseryId,name:index.nurseries.get(offer.nurseryId)?.name||offer.nurseryId,
      price:euroPrice(offer),currency:'EUR',offerIds:[offer.id],
      matchCount:count,requestedCount:parameters.length,
      matchedParameters:evaluated.filter(p=>p.result==='match').map(p=>p.label),
      differentParameters:evaluated.filter(p=>p.result==='different').map(p=>p.label),
      unknownParameters:evaluated.filter(p=>p.result==='unknown').map(p=>p.label),
      offeredParameters:parametersForCandidate(offer),sourceDate:dateValue(offer),
      historical:offer.priceKind==='historical'||!offer.priceRefresh?.checkedAt||Boolean(offer.validUntil&&offer.validUntil<today),
      nameOnly,candidate:nameOnly||!(exactIds.has(offer.id)&&count===parameters.length)
    }));
    const result={...exact,plantId:found.id,requestedParameters:parameters,
      canonicalName:recognizedSource.latinName,suppliers:candidates};
    const top=candidates[0],confirmed=candidates.find(s=>!s.candidate);
    const summary=candidates.map(s=>s.name+' — '+s.price.toFixed(2)+' € · '+s.matchCount+'/'+s.requestedCount+' parametara'+(s.historical?' · proveriti aktuelnost':'')+'; '+s.offeredParameters).join('\n');
    if(confirmed){
      const best=ranked.find(r=>r.offer.id===confirmed.offerIds[0]).offer;
      result.status='matched';result.price=confirmed.price;result.supplier=confirmed.name;result.offerId=best.id;
      result.message='Potpuno podudaranje. Ponude su rangirane prema broju poklopljenih parametara, zatim prema ceni.';
      result.values=[summary,confirmed.name,confirmed.price,parametersForCandidate(best),dateValue(best),result.message];
    }else{
      result.status=nameOnly||exact.status==='needs_data'?'needs_data':'unmatched';
      result.price=null;result.supplier=null;result.offerId=null;
      result.message=nameOnly?(top?'Naziv se tačno poklapa. Izvor ne sadrži prepoznate parametre; prikazane su ponude iste biljke, po rastućoj ceni, za ručnu proveru.':'Naziv se poklapa, ali nema validne rasadničke ponude.'):(top?'Potencijalni kandidati: rangirano po broju poklopljenih parametara, zatim po ceni.':'Nema ponude sa najmanje jednim poklopljenim parametrom. '+exact.message);
      if(input._validationError)result.message=input._validationError+' '+result.message;
      result.values=[summary,'','','','',result.message];
    }
    return result;
  }
  function parametersForCandidate(offer){
    const main=parameters(offer).split('; ').filter(Boolean),seen=new Set(main.map(v=>norm(v.split(':')[0])));
    for(const p of offer.additionalParameters||[]){
      const key=headerField(p.label),label=norm(p.label),value=String(p.value??'').trim();
      if(!label||!value||seen.has(label)||key&&key!=='preferences'||/^(?:visina cistog debla|visina do krosnje|clear stem height|stem height)$/.test(label)||/\b(?:pdv|vat|cena|price|valuta|currency|sifra|id|izvor|source)\b/.test(label)||/^(?:nije navedeno|nepoznat|n\/a|-)/i.test(value))continue;
      main.push(p.label+': '+value);seen.add(label);
    }
    return main.join('; ');
  }
  // PDF rows: reconstruct table cells when headings are readable, otherwise
  // use the original text lines and a known botanical name as a record anchor.
  // PDF rows contain original text cells in reading order, with blank
  // cells retained where a table header defined physical column positions.
  function pdfPlantRows(lines,index){
    const input=Array.isArray(lines)?lines:[];
    const result=[['Latinski naziv','Parametri sadnice','Kultivar','Izvorni opis stavke','Količina']];
    let current=null, columns=null;
    const boundary=/\s+(?:(?:[;,]\s*)?(?:standard|std|multistem|multi[- ]stem|visin[ae]|height|obim|opseg|girth|circumference|saksija|pot|clt|container|kontejner\w*|kontejnirano|wrb|busen|širina\s+krošnje|sirina\s+krosnje|prečnik|precnik|presađivanja|presadjivanja|h\s*[:=]?\s*\d|c\s*[:=]?\s*\d)\b|\d+(?:[.,]\d+)?\s*[-/]\s*\d)/i;
    const botanical=/^[\p{Lu}][\p{Ll}]{2,}\s+(?:[×x]\s+)?[\p{Ll}][\p{Ll}-]{2,}/u;
    const notName=/^(?:standard|std|multistem|multi stem|visin[ae]|height|obim|opseg|girth|circumference|saksija|pot|clt|container|kontejner\w*|wrb|busen|sirina|prečnik|precnik|presadjivanja|presađivanja|tip|naziv|latinski|botanicki|botanički|broj|nacin|način|izvorni|ukupno|napomena|sadni materijal|ponuda|strana|stranica|radovi|drvece|drveće|zbunje|žbunje)\b/i;
    const clean=v=>String(v??'').trim();
    const explicitMeasure=spec=>spec.replace(/\b(standard|std|multistem|multi[- ]stem)\s*[:;,]?\s*(\d+(?:[.,]\d+)?(?:\s*[-–—/]\s*\d+(?:[.,]\d+)?)?\s*(?:cm|mm|m))\b/gi,(_,type,measure)=>type+'; '+(/^(?:standard|std)$/i.test(type)?'visina ':'obim ')+measure);
    const labels={seedlingType:'tip sadnice',height:'visina',circumference:'obim',crownWidth:'širina krošnje',potSize:'saksija',rootType:'način isporuke',transplantCount:'broj presađivanja',rootBall:'busen',stemDiameter:'prečnik sadnice',potDiameter:'prečnik saksije'};
    function header(row){
      const keys=row.map(headerField);
      return keys.includes('name')&&keys.some(k=>k&&k!=='name')?row.slice():null;
    }
    function append(name,spec,cv='',raw='',quantity=''){
      const full=cv&&!norm(name).endsWith(' '+norm(cv))?name+' '+cv:name;
      if(!sourceNames(index,full,true).length){current=null;return;}
      const found=findPlant(index,name,cv);
      current=[found.id?index.plants.get(found.id).latinName:name,explicitMeasure(spec),found.id?'':cv,raw,quantity];
      result.push(current);
    }
    function addContinuation(text,raw){
      if(!current||!text)return;
      current[1]=[current[1],explicitMeasure(text)].filter(Boolean).join('; ');
      current[3]=[current[3],raw].filter(Boolean).join('\n');
    }
    for(const entry of input){
      const row=(Array.isArray(entry)?entry:[entry]).map(clean);
      const text=row.filter(Boolean).join(' ');
      if(!text)continue;
      const hdr=header(row);
      if(hdr){columns=hdr;continue;}
      if(columns&&row.length===columns.length){
        const map=headerMap(columns);
        const req=requestFromRow(row,map,columns);
        const spec=[];
        for(const [key,label] of Object.entries(labels)){
          const val=clean(req[key]);if(!val)continue;
          spec.push(key==='seedlingType'||key==='rootType'?val:key==='transplantCount'?val+'x presađivano':label+' '+val);
        }
        for(const key of ['preferences','sourceDescription'])if(req[key])spec.push(clean(req[key]));
        if(req.name&&!notName.test(req.name)){
          append(clean(req.name),spec.join('; '),clean(req.cultivar),text,req.quantity??'');
          continue;
        }
        if(!req.name&&spec.length){addContinuation(spec.join('; '),text);continue;}
      }
      const first=text.replace(/^\s*(?:\d+(?:[.\-/]\d+)*[.)]?\s+)?/,'').trim().replace(/^[“”"'‘’«»]+|[“”"'‘’«»]+$/g,'').trim();
      const hit=botanical.test(first)&&!notName.test(first);
      if(hit){
        const split=first.search(boundary);
        let name=split<0?first:first.slice(0,split).replace(/[;,:\s]+$/,'');
        let spec=split<0?'':first.slice(split).trim();
        // Use a dedicated name cell only when it contains a botanical name
        // and not a combined description. Keep an unknown cultivar intact.
        const cell=row.find(v=>botanical.test(v)&&!notName.test(v)&&v.search(boundary)<0);
        if(cell&&row.filter(Boolean).length>1&&norm(cell)===norm(name)){
          name=cell;
          spec=row.slice(row.indexOf(cell)+1).filter(Boolean).join(' ');
        }
        append(name,spec,'',text);
      }else if(current&&looksLikePlantRequirement(text)){
        addContinuation(text,text);
      }
    }
    return result;
  }
  function supplierList(index,offers){const groups=new Map();for(const offer of offers){if(!groups.has(offer.nurseryId))groups.set(offer.nurseryId,[]);groups.get(offer.nurseryId).push(offer);}return [...groups].map(([nurseryId,rows])=>{const prices=rows.filter(o=>euroPrice(o)!==null&&o.price>0).map(o=>o.price);return {nurseryId,name:index.nurseries.get(nurseryId)?.name||nurseryId,price:prices.length?Math.min(...prices):null,currency:'EUR',offerIds:rows.map(o=>o.id)};}).sort((a,b)=>(a.price??Infinity)-(b.price??Infinity)||a.name.localeCompare(b.name));}
  function supplierText(suppliers){return suppliers.map(s=>s.name+' — '+(s.price===null?'cena u EUR nije navedena':s.price.toLocaleString('sr-Latn-RS',{minimumFractionDigits:2,maximumFractionDigits:2})+' €')).join('\n');}
  return {FIELDS,EXTRA_HEADERS,norm,headerField,detectHeader,detectSheet,form,rootType,unit,taxGroup,parseMeasure,measureMatches,makeIndex,findPlant,parsePreferences,requestFromRow,newestVariants,parameters,recommend,recommendQuick,recommendTender,nameSuggestions,euroPrice,cleanCatalog,requestedParameters,recognizeSourceRow,isBotanicalSource,looksBotanical,sourceRequests,pdfPlantRows,validPurchasePrice};
});
