# demetra rb index

Postojeći izgled stranice je sačuvan u **`index.html`**. Podaci, fotografije i fontovi nalaze se u ovom repozitorijumu. Za rad aplikacije nisu potrebni baza na drugom servisu, prijava korisnika ni plaćeni API.

## Prvo postavljanje

1. Napravi javni repozitorijum **demetra-rb-index**, sa glavnom i podrazumevanom granom **main**.
2. Raspakuj ZIP i prenesi ceo sadržaj u koren repozitorijuma. `index.html` je odmah u korenu. Uključi i fasciklu **`.github`**.
3. Otvori **Settings → Pages → Build and deployment → Source → GitHub Actions**.
4. Otvori **Actions → Objavi Demetra katalog → Run workflow → main**. Kada provera i objava prođu, adresu sajta dobijaš u **Settings → Pages**.
5. Za probu osvežavanja izaberi **Actions → Osvezi javne cene → Run workflow → main**. U završenom izvršavanju pogledaj **Summary**.

Običan push na `main` nadalje automatski proverava i objavljuje stranicu. Ako prvi push prethodi podešavanju Pages, korak 4 ponavlja objavu posle podešavanja.

Za lokalno isprobavanje iz ove fascikle pokreni `python3 -m http.server 8000` i otvori `http://localhost:8000/`. Katalog se učitava preko HTTP-a; direktan dvoklik na HTML nije način lokalnog pokretanja.

## Tri povezane datoteke

| Datoteka | Sadržaj |
| --- | --- |
| `data/biljke.json` | 619 biljaka sa dokazom u ponudama ili upitima iz dostavljenog materijala. |
| `data/rasadnici.json` | 22 rasadnika sa rukopisnog spiska. |
| `data/kataloske-stavke.json` | 3.250 povezanih zapisa, sa `plantId` i `nurseryId`, dimenzijama, fotografijama, cenom i izvorom. |

Promena podatka u trećoj datoteci prikazuje se na odgovarajućoj biljnoj kartici posle sledeće objave. Identifikatori povezuju podatke, pa promena redosleda u datoteci ne menja vezu biljke i rasadnika.

Katalozi dopunjavaju **isključivo postojeći spisak biljaka iz ponuda**. Automatska provera cena ne dodaje nove biljke, rasadnike niti zamenske kultivare. `scripts/catalog-scope.json` čuva odobrene identifikatore i dokaze porekla bez naziva privatnih dokumenata. Validator odbija biljke izvan tog obuhvata.

## Automatsko ažuriranje cena

Ugrađena su dva GitHub Actions postupka:

- **Objavi Demetra katalog** — provera svih veza, datoteka i fotografija, pa objava na GitHub Pages.
- **Osvezi javne cene** — jednom dnevno oko **04:17 UTC** i na ručni zahtev proverava javne stranice, čuva uspešne izmene u `main` i neposredno pokreće objavu.

U ovom izdanju povezano je **31 javno objavljenih cenovnih varijanti za 19 biljaka**, na **19 konkretnih stranica**: BIOJela 24 varijante, Vitorović šest i Lorberg jedna. Njihovi tačni URL-ovi, identitet biljke, varijanta, valuta i jedinica nalaze se u `scripts/price-sources.json`; čita ih `scripts/update_prices.py`.

Provera zahteva poklapanje proizvoda i konkretne varijante. Kod Vitorovića iznos označava pakovanje od 104 sadnice. Jedinica je prikazana na kartici. Javno objavljena kataloška cena i ugovorena nabavna cena imaju različito značenje; ova automatizacija proverava javnu cenu.

Ako se stranica ne otvori, promeni naziv ili varijantu, sakrije cenu, navede nulu ili drugu valutu, prethodni podatak i njegov datum ostaju sačuvani. Actions Summary prikazuje broj uspešnih i neuspešnih provera. Pojedinačni neuspeh ne sprečava osvežavanje ostalih ispravno povezanih izvora.

Za rasadnike koji cene daju na upit ili iza prijave automatsko čitanje cene nije uključeno. Dodavanje njihovog javnog cenovnika radi se kroz novi, provereni izvor i odgovarajući parser. Ne pokreće se široka internet pretraga koja bi uvodila nove biljke ili proizvoljne prodavce.

`GITHUB_TOKEN` je ugrađeni token za ovaj repozitorijum; dodatni Secrets nisu potrebni. Pravila repozitorijuma moraju dozvoljavati workflow-u upis u `main`. Zaštićena grana ili organizaciona zabrana upisa prijavljuju se kao greška; postupak ih ne zaobilazi.

## Šta podaci trenutno potvrđuju

- 619 biljaka potiče iz 1.720 razrešenih pojavljivanja u ponudama/upitima; pregledano je 108 dokumenata tog obuhvata.
- Opšti katalozi i lager-liste korišćeni su samo za povezivanje tih biljaka sa rasadnicima sa spiska.
- Osam biljaka još nema potvrđen zapis rasadnika sa spiska. One imaju karticu sa jasnim praznim stanjem. Još 233 biljke za sada imaju samo dokaz naziva u materijalu rasadnika.
- 57 nedovoljno određenih pojavljivanja, uključujući zapise samo na nivou roda, sačuvano je u `docs/nazivi-za-potvrdu.json`. Ne prikazuju se kao potpuno određene vrste.
- Fotografija pripada navedenom rasadniku i predstavlja kataloški prikaz; ne potvrđuje izgled konkretne sadnice na današnjem lageru. Izvor fotografije ostaje povezan sa karticom.
- Neobjavljene dimenzije i cene ostaju prazne. Datum provere javne stranice prikazan je odvojeno od datuma izvornog kataloga.

Privatne ponude služe kao dokaz naziva biljaka. U ovaj paket nisu uključeni izvorni dokumenti, privatne nabavne cene, imena kupaca ili telefonski kontakti iz rukopisnih beležaka.

## Organizacija

- `index.html` — cela stranica: HTML, izgled, animacije i pretraga.
- `data/` — tri povezane datoteke koje stranica učitava.
- `assets/` i `fonts/` — lokalne fotografije i postojeći vizuelni elementi.
- `.github/workflows/` — objava i dnevno osvežavanje.
- `scripts/` — kontrola obuhvata, izvori i program za proveru cena.
- `docs/` — sažetak obuhvata i evidencija za dopunu podataka.

GitHub Pages objavljuje samo `index.html`, tri datoteke u `data/`, fotografije i fontove. Celokupan sadržaj javnog repozitorijuma ostaje javno dostupan kroz GitHub.

## Besplatno hostovanje

GitHub Pages je dostupan uz GitHub Free za javne repozitorijume. Standardni GitHub Actions runneri za javne repozitorijume su besplatni. Ovaj paket koristi te mogućnosti i standardni `github.io` domen, bez dodatnog hosting servisa.

Raspored može kasniti u odnosu na navedeni minut. GitHub isključuje zakazane workflow-e u javnom repozitorijumu posle 60 dana bez aktivnosti; po potrebi ih ponovo uključi u **Actions**. Ručno pokretanje je dostupno preko **Run workflow**.

### Zvanična uputstva

- [GitHub Pages: GitHub Actions kao izvor objave](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [Besplatna objava i korišćenje Actions za javni repozitorijum](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [Zakazano pokretanje i pravilo neaktivnosti](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Zašto se objava neposredno poziva nakon automatskog commita](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs)
