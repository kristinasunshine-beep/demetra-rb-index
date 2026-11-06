# Automatska provera javnih cena

`scripts/update_prices.py` koristi samo Python 3.11+ standardnu biblioteku. Nema instalacije paketa, prijavljivanja na rasadničke portale, slanja obrazaca ili pretraživanja novih biljaka. Proverava isključivo unapred pregledane URL-ove iz `scripts/price-sources.json` i menja postojeće stavke u `data/kataloske-stavke.json`.

## Šta se ažurira

Podržani izvori su BIOJela, Rasadnik Vitorović i izabrana javna Lorberg varijanta. Izvori bez javne numeričke cene, uključujući pregledane kataloge Gold i Zelene Pločice, nemaju izmišljenu zamensku cenu ili generičko izvlačenje brojeva iz teksta. Za njih konfiguracija može imati `enabled: false` i razlog `no_public_numeric_price`.

Uspešna provera ažurira cenu, valutu, postojeću oznaku jedinice, javni poreski navod, datum provere i stanje koje izvor izričito prikazuje. Ako izvor ne daje stanje zaliha, zapis kaže da ono nije potvrđeno. Dimenzije, fotografije, identitet biljke/rasadnika i broj zapisa ostaju isti. Cene su javno prikazane cene; nisu ugovorene nabavne cene firme.

Vitorović: cena ostaje za **pakovanje od 104 sadnice**. Updater ne deli cenu sa 104. BIOJela i Lorberg zadržavaju `jedinica iz cenovnika`; bez potvrđenog izvornog podatka ne preimenuju se u cenu „po biljci”.

Ako stranica ne radi, promeni biljku, varijantu, dimenzionu opciju, pakovanje ili valutu, ili vrati nulu/nejasnu cenu, ceo prethodni red ostaje nepromenjen. Stari datum provere ostaje uz staru cenu. Izveštaj navodi razlog. Isto važi za eksplicitno istekao `priceValidUntil`. Datum provere se nikada ne predstavlja kao datum izdavanja ponude.

## Konfiguracija — schemaVersion 1

| Polje | Ugovor |
|---|---|
| `scope.origin` | Mora biti `private_offer`. Generator izdvaja biljke iz kompanijskih dokumenata isključivo kao spisak vrsta; updater te dokumente ne čita. |
| `scope.allowedPlantIds` | Eksplicitna lista ID-jeva biljaka iz odobrenog spiska. Poreklo ove liste proverava generator, a updater sprovodi ograničenje ID-jeva. |
| `scope.allowedNurseryIds` | Odobreni rasadnici sa korisničkog spiska; updater proverava i da adapter pripada tom rasadniku. |
| `sources[].id` / `offerId` | Jedinstveni ID konfiguracije / tačan postojeći ID kataloške stavke. Dva izvora ne mogu menjati isti red. |
| `plantId` / `nurseryId` | Moraju odgovarati postojećem redu i listama u `scope`. |
| `adapter` | `biojela_woocommerce`, `vitorovic_shopify` ili `lorberg_selected_variant`. |
| `url` | Poznati osnovni HTTPS URL proizvoda na zvaničnom domenu. Nema otkrivanja dodatnih URL-ova. |
| `offerSourceUrl` | Tačan izvorni URL postojećeg UI reda, uključujući `?variant=...` ako postoji. |
| `expected.productName` | Doslovni naziv proizvoda iz izvora, uz normalizaciju Unicode zapisa, velikih/malih slova i razmaka. Nema zamene kultivara ili približnog taksonomskog povezivanja. |
| `expected.currency` | Izričito `RSD` ili `EUR`; valuta mora ponovo biti potvrđena u izvoru. |
| `expected.unit` | `{kind: "catalogue_unit", label: "jedinica iz cenovnika"}` ili `{kind: "package", label: "pakovanje od 104 sadnice", count: 104}`. Oznaka mora odgovarati UI redu. |
| `evidence` | `{sourceUrl, reviewedAt: "YYYY-MM-DD"}`: javni dokaz korišćen pri ručnom pripremanju veze. |
| `enabled` / `reason` | Isključeni izvori imaju `enabled: false` i obavezan razlog; ne šalje se mrežni zahtev niti se tvrdi da je cena proverena. |

