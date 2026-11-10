# Fotografije: automatsko pronalaženje, dopuna i osvežavanje

**Online se menjaju samo fotografije.** Cena, valuta, mere, tip sadnice, broj presađivanja, dostupnost i izvorne napomene ostaju vezani za odgovarajući red iz dostavljenog **Rasadnici ponude ZIP-a**. Foto automatizacija ih ne dopunjuje niti prepisuje.

## Kada se obrada pokreće

Workflow **Pronadji i osvezi fotografije** nalazi se u `.github/workflows/update-photos.yml` i ima tri okidača:

- **Push na `main`** koji menja podatke kataloga, foto skripte, foto konfiguraciju, fotografije, njihovu evidenciju ili sam foto workflow. Zato prvi prenos ovog paketa pokreće novu obradu bez ručnog klika na Run workflow.
- **Svakog dana u 04:23 UTC** — 05:23 zimi i 06:23 leti po beogradskom vremenu. Zakazano pokretanje može kasniti; raspored nije obećanje završetka u tačan minut.
- **Ručno**, kada je potrebno: **Actions → Pronadji i osvezi fotografije → Run workflow**.

Ovi okidači počinju da važe kada novi fajlovi zaista stignu na `main` postojećeg GitHub repozitorijuma. Lokalno pripremljen ZIP sam po sebi ne menja javni sajt i ne zakazuje GitHub posao.

## Šta se radi u jednom prolazu

`scripts/catalog_photo_pipeline.py` povezuje sledeće faze:

1. **Osvežavanje već povezanih fotografija.** Proverava podržanu stranicu proizvoda ili ranije potvrđen direktan izvor slike. Red za osvežavanje pamti sledeći zapis, tako da ograničenje broja zahteva ne zadržava posao zauvek na prvim karticama.
2. **Dopuna drugih veličina iste biljke u istom rasadniku.** Potvrđena lokalna fotografija može se koristiti za više ponuda samo kada se poklapaju i `plantId` i `nurseryId`. Fotografija jednog rasadnika ne postaje fotografija drugog rasadnika.
3. **Pronalaženje novih izvora.** `scripts/discover_nursery_photos.py` čita javne robots/sitemap dokumente i stvarno pronađene linkove rasadnika. Ne izmišlja URL-ove proizvoda. Stranica mora potvrditi pun botanički naziv ili odgovarajući puni evidentirani naziv; kratak naziv kultivara i približno poklapanje nisu dovoljni.
4. **Preuzimanje i provera.** Potvrđena fotografija dolazi samo sa odobrenog izvora, proverava se kao stvarna slika i čuva kao lokalni JPEG. Više pronađenih produktnih stranica istog rasadnika ostaje povezano za naredna osvežavanja.
5. **Jasno označena referentna fotografija.** `scripts/reference_photos.py` pokušava javni Wikimedia/Wikidata izvor sa potvrdom taksona, autorom, izvornom stranicom i odgovarajućom otvorenom licencom. Referenca se čuva na biljci, odvojeno od fotografije rasadnika. Kada postoji samo referenca vrste za određeni kultivar, kartica to izričito označava; takva slika ne predstavlja potvrđen izgled tog kultivara ili ponuđene sadnice. Za naziv koji ne potvrđuje vrstu ne bira se proizvoljna druga vrsta.
6. **Izveštaj i nastavak.** Čuva se stvarna pokrivenost, preostali posao i razlozi zbog kojih pojedini izvori još nisu potvrđeni.

Ako izvor nema javnu fotografiju, vraća grešku, zahteva pristup koji nije dostupan ili ne potvrđuje identitet, polje ostaje u evidenciji za nastavak. Prethodna ispravna slika ostaje sačuvana. Arhitektura omogućava postepenu dopunu i redovno osvežavanje, ali **ne potvrđuje 100% pokrivenosti dok to stvarni podaci ne pokažu**.

## Gde se čuvaju podaci

| Putanja | Uloga |
| --- | --- |
| `data/kataloske-stavke.json` | Fotografija tačne ponude/rasadnika: `image`, `imageKind`, `imageSourceUrl`. Ostala polja foto posao ne menja. |
| `data/biljke.json` | `plant.photo` za odvojenu referentnu fotografiju, sa izvorom, autorom, licencom i nivoom poklapanja. |
| `assets/biljke/` | Lokalne JPEG fotografije koje sajt koristi bez zavisnosti od udaljenog prikaza slike. |
| `scripts/photo-sources.json` | Odobreni izvori fotografija i potvrđene putanje proizvoda. |
| `scripts/photo-discovery.json` | Pravila i ograničenja pronalaženja izvora. |
| `docs/fotografije.json` | Veza fotografije sa tačnom biljkom, rasadnikom, ponudom i izvornom stranicom. |
| `docs/photo-refresh-state.json` | Cursor za nastavak osvežavanja povezanih fotografija; nastaje pri prvom takvom prolazu. |
| `docs/photo-discovery-state.json` | Pronađene stranice, potvrđene veze, pokušaji i red za nastavak pretrage. |
| `docs/reference-photo-state.json` | Rezultati i red za nastavak referentnih fotografija. |
| `docs/photo-coverage.json` | Aktuelna pokrivenost i spisak preostalih biljaka/ponuda bez slike. |
| `docs/photo-pipeline-report.json` | Rezultat poslednjeg celog prolaza, faze, greške izvora i izmene. |

