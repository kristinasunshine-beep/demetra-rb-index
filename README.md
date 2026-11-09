# demetra rb index

Jedna stranica `index.html`, tri povezane datoteke u `data/` i lokalne fotografije/fontovi. Sve se nalazi u postojećem GitHub repozitorijumu i objavljuje kroz njegov GitHub Pages postupak.

## Izvor podataka

**Cene, mere, tip sadnice i napomene potiču isključivo iz dostavljenog `Rasadnici ponude.zip`. Online se osvežavaju samo fotografije.** Raniji raspored cena i online dopuna botaničkih mera su isključeni.

| Datoteka | Sadržaj |
| --- | --- |
| `data/biljke.json` | 619 postojećih biljaka iz dostavljenih ponuda/upita. Nove biljne vrste nisu dodavane. |
| `data/rasadnici.json` | 24 rasadnika; Royal Garden i Lorenz von Ehren povezani su na osnovu originalnih dokumenata za 12 već postojećih biljaka. |
| `data/kataloske-stavke.json` | 3.035 arhivska zapisa povezana preko `plantId` i `nurseryId`, sa merama, cenom, tipom, napomenama i dokazom izvora. |

Od 3.035 zapisa, 2.927 je aktivno, 12 je izdvojeno za proveru, a 96 starih zapisa zamenjena su preciznijim vezama. Sačuvan je 2.351 stvarni iznos iz arhive. Valuta, jedinica mere i današnja dostupnost ne dopisuju se ako ih izvor ne potvrđuje. Cene nose datum izvornog dokumenta i nisu predstavljene kao današnji cenovnik.

Osam biljnih kartica nema pouzdanu aktivnu ponudu: sada prikazuju razlog u odeljku **Tačnost podataka**, naziv priloga ili link ka ispravno određenoj postojećoj biljci. Sve su dostupne kroz pretragu.

## Polja digitalne kartice

- **Tip sadnice**: Standard ili Multistem, samo uz izričitu oznaku u ponudi; inače „Nije navedeno u ponudi”, uz objašnjenje.
- **Svi tipovi sadnica prikazuju sve poznate parametre u glavnom panelu:** tip, obim, visinu, širinu krošnje, veličinu busena, veličinu saksije, način isporuke i broj presađivanja. Raniji naziv „Obim stabla” više se ne koristi.
- Obim i visina ostaju u svojim poljima za standardne i multistem sadnice. Podatak se ne sklanja u napomenu zbog tipa sadnice; jedna mera nikad se ne preimenuje u drugu.
- **Broj presađivanja** ima svoje polje u glavnom panelu, sa izvornom oznakom, npr. **3 (3xv)**.
- **Specifikacija iz ponude** u celosti je u glavnom panelu. Dodatne karakteristike — visina čistog debla, oblikovana krošnja, forma i slično — imaju svoja polja. Neoznačena mera prikazuje se kao **Dimenzija iz ponude**, bez proizvoljne zamene obima i visine.
- **Tačnost podataka** objašnjava nepoznat tip, neoznačenu meru, više varijanti, upit ili ponuđenu zamenu.
- Širina krošnje, veličina busena, veličina saksije, način isporuke i cena ostaju vezani za isti izvorni red/varijantu.

`STD 25–30` ne dokazuje visinu: u proverenom Arbor redu to je obim. Za takav standard glavni panel prikazuje Obim sadnice 25–30 i Način isporuke Busen (RB); visina ostaje nenavedena ako nije data. Isto pravilo važi za sve kartice.

## Prenos ovog paketa

1. Raspakujte paket preko postojeće lokalne kopije repozitorijuma **demetra-rb-index**, u isti folder u kome već stoji `index.html`. Spojite foldere i zamenite istoimene fajlove iz ovog paketa.
2. Uradite commit i push na `main` (ili **Commit to main → Push origin** u GitHub Desktop-u).
3. Sačekajte zelenu oznaku **Actions → Objavi Demetra katalog**, pa osvežite javni sajt pomoću **Ctrl+F5**.

Ovo je paket izmena za postojeći repozitorijum. Koristi već postavljene fotografije, fontove i `data/biljke.json`. Njih ne treba ponovo deliti u grupe za otpremanje.

Za prenos preko browsera pogledajte `POCNI-OVDE.txt`. Ova dopuna ne sadrži workflow fajlove; već sređen `.github/workflows` ostaje kako jeste. Podešavanje **Settings → Pages → Source → GitHub Actions** ostaje isto.

## Automatizacija

- `deploy.yml`: proverava povezane podatke i objavljuje sajt posle push-a na `main`.
- `update-photos.yml`: ponedeljkom u 04:47 UTC ili ručno kroz **Actions → Osvezi kataloske fotografije → Run workflow** proverava povezane fotografske izvore i ponovo objavljuje uspešne promene.
- `update-prices.yml`: nema raspored ni preuzimanje podataka; ručno prikazuje da je osvežavanje cena isključeno. Svi važeći workflow fajlovi nalaze se neposredno u `.github/workflows`.
- Zaštita u starim skriptama za cene i parametre vraća `disabled_by_source_policy` bez mrežnih zahteva i bez izmene kataloga.

Fotografija se preuzima samo za potvrđenu kombinaciju biljke i odgovarajućeg rasadnika. Neuspešna provera čuva prethodnu sliku. Fotografija ne potvrđuje cenu, raspoloživost ili dimenziju sadnice. Detalji su u `docs/PHOTO-UPDATES.md`.

Nova ponuda se obrađuje iz novog dokumenta, sa svojim datumom i redom; ne prepisuje drugu veličinu ili kultivar samo zato što ima isto ime vrste. `sourceEvidence` čuva naziv fajla, SHA-256, list/stranu/red gde su dostupni. Izvorni ZIP nije potreban u javnom folderu sajta.

## Provera i evidencija

Prolaze 132 Python testa, provera kataloga, regresiona provera prikaza i izvršavanje stvarnog renderer-a za svih 619 kartica. CSS, heder, fontovi i animacije imaju isti izvorni kod kao prethodno postavljena verzija; dopunjen je sadržaj kartica.

Za lokalni pregled pokrenite `python3 -m http.server 8000` iz repozitorijuma i otvorite `http://localhost:8000/`. Proveru podataka pokreće `node scripts/check-catalog.mjs`.

Aktuelni izveštaj je `docs/all-fields-migration-report.json`. Dopunjena ili normalizovana su glavna polja u 807 zapisa; 1.797 dodatnih karakteristika prikazuje se u panelima. Svih 2.927 aktivnih panela prikazuje punu izvornu specifikaciju. Pet nezavisnih primera iz ponuda zaustavlja proveru ako poznat podatak ponovo nedostaje, čak i ako je prazno polje i u JSON-u. Provera `scripts/check-catalog.mjs` pre objave izvršava stvarni renderer za sve kartice i proverava da je svaki poznati parametar u glavnom panelu. `docs/catalog-repair-report.json` i `docs/arbor-import-repair.json` ostaju jasno označeni istorijski tragovi ranijih uvoza. Njihovi stari zbirni brojevi i pravila osvežavanja ne opisuju ovo izdanje.

## Ponovljiva obrada podataka

`scripts/migrate-panel-data.py` obrađuje postojeće arhivske specifikacije bez internet zahteva. Bez argumenata prikazuje pregled; `python3 scripts/migrate-panel-data.py --output data/kataloske-stavke.json` primenjuje promene. Ponovni prolaz ne menja već ispravljene podatke. Objava radi kroz postojeći GitHub Actions postupak.
