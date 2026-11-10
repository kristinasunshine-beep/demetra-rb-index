# Ispravka kataloga — 10. novembar 2026.

Ovaj paket se nadovezuje na postojeći repozitorijum `kristinasunshine-beep/demetra-rb-index`, na proverenu verziju `008d2b46e934138ec9901180d2a7d9db16e31fe0`. Sadrži samo 15 izmenjenih ili novih datoteka. Zadržava svih 619 biljaka, 24 rasadnika i 3.079 izvornih zapisa: 2.948 aktivnih i 131 skriveni.

## Šta je popravljeno

Pregledano je svih 670 aktivnih zapisa sa nerazvrstanim merama, kao i jedan povezan zapis sa ponavljanjem. Na osnovu originalne arhive `Rasadnici ponude.zip` ispravljeno je 597 zapisa. Jedan zapis može imati više ispravljenih polja.

| Polje | Broj promenjenih zapisa |
|---|---:|
| Visina sadnice | 299 |
| Obim sadnice | 260 |
| Širina krošnje | 20 |
| Veličina saksije | 5 |

Oznake kao što je `1/2 STD` sačuvane su kao forma sadnice, a ne kao brojčana mera. Ispravljene su i potpune dimenzije oblikovanih biljaka. Tražena dimenzija i dimenzija stvarno ponuđene varijante ostaju razdvojene.

### Konkretni primeri

- **Aesculus flava ‘Vestita’, Combinatie Mauritz:** `18-20 Cont.` → obim `18–20`, kontejner, cena `80,50 €`. Druga varijanta ima obim `20–25` i cenu `92 €`. Visina nije izmišljena. Ista pregledana gramatika izvora primenjena je na 42 odgovarajuća reda tog cenovnika.
- **Acer ‘Norwegian Sunset’:** obim `20–25` prikazuje se u odgovarajućem polju bez ponavljanja kroz specifikaciju i napomenu. Cena 265 i izvorni status valute ostaju isti.
- **Cedrus atlantica ‘Glauca’:** obim `40–45`, visina `500+` i čista visina stabla `200` prikazuju se zasebno. Prethodno je `500+` bilo pogrešno u polju za obim.
- **Ginkgo biloba ‘Globus’:** obim je ispravljen na `20–25`; dodatno `150+` ostaje uz posebno objašnjenje, jer izvor ne razlikuje ukupnu i čistu visinu.

Mere, cene i način isporuke potiču iz dostavljenih ponuda. Za svaki pregledani zapis sačuvani su izvor, red/ćelija, pravilo tumačenja i prethodna vrednost. Pravila se primenjuju samo na odgovarajući izvorni zapis. Nova obrada ne vraća ispravljene mere u generičko polje.

## Prikaz bez ponavljanja

Zajednički prikaz kartica uklanja ponovljenu generičku meru kada je ista vrednost već navedena pod odgovarajućim parametrom. Uklonjene su i konkretno prepoznate ponovljene rečenice u napomenama. Izvorni tekst ostaje sačuvan u podacima i evidenciji. Napomene koje objašnjavaju stvarno ograničenje izvora, jedinicu ili razliku između traženog i ponuđenog ostaju dostupne.

CSS, zaglavlje, tipografija, animacije i postojeći izgled stranice sačuvani su. Cene, valute, fotografije, identiteti zapisa i povezanost biljaka sa rasadnicima nisu menjani ovom korekcijom mera.

## Šta izvor još ne razjašnjava

Preostalo je **75 pregledanih zapisa sa nerazjašnjenim aspektom mere**: 74 još imaju nerazvrstanu generičku meru, a kod jednog Ginkga obim je ispravljen, ali druga mera ostaje nejasna. To nisu neprovereni redovi: navedeni su sa razlogom u `docs/measurement-axis-unresolved.json`. Nejasna mera nije proizvoljno pretvorena u visinu ili obim.