**BIOJela:** generator koristi `rawName`, a za varijantu još `expected.variantId = sourceVariantId` i `expected.variantAttributes = specimenFieldsRaw`. Učitava se WooCommerce ugrađeni JSON konkretne varijante; ID, vidljive oznake opcija, numerička cena i valuta moraju se složiti. Jednostavan proizvod dobija cenu samo iz glavnog bloka proizvoda. Stare precrtane cene, rasponi i srodni proizvodi ne biraju se kao cena stavke.

**Vitorović:** `expected.productName = rawProductTitle`, `expected.variantUrl = sourceVariantUrl`. Bira se tačan `Product`/`Offer` iz JSON-LD; URL varijante i broj sadnica iz opisa/izabrane opcije moraju se poklopiti. Ne koristi se najniža cena drugog proizvoda ili varijante.

**Lorberg:** za pregledanu ponudu očekuje se `variantId: "741"`, `variantLabel: "He 2xv mB geschn. 100- 125"`, naziv `Acer campestre` i EUR. Proverava se aktivna varijanta u `ArticleInfo_ArticleKey`, cena za količinu 1 i njen poreski navod. Ako se podrazumevana varijanta promeni, nema automatskog prelaska na drugu. Količinski popust za 10 komada nije cena ovog reda. JSON-LD sa svim Lorberg varijantama ne bira cenu.

Generator vezuje UI `id = "web-" + publicRecord.id` sa odgovarajućim proveravanim javnim zapisom. U konfiguraciju ulaze samo postojeći ciljni redovi i odobreni rasadnici; kompletni strani katalozi nisu novi automatski ciljevi.

Mrežna ograničenja u `limits`: `maxUrls` (podrazumevano 40, najviše 100), `timeoutSeconds` (20, najviše 30), `requestDelaySeconds` (1.25, najmanje 0.25), `maxResponseBytes` (5.000.000, najviše 10.000.000). Isti URL čita se jednom po izvršavanju. Zahtevi su serijski, bez ponavljanja neuspešnog zahteva. Preusmeravanje na drugi proizvod/domen je greška.

## Pokretanje

```sh
python -m unittest discover -s scripts/tests -p 'test_*.py'
python scripts/update_prices.py --dry-run --report reports/price-update.json
python scripts/update_prices.py --report reports/price-update.json
```

Podrazumevani ulazi su `data/kataloske-stavke.json` i `scripts/price-sources.json`; alternativne putanje se daju pomoću `--data` i `--config`. `--dry-run` piše samo izveštaj. Uspešne izmene se snimaju atomskim zamenjivanjem JSON fajla; neuspešan izvor ne briše ili poništava prethodnu cenu.

U GitHub Actions izveštaj može biti u privremenom direktorijumu: `--report "$RUNNER_TEMP/price-update.json"`. Ne treba ga dodavati u katalog niti u javno objavljene fajlove.

## Izveštaj i izlazni kod

`status` je `completed`, `partial_failure` ili `failed`. Brojači su `requests` (jedinstveni URL-ovi), `successfulObservations`, `updated` (cena/valuta/jedinica/PDV promenjeni), `verifiedUnchanged`, `failed` i `skipped`. `checked` broji uspešne validacije. `sources[]` daje identifikatore, URL, ishod, prethodnu i proverenu cenu ili razlog neuspeha. GitHub sažetak treba da prikaže i neuspehe, ne samo uspešne izmene.

Uspešan red dobija `priceObservation`: vreme provere, izvor, tačnu varijantu, sirovu cenu, osnovicu/pakovanje i oznaku da je cena javna. `sourcePublishedAt` ostaje `null` kada izdavač ne daje datum objave. `sourceDate` i `sourcePeriod` ne popunjavaju se datumom provere; datirani/sezonski redovi nisu dozvoljeni ovoj automatizaciji.

Izlazni kod je **0** za završen prolaz, uključujući pojedinačne neuspele izvore sa sačuvanim starim cenama; **2** za neispravnu konfiguraciju/podatke. Opcija `--fail-on-source-error` daje **1** pri neuspehu bilo kog izvora; uspešna ažuriranja su i tada sačuvana, osim uz `--dry-run`. GitHub workflow treba da proveri izveštaj i istakne `failed > 0`.

Testovi koriste male strukturne isečke bez kontakata, slika i kompletnih kopija sajtova. Proveravaju identitet, pakovanja, pogrešne valute/nulte cene, očuvanje podataka na grešci, rok važenja, zabranu zamenskih proizvoda i dry-run bez upisa.
