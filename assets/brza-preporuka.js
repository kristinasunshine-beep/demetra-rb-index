(function(){
  'use strict';
  const assets=window.DemetraRecommendationAssets||{};
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const euros=value=>new Intl.NumberFormat('sr-Latn-RS',{style:'currency',currency:'EUR'}).format(value);
  function create(config){
    const root=document.getElementById('quick-recommendation-view'),nav=document.getElementById('open-quick-recommendation');
    let pdfAbort=null,worker=null,opened=false,filename='',busy=false,hasResult=false,generation=0,rankedResults=[],allResults=[],pageIndex=0,excludedIds=new Set(),removed=[];
    root.innerHTML=`<div class="recommend-titlebar"><div><p class="recommend-eyebrow">IZBOR IZ DEMETRA RB INDEXA</p><h1 id="recommend-heading" tabindex="-1"><span>BRZA</span><span class="outline">PREPORUKA.</span></h1><p class="recommend-lead">Dodaj spisak biljaka. Preuzmi Excel sa odgovarajućim rasadnicima i najnižim nabavnim cenama.</p></div></div>
      <div class="recommend-upload" id="recommend-drop"><div class="recommend-upload-icon" aria-hidden="true">+</div><h2>Prevuci Excel ili PDF dokument ovde</h2><p>Sistem sam prepoznaje biljke i njihove parametre i odmah pronalazi ponude.</p><label class="recommend-action" for="recommend-file">Izaberi Excel ili PDF<input id="recommend-file" type="file" accept=".xlsx,.xls,.xlsm,.xlsb,.ods,.csv,.tsv,.pdf,application/pdf" class="sr-only"></label><small>Iz PDF-a se izdvajaju tekst i specifikacije. Excel izvoz koristi zajednički memorandum sa kartice Moja ponuda.</small></div>
      <div class="recommend-progress"><p class="recommend-status" id="recommend-status" role="status" aria-live="polite"></p><button class="recommend-cancel" id="recommend-cancel" type="button" hidden>Prekini obradu</button></div>
      <section id="recommend-results" class="recommend-panel" hidden><div class="recommend-panel-title"><div><p class="recommend-eyebrow">PRESELEKCIJA PRE IZVOZA</p><h2 id="recommend-result-heading"></h2></div><button class="recommend-action" type="button" id="recommend-download">Preuzmi odabrane biljke <span aria-hidden="true">↓</span></button></div><p id="recommend-result-counts" class="recommend-hint"></p><div class="recommend-preselection"><div class="recommend-selection-head"><strong id="recommend-selection-count" aria-live="polite"></strong><button type="button" id="recommend-include-all">Vrati sve biljke</button></div><p class="recommend-hint">Isključi biljke koje ne želiš u izlaznom Excel dokumentu. Sve ponude za isključenu stavku biće izostavljene.</p><div id="recommend-selection-list" class="recommend-selection-list"></div></div><div class="recommend-table-wrap"><table class="recommend-table"><thead><tr><th>Latinski naziv biljke</th><th>Parametri iz tvoje tabele</th><th>Količina</th><th>Spisak rasadnika</th><th>Nabavna cena</th><th>Rezultat</th></tr></thead><tbody id="recommend-results-body"></tbody></table></div><div class="recommend-navigation"><button class="quote-back" id="recommend-prev-page" type="button">← Prethodne stavke</button><span id="recommend-page-label" class="recommend-hint" role="status" aria-live="polite"></span><button class="quote-back" id="recommend-next-page" type="button">Sledeće stavke →</button></div><div class="recommend-navigation"><button id="recommend-remove-plant" type="button">Ukloni ovu biljku</button><button id="recommend-restore-plant" type="button" disabled>Vrati poslednju uklonjenu</button></div><p id="recommend-preview-note" class="recommend-hint"></p></section>`;
    const el=id=>root.querySelector('#'+id);
    function status(message,error=false){el('recommend-status').textContent=message;el('recommend-status').classList.toggle('is-error',error);}
    function setBusy(value){busy=value;root.setAttribute('aria-busy',String(value));el('recommend-download').disabled=value||!hasResult;el('recommend-cancel').hidden=!value;el('recommend-file').disabled=value;if(allResults.length&&!el('recommend-results').hidden){renderRankedPage();renderSelection();}}
    function renderSelection(){
      el('recommend-selection-count').textContent='Za izvoz: '+rankedResults.length+' od '+allResults.length+' biljaka';
      el('recommend-include-all').disabled=busy||!excludedIds.size;
      el('recommend-selection-list').innerHTML=allResults.map((item,i)=>{
        const included=!excludedIds.has(item.id);
        return '<label class="recommend-selection-item"><input type="checkbox" data-selection-index="'+i+'" '+(included?'checked ':'')+(busy?'disabled ':'')+'><span><strong>'+escape(item.canonicalName||item.name)+'</strong><small>'+escape([...(item.parameters||[]).map(p=>p.label+': '+p.value),item.quantity!==''&&item.quantity!=null?'Količina: '+item.quantity:'',item.sheet+' · red '+item.row].filter(Boolean).join(' · '))+'</small></span><span class="recommend-selection-state">'+(included?'U izvozu':'Izostavljeno')+'</span></label>';
      }).join('');
    }
    function applySelection(focusId){
      rankedResults=allResults.filter(item=>!excludedIds.has(item.id));
      const target=rankedResults.findIndex(item=>item.id===focusId);
      pageIndex=target>=0?target:Math.max(0,Math.min(pageIndex,rankedResults.length-1));
      renderRankedPage();renderSelection();
    }
    el('recommend-selection-list').addEventListener('change',event=>{
      const input=event.target.closest('input[data-selection-index]');
      if(!input||busy)return;
      const item=allResults[Number(input.dataset.selectionIndex)];if(!item)return;
      const current=rankedResults[pageIndex]?.id;
      if(input.checked){excludedIds.delete(item.id);removed=removed.filter(x=>x.item.id!==item.id);}
      else if(!excludedIds.has(item.id)){excludedIds.add(item.id);removed.push({item,index:allResults.indexOf(item)});}
      applySelection(input.checked?item.id:current);
      el('recommend-selection-list').querySelector('input[data-selection-index="'+input.dataset.selectionIndex+'"]')?.focus({preventScroll:true});
    });
    el('recommend-include-all').addEventListener('click',()=>{
      if(busy)return;excludedIds.clear();removed=[];applySelection(rankedResults[pageIndex]?.id);
    });
    function renderRankedPage(){
      // Each recognized source-plant row has its own page; all nursery variants stay together.
      const pageSize=1,total=rankedResults.length,from=pageIndex*pageSize;
      const rows=rankedResults.slice(from,from+pageSize);
      el('recommend-results-body').innerHTML=rows.flatMap(r=>{
        const suppliers=r.suppliers?.length?r.suppliers:[null];
        return suppliers.map((s,i)=>'<tr class="'+(s&&!s.candidate?'is-match':'is-unmatched')+'"><td>'+(i?'':r.plantId?'<a class="recommend-plant-link" href="#plant='+encodeURIComponent(r.plantId)+'">'+escape(r.canonicalName||r.name)+'</a>':escape(r.name))+'</td><td class="recommend-parameters">'+(i?'':(r.parameters||[]).map(p=>'<div class="'+(((/^(obim|visina)\b/i.test(p.label)||/^(height|circumference)$/.test(p.key)) && /\d/.test(String(p.value)) && !/nije|nepoznat/i.test(String(p.value)))?'recommend-parameter--priority':'')+'">'+escape(p.label)+': '+escape(p.value)+'</div>').join('')||'—')+'</td><td>'+(i?'':escape(r.quantity??''))+'</td><td>'+escape(s?.name||'—')+'</td><td class="recommend-price">'+(Number.isFinite(s?.price)?escape(euros(s.price)):'—')+'</td><td>'+ (s?'<strong>'+escape(s.matchCount+'/'+s.requestedCount+' parametara')+'</strong><small>'+escape(s.candidate?'Potencijalni kandidat':'Tačno podudaranje')+'</small><small>'+escape('Poklopljeno: '+s.matchedParameters.join(', '))+'</small>':escape(r.status==='not_found'?'Naziv nije pronađen':'Nema podudarnog parametra'))+(s?.historical?'<small>Proveriti aktuelnost cene</small>':'')+(s?.offeredParameters?'<small>'+escape(s.offeredParameters)+'</small>':'')+'</td></tr>');
      }).join('');
      el('recommend-page-label').textContent=total?'Strana '+(pageIndex+1)+' od '+Math.ceil(total/pageSize)+' · stavka '+(from+1)+' od '+total:'Nema prepoznatih stavki';
      el('recommend-remove-plant').disabled=!total||busy;
      el('recommend-restore-plant').disabled=!removed.length||busy;
      hasResult=total>0;el('recommend-download').disabled=busy||!hasResult;
      el('recommend-prev-page').disabled=pageIndex===0;
      el('recommend-next-page').disabled=from+pageSize>=total;
      el('recommend-preview-note').textContent='Sve varijante sa najmanje jednim poklopljenim parametrom, rangirane po broju poklapanja, zatim po rastućoj ceni.';
    }
    function turnPage(direction){
      const newPage=pageIndex+direction;
      if(newPage<0||newPage>=rankedResults.length)return;
      pageIndex=newPage;
      renderRankedPage();
      // Start the new page at its heading rather than leaving the reader at the old footer.
      el('recommend-result-heading').scrollIntoView({behavior:'instant',block:'start'});
    }
    el('recommend-remove-plant').addEventListener('click',()=>{
      if(busy||!rankedResults[pageIndex])return;
      const item=rankedResults[pageIndex];excludedIds.add(item.id);removed.push({item,index:allResults.indexOf(item)});
      applySelection();
      status('Stavka uklonjena iz preporuke i Excel izvoza. Preostalo: '+rankedResults.length+'.');
    });
    el('recommend-restore-plant').addEventListener('click',()=>{
      if(busy||!removed.length)return;
      const {item}=removed.pop();excludedIds.delete(item.id);applySelection(item.id);
      status('Stavka vraćena u preporuku.');
    });
    el('recommend-prev-page').addEventListener('click',()=>turnPage(-1));
    el('recommend-next-page').addEventListener('click',()=>turnPage(1));
    function ensureWorker(){
      if(worker)return worker;
      const workerUrl=assets.workerSource?URL.createObjectURL(new Blob([assets.workerSource],{type:'text/javascript'})):new URL('./assets/brza-preporuka-worker.js?v=final-selection-r4-20261125',document.baseURI);
      worker=new Worker(workerUrl);if(assets.workerSource)URL.revokeObjectURL(workerUrl);
      worker.onmessage=({data})=>{
        if(data.type==='progress')status(data.message);
        if(data.type==='results'){
          hasResult=true;setBusy(false);el('recommend-results').hidden=false;el('recommend-result-heading').textContent=filename;
          el('recommend-result-counts').textContent=`Obrađeno: ${data.processed.toLocaleString('sr-Latn-RS')} · Prepoznato: ${(data.recognized??data.matched).toLocaleString('sr-Latn-RS')} · Tačno podudaranje: ${data.matched.toLocaleString('sr-Latn-RS')} · Nepotpuna specifikacija: ${(data.needsData??0).toLocaleString('sr-Latn-RS')} · Nije pronađeno u indeksu: ${(data.notFound??0).toLocaleString('sr-Latn-RS')} · Nema potvrđene ponude: ${data.unmatched.toLocaleString('sr-Latn-RS')}`;
          allResults=data.preview;rankedResults=allResults.slice();pageIndex=0;excludedIds=new Set();removed=[];applySelection();
          el('recommend-results').scrollIntoView({behavior:'smooth',block:'start'});status(data.processed?'Pregledaj i koriguj preselektovane biljke, pa preuzmi Excel.':'Nijedan botanički naziv nije prepoznat. Proveri čitljivost dokumenta.',!data.processed);
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
    el('recommend-download').addEventListener('click',()=>{if(!hasResult||busy)return;setBusy(true);ensureWorker().postMessage({type:'export',excludedIds:[...excludedIds],templateUrl:assets.templateUrl||new URL('./assets/brza-preporuka-template.xlsx',document.baseURI).href,sharedTemplateUrl:new URL('./assets/moja-ponuda-template.xlsx',document.baseURI).href});});
    el('recommend-cancel').addEventListener('click',()=>{generation++;pdfAbort?.abort();pdfAbort=null;worker?.terminate();worker=null;hasResult=false;setBusy(false);el('recommend-file').value='';status('Obrada je prekinuta.');});
    function hide(){opened=false;root.hidden=true;nav.setAttribute('aria-expanded','false');}
    function open(){opened=true;config.onOpen?.();root.hidden=false;document.getElementById('main').hidden=true;nav.setAttribute('aria-expanded','true');document.body.dataset.view='recommendation';document.title='Brza preporuka · demetra rb index';if(location.hash!=='#brza-preporuka')history.pushState({demetraNav:true},'','#brza-preporuka');el('recommend-heading').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
    nav.addEventListener('click',open);
    return {open,hide,isOpen:()=>opened};
  }
  window.DemetraRecommendation={create};
})();
