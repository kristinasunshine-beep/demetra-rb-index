(function(){
  'use strict';
  const assets=window.DemetraRecommendationAssets||{};
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const euros=value=>new Intl.NumberFormat('sr-Latn-RS',{style:'currency',currency:'EUR'}).format(value);
  function create(config){
    const root=document.getElementById('quick-recommendation-view'),nav=document.getElementById('open-quick-recommendation');
    let pdfAbort=null,worker=null,opened=false,filename='',busy=false,hasResult=false,generation=0,rankedResults=[],allResults=[],pageIndex=0,excludedOffers=new Set(),removed=[];
    root.innerHTML=`<div class="recommend-titlebar"><div><p class="recommend-eyebrow">IZBOR IZ DEMETRA RB INDEXA</p><h1 id="recommend-heading" tabindex="-1"><span>BRZA</span><span class="outline">PREPORUKA.</span></h1><p class="recommend-lead">Dodaj spisak biljaka. Preuzmi Excel sa odgovarajućim rasadnicima i najnižim nabavnim cenama.</p></div></div>
      <div class="recommend-upload" id="recommend-drop"><div class="recommend-upload-icon" aria-hidden="true">+</div><h2>Prevuci Excel ili PDF dokument ovde</h2><p>Sistem sam prepoznaje biljke i njihove parametre i odmah pronalazi ponude.</p><label class="recommend-action" for="recommend-file">Izaberi Excel ili PDF<input id="recommend-file" type="file" accept=".xlsx,.xls,.xlsm,.xlsb,.ods,.csv,.tsv,.pdf,application/pdf" class="sr-only"></label><small>Iz PDF-a se izdvajaju tekst i specifikacije. Excel izvoz koristi zajednički memorandum sa kartice Moja ponuda.</small></div>
      <div class="recommend-progress"><p class="recommend-status" id="recommend-status" role="status" aria-live="polite"></p><button class="recommend-cancel" id="recommend-cancel" type="button" hidden>Prekini obradu</button></div>
      <section id="recommend-results" class="recommend-panel" hidden><div class="recommend-panel-title"><div><p class="recommend-eyebrow">REZULTAT BRZE PREPORUKE</p><h2 id="recommend-result-heading"></h2></div><button class="recommend-action" type="button" id="recommend-download">Preuzmi Excel <span aria-hidden="true">↓</span></button></div><p id="recommend-result-counts" class="recommend-hint"></p><div class="recommend-table-wrap"><table class="recommend-table"><thead><tr><th>Latinski naziv biljke</th><th>Parametri ponuđene biljke</th><th>Rasadnik</th><th>Nabavna cena</th><th>Poklapanje</th><th>Količina</th><th>Uklanjanje</th></tr></thead><tbody id="recommend-results-body"></tbody></table></div><div id="recommend-pagination" class="recommend-navigation" hidden><button class="quote-back" id="recommend-prev-page" type="button">← Prethodne stavke</button><span id="recommend-page-label" class="recommend-hint" role="status" aria-live="polite"></span><button class="quote-back" id="recommend-next-page" type="button">Sledeće stavke →</button></div><div class="recommend-navigation"><button id="recommend-restore-plant" type="button" disabled>Vrati poslednju uklonjenu ponudu</button></div><p id="recommend-preview-note" class="recommend-hint"></p></section>`;
    const el=id=>root.querySelector('#'+id);
    function status(message,error=false){el('recommend-status').textContent=message;el('recommend-status').classList.toggle('is-error',error);}
    function setBusy(value){busy=value;root.setAttribute('aria-busy',String(value));el('recommend-download').disabled=value||!hasResult;el('recommend-cancel').hidden=!value;el('recommend-file').disabled=value;if(allResults.length&&!el('recommend-results').hidden){renderRankedPage();}}
    const pageSize=25;
    const offerKey=(item,supplier)=>JSON.stringify([item.id,supplier.offerIds[0]]);
    function applySelection(focusId){
      rankedResults=allResults.map(item=>{
        const suppliers=(item.suppliers||[]).filter(s=>!excludedOffers.has(offerKey(item,s)));
        return {...item,suppliers,allOffersRemoved:Boolean(item.suppliers?.length&&!suppliers.length)};
      });
      const target=rankedResults.findIndex(item=>item.id===focusId);
      pageIndex=target>=0?Math.floor(target/pageSize):Math.max(0,Math.min(pageIndex,Math.ceil(rankedResults.length/pageSize)-1));
      renderRankedPage();
    }
    function renderRankedPage(){
      const total=rankedResults.length,from=pageIndex*pageSize,rows=rankedResults.slice(from,from+pageSize);
      const disabled=busy?' disabled':'';
      const button=(kind,id,offer,label)=>'<button type="button" class="recommend-delete" data-remove-kind="'+kind+'" data-request-id="'+escape(id)+'"'+(offer?' data-offer-id="'+escape(offer)+'"':'')+disabled+'>'+label+'</button>';
      el('recommend-results-body').innerHTML=rows.flatMap(r=>{
        const suppliers=r.suppliers?.length?r.suppliers:[null];
        const name=r.plantId?'<a class="recommend-plant-link" href="#plant='+encodeURIComponent(r.plantId)+'">'+escape(r.canonicalName||r.name)+'</a>':escape(r.canonicalName||r.name);
        const requested=(r.parameters||[]).map(p=>p.label+': '+p.value).join(' · ');
        return suppliers.map((s,i)=>'<tr data-result-id="'+escape(r.id)+'"'+(s?' data-result-offer="'+escape(s.offerIds[0])+'"':'')+' class="'+(i===0?'recommend-plant-start ':'')+(s&&!s.candidate?'is-match':'is-unmatched')+'"><td>'+(i?'':name+(requested?'<small>Traženo: '+escape(requested)+'</small>':''))+'</td><td class="recommend-parameters">'+(s?(s.offeredParameters||'').split('; ').filter(Boolean).map(v=>'<div>'+escape(v)+'</div>').join('')||'—':'—')+'</td><td>'+escape(s?.name||'—')+'</td><td class="recommend-price">'+(Number.isFinite(s?.price)?escape(euros(s.price)):'—')+'</td><td>'+(s?'<strong>'+escape(s.matchCount+'/'+s.requestedCount)+'</strong><small>'+escape(s.nameOnly?'Poklapanje naziva · bez specifikacije':s.candidate?'Delimično podudaranje':'Tačno podudaranje')+'</small>'+(s.matchedParameters?.length?'<small>Poklopljeno: '+escape(s.matchedParameters.join(', '))+'</small>':'')+(s.historical?'<small>Proveriti aktuelnost cene</small>':''):escape(r.allOffersRemoved?'Sve ponude su uklonjene':r.status==='not_found'?'Naziv nije pronađen':!r.parameters?.length?'Nema validne rasadničke ponude':'Nema podudarnog parametra'))+'</td><td>'+(i?'':escape(r.quantity??''))+'</td><td>'+(s?button('offer',r.id,s.offerIds[0],'Ukloni ponudu'):'')+'</td></tr>');
      }).join('');
      const offerCount=rankedResults.reduce((n,r)=>n+r.suppliers.length,0);
      el('recommend-pagination').hidden=total<=pageSize;
      el('recommend-page-label').textContent=total>pageSize?'Biljke '+(from+1)+'–'+Math.min(from+pageSize,total)+' od '+total+' · '+offerCount+' ponuda':'';
      el('recommend-restore-plant').disabled=!removed.length||busy;
      hasResult=total>0;el('recommend-download').disabled=busy||!hasResult;
      el('recommend-prev-page').disabled=busy||pageIndex===0;
      el('recommend-next-page').disabled=busy||from+pageSize>=total;
      el('recommend-preview-note').textContent='Ponude su rangirane po broju poklopljenih parametara, zatim po ceni. Kada izvor nema parametre, prikazuju se ponude tačno iste biljke po ceni, bez potvrde podudarnosti parametara. Uklanjaju se samo rasadničke ponude.';
    }
    el('recommend-results-body').addEventListener('click',event=>{
      const control=event.target.closest('button[data-remove-kind]');
      if(!control||busy)return;
      const id=control.dataset.requestId,item=allResults.find(r=>r.id===id);if(!item)return;
      if(control.dataset.removeKind!=='offer')return;
      const supplier=(item.suppliers||[]).find(s=>s.offerIds[0]===control.dataset.offerId);if(!supplier)return;
      const key=offerKey(item,supplier);if(excludedOffers.has(key))return;
      excludedOffers.add(key);removed.push({id,key});
      applySelection(id);status('Stavka uklonjena iz rezultata preporuke.');
    });
    function turnPage(direction){
      const newPage=pageIndex+direction;
      if(busy||newPage<0||newPage>=Math.ceil(rankedResults.length/pageSize))return;
      pageIndex=newPage;
      renderRankedPage();
      // Start the new page at its heading rather than leaving the reader at the old footer.
      el('recommend-result-heading').scrollIntoView({behavior:'instant',block:'start'});
    }
    el('recommend-restore-plant').addEventListener('click',()=>{
      if(busy||!removed.length)return;
      const action=removed.pop();
      excludedOffers.delete(action.key);
      applySelection(action.id);status('Stavka vraćena u preporuku.');
    });
    el('recommend-prev-page').addEventListener('click',()=>turnPage(-1));
    el('recommend-next-page').addEventListener('click',()=>turnPage(1));
    function ensureWorker(){
      if(worker)return worker;
      const workerUrl=assets.workerSource?URL.createObjectURL(new Blob([assets.workerSource],{type:'text/javascript'})):new URL('./assets/brza-preporuka-worker.js?v=description-quantity-r7-20261125',document.baseURI);
      worker=new Worker(workerUrl);if(assets.workerSource)URL.revokeObjectURL(workerUrl);
      worker.onmessage=({data})=>{
        if(data.type==='progress')status(data.message);
        if(data.type==='results'){
          hasResult=true;setBusy(false);el('recommend-results').hidden=false;el('recommend-result-heading').textContent=filename;
          el('recommend-result-counts').textContent=`Obrađeno: ${data.processed.toLocaleString('sr-Latn-RS')} · Prepoznato: ${(data.recognized??data.matched).toLocaleString('sr-Latn-RS')} · Tačno podudaranje: ${data.matched.toLocaleString('sr-Latn-RS')} · Nepotpuna specifikacija: ${(data.needsData??0).toLocaleString('sr-Latn-RS')} · Nije pronađeno u indeksu: ${(data.notFound??0).toLocaleString('sr-Latn-RS')} · Nema potvrđene ponude: ${data.unmatched.toLocaleString('sr-Latn-RS')}`;
          allResults=data.preview;rankedResults=allResults.slice();pageIndex=0;excludedOffers=new Set();removed=[];applySelection();
          el('recommend-results').scrollIntoView({behavior:'smooth',block:'start'});status(data.processed?'Pregledaj rasadničke ponude, ukloni nepotrebne stavke i preuzmi Excel.':'Nijedan botanički naziv nije prepoznat. Proveri čitljivost dokumenta.',!data.processed);
        }
        if(data.type==='download'){
          const url=URL.createObjectURL(new Blob([data.bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
          const link=document.createElement('a');link.href=url;link.download='Demetra-brza-preporuka-'+filename.replace(/\.[^.]+$/,'').replace(/[<>:"/\\|?*]/g,'-')+'.xlsx';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);setBusy(false);status('Excel je poslat pregledaču za preuzimanje.');
        }
        if(data.type==='error'){hasResult=rankedResults.length>0&&!el('recommend-results').hidden;setBusy(false);status(data.message,true);}
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
          const module=await import(new URL('./assets/pdf-import.mjs?v=botanical-ocr-r3-20261125',document.baseURI).href);
          const botanicalIndex=window.DemetraRecommendCore.makeIndex(catalog);
          pdfRows=await module.extractPdfRows(await file.arrayBuffer(),{signal:pdfAbort.signal,hasBotanicalRows:rows=>rows.some(row=>window.DemetraRecommendCore.sourceRequests(botanicalIndex,row,{},[]).some(hit=>!hit.identity.startsWith('unknown:'))),onProgress:message=>{if(current===generation)status(message);}});
        }
        if(current===generation)ensureWorker().postMessage({type:'process',file,catalog,pdfRows});
      }catch(error){if(current===generation){setBusy(false);status(error.message,true);}}
    }
    el('recommend-file').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';read(file);});
    const drop=el('recommend-drop');drop.addEventListener('dragover',e=>{e.preventDefault();if(!busy)drop.classList.add('is-dragging');});drop.addEventListener('dragleave',()=>drop.classList.remove('is-dragging'));drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('is-dragging');read(e.dataTransfer.files[0]);});
    el('recommend-download').addEventListener('click',()=>{if(!hasResult||busy)return;setBusy(true);ensureWorker().postMessage({type:'export',excludedOffers:[...excludedOffers],templateUrl:assets.templateUrl||new URL('./assets/brza-preporuka-template.xlsx',document.baseURI).href,sharedTemplateUrl:new URL('./assets/moja-ponuda-template.xlsx',document.baseURI).href});});
    el('recommend-cancel').addEventListener('click',()=>{generation++;pdfAbort?.abort();pdfAbort=null;worker?.terminate();worker=null;hasResult=false;setBusy(false);el('recommend-file').value='';status('Obrada je prekinuta.');});
    function hide(){opened=false;root.hidden=true;nav.setAttribute('aria-expanded','false');}
    function open(){opened=true;config.onOpen?.();root.hidden=false;document.getElementById('main').hidden=true;nav.setAttribute('aria-expanded','true');document.body.dataset.view='recommendation';document.title='Brza preporuka · demetra rb index';if(location.hash!=='#brza-preporuka')history.pushState({demetraNav:true},'','#brza-preporuka');el('recommend-heading').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
    nav.addEventListener('click',open);
    return {open,hide,isOpen:()=>opened};
  }
  window.DemetraRecommendation={create};
})();
