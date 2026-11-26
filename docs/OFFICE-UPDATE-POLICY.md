# Pravila poslovnog ažuriranja

Pre svakog upisa pročitaj najnoviji main i ovaj dokument. Poslovni originali ostaju netaknuti. Pripremi promene prema tačnom baseCommit; ako se main promeni, ponovo preuzmi i ponovo pregledaj podatke. Upis isključivo bez force, uz expected SHA. Nikada ne šalji zastarelu kompletnu bazu.

Postojeće biljke, rasadnici i ponude ostaju sa istim ID. Nove biljke i rasadnike dodaj samo iz pregledanih poslovnih ponuda; ažuriraj scope i allowed IDs zajedno sa podacima. Parametri ponuđene biljke ne smeju biti prepisani iz upita. Cene samo uz izvorni dokaz i postojeća pravila EUR normalizacije. Ne dupliraj identične ponude, ne izmišljaj cene, parametre, datume ili fotografije. Ne menjaj dizajn, Brzu preporuku, Moju ponudu, Excel generatore, workflow ili zaštitne skripte. Ne briši zapise bez posebnog odobrenja. Fotografije samo po postojećoj politici.

Pre upisa izvrši check-catalog-preservation.mjs, check-catalog.mjs i currency-normalization.mjs --repo . --check. Deployment mora proći sve postojeće testove. Prijavi base i final SHA, broj biljaka, rasadnika i ponuda pre/posle, dodate i promenjene zapise, nerazjašnjene stavke i rezultat objave. Ako postoji konflikt, ne objavljuj.

Referentna verzija: 5303f820450c691678121b07d16067e3d3612264 (642 biljke, Jugoslav). Zaštita u deploymentu ne zamenjuje proveru pre upisa; ne može sprečiti ovlašćenog korisnika da direktno izmeni main. Za odobreno brisanje ili preimenovanje identiteta potrebna je posebna revizija zaštite.
