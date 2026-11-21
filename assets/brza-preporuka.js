(function(){
  'use strict';
  const assets=window.DemetraRecommendationAssets||{};
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const euros=value=>new Intl.NumberFormat('sr-Latn-RS',{style:'currency',currency:'EUR'}).format(value);
  function create(config){
    const root=document.getElementById('quick-recommendation-view'),nav=document.getElementById('open-quick-recommendation');
    let pdfAbort=null,worker=null,opened=false,filename='',busy=false,hasResult=false,generation=0;
    root.innerHTML=`<div class="recommend-titlebar"><div><div class="recommend-navigation"><button class="quote-back" id="recommend-back" type="button">← Korak nazad</button><button class="quote-back" id="recommend-home" type="button">⌂ Početna</button></div><p class="recommend-eyebrow">IZBOR IZ DEMETRA RB INDEXA</p><h1 id="recommend-heading" tabindex="-1"><span>BRZA</span><span class="outline">PREPORUKA.</span></h1><p class="recommend-lead">Dodaj spisak biljaka. Preuzmi Excel sa odgovarajućim rasadnicima i najnižim nabavnim cenama.</p></div></div>
      <div class="recommend-upload" id="recommend-drop"><div class="recommend-upload-icon" aria-hidden="true">+</div><h2>Prevuci Excel ili PDF dokument ovde</h2><p>Sistem sam prepoznaje biljke i njihove parametre i odmah pronalazi ponude.</p><label class="recommend-action" for="recommend-file">Izaberi Excel ili PDF<input id="recommend-file" type="file" accept=".xlsx,.xls,.xlsm,.xlsb,.ods,.csv,.tsv,.pdf,application/pdf" class="sr-only"></label><small>Excel listovi ostaju sačuvani; iz PDF-a se izdvajaju tekst i specifikacije.</small></div>
      <div class="recommend-progress"><p class="recommend-status" id="recommend-status" role="status" aria-live="polite"></p><button class="recommend-cancel" id="recommend-cancel" type="button" hidden>Prekini obradu</button></div>
      <section id="recommend-results" class="recommend-panel" hidden><div class="recommend-panel-title"><div><p class="recommend-eyebrow">PREPORUKA JE SPREMNA</p><h2 id="recommend-result-heading"></h2></div><button class="recommend-action" type="button" id="recommend-download">Preuzmi Excel <span aria-hidden="true">↓</span></button></div><p id="recommend-result-counts" class="recommend-hint"></p><div class="recommend-table-wrap"><table class="recommend-table"><thead><tr><th>Latinski naziv biljke</th><th>Parametri iz tvoje tabele</th><th>Spisak rasadnika</th><th>Nabavna cena</th><th>Rezultat</th></tr></thead><tbody id="recommend-results-body"></tbody></table></div><p id="recommend-preview-note" class="recommend-hint"></p></section>`;
    const el=id=>root.querySelector('#'+id);
    function status(message,error=false){el('recommend-status').textContent=message;el('recommend-status').classList.toggle('is-error',error);}
    function setBusy(value){busy=value;root.setAttribute('aria-busy',String(value));el('recommend-download').disabled=value||!hasResult;el('recommend-cancel').hidden=!value;el('recommend-file').disabled=value;}
    function ensureWorker(){
      if(worker)return worker;
      const workerUrl=assets.workerSource?URL.createObjectURL(new Blob([assets.workerSource],{type:'text/javascript'})):new URL('./assets/brza-preporuka-worker.js?v=no-tax-r1-20261121',document.baseURI);
      worker=new Worker(workerUrl);if(assets.workerSource)URL.revokeObjectURL(workerUrl);
      worker.onmessage=({data})=>{
        if(data.type==='progress')status(data.message);
        if(data.type==='results'){
          hasResult=true;setBusy(false);el('recommend-results').hidden=false;el('recommend-result-heading').textContent=filename;
          el('recommend-result-counts').textContent=`Obrađeno: ${data.processed.toLocaleString('sr-Latn-RS')} · Prepoznato: ${(data.recognized??data.matched).toLocaleString('sr-Latn-RS')} · Tačno podudaranje: ${data.matched.toLocaleString('sr-Latn-RS')} · Nepotpuna specifikacija: ${(data.needsData??0).toLocaleString('sr-Latn-RS')} · Nije pronađeno u indeksu: ${(data.notFound??0).toLocaleString('sr-Latn-RS')} · Nema potvrđene ponude: ${data.unmatched.toLocaleString('sr-Latn-RS')}`;
          el('recommend-results-body').innerHTML=data.preview.flatMap(r=>{
            const suppliers=r.suppliers?.length?r.suppliers:[null];
            return suppliers.map((supplier,i)=>'<tr class="'+(r.status==='matched'?'is-match':'is-unmatched')+'"><td>'+(i?'':r.plantId?'<a class="recommend-plant-link" href="#plant='+encodeURIComponent(r.plantId)+'">'+escape(r.canonicalName||r.name)+'</a>':escape(r.name))+'</td><td class="recommend-parameters">'+(i?'':(r.parameters||[]).map(p=>'<div>'+escape(p.label)+': '+escape(p.value)+'</div>').join('')||'—')+'</td><td>'+escape(supplier?.name||'—')+'</td><td class="recommend-price">'+(Number.isFinite(supplier?.price)?escape(euros(supplier.price)):'—')+'</td><td>'+escape(r.status==='matched'?'Tačno podudaranje':supplier?'Potencijalni kandidat':r.status==='not_found'?'Naziv nije pronađen':'Potrebna provera')+(supplier?.historical?'<small>Proveriti aktuelnost cene</small>':'')+(supplier?.offeredParameters?'<small>'+escape(supplier.offeredParameters)+'</small>':'')+'</td></tr>');
          }).join('');
          el('recommend-preview-note').textContent=(data.processed>data.preview.length?`Pregled prvih ${data.preview.length} biljaka. `:'')+'Pregled prikazuje prepoznate parametre, rasadnike i njihove evidentirane cene. Potencijalni kandidati nisu potvrđeno podudaranje.';
          el('recommend-results').scrollIntoView({behavior:'smooth',block:'start'});status('Gotovo. Preuzmi Excel sa preporukama.');
        }
        if(data.type==='download'){
          const url=URL.createObjectURL(new Blob([data.bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
          const link=document.createElement('a');link.href=url;link.download='Demetra-brza-preporuka-'+filename.replace(/\.[^.]+$/,'').replace(/[<>:"/\\|?*]/g,'-')+'.xlsx';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);setBusy(false);status('Excel je poslat pregledaču za preuzimanje.');
        }
        if(data.type==='error'){hasResult=false;setBusy(false);status(data.message,true);}
      };
      worker.onerror=()=>{hasResult=false;setBusy(false);status('Tabela nije mogla da se obradi. Izaberi datoteku ponovo.',true);worker.terminate();worker=null;};return worker;
    }
    async function read(file){
      if(!file||busy)return;const current=++generation;filename=file.name;hasResult=false;el('recommend-results').hidden=true;setBusy(true);status('Prepoznajem biljke i parametre iz tvoje tabele…');
      try{
        let catalog=config.getCatalog();
        for(let i=0;!catalog&&i<240;i++){await new Promise(resolve=>setTimeout(resolve,250));if(current!==generation)return;catalog=config.getCatalog();}
        if(!catalog)throw new Error('Katalog trenutno nije dostupan. Pokušaj ponovo kada se učita stranica.');
        let pdfRows=null;
        if(/\.pdf$/i.test(file.name)){
          pdfAbort=new AbortController();
          const module=await import(new URL('./assets/pdf-import.mjs?v=ocr-lines-r2-20261121',document.baseURI).href);
          pdfRows=await module.extractPdfRows(await file.arrayBuffer(),{signal:pdfAbort.signal,onProgress:message=>{if(current===generation)status(message);}});
        }
        if(current===generation)ensureWorker().postMessage({type:'process',file,catalog,pdfRows});
      }catch(error){if(current===generation){setBusy(false);status(error.message,true);}}
    }
    el('recommend-file').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';read(file);});
    const drop=el('recommend-drop');drop.addEventListener('dragover',e=>{e.preventDefault();if(!busy)drop.classList.add('is-dragging');});drop.addEventListener('dragleave',()=>drop.classList.remove('is-dragging'));drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('is-dragging');read(e.dataTransfer.files[0]);});
    el('recommend-download').addEventListener('click',()=>{if(!hasResult||busy)return;setBusy(true);ensureWorker().postMessage({type:'export',templateUrl:assets.templateUrl||new URL('./assets/brza-preporuka-template.xlsx',document.baseURI).href});});
    el('recommend-cancel').addEventListener('click',()=>{generation++;pdfAbort?.abort();pdfAbort=null;worker?.terminate();worker=null;hasResult=false;setBusy(false);el('recommend-file').value='';status('Obrada je prekinuta.');});
    function hide(){opened=false;root.hidden=true;nav.setAttribute('aria-expanded','false');}
    function open(){opened=true;config.onOpen?.();root.hidden=false;document.getElementById('main').hidden=true;nav.setAttribute('aria-expanded','true');document.body.dataset.view='recommendation';document.title='Brza preporuka · demetra rb index';if(location.hash!=='#brza-preporuka')history.pushState({demetraNav:true},'','#brza-preporuka');el('recommend-heading').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
    el('recommend-back').addEventListener('click',()=>{if(window.DemetraNavigation)window.DemetraNavigation.back();else config.onClose?.();});
    el('recommend-home').addEventListener('click',()=>{if(window.DemetraNavigation)window.DemetraNavigation.home();else config.onClose?.();});nav.addEventListener('click',open);
    return {open,hide,isOpen:()=>opened};
  }
  window.DemetraRecommendation={create};
})();
