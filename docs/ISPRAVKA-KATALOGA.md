# Dopunjene digitalne kartice — samo izvori iz arhive

## Novo pravilo

Cena, valuta, mere, tip sadnice, napomena o presađivanju i napomena o tačnosti potiču isključivo iz dostavljenog **Rasadnici ponude.zip**. Online izvor sme menjati samo fotografiju i njenu evidenciju.

## Stanje posle dopune

| Stavka | Broj |
| --- | ---: |
| Postojeće biljke | 619 |
| Rasadnici | 24 |
| Arhivski zapisi | 2.872 |
| Aktivni zapisi | 2.838 |
| Iznosi iz arhive | 2.351 |
| Standard, izričito označen | 647 |
| Multistem, izričito označen | 269 |
| Bez jednoznačno određenog tipa | 1.956 |
| Zapisi sa napomenom o presađivanju | 75 |
| Zapisi sa vezom do proverenog fajla u ZIP-u | 2.872 |

Brojevi tipova uključuju i istorijske zapise izdvojene iz aktivnog prikaza. Među aktivnim zapisima su 644 standardna, 267 multistem i 1.927 bez jednoznačnog tipa. Svi su sačuvani pod postojećim biljnim identifikatorima.

Popunjene su 428 ranije prazne izvorne specifikacije iz tabela, PDF-ova i opisnih imena originalnih fotografskih priloga. Dodato je 15 arhivskih zapisa za 12 već postojećih biljaka, sa stvarnim rasadnicima Royal Garden i Lorenz von Ehren. Sedam od tih zapisa potiče iz upita bez dobavljačke cene; to je jasno navedeno.

Iz aktivnog kataloga uklonjeno je 850 internet kataloških redova, uključujući 31 online cenu. Njihove fotografske adrese i identiteti sačuvani su zasebno u `photo-reference-catalog.json`, bez cena, dimenzija ili dostupnosti. Fotografija je prevezana samo kada se poklapaju ista biljka i isti rasadnik. Podaci iz arhive nisu dopunjavani merama odrasle biljke sa interneta.

## Prikaz mera i tipa

| Tip iz ponude | Glavni parametar na kartici | Ostala izvorna mera |
| --- | --- | --- |
| Standard | Visina sadnice | Izvorni obim, kada postoji, u napomeni |
| Multistem | Obim sadnice | Izvorna visina, kada postoji, u napomeni |
| Nije određen | Obim sadnice i Visina sadnice | Samo stvarno navedene mere, uz napomenu o tipu |

`STD`, `standard`, `MULTISTEM`, `MSTEM` i jasne oznake istog značenja razvrstavaju se prema izvornom redu. `HS`, `HST`, `FTH`, `SOL` i slične oznake bez legende ne pretvaraju se automatski u standard ili multistem. Više varijanti u istom starom zbirnom zapisu ostaje zabeleženo u `sourceSpecifications`; zajednički tip ili mera nisu proizvoljno dodeljeni.

Oznake `Nxv`, `Nxtr`, izričito opisano presađivanje i označeni rimski brojevi čuvaju se u **Napomeni o presađivanju**. Raspon, npr. II/III, ostaje raspon. Količina komada, dimenzija 3×4 m ili broj grana nisu broj presađivanja.

## Provereni primeri

| Izvorni zapis | Cena | Mere i napomena |
| --- | --- | --- |
| Arbor: Acer campestre Elsrijk 25-30 STD RB | 450 EUR/kom | Standard. Visina nije navedena; obim 25–30 ostaje u napomeni. |
| Arbor: Acer platanoides Cleveland 25-30 STD RB | 280 EUR/kom | Standard. Isti princip, zaseban izvorni red. |
| Arbor: Acer campestre Elsrijk 10-12 STD C80L | 210, valuta nije navedena | Druga varijanta: obim 10–12, posuda 80 L. |
| Lorenz: Gleditsia triacanthos Spectrum | 1.200 EUR/kom | Multistem; oznaka `5xtr` daje napomenu o pet presađivanja. Neoznačene mere ostaju u izvornom opisu. |

Arbor PDF S2526-02956 ima datum 23.02.2026. i važenje do 25.03.2026. Prikazana cena je cena te arhivirane ponude, a ne potvrda današnje raspoloživosti. Izvorna tabela od 15.04.2026. nema označenu valutu; iznos je prikazan uz tu napomenu.

## Nepouzdane ili nepotpune veze

Dvanaest zapisa ostaje `needs_review`, zbog različite vrste u zahtevu i odgovoru, precrtanog reda, zajedničke cene za više mogućih zamena ili lista bez potvrđenog izdavaoca. Ne prikazuju se kao potvrđena ponuda. Dvadeset dva generička ili skraćena stara zapisa imaju status `superseded` i vezu prema preciznijem zapisu.

Osam biljaka zbog toga nema aktivnu ponudu: sedam kartica prikazuje objašnjenje iz izvora i naziv priloga, a nepotpuni Liquidambar ‘Gum’ vodi na već postojeću karticu ‘Gum Ball’. Prazan podatak označava ograničenje dokumenta; druga vrsta, mera ili cena ne ubacuju se kao zamena.

## Objavljivanje i automatizacija

Pratite `POCNI-OVDE.txt`. Paket se raspakuje preko postojećeg repozitorijuma, zatim commit/push na `main`. Uključuje obe putanje starog cenovnog workflow-a, sada bez rasporeda i bez mrežnog rada. Jedini aktivni postupak za internet podatke je **Osvezi kataloske fotografije**.

Provera zaštite pokrenuta je i na konačnoj podatkovnoj datoteci: obe stare skripte vratile su `disabled_by_source_policy`, sa 0 zahteva i identičnim bajtovima kataloga pre i posle pokretanja.

## Šta je provereno

- 93 Python testa prolaze.
- Sve 619 kartice izvršene su kroz stvarni renderer iz `index.html`, uključujući 2.838 aktivnih varijanti i dodatnu proveru 34 neaktivna zapisa.
- Provereni su tip, pravilo mera, napomene, postojeći iznosi, osam objašnjenja praznog stanja i link ka ispravljenom kultivaru.
- Proverene su veze biljaka/rasadnika, dozvoljeni obuhvat, postojeće lokalne slike i YAML konfiguracija.
- CSS i HTML pre skripte identični su GitHub verziji sa početka ove ispravke.
- Živa browser sesija i GitHub izvršavanje ovog novog paketa nisu pokrenuti; objava sledi posle korisničkog push-a.

Mašinski izveštaj sa dokazima je `docs/source-only-report.json`. Prethodni izveštaji sa starim brojevima označeni su kao istorijski. Polazni GitHub commit: `5afcf78dbba29c355ec1c39975e6520be084d4ec`.
