# Provera nabavnih cena u evrima

Od 23.11.2026. novi ulazi i buduća automatska ažuriranja cena koriste EUR.
Automatsko preuzimanje NBS kursa i periodično preračunavanje su isključeni.
GitHub nema ovlašćenje da prepisuje cenu samo zato što se kurs promenio.

Jutarnji postupak radi od ponedeljka do petka u 08:45 po lokalnom vremenu
Europe/Budapest. Poslovni računar, aplikacija i odobreni poslovni folder moraju
biti dostupni. GitHub radnim danima proverava objavljenu potvrdu pregleda;
njegov workflow ima samo dozvolu za čitanje. GitHub potvrda pokreće se u 09:15 UTC\n(10:15 zimi, 11:15 leti po lokalnom vremenu), posle jutarnje poslovne obrade. Fotografska pretraga ima nezavisan
raspored i nastavlja da radi na GitHub-u i kada poslovni računar nije uključen.

Provera poredi isti rasadnik, biljku/kultivar, sve mere, jedinicu i izvornu cenu.
Potvrđena promena u EUR može da se primeni. Nova ili promenjena cena u drugoj
valuti ostaje izdvojena za proveru, bez automatske konverzije ili promene oznake
valute. Dopune kataloga prolaze isti pregled izvornog reda i registara izuzetaka.
Za postojeći arhivski dokument valuta se ne pretpostavlja ponovo prema ovom pravilu.

Ranije dinarske ponude zadržavaju izvorne iznose, valutu, već prikazanu cenu u EUR
i dokaze istorijske konverzije. data/exchange-rates.json ostaje arhivski dokaz sa
svojim stvarnim datumom, a ne današnji kurs. Offline provere proveravaju te
istorijske podatke bez kontakta sa NBS-om.

scripts/update_exchange_rates.mjs i stara jednokratna ispravka srpskih cenovnika
su povučeni: direktan poziv vraća izričit skipped/disabled rezultat, bez mrežnih
zahteva i upisa. Workflow stare migracije uklonjen je. Za jutarnju pripremu se
koristi scripts/prepare_morning_prices.mjs; originalne ponude su samo za čitanje.

Online cene nisu izvor nabavnih cena. Ranije uputstvo za update_prices.py je
zamenjeno ovim postupkom. Online katalozi rasadnika koriste se za fotografije.
