import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {chromium} from 'playwright';

const port=8766;
const url='http://127.0.0.1:'+port+'/';
const server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1'],{stdio:'ignore'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const browserErrors=[];
let browser;
try {
  for(let t=0;t<40;t++) {
    try {const r=await fetch(url);if(r.ok)break;} catch {}
    await sleep(250);
  }
  const command=['google-chrome','chromium','chromium-browser'].map(name=>spawnSync('which',[name],{encoding:'utf8'})).find(x=>x.status===0)?.stdout?.trim();
  if(!command)throw new Error('Chrome browser not installed on runner');
  browser=await chromium.launch({headless:true,executablePath:command,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on('pageerror',e=>browserErrors.push('desktop '+e.message));
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.locator('#plant-search:not([aria-busy])').waitFor({timeout:45000});
  assert.equal(await page.locator('.control-nav-search').isVisible(),true,'sidebar search nav');
  assert.equal(await page.locator('#open-quick-recommendation').isVisible(),true);
  assert.equal(await page.locator('#open-my-quote').isVisible(),true);

  await page.locator('#plant-search').fill('aCER PALMATUM');
  assert.equal(await page.locator('#plant-search').inputValue(),'Acer palmatum');
  await page.locator('#search-popup .suggestion').first().waitFor({timeout:15000});
  // The light dropdown must have dark legible text; inherited white previously hid names.
  const suggestionName=page.locator('#search-popup .suggestion-name').first();
  assert.match(await suggestionName.innerText(),/Acer/i,'suggested plant has a visible Latin name');
  const suggestionColor=await suggestionName.evaluate(el=>getComputedStyle(el).color);
  assert.equal(suggestionColor,'rgb(22, 26, 25)','suggestion text contrast on white');

  await page.locator('#search-popup .suggestion').first().click();
  await page.locator('#plant-dialog[open]').waitFor({timeout:10000});
  assert.match(await page.locator('#plant-detail-title').innerText(),/Acer palmatum/i);
  assert.equal((await page.locator('#plant-dialog .dialog-topline-label').innerText()).trim(),'Acer palmatum','card header uses current plant name');

  assert.ok(await page.locator('#plant-dialog .offer-card').count()>0,'real offer cards');
  const price=await page.locator('#plant-dialog .offer-pricing .offer-price strong').first().boundingBox();
  const action=await page.locator('#plant-dialog .offer-pricing .quote-add').first().boundingBox();
  assert.ok(price&&action&&action.y>price.y+price.height-2,'quote action is underneath price');
  const image=page.locator('#plant-dialog .offer-visual img[data-catalog-image]').first();
  assert.ok(await image.count()>0,'real catalog reference photograph rendered');
  await image.evaluate(el=>el.decode()).catch(()=>{});
  assert.ok(await image.evaluate(el=>el.naturalWidth)>0,'photograph loaded');

  await page.locator('#plant-dialog .quote-add').first().click();
  assert.equal((await page.locator('#my-quote-count').innerText()).trim(),'(1)','quote nav registers one selected species');

  await page.locator('#plant-dialog .record-quote-link').click();
  await page.locator('#my-quote-view:not([hidden])').waitFor({timeout:10000});
  assert.equal((await page.locator('#my-quote-count').innerText()).trim(),'(1)','quote count persists on navigation');

  assert.ok(await page.locator('#quote-items .quote-item').count()>0,'quote contains selected offer');
  const item=page.locator('#quote-items .quote-item').first();
  await item.locator('input[data-quote-edit="quantity"]').fill('2');
  await item.locator('input[data-quote-edit="price"]').fill('100');
  await item.locator('input[data-quote-edit="price"]').blur();
  assert.ok((await item.locator('[data-quote-amount]').innerText()).includes('200'),'quote recalculates');
  assert.ok(await page.locator('.quote-company-logo').count()>0,'original memorandum present');
  assert.ok(await page.locator('.quote-standards').count()>0,'original standards present');
  assert.equal(await page.locator('#quote-download').isEnabled(),true,'Excel export available with valid quote');
  const [exported]=await Promise.all([page.waitForEvent('download',{timeout:30000}),page.locator('#quote-download').click()]);
  assert.ok(exported.suggestedFilename().endsWith('.xlsx'),'quote Excel export');

  await page.locator('#open-quick-recommendation').click();
  await page.locator('#quick-recommendation-view:not([hidden])').waitFor({timeout:10000});
  await page.locator('#recommend-file').setInputFiles({name:'spisak.csv',mimeType:'text/csv',buffer:Buffer.from('Naziv biljke;Visina sadnice\nAcer palmatum;300 cm\n','utf8')});
  await page.locator('#recommend-results:not([hidden])').waitFor({timeout:45000});
  assert.ok((await page.locator('#recommend-result-counts').innerText()).includes('Obrađeno biljaka:'),'recommendation processed Excel-compatible CSV');
  assert.equal(await page.locator('#recommend-download').isEnabled(),true);
  const [recommended]=await Promise.all([page.waitForEvent('download',{timeout:30000}),page.locator('#recommend-download').click()]);
  assert.ok(recommended.suggestedFilename().endsWith('.xlsx'),'recommendation Excel export');

  const mobile=await browser.newPage({viewport:{width:390,height:844}});
  mobile.on('pageerror',e=>browserErrors.push('mobile '+e.message));
  await mobile.goto(url,{waitUntil:'domcontentloaded'});
  await mobile.locator('#plant-search:not([aria-busy])').waitFor({timeout:45000});
  assert.equal(await mobile.locator('#open-my-quote').isVisible(),true);
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile avoids horizontal overflow');
  await mobile.locator('#plant-search').fill('Magnolia');
  await mobile.locator('#search-popup .suggestion').first().waitFor({timeout:15000});
  await mobile.locator('#search-popup .suggestion').first().click();
  await mobile.locator('#plant-dialog[open]').waitFor();
  assert.ok(await mobile.locator('#plant-detail-title').innerText());
  await mobile.close();
  assert.deepEqual(browserErrors,[],'no uncaught browser JavaScript errors');
  console.log('Control Room browser smoke checks passed: live catalog, search, image, quote, both Excel exports, mobile.');
} finally {
  if(browser)await browser.close();
  server.kill('SIGTERM');
}