Sve ostaje u istom repozitorijumu. Nema dodatne baze u oblaku, Cloudflare-a ili plaćenog pretraživačkog API-ja.

## Ograničenja rada i zaštita kataloga

Jedan GitHub posao traje najviše **30 minuta**. Pipeline ima vremenski budžet **25 minuta**, najviše **120 povezanih zapisa za osvežavanje**, **120 zahteva za pronalaženje izvora** i **180 zahteva referentnom servisu**. To su gornje granice, a ne obećani brojevi novih fotografija. Kratki vremenski limiti, veličina odgovora, broj kandidata i sačuvani redovi sprečavaju neograničenu pretragu. Preostali posao nastavlja se u sledećem prolazu; neuspešni izvori imaju period za ponovnu proveru.

Faze rade u privremenim kopijama. Pre upisa se proveravaju sva nefoto polja, identiteti i redosled zapisa, metapodaci i izvorna politika. Cene, mere, kultivar ili izvorni red ne mogu se promeniti usput. Greška pojedinog izvora ne briše postojeću fotografiju. Promena glavnih fajlova tokom rada ili konflikt pri push-u zaustavlja upis umesto da prepiše tuđu izmenu.

Workflow koristi Python 3.13 i Pillow 13.0.0, proveru kataloga i foto/source-policy testove. Commit obuhvata samo fotografske podatke, slike, dozvoljene foto izvore i evidenciju nastavka. U ovom paketu proverena su **61 foto testa i 3 testa zabrane online promene nefoto podataka**.

## Objavljivanje na postojećem GitHub-u

1. Raspakujte novi paket preko lokalne kopije postojećeg repozitorijuma, u folder gde je `index.html`. Spojite foldere i sačuvajte tačne putanje, uključujući početnu tačku u `.github/workflows/update-photos.yml`. Nemojte praviti dodatni ugnježdeni folder `workflows`.
2. Uradite commit i push na `main`. Postojeće podešavanje **Settings → Pages → Source → GitHub Actions** ostaje važeće. Repozitorijum mora dozvoljavati pokretanje Actions poslova i upis njihovog foto commit-a na `main`.
3. U **Actions** pratite **Objavi Demetra katalog** i **Pronadji i osvezi fotografije**. Prvi objavljuje preneti paket; foto posao zatim čuva svoju dopunu i izričito poziva postojeći `deploy.yml` da objavi najnovije slike. Nije potrebno ručno pokretanje za svaku izmenu.
4. Posle uspešnog posla `publish` osvežite javni sajt pomoću **Ctrl+F5**. Brojevi i preostali posao vide se u Summary foto workflowa i navedenim JSON izveštajima.

Botov commit ne treba oslanjati na pokretanje drugog workflowa običnim push okidačem; zato je naknadni `deploy.yml` pozvan direktno iz foto workflowa.

Za postojeći **javni repozitorijum**, GitHub Pages je dostupan uz GitHub Free, a standardni GitHub-hosted runner koji ovaj workflow koristi besplatan je za javne repozitorijume. Ovo nije obećanje neograničenog besplatnog rada privatnih repozitorijuma ili plaćenih runnera. Zvanični uslovi: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) i [GitHub Actions billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage).

## Provereni početni snimak ovog paketa

Posle stvarnog lokalnog pronalaženja/preuzimanja i spajanja sa ažuriranim arhivskim varijantama, **9. 11. 2026.**:

| Pokazatelj | Broj |
| --- | ---: |
| Biljke sa najmanje jednom fotografijom | 65 / 619 |
| Aktivne ponude sa fotografijom svog rasadnika | 242 |
| Aktivne ponude sa označenom referentnom fotografijom | 12 |
| Aktivne ponude koje još čekaju sliku | 2.694 |
| Pokrivenost aktivnih ponuda | 8,62% |

U novom prolazu stvarno su preuzete **23 nove Lorberg fotografije**. Referentni servis u toj proveri vratio je API grešku; postojeće potvrđene reference su sačuvane. Ovaj snimak nije tvrdnja da je nova verzija već objavljena na GitHub-u. Posle narednih obrada merodavan je aktuelni `docs/photo-coverage.json`.

## Ranije automatizacije cena i mera

`update-prices.yml` nema raspored i ne preuzima online cene. Ranije skripte `update_prices.py` i `update_catalog_parameters.py` poštuju `sourcePolicy.nonPhoto = "rasadnici-ponude-zip"`: za takve podatke vraćaju `disabled_by_source_policy`, bez internet zahteva i izmene kataloga. U foto workflowu nema poziva za ažuriranje cena ili botaničkih mera.
