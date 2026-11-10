# Fotografije za svih 619 biljaka

Ovaj postupak zamenjuje prethodni foto workflow. Čita ceo `data/biljke.json`, pa obuhvata svih 619 biljaka i automatski uključuje buduće nove biljke. Broj postojećih veza sa fotografijama ne ograničava pretragu.

## Prenos na GitHub

1. Raspakuj ZIP u lokalnu kopiju repozitorijuma **demetra-rb-index**, u folder gde je `index.html`. Spoji foldere uz zamenu istoimenih fajlova iz paketa. Sačuvaj postojeće ostale fajlove i fotografije.
2. Prenesi sve fajlove paketa i uradi commit/push na **main**. Uključi i skriveni folder **`.github`**, posebno `.github/workflows/update-photos.yml`. Ako koristiš GitHub u pregledaču, proveri da je ovaj fajl zaista ažuriran; po potrebi ga otvori i zameni njegov sadržaj. Sam ZIP ne treba postavljati kao zamenu za raspakovane fajlove.
3. Otvori **Actions → Fotografije za sve biljke**. Push pokreće obradu automatski; možeš je pokrenuti i preko **Run workflow → main → Run workflow**.
4. Posle uspešne obrade sačekaj i posao **publish**. On poziva postojeći workflow za GitHub Pages. Osveži sajt pomoću **Ctrl+F5**.

Repozitorijum mora dozvoljavati Actions upis na `main`, a Pages treba da ostane podešen na **GitHub Actions**. Ako zaštita grane blokira botov push, to će biti prijavljeno kao greška; workflow ne zaobilazi zaštitu. Paket sam po sebi ne objavljuje promene.

## Kako bira fotografiju

Postojeće ispravne fotografije se zadržavaju. Za biljke koje čekaju sliku redosled je: **rasadnik iz ponude → drugi odobreni rasadnik → Wikimedia Commons → GBIF**. Paket koristi postojeća pravila rasadničkih izvora i uključenu foto konfiguraciju; nije potrebno ručno povezivanje svake biljke.

Pre mrežne pretrage automatski se obnavljaju pouzdane veze sa fotografijama iz ranije arhive projekta. Moraju se poklopiti tačna biljka, rasadnik, lokalna putanja i izvorna stranica, a završni deo URL-a mora odgovarati punom botaničkom nazivu. Ako je ista slika nejasno povezana sa različitim kultivarima, odbacuju se sve sporne veze. Ovo je obnova postojeće arhivske evidencije, bez tvrdnje da je udaljeni izvor ponovo potvrđen.

Traži se pun botanički naziv, uključujući kultivar. Fotografija vrste ne zamenjuje automatski fotografiju njenog kultivara. Približan naziv, nejasan identitet ili nepodržana prava korišćenja ostavljaju biljku u spisku za dopunu. Slika se pre povezivanja proverava i čuva lokalno u `assets/biljke/`.

Javne kartice prikazuju fotografiju bez dodatnog foto panela, tehničkih oznaka, autora, licence ili izvornog URL-a. Podaci biljke čuvaju putanju slike i izvorni URL; dokazi pretrage ostaju u zasebnoj evidenciji. Rasadničke fotografije koriste već uspostavljena pravila izvora u ovom katalogu; ta oznaka nije nova pravna provera dozvole. Commons/GBIF automatski dopunjuju samo fotografije sa izričitom podržanom CC0 ili public-domain oznakom konkretnog medija, bez obaveze navođenja autora na kartici. Ranije reference koje su bile samo primer vrste za kultivar ili zahtevale javnu atribuciju ne pretvaraju se u potvrđene slike kultivara.

## Izveštaj i nastavak

| Fajl | Sadržaj |
| --- | --- |
| `docs/photo-coverage.json` | Stvarna pokrivenost celog kataloga i biljke koje još čekaju fotografiju. |
| `docs/full-photo-state.json` | Sačuvan red pretrage, pokušaji i nastavak narednog prolaza. |
| `docs/full-photo-manifest.json` | Izvori, potvrde identiteta, postojeće rasadničko pravilo ili potvrđena otvorena licenca medija. |
| `docs/photo-pipeline-report.json` | Rezultat poslednje obrade i eventualne greške. |

Jedan prolaz osvežava indeks do 3 minuta, zatim obrađuje fotografije do 20 minuta uz najviše 2.500 zahteva. Koristi do osam paralelnih pretraga, uz najviše dva istovremena zahteva ka istom izvoru. Potvrđeni kandidati se čuvaju za nastavak. Svaki prolaz obuhvata ceo katalog u izveštaju; pretrage koje nisu stale u budžet nastavljaju se iz sačuvanog reda. Biljke za koje odgovarajuća slika nije pronađena ponovo dolaze na red nakon jednog dana. Zadržan je postojeći dnevni raspored u **04:23 UTC** (05:23 zimi, 06:23 leti po srednjoevropskom vremenu). Moguće je i ručno ponovno pokretanje.

**Obuhvat svih 619 biljaka nije potvrda da svih 619 već ima odgovarajuću fotografiju.** Merodavan je rezultat u izveštaju. Nedostupni izvori i nepotvrđeni kultivari ostaju vidljivi u evidenciji, bez nasumičnih zamena.

Cene, mere, nazivi, ponude i struktura sajta ostaju sačuvani. Ako se `main` promeni tokom rada, upis se zaustavlja i obrada se ponavlja nad novim stanjem kataloga. Ne vrši se automatsko spajanje zastarelih foto odluka.

Lokalna provera bez pretrage izvora:

```text
python scripts/full_photo_coverage.py --audit-only
node scripts/check-catalog.mjs
python scripts/full_photo_coverage.py --validate-only
```

Verzije potrebne za GitHub posao proverene su u zvaničnim izvorima: [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-python v7.0.0](https://github.com/actions/setup-python/releases/tag/v7.0.0), [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) i [Pillow 13.0.0](https://pypi.org/project/pillow/13.0.0/).
