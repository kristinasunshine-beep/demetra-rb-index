(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DemetraRecommendCore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const FIELDS=[
    ['name','Naziv biljke'],['cultivar','Kultivar / sorta'],['circumference','Obim sadnice'],['height','Visina sadnice'],
    ['crownWidth','Širina krošnje'],['potSize','Veličina saksije'],['rootType','Način isporuke'],['seedlingType','Tip sadnice'],
    ['transplantCount','Broj presađivanja'],['rootBall','Busen'],['stemDiameter','Prečnik sadnice'],['potDiameter','Prečnik saksije'],['clearStemHeight','Visina do krošnje'],['quantity','Količina'],['unit','Jedinica mere'],
    ['preferences','Ostali zahtevi'],['sourceDescription','Izvorni opis stavke'],['currency','Valuta']
  ];
  const EXTRA_HEADERS=['Spisak rasadnika','Rasadnik sa najnižom cenom','Najniža nabavna cena (€)','Ponuđeni parametri','Datum izvorne ponude','Rezultat preporuke'];
  const GENERATED_HEADERS=EXTRA_HEADERS.concat(['Preporučeni rasadnik','Nabavna cena','Valuta cene','Jedinica cene','PDV prema ponudi','Provera izvora']).map(v=>norm(v));
  function norm(v){return String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'dj').replace(/[×]/g,' x ').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
  const ALIASES={
    name:['naziv','biljka','naziv biljke','naziv sadnice','naziv sadnog materijala','sadni materijal','latinski naziv','latinski naziv biljke','latinski naziv sadnice','botanicki naziv','botanicki naziv biljke','botanical name','plant name','plant','species','name','latin name','vrsta','vrsta biljke','botanischer name','bezeichnung','product'],
    cultivar:['kultivar','sorta','kultivar sorta','cultivar','variety'],circumference:['obim','obim sadnice','obim stabla','obim debla','opseg','opseg debla','opseg stabla','girth','circumference','stammumfang','st u'],
    height:['visina','visina sadnice','visina biljke','height','height cm','hoehe','hohe'],crownWidth:['sirina krosnje','precnik krosnje','crown width','crown spread'],
    potSize:['velicina saksije','saksija','zapremina saksije','pot','pot size','container size','litara','litres','clt'],
    rootType:['nacin isporuke','pakovanje','root type','root system','delivery','wurzel','rootball type'],seedlingType:['tip sadnice','forma','oblik','form','plant type','tip'],
    transplantCount:['broj presadjivanja','presadjivanja','transplants','transplant count'],rootBall:['busen','velicina busena','rootball','root ball'],
    stemDiameter:['precnik sadnice','promjer sadnice','stem diameter','precnik debla','promjer debla'],potDiameter:['precnik saksije','promjer saksije','promjer posude','pot diameter'],clearStemHeight:['visina do krosnje','visina cistog debla','clear stem height','stem height'],
    quantity:['kolicina','qty','quantity','komada','broj komada','amount','anzahl','kol'],unit:['jed','jm','j m','jed mj','jed mere','jed mjere','jedinica','jedinica mere','jedinica mjere','unit'],
    sourceDescription:['izvorni opis stavke','izvorni opis','original description'],
    preferences:['preferencije','preference','preferences','zahtevi','zahtjevi','specifikacija','opis','description','specification','detalji','napomena','napomene','remarks','zahtevane karakteristike','dimenzije','velicina','size','sizes','parametri','parametri sadnice','parametri biljke','opis sadnice','opis biljke','opis stavke','dodatni uslovi iz troskovnika','dodatni uvjeti iz troskovnika','karakteristike','kvalitet','kvaliteta'],
    currency:['valuta','currency']
  };
  function headerField(v){if(GENERATED_HEADERS.includes(norm(v)))return '';const n=norm(v).replace(/\b(?:cm|mm|m|lit|l|lt|ltr|litara|litre|litres|eur)\b/g,'').trim();for(const [key,list] of Object.entries(ALIASES))if(list.includes(n)||list.includes(norm(v)))return key;if(/^(?:latinski|botanicki|botanical|latin)\s+(?:naziv|name)\b/.test(n))return 'name';if(/\b(?:opis|specifikacija|specification|description|zahtevi|zahtjevi|uslovi|uvjeti|napomene?|preferencije|parametri|karakteristike)\b/.test(n))return 'preferences';return '';}
  function headerMap(headers){const map={};headers.forEach((v,c)=>{const f=headerField(v);if(!f)return;if(map[f]===undefined)map[f]=c;else if(f==='name'){if(/latinski|botanicki|botanical|latin/.test(norm(v))&&!/latinski|botanicki|botanical|latin/.test(norm(headers[map[f]])))map[f]=c;}else map[f]=[...new Set([].concat(map[f],c))];});return map;}
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
  function detectSheet(rows,index,options={}){
    const guess=detectHeader(rows,index),headers=guess.headers||[],tokens=headers.map(norm);
    const auxiliary=tokens.some(v=>/^(?:parametar|parameter|naziv parametra)$/.test(v))&&tokens.some(v=>/^(?:vrednost|vrijednost|value)$/.test(v));
    if(auxiliary)return {headerRow:guess.row,map:{},headers,dataStartRow:guess.dataStartRow,hasHeader:true,enabled:false,reason:'Pomoćni list sa pojedinačnim parametrima sačuvan je bez dupliranja biljaka.'};
    let hasHeader=guess.hasHeader,headerRow=guess.row,dataStartRow=guess.dataStartRow,map={...guess.map},effectiveHeaders=headers;
    if(!hasHeader){
      const counts=new Map();for(let r=0;r<Math.min(rows.length,240);r++)(rows[r]||[]).forEach((v,c)=>{if(!index||!String(v??'').trim())return;const found=findPlant(index,v);if(found.id){const hit=counts.get(c)||{count:0,first:r};hit.count++;counts.set(c,hit);}});
      const ranked=[...counts.entries()].sort((a,b)=>b[1].count-a[1].count);
      if(!ranked.length||ranked[1]&&ranked[1][1].count===ranked[0][1].count)return {headerRow:-1,map:{},headers:[],dataStartRow:0,hasHeader:false,enabled:false,reason:'List ne sadrži jednoznačno prepoznat spisak biljaka.'};
      map={name:ranked[0][0]};hasHeader=false;headerRow=-1;dataStartRow=0;effectiveHeaders=Array(rows.reduce((width,row)=>Math.max(width,row?.length||0),0)).fill('');
    }
    const used=new Set(Object.values(map).flat());
    const descriptions=[];for(let c=0;c<effectiveHeaders.length;c++)if(!used.has(c)&&!informationalHeader(effectiveHeaders[c])&&rows.slice(dataStartRow,dataStartRow+240).some(row=>String(row?.[c]??'').trim()))descriptions.push(c);
    if(descriptions.length)map.preferences=[...new Set([].concat(map.preferences??[],descriptions))];
    return {headerRow,map,headers:effectiveHeaders,dataStartRow,hasHeader,enabled:true};
  }
  function form(v){const n=norm(v);if(/^(standard|std|stam|hochstanden|hochstaemmig|hochstaff|jednostablo|visoko stablo|hs)$/.test(n))return 'standard';if(/^(multistem|multi stem|multi|vise stablo|visestablo|visestablasica|zbun|bush|grm|ms)$/.test(n))return 'multistem';return n;}
  function rootType(v){const n=norm(v);if(/^(wrb|wire root ball|busen u zicanoj korpi(?: wrb| drkl| mdb| w b)?|wire basket|dr bal|db|zicana korpa)$/.test(n))return 'wrb';if(/^(cont|container|kontejner(?: cont| cg| clt)?|container grown|kontejnerska|co|c)$/.test(n))return 'container';if(/^(br|bare root|goli koren(?: br)?|bare roots)$/.test(n))return 'bare-root';if(/^(rb|root ball|busen(?: rb| kl| zolla)?|balled|bal|b)$/.test(n))return 'root-ball';if(/^(woodbox|wood box|drvena kutija|drvena kutija woodbox)$/.test(n))return 'woodbox';if(/^(airpot|air pot|air pot kontejner airpot)$/.test(n))return 'airpot';return n;}
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
  function parsePreferences(value){
    let s=String(value??'').trim().replace(/[–—−]/g,'-');const fields={},conflicts=[];
    const take=(key,re,transform=x=>x)=>{s=s.replace(re,(whole,v)=>{const next=transform(v||whole);if(fields[key]&&!sameRequirement(key,fields[key],next))conflicts.push(key);else fields[key]=next;return ' ';});};
    const amount='((?:>=|<=|≥|≤|>|<|min\\.?|max\\.?)?\\s*\\d+(?:[.,]\\d+)?\\s*(?:[-/]\\s*\\d+(?:[.,]\\d+)?)?\\s*(?:litara|litres|litre|ltr|lt|cm|mm|m|l)?\\s*\\+?)';
    take('height',new RegExp('(?:\\bheight|\\bvisina(?:\\s+(?:sadnice|biljke|stabla))?|\\bh)\\s*[:=]?\\s*'+amount,'gi'));
    take('circumference',new RegExp('(?:\\b(?:obim|opseg)(?:\\s+(?:sadnice|stabla|debla))?|\\bgirth|\\bcircumference)\\s*[:=]?\\s*'+amount,'gi'));
    take('crownWidth',new RegExp('(?:sirina krosnje|širina krošnje|crown width)\\s*[:=]?\\s*'+amount,'gi'));
    take('potSize',new RegExp('(?:\\bpot|\\bsaksija|\\bclt|\\bc(?=\\s*\\d))\\s*[:=]?\\s*'+amount,'gi'));
    take('seedlingType',/\b(multistem|multi[- ]stem|standard|std)\b/gi);
    take('rootType',/\b(wrb|container|kontejner|kontejnirano|kontejnerski|bare root|goli koren|woodbox|rb)\b/gi,v=>/kontejnirano|kontejnerski/i.test(v)?'container':v);
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
  const MEASURES=['circumference','height','crownWidth','potSize','rootBall','stemDiameter','potDiameter','clearStemHeight'];
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
  function parameters(o){const labels={seedlingType:'Tip',circumference:'Obim',height:'Visina',crownWidth:'Širina krošnje',potSize:'Saksija',rootBall:'Busen',stemDiameter:'Prečnik sadnice',potDiameter:'Prečnik saksije',clearStemHeight:'Visina do krošnje',rootType:'Isporuka',transplantCount:'Presađivanja'};return Object.entries(labels).map(([k,l])=>[l,offeredValue(o,k)]).filter(([,v])=>v!==''&&v!==null&&v!==undefined).map(([l,v])=>`${l}: ${v}`).join('; ');}
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
  function recommend(index,input,options={}){
    const requested={...input},found=findPlant(index,requested.name,requested.cultivar);
    const fail=(message,suppliers=[])=>({status:'unmatched',message,suppliers,values:[supplierText(suppliers),'','','','',message]});
    if(!String(requested.name??'').trim())return {status:'empty',message:'',values:Array(EXTRA_HEADERS.length).fill('')};
    if(requested._validationError)return fail(requested._validationError);
    if(found.error)return fail(found.error);
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
      if(String(requested.seedlingType??'').trim()&&form(requested.seedlingType)!==form(o.seedlingType))return false;
      if(String(requested.rootType??'').trim()&&rootType(requested.rootType)!==rootType(o.rootType))return false;
      if(String(requested.transplantCount??'').trim()&&(transplantNumber(requested.transplantCount)===null||transplantNumber(requested.transplantCount)!==transplantNumber(o.transplantCount)))return false;
      if(String(requested.unit??'').trim()&&unit(requested.unit)!==unit(o.unit))return false;
      if(requested.quantity!==undefined&&String(requested.quantity).trim()&&Number.isFinite(o.availableQuantity)&&o.availableQuantity<Number(String(requested.quantity).replace(',','.')))return false;
      return true;
    });
    if(!offers.length)return fail('Nema ponude koja potvrđuje sve tražene parametre.');
    offers=newestVariants(offers);
    const suppliers=supplierList(index,offers);
    offers=offers.filter(o=>euroPrice(o)!==null&&o.price>0);
    if(!offers.length)return fail('Za ove parametre nema potvrđene cene u valuti '+currency+'.',suppliers);
    const tax=new Set(offers.map(o=>taxGroup(o.taxStatus))),units=new Set(offers.map(o=>unit(o.unit)));
    // A price per pack, a gross amount and an unknown tax basis cannot silently win over a net unit price.
    if(tax.size>1||units.size>1)return fail('Cene nisu uporedive: '+[tax.size>1?'različit ili nepoznat PDV':'',units.size>1?'različite jedinice mere':''].filter(Boolean).join('; ')+'.',suppliers);
    offers.sort((a,b)=>a.price-b.price||(index.nurseries.get(a.nurseryId)?.name||'').localeCompare(index.nurseries.get(b.nurseryId)?.name||'')||a.id.localeCompare(b.id));
    const best=offers[0],supplier=index.nurseries.get(best.nurseryId)?.name||best.nurseryId;
    const ties=offers.filter(o=>o.price===best.price),names=[...new Set(ties.map(o=>index.nurseries.get(o.nurseryId)?.name||o.nurseryId))];
    let message='Najniža evidentirana cena za tražene parametre.';
    if(best.priceKind==='historical'||!best.priceRefresh?.checkedAt)message+=' Cena iz arhive; aktuelan lager nije potvrđen.';
    if(tax.has('unspecified'))message+=' PDV nije naveden u izvoru.';
    if(names.length>1)message+=' Ista cena: '+names.join(', ')+'.';
    if(best.unit)message+=' Jedinica cene: '+best.unit+'.';if(best.taxStatus&&taxGroup(best.taxStatus)!=='unspecified')message+=' '+best.taxStatus+'.';
    return {status:'matched',offerId:best.id,plantId:found.id,price:best.price,currency,supplier,suppliers,message,
      values:[supplierText(suppliers),supplier,best.price,parameters(best),dateValue(best),message]};
  }
  function supplierList(index,offers){const groups=new Map();for(const offer of offers){if(!groups.has(offer.nurseryId))groups.set(offer.nurseryId,[]);groups.get(offer.nurseryId).push(offer);}return [...groups].map(([nurseryId,rows])=>{const prices=rows.filter(o=>euroPrice(o)!==null&&o.price>0).map(o=>o.price);return {nurseryId,name:index.nurseries.get(nurseryId)?.name||nurseryId,price:prices.length?Math.min(...prices):null,currency:'EUR',offerIds:rows.map(o=>o.id)};}).sort((a,b)=>(a.price??Infinity)-(b.price??Infinity)||a.name.localeCompare(b.name));}
  function supplierText(suppliers){return suppliers.map(s=>s.name+' — '+(s.price===null?'cena u EUR nije navedena':s.price.toLocaleString('sr-Latn-RS',{minimumFractionDigits:2,maximumFractionDigits:2})+' €')).join('\n');}
  return {FIELDS,EXTRA_HEADERS,norm,headerField,detectHeader,detectSheet,form,rootType,unit,taxGroup,parseMeasure,measureMatches,makeIndex,findPlant,parsePreferences,requestFromRow,newestVariants,parameters,recommend,euroPrice};
});
