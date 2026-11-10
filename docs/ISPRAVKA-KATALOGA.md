# Ispravno raspoređivanje mera — 9. novembar 2026.

## Konkretan primer: 100–150 WRB

U originalnoj Volentis ponudi 75953, za četinarske sadnice, `100-150 WRB` znači visinsku klasu 100–150 i isporuku sa busenom u žičanoj korpi. Jedinica koja nije upisana u izvoru nije naknadno dodata.

| Glavno polje | Vrednost |
| --- | --- |
| Visina sadnice | 100–150 |
| Način isporuke | Busen u žičanoj korpi (WRB) |

Vrednost se više ne ponavlja pod „Dimenzija iz ponude“. Sirova „Specifikacija iz ponude“ uklonjena je iz prikaza, a sačuvana u JSON-u kao dokaz izvora. Isto pravilo važi za sve kartice. Broj presađivanja i stvarne dodatne karakteristike ostaju u svom polju.

## Obuhvat ispravke

| Stavka | Broj |
| --- | ---: |
| Biljke, bez proširenja spiska | 619 |
| Rasadnici | 24 |
| Aktivne varijante | 2.948 |
| Ukupni zapisi, sa istorijskim zamenjenim zapisima | 3.079 |
| Zapisi sa dopunjenim glavnim poljima u ovom prolazu | 556 |
| Dopunjene visine | 522 |
| Dopunjeni obimi | 37 |
| Dopunjeni načini isporuke | 37 |
| Dopunjene saksije | 9 |
| Dopunjene veličine busena | 2 |
| Razrešeni zbirni zapisi | 19 |
| Preostali aktivni zbirni zapisi | 0 |

Brojevi dopuna polja mogu biti veći od broja izmenjenih zapisa. Ovo su nove dopune preko prethodno prenetih podataka.

Pravila su proverena kroz originalne oznake i dobavljački kontekst. Visina, obim, prečnik busena, prečnik saksije i visina čistog debla nisu međusobno zamenjivani. Gola veličina bez potvrđene ose, naročito oblikovana krošnja ili fotografija sa dve dimenzije u nazivu, ne pretvara se proizvoljno u visinu. Takvi izvorni podaci ostaju posebno označeni.

## Razdvojene varijante i odgovori rasadnika

Originalna Mauritz tabela `ponuda Marina Dorćol.ods`, list `Blad1`, redovi 119 i 131, sadrži zasebne zahteve za Abies concolor 'Glauca', sa visinama 100–150 i 150–200. Sada postoje dve odvojene varijante sa svojim visinama i RB pakovanjem.

U odgovoru rasadnik navodi zamenu „concolor“. Cene 87,45 EUR i 121 EUR zato su povezane sa zasebnim ponuđenim varijantama **Abies concolor**, a nisu pripisane traženom kultivaru 'Glauca'. Status kartice razlikuje specifikaciju upita i arhiviranu ponudu. Veze između odgovarajućih izvora i varijanti sačuvane su u podacima.

Svih 19 preostalih zbirnih zapisa je razrešeno. Jednake ponuđene varijante iz dva reda nisu predstavljene kao dve identične kartice: njihovi dodatni izvorni dokazi su sačuvani zajedno. Dve nejasne oznake „Columnare“ sačuvane su za proveru identiteta, umesto da budu objavljene kao potvrđeni kultivar „Columnaris“.

## Cene iz originalne arhive

Ponovljena provera originalnih ODS ćelija vratila je još **54 iznosa**: 43 cene neposredno odgovarajućih redova i 11 cena jasno razdvojenih ponuđenih alternativa. Prethodnih **2.351** iznosa je sačuvano bez promene. Ukupno sada postoji **2.405** zapisa sa iznosom.

Svaka nova cena ima originalni red, ćeliju, SHA-256 datoteke i dokaz valute. To su arhivirane cene, a ne potvrda današnje cene ili lagera. Internet automatizacija i dalje menja samo fotografije.

## Provere pre objave

`node scripts/check-catalog.mjs` izvršava stvarni renderer svih 2.948 aktivnih panela i proverava još 131 neaktivan zapis. Provera obuhvata 5.945 popunjenih parametara, 129 eksplicitnih izvornih kolona, šest fiksnih primera iz ponuda i dva zasebna Abies Glauca reda. Objava se prekida ako se poznata visina ponovo izgubi u tekstu, ako se aktivne varijante spoje ili ako se ista izvorna specifikacija vrati kao duplikat.

Prolazi 194 Python testa. Nove provere obuhvataju razdvajanje zahteva i ponuđene zamene, tačnost izbora cenovnog reda, prirodne i oblikovane forme, fotografije i zabranu internet promene nefoto podataka.

Izgled stranice, heder, fontovi i animacije zadržani su. Ispravka menja raspored i sadržaj podataka u karticama i podršku za fotografije.

## Datoteke za proveru

- `docs/semantic-panels-migration-report.json`: svaka dopuna polja i njen izvor.
- `docs/source-row-materialization-report.json`: razdvojeni redovi i provereni izvorni fajlovi.
- `docs/ods-price-recovery-report.json`: 43 neposredno obnovljene ODS cene; 11 ponuđenih alternativa ima dokaz u samom zapisu.
- `docs/photo-coverage.json`: aktuelna pokrivenost fotografijama i preostali red za obradu.
- `docs/PHOTO-UPDATES.md`: automatsko dopunjavanje fotografija.

Paket je namenjen dopuni postojećeg repozitorijuma. Koraci su u `POCNI-OVDE.txt`.
