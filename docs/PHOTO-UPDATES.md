# Online se osvežavaju samo fotografije

Svi ostali podaci digitalne kartice — cena, valuta, mere, tip sadnice, broj presađivanja i napomene — potiču iz dostavljenog **Rasadnici ponude ZIP-a**. Čuvaju se uz tačan izvorni red i datum ponude. Internet automatizacija ih ne dopunjuje niti menja.

## Fotografije

Workflow **Osvezi kataloske fotografije** pokreće se ponedeljkom u **04:47 UTC** (05:47 po beogradskom zimskom vremenu, 06:47 leti) i ručno preko **Actions → Osvezi kataloske fotografije → Run workflow**. Raspored postaje aktivan po prenosu fajla na podrazumevanu granu `main`; GitHub može odložiti zakazano pokretanje.

Skripta `scripts/update_photos.py` koristi postojeću vezu tačne biljke i rasadnika. Proverava podržanu stranicu proizvoda ili ranije potvrđen direktan izvor slike, čuva JPEG u `assets/biljke/`, ažurira samo fotografska polja zapisa i vodi poreklo u `docs/fotografije.json`. Podržana politika izvora obuhvata 13 rasadnika; obrađuju se samo stvarno povezani zapisi, bez dodavanja biljaka ili rasadnika.

Za ponudu iz ZIP-a adresa fotografije može stajati u `photoSourcePage` ili `imageSourceUrl`, odvojeno od izvora poslovnih podataka. Ako postoji upisana fotografija sa manifestom, njen potvrđeni izvor ima prednost. Fotografija drugog rasadnika ne koristi se kao zamena. Ako stranica, identitet proizvoda ili slika ne prođu proveru, prethodna fotografija ostaje sačuvana, a neuspeh se vidi u Actions izveštaju.

Pre snimanja se proverava da su sva nefoto polja svakog zapisa nepromenjena, uključujući izvor, cenu, obim, visinu, `seedlingType`, `transplantNote`, `dataAccuracyNote` i politiku izvora. Posle uspešnog upisa workflow poziva postojeći `deploy.yml` da objavi fotografije na GitHub Pages.

## Ranije automatizacije cena i mera

Svih 31 ranijih javnih cenovnih izvora u `scripts/price-sources.json` sada ima `enabled: false`. `update-prices.yml` nema raspored, nema pristup za pisanje i nema preuzimanje sa interneta; ručno pokretanje prikazuje samo obaveštenje o novom pravilu izvora.

Za kompatibilnost sa ranijim paketima isti bezopasni fajl zamenjuje i stari pogrešno ugnježden put `.github/workflows/.github/workflows/update-prices.yml`. To nije nova automatizacija.

Obe ranije skripte, `update_prices.py` i `update_catalog_parameters.py`, imaju zaštitu na `sourcePolicy.nonPhoto = "rasadnici-ponude-zip"`. Čak i ako ih pozove stari workflow, vratiće `disabled_by_source_policy`, napraviće **0 internet zahteva** i sačuvaće podatkovnu datoteku bez izmene. U foto workflow-u nema poziva za ažuriranje cena ili botaničkih mera.

## Prenos na GitHub

1. Prenesite sve fajlove paketa preko postojećeg checkout-a, uz očuvane putanje `.github/workflows/`, `scripts/`, `data/` i `docs/`.
2. Postojeći `deploy.yml` nastavlja objavljivanje sajta. Za proveru fotografija pokrenite **Osvezi kataloske fotografije** iz kartice **Actions**.
3. Sačekajte uspešan posao `publish`, pa osvežite stranicu pomoću **Ctrl+F5**.

Foto posao koristi fiksirani Python 3.13 i Pillow 13.0.0, proveru kataloga, 14 testova fotografija i tri testa zabrane online promene nefoto podataka. Commit obuhvata samo fotografije, njihov manifest i fotografska polja kataloga. Konflikt sa paralelnom izmenom prekida upis bez forsiranog prepisivanja.
