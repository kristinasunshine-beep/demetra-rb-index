import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const txt=p=>readFileSync(resolve(root,p),'utf8');
const buffer=p=>readFileSync(resolve(root,p));
function sizeOfPng(file) {
  const b=buffer(file);
  assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a',file+' PNG signature');
  return [b.readUInt32BE(16),b.readUInt32BE(20)];
}
test('PWA icons are real installable raster resources in the repo',()=>{
  for (const [path,size] of [
    ['assets/icons/icon-192.png',192],
    ['assets/icons/icon-512.png',512],
    ['assets/icons/icon-maskable-512.png',512],
    ['assets/icons/apple-touch-icon.png',180],
    ['assets/icons/favicon-32.png',32]
  ]) {
    assert.deepEqual(sizeOfPng(path),[size,size]);
    assert.ok(statSync(resolve(root,path)).size>200,path+' is not empty');
  }
  assert.ok(buffer('assets/icons/favicon.ico').subarray(0,4).equals(Buffer.from([0,0,1,0])));
});
test('Browser favicon is separate white/coral art, never the green PWA tile',()=>{
  const favicon=txt('assets/icons/favicon.svg');
  const mobile=txt('assets/icons/icon.svg');
  const html=txt('index.html');
  assert.match(favicon,/<rect[^>]*fill="#FFFFFF"/);
  assert.match(favicon,/<g[^>]*stroke="#F9583B"/);
  assert.doesNotMatch(favicon,/#151918|#234D36|stroke="#FAF9F3"/);
  assert.match(mobile,/<rect[^>]*fill="#151918"/);
  assert.match(html,/rel="icon" href="\.\/assets\/icons\/favicon\.svg/);
  assert.match(html,/rel="apple-touch-icon" href="\.\/assets\/icons\/apple-touch-icon\.png/);
  const bg=readFileSync(resolve(root,'assets/icons/favicon-32.png'));
  assert.equal(bg.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
});
test('Manifest remains scoped to GitHub Pages project path',()=>{
  const manifest=JSON.parse(txt('manifest.webmanifest'));
  assert.equal(manifest.start_url,'./');
  assert.equal(manifest.scope,'./');
  assert.equal(manifest.display,'standalone');
  const purposes=new Set(manifest.icons.flatMap(x=>x.purpose.split(' ')));
  assert.ok(purposes.has('maskable')&&purposes.has('any'));
  assert.ok(manifest.icons.some(x=>x.sizes==='192x192'));
  assert.ok(manifest.icons.some(x=>x.sizes==='512x512'));
});
test('Mobile outline rule cannot modify desktop and does not touch existing search behavior',()=>{
  const css=txt('assets/control-room-mobile-outline.css');
  assert.match(css,/@media screen and \(max-width:\s*760px\)/);
  assert.match(css,/\.search-intro h1 em/);
  assert.doesNotMatch(css,/#plant-search|\.offer-pricing|\.quote-item/);
  const html=txt('index.html');
  assert.match(html,/rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html,/control-room-mobile-outline\.css/);
  assert.match(html,/navigator\.serviceWorker\.register\('\.\/service-worker\.js'(?:\s*,[^)]*)?\)/);
});
test('Offline shell does not cache catalog JSON, user quotes or archived prices',()=>{
  const service=txt('service-worker.js');
  assert.match(service,/pathname\.includes\('\/data\/'\)/);
  assert.match(service,/xlsx\|xls\|csv/);
  assert.match(service,/cache:'reload'/);
  const dataGuard=service.indexOf("url.pathname.includes('/data/')");
  assert.ok(dataGuard>=0 && dataGuard<service.indexOf('cache.put'), 'Catalog requests exit before shell assets can be cached');
  assert.match(service,/if \(url\.pathname\.includes\('\/data\/'\)[^\n]+return;/);
});

test('PWA tile matches #151918 pixel sample from user photo without any decorative border',()=>{
  for(const file of ['assets/icons/icon.svg','assets/icons/icon-maskable.svg']){
    const svg=txt(file);
    assert.match(svg,/<rect[^>]*fill="#151918"/,'exact color sampled from source image');
    assert.doesNotMatch(svg,/<circle[^>]*cx="256"[^>]*cy="256"/,'no extra decorative circle around tree');
    assert.match(svg,/<g[^>]*stroke="#F9583B"/,'original coral plant symbol');
    assert.match(svg,/<circle cx="16" cy="12" r="8.5"\/>/,'original circular treetop remains');
    assert.doesNotMatch(svg,/fill="#234D36"/,'wrong bright green removed');
  }
  const manifest=JSON.parse(txt('manifest.webmanifest'));
  assert.equal(manifest.background_color,'#151918');
  assert.equal(manifest.theme_color,'#151918');
});
test('Mobile outline retains original font and merges glyph contours without horizontal distortion',()=>{
  const css=txt('assets/control-room-mobile-outline.css');
  assert.match(css,/font-family:\s*var\(--sans\)/);
  assert.match(css,/filter:url\("#demetra-mobile-union-outline"\)/);
  assert.match(css,/transform:\s*none/);
  assert.match(css,/@media screen and \(max-width:\s*760px\)/);
  assert.ok(statSync(resolve(root,'fonts/BarlowCondensed-SemiBold.ttf')).size>50000);
});

