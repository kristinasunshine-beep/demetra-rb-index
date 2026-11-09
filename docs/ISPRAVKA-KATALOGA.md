# Podaci iz ponuda u glavnom panelu — 9. novembar 2026.

## Ispravljen uzrok

Prethodna provera potvrđivala je prikaz već popunjenih polja JSON-a. Nije otkrivala poznate podatke koji su ostali samo u specifikaciji. Ekstrakcija sada obrađuje dodatne dobavljačke oznake, a provera sadrži nezavisne primere iz originalnih redova.

Svaka aktivna varijanta koristi glavni panel sa poljima **Tip sadnice, Obim sadnice, Visina sadnice, Širina krošnje, Veličina busena, Veličina saksije, Način isporuke i Broj presađivanja.** U istom panelu prikazuju se dodatne karakteristike i cela **Specifikacija iz ponude**. Footer čuva izvor, datum i objašnjenje tačnosti.

## Primer iz prijave

Izvor: `Rasadnici ponude.zip`, `special stocklist Demetra.xlsx`, list `Voorraad 9460`, red 5. C5 sadrži `14-16 Ho 3xv` za Acer Norwegian Sunset.

| Polje glavnog panela | Vrednost |
| --- | --- |
| Tip sadnice | Standard |
| Obim sadnice | 14–16 |
| Broj presađivanja | 3 (3xv) |
| Specifikacija iz ponude | Acer Norwegian Sunset; Izvorna oznaka: 14-16 Ho 3xv |

U tom fajlu nema kolone cene ni pakovanja. Visina i veličina busena ne izvode se iz obima. Jedinica koja nije upisana uz meru u konkretnom izvoru nije dopisana.

## Globalna primena

| Stavka | Broj |
| --- | ---: |
| Postojeće biljke | 619 |
| Arhivski zapisi | 3.035 |
| Provereni aktivni paneli | 2.927 |
| Zapisi sa dopunjenim ili normalizovanim glavnim poljima | 807 |
| Dopunjeni tipovi | 253 |
| Dopunjeni obimi | 279 |
| Dopunjene visine | 133 |
| Dopune i normalizacije načina isporuke | 467 |
| Dopunjene širine krošnje | 6 |
| Dopunjene saksije | 1 |
| Dodatne karakteristike u panelima | 1.797 |
| Sačuvani iznosi iz arhive | 2.351 |

Svaka aktivna varijanta prikazuje svoju izvornu specifikaciju u glavnom panelu. Neodređena mera dobija polje **Dimenzija iz ponude** sa izvornom vrednošću. Različite veličine i ponuđene alternative zadržavaju sopstveni izvor. Podaci drugog reda ne prepisuju se ovoj sadnici.

## Tumačenje oznaka

Ho/HS/HST čitaju se kao standard u odgovarajućem holandskom kontekstu; pripadajući raspon je obim. MS/MSTEM i jasne multistem oznake čuvaju svoj tip i meru. Lorberg H, Sol Baum, mDb, br i StU imaju posebna pravila. H uz 3xv nije visina 3; mDb označava pakovanje. Običan SOL ili STR ne proglašava se standardom.

STD/RB, CLT, C, CS/P, CG, DRKL, KL, WOODBOX i AIRPOT čitaju se u dobavljačkom kontekstu. Visina čistog debla, oblikovana krošnja, forma, broj etaža i broj grana imaju svoja polja. Broj presađivanja zadržava izvorni kod i eventualni raspon.

Proverene zamke: `1/2 STD` nije obim 1–2; `STEM220C130L` razdvaja čisto deblo i saksiju; Ball u nazivu kultivara nije automatski forma. Obim, visina i veličina busena ne menjaju značenje prema tipu sadnice.

Numeričke vrednosti potiču isključivo iz arhive. Za značenje kodova korišćena su objašnjenja rasadnika: [Lorberg](https://www.lorberg.com/en-gb/list-of-abbreviations), [Bogaert](https://www.boomkwekerij-bogaert.be/malus-toringo-brouwers-beauty-10-12-hoogstam-wortelgoed), [Wykeham](https://www.wykehammatureplants.co.uk/help-advice/caring-for-your-plants/root-condition-explained/). Sa interneta nisu preuzimane cene, botaničke visine ili dimenzije za kartice.

## Provera pre objave

Postojeći deploy poziva `scripts/check-catalog.mjs`. Provera sada obuhvata sva glavna polja, presađivanje, dodatne karakteristike i punu specifikaciju. Pet nezavisnih redova iz arhive zaustavlja objavu ako poznat podatak nedostaje: Mauritz Ho/3xv, Arbor STD/RB, Arbor MULTISTEM/C230L, Volentis MS/DRKL i Lorberg H/3xv/mDb.

Prošlo je 132 Python testa, test prikaza i provera svih 2.927 aktivnih panela. Dodatno je provereno 108 neaktivnih istorijskih zapisa. Ponovna migracija daje identične podatke. HTML i CSS pre skripta identični su prethodnom paketu, pa su heder, izgled, fontovi i animacije sačuvani. Provera je izvršavala stvarni HTML renderer; vizuelni browser pregled nije izvršen.

## Prenos

Raspakujte paket, prenesite sadržaj u koren postojećeg repozitorijuma i uradite **Commit changes** na `main`. Postojeći GitHub Actions automatski objavljuje izmenu. Uputstvo je u `POCNI-OVDE.txt`. Aktuelni izveštaj je `docs/all-fields-migration-report.json`; raniji izveštaji su istorijski. Online se i dalje osvežavaju samo fotografije.
