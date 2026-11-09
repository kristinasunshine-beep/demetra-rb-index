# Svi parametri u glavnom panelu — 9. novembar 2026.

## Ispravka prikaza

Svaka varijanta svake biljke koristi isti glavni panel sa sedam stavki: **Tip sadnice, Obim sadnice, Visina sadnice, Širina krošnje, Veličina busena, Veličina saksije i Način isporuke.** Standard i multistem više ne skrivaju jednu meru u fusnoti. Cena ostaje u svom cenovnom delu panela.

Napomene služe za broj presađivanja, poreklo, nejasne oznake i tačnost podataka. Izvorni opis ostaje sačuvan radi poređenja.

## Proveren primer iz prijave

Originalni Arbor XLSX, Sheet1, red 145: `Acer Pacific Sunset 16-18 STD RB`, iznos 250. U panelu je sada:

| Polje | Vrednost |
| --- | --- |
| Tip sadnice | Standard |
| Obim sadnice | 16–18 |
| Način isporuke | Busen (RB) |
| Cena | 250; valuta nije navedena u izvoru |

Red 146 čuva zasebnu varijantu 18–20 i cenu 300. Red 147 čuva Multistem, trgovačku visinu 350–400, saksiju 230 L i cenu 480. Visina ove poslednje varijante protumačena je po uskom Arbor obrascu: jedan veći raspon posle MULTISTEM i pre pakovanja. Jedinica koja nije navedena nije dopisana.

`RB` potvrđuje busen kao način isporuke. Veličina/prečnik busena ostaje zasebna mera i ne izmišlja se iz same oznake.

## Obuhvat

| Stavka | Broj |
| --- | ---: |
| Biljke | 619 |
| Rasadnici | 24 |
| Arhivski zapisi posle razdvajanja | 3.035 |
| Aktivne varijante | 2.927 |
| Iznosi iz ponuda | 2.351 |
| Zapisi sa dopunjenim ili normalizovanim parametrima | 469 |
| Nove zasebne varijante iz postojećih izvornih redova | 163 |

Izdvojene su varijante sa sopstvenim listom/redom i izvorom. Zbirna cena nije kopirana na novu varijantu. Već postojeći precizni zapisi ponovo su korišćeni; nisu duplirani. Kombinovani upiti sa drugom ponuđenom vrstom i nejasni fotografski opisi ostaju objašnjeni u napomeni.

**Sve postojeće cene, valute i dokazi cene ostali su identični.** Nove vrste i rasadnici nisu dodavani. Online zahteva za cene ili parametre nije bilo.

## Izdvajanje parametara

`scripts/extract_offer_parameters.py` obrađuje već dokazani arhivski red. Izričite oznake H/Height/Visina, Obim/Circumference, Crown width i veličina busena idu u zasebna polja. RB/WRB/BR i oznake kontejnera pretvaraju se u čitljivo pakovanje. C bez L ostaje izvorni kod; litri se ne dopisuju.

Parser ne čita alternative iz naziva stupca `br/cont/rb` kao podatak proizvoda. Čita stvarnu vrednost tog polja. Nemačko `br` uz dimenziju ne tumači se kao goli koren. Količina komada ne postaje veličina saksije, a namerno izostavljena sumnjiva mera ne vraća se automatski.

Za svaku dopunu sačuvani su izvor, pravilo i sirovi tekst u `panelParameterEvidence`. Nerazjašnjene oznake nisu pretvorene u izmišljenu meru. SHA originalnih izvora, listovi, redovi i veze prema biljci/rasadniku ostaju u podacima.

## Zaštita pri sledećoj objavi

Postojeći deploy već poziva `scripts/check-catalog.mjs`. Ta provera sada uključuje `scripts/check-panels.mjs`, koji izvršava stvarni renderer za sve kartice i varijante. Proverava da svih sedam stavki postoji u glavnom panelu, da vrednosti pripadaju ispravnoj biljci i da postojeća cena nije izostavljena. Izostavljanje obima iz panela zaustavlja proveru.

CSS, heder, fontovi, animacije i pretraga imaju isti kod. Menjani su prikaz podataka, dokazivo izdvajanje parametara i provera pre objave. Živi browser prikaz nije izvršen u ovom okruženju; validiran je stvarni HTML renderer i identičnost stilova.

## Prenos

Raspakujte ovaj paket preko postojećeg repozitorijuma i uradite commit/push na `main`. Automatska objava se već pokreće na tu promenu. Ovaj paket nema `.github` ni YML datoteke, pa ranije sređeni folderi ostaju kakvi jesu. Detalji su u `POCNI-OVDE.txt`.

Fotografski workflow nastavlja isto nedeljno osvežavanje. Cene i mere ostaju iz dostavljenog ZIP-a. Aktuelni mašinski izveštaj je `docs/panel-parameters-report.json`; prethodni izveštaji su istorijski.
