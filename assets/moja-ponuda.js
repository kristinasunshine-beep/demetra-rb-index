(function () {
  'use strict';
  const Core = window.DemetraQuoteCore;
  if (!Core) return;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const asset = name => window.DemetraQuoteAssets?.[name] || new URL('./assets/' + name, document.baseURI).href;
  let zipPromise;
  function loadZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (!zipPromise) zipPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = asset('vendor/jszip-3.10.1.min.js');
      script.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error('Excel alat nije učitan.'));
      script.onerror = () => { script.remove(); reject(new Error('Proverite vezu i ponovo preuzmite ponudu.')); };
      document.head.appendChild(script);
    }).catch(error => { zipPromise = null; throw error; });
    return zipPromise;
  }
  function create(config) {
    const root = document.getElementById('my-quote-view');
    const main = document.getElementById('main');
    const nav = document.getElementById('open-my-quote');
    const toast = document.getElementById('quote-toast');
    let quote = Core.emptyQuote(), opened = false, exporting = false, storageError = '', removed = null;
    try { quote = Core.parseQuote(localStorage.getItem(Core.STORAGE_KEY)); }
    catch { storageError = 'Sačuvana ponuda nije mogla da se učita. Nova ponuda može da se preuzme u Excel.'; }
    const fields = [
      ['number','Broj ponude','text','npr. 01/26'],['date','Datum','date',''],
      ['preparedBy','Ponudu izradio/la','text','Ime i prezime'],['preparedPhone','Kontakt sastavljača','tel','Telefon'],
      ['client','Investitor / kontakt','text','Ime i prezime / naziv firme'],['address','Adresa','text','Ulica i broj'],
      ['city','Grad i poštanski broj','text','Grad, poštanski broj'],['email','Email investitora','email','Email adresa'],
      ['phone','Telefon investitora','tel','Telefon'],['taxId','PIB investitora','text','PIB'],
      ['registration','Matični broj investitora','text','Matični broj']
    ];
    function fieldMarkup([key,label,type,placeholder]) {
      return `<label class="quote-field"><span>${label}</span><input type="${type}" id="quote-${key}" data-quote-meta="${key}" value="${escape(quote.meta[key])}" placeholder="${placeholder}" maxlength="500" autocomplete="off"></label>`;
    }
    root.innerHTML = `<div class="quote-titlebar"><div><button type="button" class="quote-back" data-quote-action="back">← Nazad na katalog</button><h1 id="quote-heading" tabindex="-1">Moja ponuda</h1></div><button type="button" class="quote-download" id="quote-download">Preuzmi Excel <span aria-hidden="true">↓</span></button></div>
      <section class="quote-letterhead" aria-label="Zaglavlje ponude"><div class="quote-logos"><img class="quote-company-logo" src="${escape(asset('demetra-memorandum-logo.png'))}" alt="Originalni logotip DEMETRA RB"><img class="quote-standards" src="${escape(asset('demetra-memorandum-standardi.jpg'))}" alt="Znaci iz memoranduma: AQRA 45001:2018, NAC, ISO 14001:2015 i ISO 9001:2015"></div>
      <div class="quote-company"><div><p id="quote-description">${escape(quote.meta.description)}</p><a href="mailto:office@demetrarb.com">office@demetrarb.com</a><br><a href="https://demetrarb.com/BG/" target="_blank" rel="noopener noreferrer">demetrarb.com/BG/</a></div><p>Matični broj: <strong>06517293</strong><br>PIB: <strong>101713319</strong><br>Zarija Vujoševića 80<br>11070 Novi Beograd<br>+381 11 3112798</p></div>
      <details class="quote-header-fields"><summary>Podaci za zaglavlje ponude <span>Broj, datum i investitor</span></summary><form id="quote-meta-form" novalidate><div class="quote-field-grid">${fields.map(fieldMarkup).join('')}<label class="quote-field quote-field-wide"><span>Opis delatnosti</span><input data-quote-meta="description" maxlength="500" value="${escape(quote.meta.description)}"></label><label class="quote-field quote-field-wide"><span>Napomena uz ponudu</span><textarea data-quote-meta="note" maxlength="4000" rows="2">${escape(quote.meta.note)}</textarea></label></div></form></details></section>
      <div class="quote-list-heading"><h2>Izabrane stavke <span id="quote-line-count">0</span></h2><p>Cene su preuzete iz kataloga. Količinu i cenu možeš da izmeniš za ovu ponudu.</p></div>
      <div id="quote-items"></div><div class="quote-summary"><div><p id="quote-summary-status" role="status"></p><p class="quote-storage" id="quote-storage-status">Ponuda se čuva u ovom pregledaču.</p><button type="button" class="quote-clear" id="quote-clear">Isprazni ponudu</button></div><div class="quote-total"><span id="quote-total-label">Ukupno</span><strong id="quote-total">0,00 €</strong></div></div>
      <div id="quote-undo" class="quote-undo" hidden><span>Stavke su uklonjene.</span><button type="button" data-quote-action="undo">Vrati uklonjeno</button></div><p id="quote-export-status" class="quote-export-status" role="status"></p>`;
    const el = id => document.getElementById(id);
    function notify(message, showLink = false) {
      toast.innerHTML = `<span>${escape(message)}</span>${showLink ? '<button type="button" data-action="open-my-quote">Otvori ponudu</button>' : ''}<button type="button" data-quote-action="dismiss-toast" aria-label="Zatvori obaveštenje">×</button>`;
      toast.hidden = false;
    }
    function save() {
      el('quote-export-status').textContent = '';
      try { localStorage.setItem(Core.STORAGE_KEY, JSON.stringify(quote)); storageError = ''; }
      catch { storageError = 'Ponuda se trenutno čuva samo na otvorenoj stranici. Pre zatvaranja preuzmi Excel.'; }
      el('quote-storage-status').textContent = storageError || 'Ponuda se čuva u ovom pregledaču.';
    }
    function syncButtons() {
      const selected = new Set(quote.items.map(item => item.offerId));
      document.querySelectorAll('[data-action="add-to-quote"]').forEach(button => {
        const active = selected.has(button.dataset.offerId);
        button.disabled = active;
        button.classList.toggle('is-added', active);
        button.textContent = active ? '✓ U mojoj ponudi' : 'Dodaj u moju ponudu';
      });
      el('my-quote-count').textContent = String(quote.items.length);
      const count=quote.items.length, last=count%10, teen=count%100;
      const word=last===1&&teen!==11?'stavka':last>=2&&last<=4&&(teen<12||teen>14)?'stavke':'stavki';
      nav.setAttribute('aria-label', `Moja ponuda, ${count} ${word}`);
      nav.setAttribute('aria-expanded', String(opened));
    }
    function rowMarkup(item, index) {
      const id = escape(item.offerId), params = item.parameters.filter(([,value]) => value !== '' && value !== null);
      const short = params.filter(([,value]) => !/^nije navedeno|^nepoznat/i.test(String(value))).slice(0,3);
      return `<article class="quote-item" data-quote-row="${id}"><div class="quote-plant"><span class="quote-row-number">${index+1}</span><h3>${escape(item.latinName)}</h3><p class="quote-quick-params">${short.map(([label,value])=>escape(label+': '+value)).join(' · ') || 'Parametri nisu navedeni u katalogu.'}</p><details class="quote-parameters"><summary>Svi parametri i napomene</summary><dl>${[...params,...item.details].map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value || 'Nije navedeno')}</dd></div>`).join('')}</dl><label class="quote-field"><span>Moja napomena</span><textarea data-quote-item="${id}" data-quote-edit="note" maxlength="4000" rows="2">${escape(item.note)}</textarea></label><a href="#plant=${encodeURIComponent(item.plantId)}">Otvori karticu biljke ↗</a></details></div><div class="quote-nursery"><span class="quote-mobile-label">Rasadnik</span>${escape(item.nursery)}<small>${escape(item.country)}</small></div>
      <label class="quote-number"><span>Količina (${escape(item.unit)})</span><input aria-label="Količina: ${escape(item.latinName)}, stavka ${index+1}" inputmode="decimal" data-quote-item="${id}" data-quote-edit="quantity" value="${escape(item.quantity)}" maxlength="40"><small data-quote-error="quantity"></small></label>
      <label class="quote-number"><span>Cena (${escape(item.currency === 'EUR' ? '€' : item.currency)})</span><input aria-label="Cena ${escape(item.currency)}: ${escape(item.latinName)}, stavka ${index+1}" inputmode="decimal" data-quote-item="${id}" data-quote-edit="price" value="${escape(item.price)}" placeholder="Unesi cenu" maxlength="40"><small data-quote-error="price"></small><small class="quote-source-price">Katalog: ${item.sourcePrice === null ? 'nije navedena' : escape(Core.money(item.sourcePrice,item.currency))}</small></label>
      <div class="quote-amount"><span>Iznos</span><strong data-quote-amount>—</strong></div><button type="button" class="quote-remove" data-quote-remove="${id}" aria-label="Ukloni ${escape(item.latinName)}, stavka ${index+1}">×</button></article>`;
    }
    function renderItems() {
      el('quote-items').innerHTML = quote.items.length ? quote.items.map(rowMarkup).join('') :
        '<div class="quote-empty"><span aria-hidden="true">+</span><h3>Izaberi biljke za svoju ponudu</h3><p>Otvori karticu biljke, pronađi odgovarajuću ponudu rasadnika i izaberi „Dodaj u moju ponudu“.</p><button type="button" data-quote-action="back">Pronađi biljku →</button></div>';
      updateTotals(); syncButtons();
    }
    function updateTotals() {
      const summary = Core.summarize(quote), dateValid = Core.validDate(quote.meta.date);
      el('quote-line-count').textContent = String(quote.items.length);
      el('quote-total').innerHTML = summary.totals.length ? summary.totals.map(total=>escape(Core.money(total.amount,total.currency))).join('<br>') : Core.money(0);
      el('quote-total-label').textContent = summary.invalidCount ? 'Zbir popunjenih stavki' : 'Ukupno po unetim cenama';
      el('quote-download').disabled = exporting || !summary.ready || !dateValid;
      el('quote-clear').hidden = !quote.items.length;
      el('quote-summary-status').textContent = !dateValid ? 'Unesi datum ponude u zaglavlju.' : summary.invalidCount ?
        `Dopuni količinu ili cenu pre preuzimanja. Stavke za dopunu: ${summary.invalidCount}.` : !summary.safe ? 'Ukupan iznos je prevelik za izvoz.' :
        quote.items.length ? 'Excel sadrži jedan list „Moja ponuda“, sa stavkama i parametrima sadnica.' : '';
      const rows = root.querySelectorAll('[data-quote-row]');
      rows.forEach((row, index) => {
        const result = summary.rows[index]; if (!result) return;
        row.querySelector('[data-quote-amount]').textContent = result.valid ? Core.money(result.amount,quote.items[index].currency) : '—';
        for (const key of ['quantity','price']) {
          const input = row.querySelector(`[data-quote-edit="${key}"]`);
          input.setAttribute('aria-invalid', String(!result[key].valid));
          row.querySelector(`[data-quote-error="${key}"]`).textContent = result[key].valid ? '' : result[key].reason;
        }
      });
      el('quote-storage-status').textContent = storageError || 'Ponuda se čuva u ovom pregledaču.';
    }
    function hide() {
      opened = false; root.hidden = true; main.hidden = false; document.body.dataset.view = 'search'; syncButtons();
    }
    function open() {
      opened = true; config.onOpen?.(); renderItems();
      root.hidden = false; main.hidden = true; document.body.dataset.view = 'quote';
      document.title = 'Moja ponuda · demetra rb index';
      history.replaceState(null,'','#moja-ponuda'); syncButtons(); toast.hidden = true;
      el('quote-heading').focus({preventScroll:true}); window.scrollTo({top:0,behavior:'instant'});
    }
    function back() {
      hide(); document.title = 'demetra rb index'; history.replaceState(null,'','#search'); config.onClose?.();
    }
    async function download() {
      if (exporting || !Core.summarize(quote).ready || !Core.validDate(quote.meta.date)) return;
      exporting = true; updateTotals(); el('quote-export-status').textContent = 'Pripremam Excel ponudu…';
      const downloadQuote = Core.parseQuote(JSON.stringify(quote));
      try {
        const [Zip,response] = await Promise.all([loadZip(), fetch(asset('moja-ponuda-template.xlsx'), {cache:'no-store'})]);
        if (!response.ok) throw new Error('Obrazac ponude nije dostupan. Pokušaj ponovo.');
        const bytes = await Core.buildXlsx(await response.arrayBuffer(), downloadQuote, Zip);
        const url = URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
        const link = document.createElement('a'); link.href = url; link.download = Core.filename(downloadQuote.meta);
        document.body.appendChild(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),30000);
        el('quote-export-status').textContent = 'Excel ponuda je spremna. Možeš dalje da menjaš podatke i formule u Excelu.';
      } catch(error) { el('quote-export-status').textContent = error.message || 'Preuzimanje nije uspelo. Pokušaj ponovo.'; }
      finally { exporting = false; updateTotals(); }
    }
    root.addEventListener('input', event => {
      const target = event.target;
      if (target.dataset.quoteMeta) {
        quote.meta[target.dataset.quoteMeta] = target.value;
        if (target.dataset.quoteMeta === 'description') el('quote-description').textContent = target.value;
      } else if (target.dataset.quoteEdit) {
        const item = quote.items.find(item=>item.offerId === target.dataset.quoteItem);
        if (item) item[target.dataset.quoteEdit] = target.value;
      } else return;
      save(); updateTotals();
    });
    el('quote-meta-form').addEventListener('submit',event=>event.preventDefault());
    document.addEventListener('click', event => {
      if (opened && event.target.closest('.skip-link')) { event.preventDefault(); el('quote-heading').focus(); return; }
      const target = event.target.closest('button'); if (!target) return;
      if (target.dataset.action === 'open-my-quote') { open(); return; }
      if (target.dataset.action === 'add-to-quote') {
        try {
          const snapshot = config.getItem(target.dataset.offerId);
          if (!snapshot) throw new Error('Ova varijanta više nije dostupna u katalogu.');
          const added = Core.addItem(quote,snapshot); save(); syncButtons();
          notify(added ? snapshot.latinName + ' je dodata u ponudu.' : 'Ova varijanta je već u ponudi.',true);
        } catch(error) { notify(error.message); }
        return;
      }
      if (target.dataset.quoteAction === 'dismiss-toast') { toast.hidden = true; return; }
      if (!root.contains(target)) return;
      if (target.dataset.quoteAction === 'back') back();
      if (target.dataset.quoteRemove) {
        const index = quote.items.findIndex(item=>item.offerId===target.dataset.quoteRemove);
        if (index < 0) return;
        removed = {items:quote.items.map(item=>({...item})),meta:null}; quote.items.splice(index,1);
        el('quote-undo').hidden = false; save(); renderItems();
      }
      if (target.id === 'quote-clear') {
        removed = {items:quote.items.map(item=>({...item})),meta:null}; quote.items=[];
        el('quote-undo').hidden=false; save(); renderItems();
      }
      if (target.dataset.quoteAction === 'undo' && removed) {
        const ids = new Set(quote.items.map(item=>item.offerId));
        quote.items = [...removed.items.filter(item=>!ids.has(item.offerId)),...quote.items];
        removed = null; el('quote-undo').hidden=true; save(); renderItems();
      }
      if (target.id === 'quote-download') download();
    });
    syncButtons(); renderItems();
    return {open,hide,refresh:syncButtons,isOpen:()=>opened};
  }
  window.DemetraQuote = {create};
})();
