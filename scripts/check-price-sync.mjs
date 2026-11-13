import {readFile,appendFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
try{
 const status=JSON.parse(await readFile(new URL('data/price-sync-status.json',root),'utf8'));
 const age=(Date.now()-Date.parse(status.checkedAt))/3600000;
 const summary=`## Provera cena\nPoslednja provera izvora: ${status.checkedAt}\n\nPotvrđeno: ${status.verifiedPrices}. Promenjeno: ${status.updatedPrices}. Zadržano do provere: ${status.pendingPrices}.\n\nPrivatni poslovni folder čita jutarnja automatizacija na poslovnom računaru. GitHub proverava objavljeni rezultat.\n`;
 console.log(summary);if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,summary);
 if(!Number.isFinite(age)||age< -1||age>36||!status.sourceReadable)throw new Error('Jutarnja potvrda cena nije dostupna ili je starija od 36 sati.');
 if(status.pendingPrices)console.log('::warning::Deo promenjenih izvora čeka proveru; ti zapisi ne ulaze u Brzu preporuku.');
}catch(error){console.error(error.message);process.exitCode=1;}
