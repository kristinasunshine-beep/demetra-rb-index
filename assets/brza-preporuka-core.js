(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DemetraRecommendCore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const FIELDS=[
    ['name','Naziv biljke'],['cultivar','Kultivar / sorta'],['circumference','Obim sadnice'],['height','Visina sadnice'],
    ['crownWidth','Širina krošnje'],['potSize','Veličina saksije'],['rootType','Način isporuke'],['seedlingType','Tip sadnice'],
    ['transplantCount','Broj presađivanja'],['rootBall','Busen'],['quantity','Količina'],['unit','Jedinica mere'],
    ['preferences','Ostali zahtevi'],['currency','Valuta']
  ];
  const EXTRA_HEADERS=['Preporučeni rasadnik','Nabavna cena','Valuta cene','Ponuđeni parametri','Jedinica cene','PDV prema ponudi','Datum izvorne ponude','Provera izvora','Rezultat preporuke'];
  function norm(v){return String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'dj').replace(/[×]/g,' x ').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
  const ALIASES={
    name:['naziv','biljka','naziv biljke','sadni materijal','latinski naziv','latinski naziv biljke','botanicki naziv','botanical name','plant name','plant','species','name','latin name','vrsta','vrsta biljke','botanischer name','bezeichnung','product'],
    cultivar:['kultivar','sorta','cultivar','variety'],circumference:['obim','obim sadnice','obim stabla','obim debla','girth','circumference','stammumfang','st u'],
    height:['visina','visina sadnice','visina biljke','height','height cm','hoehe','hohe'],crownWidth:['sirina krosnje','precnik krosnje','crown width','crown spread'],
    potSize:['velicina saksije','saksija','zapremina saksije','pot','pot size','container size','litara','litres','clt'],
    rootType:['nacin isporuke','pakovanje','root type','root system','delivery','wurzel','rootball type'],seedlingType:['tip sadnice','forma','oblik','form','plant type','tip'],
    transplantCount:['broj presadjivanja','presadjivanja','transplants','transplant count'],rootBall:['busen','velicina busena','rootball','root ball'],
    quantity:['kolicina','qty','quantity','komada','broj komada','amount','anzahl'],unit:['jed','jm','j m','jedinica','jedinica mere','unit'],
    preferences:['preferencije','preference','preferences','zahtevi','specifikacija','opis','description','specification','detalji','napomena','napomene','remarks','zahtevane karakteristike','dimenzije','velicina','size','sizes'],
    currency:['valuta','currency']
  };
  function headerField(v){const n=norm(v).replace(/\b(?:cm|mm|m|lit|l|lt|ltr|litara|litre|litres|eur)\b/g,'').trim();for(const [key,list] of Object.entries(ALIASES))if(list.includes(n)||list.includes(norm(v)))return key;return '';}
  function detectHeader(rows){let best={row:0,map:{},score:0};for(let r=0;r<Math.min(rows.length,60);r++){const map={};(rows[r]||[]).forEach((v,c)=>{const f=headerField(v);if(f&&map[f]===undefined)map[f]=c;});const score=Object.keys(map).length+(map.name!==undefined?5:0);if(score>best.score)best={row:r,map,score};}return best;}
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
    const complete=norm(String(value??'')+(cultivar?' '+cultivar:''));const match=index.names.get(complete);
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
    const take=(key,re,transform=x=>x)=>{s=s.replace(re,(whole,v)=>{const next=transform(v||whole);if(fields[key]&&norm(fields[key])!==norm(next))conflicts.push(key);else fields[key]=next;return ' ';});};
    const amount='((?:>=|<=|≥|≤|>|<|min\\.?|max\\.?)?\\s*\\d+(?:[.,]\\d+)?\\s*(?:[-/]\\s*\\d+(?:[.,]\\d+)?)?\\s*(?:cm|mm|m|l|litara)?\\s*\\+?)';
    take('height',new RegExp('(?:\\bheight|\\bvisina|\\bh)\\s*[:=]?\\s*'+amount,'gi'));
    take('circumference',new RegExp('(?:\\bobim(?:\\s+(?:sadnice|stabla|debla))?|\\bgirth|\\bcircumference)\\s*[:=]?\\s*'+amount,'gi'));
    take('crownWidth',new RegExp('(?:sirina krosnje|širina krošnje|crown width)\\s*[:=]?\\s*'+amount,'gi'));
    take('potSize',new RegExp('(?:\\bpot|\\bsaksija|\\bclt|\\bc(?=\\s*\\d))\\s*[:=]?\\s*'+amount,'gi'));
    take('seedlingType',/\b(multistem|multi[- ]stem|standard|std)\b/gi);
    take('rootType',/\b(wrb|container|kontejner|bare root|goli koren|woodbox)\b/gi);
    take('transplantCount',/\b(\d+)\s*(?:x\s*v|puta presađivana|puta presadjivana)\b/gi);
    const rest=s.replace(/[;,|:.()\s]+/g,' ').trim();
    return {fields,rest,conflicts};
  }
  function requestFromRow(row,map,headers=[]){
    const request={};
    for(const [key] of FIELDS){
      const col=map[key];if(!Number.isInteger(col)||col<0)continue;
      let value=row[col]??'';
      if(MEASURES.includes(key)&&parseMeasure(value,key)?.valid&&!/(?:mm|cm|m|l|lt|ltr|lit|litara|litre|litres)\s*\+?$/i.test(String(value).trim())){
        const units=[...new Set((norm(headers[col]).match(/\b(?:mm|cm|m|l|lt|ltr|lit|litara|litre|litres)\b/g)||[]).map(u=>u.startsWith('l')?'l':u))];
        if(units.length===1)value=String(value).trim()+' '+units[0];
        else if(units.length>1)request._validationError='Jedinica mere u zaglavlju nije jednoznačna: '+headers[col];
      }
      request[key]=value;
    }
    return request;
  }
  const MEASURES=['circumference','height','crownWidth','potSize','rootBall'];
  function variantKey(o){const measureKey=k=>{const m=parseMeasure(o[k],k);return m?.valid?[m.op,Number(m.lo.toFixed(6)),Number(m.hi.toFixed(6))].join(':'):norm(o[k]);};return [o.plantId,o.nurseryId,...MEASURES.map(measureKey),form(o.seedlingType),rootType(o.rootType),String(o.transplantCount??''),unit(o.unit),taxGroup(o.taxStatus),o.currency].join('|');}
  function dateValue(o){return /^\d{4}-\d{2}-\d{2}/.test(o.sourceDate||'')?o.sourceDate.slice(0,10):'';}
  function newestVariants(offers){const stamp=o=>o.priceRefresh?.status==='verified'&&/^\d{4}-\d{2}-\d{2}/.test(o.priceRefresh.changedAt||'')?o.priceRefresh.changedAt.slice(0,10):dateValue(o);const groups=new Map();for(const o of offers){const key=variantKey(o);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(o);}return [...groups.values()].flatMap(rows=>{const dates=rows.map(stamp).filter(Boolean).sort();return dates.length?rows.filter(o=>stamp(o)===dates.at(-1)):rows;});}
  function parameters(o){const labels={seedlingType:'Tip',circumference:'Obim',height:'Visina',crownWidth:'Širina krošnje',potSize:'Saksija',rootBall:'Busen',rootType:'Isporuka',transplantCount:'Presađivanja'};return Object.entries(labels).filter(([k])=>o[k]!==''&&o[k]!==null&&o[k]!==undefined).map(([k,l])=>`${l}: ${o[k]}`).join('; ');}
  function unavailable(o){return o.available===false||/^(?:nema na stanju|nije dostupno|out of stock|sold out|unavailable|not available)\b/i.test(String(o.availability||''));}
  function recommend(index,input,options={}){
    const requested={...input},found=findPlant(index,requested.name,requested.cultivar);
    const fail=message=>({status:'unmatched',message,values:['','','','','','','','',message]});
    if(!String(requested.name??'').trim())return {status:'empty',message:'',values:Array(EXTRA_HEADERS.length).fill('')};
    if(requested._validationError)return fail(requested._validationError);
    if(found.error)return fail(found.error);
    const pref=parsePreferences([found.remainder,requested.preferences].filter(Boolean).join('; '));
    if(pref.rest||pref.conflicts.length)return fail('Zahtev nije jednoznačan: '+(pref.rest||pref.conflicts.join(', ')));
    for(const [key,value] of Object.entries(pref.fields)){if(requested[key]!==undefined&&String(requested[key]).trim()&&norm(requested[key])!==norm(value))return fail('Različiti zahtevi za polje: '+FIELDS.find(f=>f[0]===key)?.[1]);requested[key]=value;}
    const currency=String(requested.currency||options.currency||'EUR').trim().toUpperCase();
    if(!/^[A-Z]{3}$/.test(currency))return fail('Valuta zahteva nije prepoznata.');
    const requestedQuantity=Number(String(requested.quantity??'').replace(',','.'));
    if(String(requested.quantity??'').trim()&&(!Number.isFinite(requestedQuantity)||requestedQuantity<=0))return fail('Količina zahteva nije ispravan pozitivan broj.');
    const now=options.today||new Date().toISOString().slice(0,10);
    let offers=newestVariants((index.byPlant.get(found.id)||[]).filter(o=>(o.parameterRole||o.sourceEvidence?.parameterRole)!=='requested'));
    offers=offers.filter(o=>!unavailable(o)&&o.priceRefresh?.status!=='pending'&&!(o.validUntil&&o.validUntil<now));
    offers=offers.filter(o=>{
      for(const field of MEASURES)if(String(requested[field]??'').trim()&&!measureMatches(requested[field],o[field],field))return false;
      if(String(requested.seedlingType??'').trim()&&form(requested.seedlingType)!==form(o.seedlingType))return false;
      if(String(requested.rootType??'').trim()&&rootType(requested.rootType)!==rootType(o.rootType))return false;
      if(String(requested.transplantCount??'').trim()&&Number(requested.transplantCount)!==Number(o.transplantCount))return false;
      if(String(requested.unit??'').trim()&&unit(requested.unit)!==unit(o.unit))return false;
      if(requested.quantity!==undefined&&String(requested.quantity).trim()&&Number.isFinite(o.availableQuantity)&&o.availableQuantity<Number(String(requested.quantity).replace(',','.')))return false;
      return true;
    });
    if(!offers.length)return fail('Nema ponude koja potvrđuje sve tražene parametre.');
    offers=newestVariants(offers);
    offers=offers.filter(o=>Number.isFinite(o.price)&&o.price>0&&o.currency===currency);
    if(!offers.length)return fail('Za ove parametre nema potvrđene cene u valuti '+currency+'.');
    const tax=new Set(offers.map(o=>taxGroup(o.taxStatus))),units=new Set(offers.map(o=>unit(o.unit)));
    // A price per pack, a gross amount and an unknown tax basis cannot silently win over a net unit price.
    if(tax.size>1||units.size>1)return fail('Cene nisu uporedive: '+[tax.size>1?'različit ili nepoznat PDV':'',units.size>1?'različite jedinice mere':''].filter(Boolean).join('; ')+'.');
    offers.sort((a,b)=>a.price-b.price||(index.nurseries.get(a.nurseryId)?.name||'').localeCompare(index.nurseries.get(b.nurseryId)?.name||'')||a.id.localeCompare(b.id));
    const best=offers[0],supplier=index.nurseries.get(best.nurseryId)?.name||best.nurseryId;
    const ties=offers.filter(o=>o.price===best.price),names=[...new Set(ties.map(o=>index.nurseries.get(o.nurseryId)?.name||o.nurseryId))];
    let message='Najniža evidentirana cena za tražene parametre.';
    if(best.priceKind==='historical'||!best.priceRefresh?.checkedAt)message+=' Cena iz arhive; aktuelan lager nije potvrđen.';
    if(tax.has('unspecified'))message+=' PDV nije naveden u izvoru.';
    if(names.length>1)message+=' Ista cena: '+names.join(', ')+'.';
    const checked=best.priceRefresh?.checkedAt?.slice(0,10)||'';
    return {status:'matched',offerId:best.id,plantId:found.id,price:best.price,currency,supplier,message,
      values:[supplier,best.price,currency,parameters(best),best.unit||'',best.taxStatus||'',dateValue(best),checked,message]};
  }
  return {FIELDS,EXTRA_HEADERS,norm,headerField,detectHeader,form,rootType,unit,taxGroup,parseMeasure,measureMatches,makeIndex,findPlant,parsePreferences,requestFromRow,newestVariants,parameters,recommend};
});
