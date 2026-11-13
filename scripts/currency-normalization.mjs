import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const NBS_URL='https://webappcenter.nbs.rs/ExchangeRateWebApp/ExchangeRate/CurrentMiddleRate';
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
const currency=v=>String(v??'').trim().toUpperCase();
export const toEuros=(amount,rate)=>Math.round((amount/rate+Number.EPSILON)*100)/100;

export function validateExchangeRates(rates){
  if(rates?.schemaVersion!==1||rates.base!=='EUR'||rates.quote!=='RSD'||!finite(rates.rate)||!/^\d{4}-\d{2}-\d{2}$/.test(rates.rateDate||'')||!Number.isFinite(Date.parse(rates.rateDate))||new Date(rates.rateDate).toISOString().slice(0,10)!==rates.rateDate)throw new Error('Nedostaje ispravan zvanični kurs EUR/RSD.');
  const url=new URL(rates.sourceUrl);if(url.protocol!=='https:'||!['webappcenter.nbs.rs','www.nbs.rs','nbs.rs'].includes(url.hostname))throw new Error('Kurs mora imati zvaničan izvor NBS.');
  return rates;
}
export async function loadExchangeRates(repo){return validateExchangeRates(JSON.parse(await fs.readFile(path.join(repo,'data/exchange-rates.json'),'utf8')));}

export function getSourcePrice(offer){
  const converted=offer.priceConversion?.status==='converted';
  const amount=finite(offer.sourceAmount)?offer.sourceAmount:converted&&finite(offer.priceConversion.originalAmount)?offer.priceConversion.originalAmount:finite(offer.price)?offer.price:null;
  const code=currency(offer.sourceCurrency|| (converted?offer.priceConversion.fromCurrency:'') || offer.priceEvidence?.currency || offer.currency);
  return {amount,currency:code,evidence:offer.sourceCurrencyEvidence||offer.priceEvidence?.currencyEvidence||offer.currencyEvidence||null};
}

// Always convert the original amount. Re-running this function never divides an EUR result again.
export function normalizeOfferCurrency(offer,rates,options={}){
  const source=getSourcePrice(offer),amount=options.sourceAmount===undefined?source.amount:options.sourceAmount;
  const code=currency(options.sourceCurrency===undefined?source.currency:options.sourceCurrency);
  if(options.sourceEvidence)offer.sourceCurrencyEvidence=options.sourceEvidence;
  if(!finite(amount))return offer;
  offer.sourceAmount=amount;offer.sourceCurrency=code;
  if(code==='EUR'){
    offer.price=amount;offer.currency='EUR';delete offer.priceConversion;
    if(['converted','unresolved'].includes(offer.currencyStatus))offer.currencyStatus='stated';
    return offer;
  }
  if(code==='RSD'){
    validateExchangeRates(rates);
    const price=toEuros(amount,rates.rate);
    if(!finite(price))throw new Error('Preračunata cena mora biti pozitivna: '+offer.id);
    const old=offer.priceConversion;
    offer.price=price;offer.currency='EUR';offer.currencyStatus='converted';
    offer.priceConversion={status:'converted',fromCurrency:'RSD',toCurrency:'EUR',originalAmount:amount,rate:rates.rate,rateDate:rates.rateDate,sourceUrl:rates.sourceUrl,
      calculatedAt:old?.status==='converted'&&old.originalAmount===amount&&old.rate===rates.rate&&old.rateDate===rates.rateDate?old.calculatedAt:(options.now||new Date().toISOString())};
    return offer;
  }
  offer.price=null;offer.currency='';offer.currencyStatus='unresolved';
  offer.priceConversion={status:'unresolved',reason:code?'Izvorna valuta '+code+' nema potvrđen kurs za EUR.':'Izvorna valuta nije potvrđena.'};
  return offer;
}

export function normalizeDocument(document,rates,options={}){
  let changed=0,converted=0,native=0,unresolved=0;
  for(const offer of document.offers){const before=JSON.stringify(offer);normalizeOfferCurrency(offer,rates,options);if(JSON.stringify(offer)!==before)changed++;if(offer.priceConversion?.status==='converted')converted++;else if(finite(offer.price)&&offer.currency==='EUR')native++;else if(finite(offer.sourceAmount)&&offer.price===null)unresolved++;}
  if(changed)document.updatedAt=options.now||new Date().toISOString();
  return {changed,converted,native,unresolved};
}

export function checkNormalizedPrices(document,rates){
  validateExchangeRates(rates);let converted=0,priced=0;
  for(const offer of document.offers){
    if(offer.price===null)continue;
    if(!finite(offer.price)||offer.currency!=='EUR')throw new Error('Cena nije normalizovana u EUR: '+offer.id);
    priced++;
    if(offer.sourceCurrency==='RSD'){
      const proof=offer.priceConversion;
      if(proof?.status!=='converted'||proof.fromCurrency!=='RSD'||proof.toCurrency!=='EUR'||proof.originalAmount!==offer.sourceAmount||proof.rate!==rates.rate||proof.rateDate!==rates.rateDate||proof.sourceUrl!==rates.sourceUrl||offer.price!==toEuros(offer.sourceAmount,rates.rate))throw new Error('Neispravan dokaz konverzije RSD/EUR: '+offer.id);
      converted++;
    }else if(offer.sourceCurrency!=='EUR'||offer.sourceAmount!==offer.price)throw new Error('Nedostaje potvrđena izvorna cena/valuta: '+offer.id);
  }
  return {priced,converted};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),at=args.indexOf('--repo'),repo=path.resolve(at<0?path.join(path.dirname(fileURLToPath(import.meta.url)),'..'):args[at+1]);
  try{
    const rates=await loadExchangeRates(repo),file=path.join(repo,'data/kataloske-stavke.json'),doc=JSON.parse(await fs.readFile(file,'utf8'));
    if(args.includes('--apply')){const stats=normalizeDocument(doc,rates);if(stats.changed)await fs.writeFile(file,JSON.stringify(doc,null,2)+'\n');console.log(JSON.stringify(stats));}
    else console.log(JSON.stringify(checkNormalizedPrices(doc,rates)));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
