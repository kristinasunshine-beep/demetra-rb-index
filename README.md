# demetra rb index

Jedna stranica `index.html`, tri povezane datoteke u `data/` i lokalne fotografije/fontovi. Sve se nalazi u postojećem GitHub repozitorijumu i objavljuje kroz njegov GitHub Pages postupak.

## Izvor podataka

**Cene, mere, tip sadnice i napomene potiču isključivo iz dostavljenog `Rasadnici ponude.zip`. Online se osvežavaju samo fotografije.** Raniji raspored cena i online dopuna botaničkih mera su isključeni.

| Datoteka | Sadržaj |
| --- | --- |
| `data/biljke.json` | 619 postojećih biljaka iz dostavljenih ponuda/upita. Nove biljne vrste nisu dodavane. |
| `data/rasadnici.json` | 24 rasadnika; Royal Garden i Lorenz von Ehren povezani su na osnovu originalnih dokumenata za 12 već postojećih biljaka. |
| `data/kataloske-stavke.json` | 3.079 arhivskih zapisa povezana preko `plantId` i `nurseryId`, sa merama, cenom, tipom, napomenama i dokazom izvora. |

Od 3.079 zapisa, 2.948 je aktivno, 14 je izdvojeno za proveru, a 117 starih zapisa zamenjeno je preciznijim vezama. Sačuvano je prethodnih 2.351 iznosa, a iz originalnih ODS redova obnovljena su još 54; ukupno je 2.405 zapisa sa iznosom. Valuta, jedinica mere i današnja dostupnost ne dopisuju se ako ih izvor ne potvrđuje. Cene nose datum izvornog dokumenta i nisu predstavljene kao današnji cenovnik.

Osam biljnih kartica nema pouzdanu aktivnu ponudu: sada prikazuju razlog u odeljku **Tačnost podataka**, naziv priloga ili link ka ispravno određenoj postojećoj biljci. Sve su dostupne kroz pretragu.

## Polja digitalne kartice

- **Tip sadnice**: Standard ili Multistem, samo uz izričitu oznaku u ponudi; inače „Nije navedeno u ponudi”, uz objašnjenje.
- **Svi tipovi sadnica prikazuju sve poznate parametre u glavnom panelu:** tip, obim, visinu, širinu krošnje, veličinu busena, veličinu saksije, način isporuke i broj presađivanja. Raniji naziv „Obim stabla” više se ne koristi.
- Obim i visina ostaju u svojim poljima za standardne i multistem sadnice. Podatak se ne sklanja u napomenu zbog tipa sadnice; jedna mera nikad se ne preimenuje u drugu.
- **Broj presađivanja** ima svoje polje u glavnom panelu, sa izvornom oznakom, npr. **3 (3xv)**.
- Svaka protumačena mera prikazuje se jednom, u odgovarajućem polju. Sirova **Specifikacija iz ponude** sačuvana je u bazi, a uklonjena iz prikaza. Dodatne karakteristike — visina čistog debla, oblikovana krošnja i forma — imaju svoja polja. Izvorna dimenzija bez potvrđene ose ostaje posebno označena; već raspoređena mera ne ponavlja se pod generičkim nazivom.
- **Tačnost podataka** objašnjava nepoznat tip, neoznačenu meru, više varijanti, upit ili ponuđenu zamenu.
- Širina krošnje, veličina busena, veličina saksije, način isporuke i cena ostaju vezani za isti izvorni red/varijantu.

`STD 25–30` ne dokazuje visinu: u proverenom Arbor redu to je obim. Za takav standard glavni panel prikazuje Obim sadnice 25–30 i Način isporuke Busen (RB); visina ostaje nenavedena ako nije data. Isto pravilo važi za sve kartice.

## Prenos ovog paketa

1. Raspakujte paket preko postojeće lokalne kopije repozitorijuma **demetra-rb-index**, u isti folder u kome već stoji `index.html`. Spojite foldere i zamenite istoimene fajlove iz ovog paketa.
2. Uradite commit i push na `main` (ili **Commit to main → Push origin** u GitHub Desktop-u).
3. Sačekajte zelenu oznaku **Actions → Objavi Demetra katalog**, pa osvežite javni sajt pomoću **Ctrl+F5**.

Ovo je paket izmena za postojeći repozitorijum. Foto dopuna uključuje nove fotografije, povezane foto podatke, evidenciju nastavka i novi sadržaj postojećeg `.github/workflows/update-photos.yml`. Prenesite ih zajedno, uz očuvane putanje.

Za prenos preko browsera pogledajte `POCNI-OVDE.txt`. Novi foto workflow treba zameniti direktno u postojećem `.github/workflows`, bez dodatnog ugnježdenog foldera. Podešavanje **Settings → Pages → Source → GitHub Actions** ostaje isto.

## Automatizacija