Kompletna evidencija korekcija je u `scripts/archive-measurement-axes.json`, a završna provera u `docs/measurement-axis-review.json`.

## Fotografije

Stanje provereno u repozitorijumu 10. novembra u 08:16 UTC: **82 od 619 biljaka imaju bar jednu fotografiju; 537 ih još nema**. Fotografiju rasadnika imaju 283 aktivna zapisa, referentnu fotografiju 12, a bez fotografije je 2.653 zapisa. Jedna biljka može imati više zapisa i rasadnika.

Paket čuva sve fotografije iz te verzije i popravlja dva zastoja automatizacije:

1. Pretraga sada nastavlja od sledećeg neobrađenog kandidata, umesto da u svakom prolazu ponavlja samo prve tri adrese.
2. Greška jednog servisa za referentne fotografije više ne prekida odmah nezavisnu pretragu drugog servisa. Čuvaju se i precizniji podaci o grešci.

Ove ispravke omogućavaju nastavak pretrage. Ne garantuju da je za svaku kombinaciju biljke i rasadnika dostupna odgovarajuća fotografija. Identitet biljke, sorta, poreklo fotografije i uslovi korišćenja i dalje se proveravaju. U ovom koraku nisu dodate nove internet fotografije niti su menjani podaci iz ponuda.

## Provera

- Prošlo je 212 Python testova.
- Prošao je `node scripts/check-catalog.mjs`: 619 biljaka, 2.948 aktivnih kartica i 131 skriveni zapis; proverena su 6.524 poznata parametra.
- Prošao je `node scripts/tests/test_card_render.mjs`.
- Provereno je da su sve promene ograničene na odobrena polja i da se ponovnim pokretanjem migracije ne menjaju već ispravljene vrednosti.
- Direktni vizuelni pregled lokalne verzije nije bio dostupan cloud pregledaču; provera stvarnog HTML prikaza kartica izvršena je Node proverama.

## Kako preneti ovu izmenu na GitHub

1. Raspakuj ZIP.
2. U korenu postojećeg repozitorijuma, tamo gde je sada `index.html`, izaberi **Add file → Upload files**. Prenesi raspakovani `index.html` i foldere `data`, `scripts` i `docs`, zajedno u jednom unosu. Prenosi njihov sadržaj sa postojećim putanjama; ne dodaj spoljašnji folder nazvan po ZIP-u i ne otpremaj sam ZIP.
3. Izaberi **Commit changes** na `main`. Postojeći workflow za objavu pokreće se automatski na tu promenu. Novi fajlovi će biti dodati, a istoimeni zamenjeni.

Ovaj paket ne sadrži `assets` ni `.github`, jer tu nema promena. Postojeće fotografije, skripte koje nisu menjane i workflow datoteke ostaju u repozitorijumu. Nemoj brisati repozitorijum niti postojeće foldere pre prenosa.

## Status objave

Asistent nije objavio ovaj paket: i nakon uspešne GitHub potvrde uređaja, radno okruženje je blokiralo GitHub API, a automatska kontrola odobravanja odbila je proširenje mrežnog pristupa.

Pored toga, proverena prethodna objava na GitHub Pages završila se greškom **“Timeout reached, aborting!”** u završnom koraku objavljivanja. Zato sajt još može da prikazuje prethodni HTML. Uspešan posao za fotografije nije isto što i uspešna objava stranice.

Posle novog prenosa proveri završni status objave u **Actions**. Tek uspešan završetak tog koraka potvrđuje da je paket dostupan online. Ako se isti timeout ponovi, u tom neuspelom run-u izaberi **Re-run failed jobs**; nema potrebe da ponovo prenosiš ZIP ili da svaki put ručno pokrećeš celokupni katalog. Osvežavanje pregledača samo po sebi ne popravlja neuspelu objavu.

Provereni run: https://github.com/kristinasunshine-beep/demetra-rb-index/actions/runs/42780427187
