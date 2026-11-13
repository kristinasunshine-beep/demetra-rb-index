import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NBS_URL,validateExchangeRates,normalizeDocument,checkNormalizedPrices} from './currency-normalization.mjs';

const plain=value=>String(value).replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n))).replace(/\s+/g,' ').trim();
export function parseNbsRates(html,now=new Date().toISOString()){
  const text=plain(html),date=text.match(/(?:ФОРМИРАНА НА ДАН|FORMIRANA NA DAN)\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i);
  if(!date)throw new Error('NBS datum kursne liste nije prepoznat.');
  const rateDate=[date[3],date[2].padStart(2,'0'),date[1].padStart(2,'0')].join('-');
  const age=(Date.parse(now)-Date.parse(rateDate))/86400000;
  if(!Number.isFinite(age)||age< -1||age>7)throw new Error('NBS kursna lista ima neočekivan datum.');
  const row=[...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>[...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>plain(c[1]))).find(c=>c[0]==='EUR');
  if(!row||row.length!==5||row[1]!=='978'||Number(row[3])!==1)throw new Error('NBS EUR red ili jedinica kursa nisu prepoznati.');
  if(!/^\d+(?:[.,]\d{1,6})?$/.test(row[4]))throw new Error('Neispravan format NBS EUR kursa.');
  const rate=Number(row[4].replace(',','.')),number=text.match(/(?:КУРСНА ЛИСТА БР\.?|KURSNA LISTA BR\.?)\s*(\d+)/i);
  return validateExchangeRates({schemaVersion:1,base:'EUR',quote:'RSD',rate,rateDate,source:'NBS official middle rate',sourceUrl:NBS_URL,listNumber:number?.[1]||'',fetchedAt:now});
}

export async function updateExchangeRates(repo,{fetchImpl=fetch,now=new Date().toISOString()}={}){
  const response=await fetchImpl(NBS_URL,{headers:{'User-Agent':'Demetra-RB-Index/1.0 (catalogue currency normalization)','Accept':'text/html'},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('NBS kurs nije preuzet: HTTP '+response.status);
  const rates=parseNbsRates(await response.text(),now),rateFile=path.join(repo,'data/exchange-rates.json'),offerFile=path.join(repo,'data/kataloske-stavke.json');
  const previous=JSON.parse(await fs.readFile(rateFile,'utf8'));
  if(rates.rateDate<previous.rateDate)throw new Error('NBS odgovor je stariji od poslednjeg sačuvanog kursa.');
  const rateChanged=rates.rate!==previous.rate||rates.rateDate!==previous.rateDate;
  const effective=rateChanged?rates:previous,document=JSON.parse(await fs.readFile(offerFile,'utf8'));
  const stats=normalizeDocument(document,effective,{now});checkNormalizedPrices(document,effective);
  // GitHub publishes both files in one commit. A failed fetch never changes either file.
  if(rateChanged)await fs.writeFile(rateFile,JSON.stringify(effective,null,2)+'\n');
  if(stats.changed)await fs.writeFile(offerFile,JSON.stringify(document,null,2)+'\n');
  return {...stats,rateChanged,rate:effective.rate,rateDate:effective.rateDate};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),at=args.indexOf('--repo'),repo=path.resolve(at<0?path.join(path.dirname(fileURLToPath(import.meta.url)),'..'):args[at+1]);
  try{console.log(JSON.stringify(await updateExchangeRates(repo),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