- `deploy.yml`: proverava povezane podatke i objavljuje sajt posle push-a na `main`.
- `update-photos.yml`: **Pronadji i osvezi fotografije** pokreće se posle push-a relevantnih podataka/foto fajlova na `main`, svakog dana u **04:23 UTC**, ili ručno kroz **Actions → Pronadji i osvezi fotografije → Run workflow**. Pronalaženje, preuzimanje, osvežavanje i naknadna objava rade automatski. Okidači važe kada novi fajl stigne na `main`.
- `update-prices.yml`: nema raspored ni preuzimanje podataka; ručno prikazuje da je osvežavanje cena isključeno. Svi važeći workflow fajlovi nalaze se neposredno u `.github/workflows`.
- Zaštita u starim skriptama za cene i parametre vraća `disabled_by_source_policy` bez mrežnih zahteva i bez izmene kataloga.

Foto pipeline prvo proverava fotografije tačne kombinacije biljke i rasadnika, zatim pronalazi nove izvore preko javnih stranica i sitemap dokumenata. Kada nema potvrđene slike rasadnika, može prikazati **posebno označenu referentnu fotografiju** sa potvrdom taksona, izvorom, autorom i licencom. Referenca vrste za kultivar izričito je označena i ne predstavlja potvrđenu fotografiju tog kultivara ili ponuđene sadnice. Fotografije ne potvrđuju cenu, lager ili dimenziju.

Redovi za nastavak čuvaju se u `docs/photo-refresh-state.json`, `docs/photo-discovery-state.json` i `docs/reference-photo-state.json`. Posao traje najviše 30 minuta, uz ograničene zahteve; sledeći prolaz nastavlja preostali posao. Neuspešan izvor čuva prethodnu sliku, a praznine ostaju evidentirane. Nema obećanja 100% pokrivenosti dok svi potrebni izvori i identiteti nisu stvarno potvrđeni.

Početni snimak foto dopune od **9. 11. 2026.**: **65 od 619 biljaka** ima fotografiju; **242 aktivne ponude** imaju sliku rasadnika, **12** označenu referencu, a **2.694** čekaju dopunu. Pokrivenost ponuda je **8,62%**. Aktuelni brojevi posle svake obrade nalaze se u `docs/photo-coverage.json`; detalji faza su u `docs/photo-pipeline-report.json`. Nova obrada uključila je 23 stvarno preuzete Lorberg fotografije. Lokalna obrada paketa ne znači da je nova verzija već objavljena na GitHub-u.

Sve fotografije, veze, konfiguracije i izveštaji ostaju u postojećem repozitorijumu. Rešenje koristi GitHub Pages i standardni Actions runner za javni repozitorijum, bez dodatnog plaćenog servisa; uslovi privatnih repozitorijuma razlikuju se. Postupak prenosa, automatizacija i zvanični GitHub uslovi opisani su u `docs/PHOTO-UPDATES.md`.

Nova ponuda se obrađuje iz novog dokumenta, sa svojim datumom i redom; ne prepisuje drugu veličinu ili kultivar samo zato što ima isto ime vrste. `sourceEvidence` čuva naziv fajla, SHA-256, list/stranu/red gde su dostupni. Izvorni ZIP nije potreban u javnom folderu sajta.

## Provera i evidencija

Prolaze 194 Python testa, provera kataloga, regresiona provera prikaza i izvršavanje stvarnog renderer-a za svih 619 kartica. CSS, heder, fontovi i animacije imaju isti izvorni kod kao prethodno postavljena verzija; dopunjen je sadržaj kartica.

Za lokalni pregled pokrenite `python3 -m http.server 8000` iz repozitorijuma i otvorite `http://localhost:8000/`. Proveru podataka pokreće `node scripts/check-catalog.mjs`.

Aktuelni izveštaj je `docs/semantic-panels-migration-report.json`. U ovom prolazu dopunjena su glavna polja 556 zapisa, uključujući 522 visine. Svih 19 preostalih zbirnih zapisa je razrešeno; aktivne varijante imaju pojedinačne izvorne redove. Svih 2.948 aktivnih panela prikazuje parametre bez duplirane sirove specifikacije. Šest nezavisnih primera, dva odvojena Abies Glauca reda i 129 eksplicitnih izvornih kolona sprečavaju objavu ako se poznati podatak izgubi u tekstu. Provera izvršava stvarni HTML renderer. Raniji izveštaji (`all-fields-migration-report.json`, `catalog-repair-report.json`, `arbor-import-repair.json`) ostaju istorijski tragovi, sa brojkama prethodnih izdanja.

## Ponovljiva obrada podataka

`scripts/migrate-panel-data.py` obrađuje postojeće arhivske specifikacije bez internet zahteva. Bez argumenata prikazuje pregled; `python3 scripts/migrate-panel-data.py --output data/kataloske-stavke.json` primenjuje promene. Ponovni prolaz ne menja već ispravljene podatke. Objava radi kroz postojeći GitHub Actions postupak.
