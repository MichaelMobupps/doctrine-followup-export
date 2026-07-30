import { detectStructuralViolations } from "../lib/structuralLint";
import { findHypeAdjectivesInBody } from "../lib/doctrineRules";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
}
const ackFired = (body: string, lang: string) =>
  detectStructuralViolations(body, { languageTag: lang, originalText: "", companyName: "" })
    .issues.some((i) => i.includes("FOLLOWUP-ACK"));

// ---- the four actual generated email bodies from the heal smoke ----
const itGaming = `Buongiorno Alex,

Riprendo la mia email di qualche giorno fa sull'acquisizione di utenti per i giochi mobile di PixelForge Games. Vale la pena notare che nei giochi mobile la fidelizzazione al D7 varia sensibilmente in base alla qualità del traffico iniziale.`;

const itCps = `Buongiorno Alex,

Riprendo la mia email di qualche giorno fa sulla partnership a costo per vendita per ShopNova. Volevo aggiungere un dettaglio che potrebbe avere senso considerare.`;

const trGaming = `Sayın Alex,

Umarım iyisinizdir. Birkaç gün önce PixelForge Games için mobil oyun kullanıcı edinimi üzerine ilettiğim mesajın ardından kısa bir ekleme yapmak istedim.`;

const huCps = `Tisztelt Alex!

Remélem, jól van. Visszatérek a ShopNova számára ajánlott értékesítésenkénti teljesítménypartnerségről szóló korábbi levelemre. Érdemes megemlíteni, hogy a hazai vásárlók egyre inkább az azonnali fizetési megoldásokat részesítik előnyben, ami a webshopok számára a megerősített, lezárt vásárlás alapú elszámolást teszi a legmegbízhatóbb mérési alappá.`;

console.log("== FIX: false positives must now be GONE ==");
check("it/gaming FOLLOWUP-ACK no longer fires", !ackFired(itGaming, "it"));
check("it/cps   FOLLOWUP-ACK no longer fires", !ackFired(itCps, "it"));
check("tr/gaming FOLLOWUP-ACK no longer fires", !ackFired(trGaming, "tr"));
check("hu/cps   'erős' NOT flagged inside 'megerősített'", !findHypeAdjectivesInBody(huCps, "hu").includes("erős"));

console.log("\n== REGRESSION: real violations must STILL fire ==");
// standalone hype 'erős' must still be caught (word-boundary, not substring)
check("hu standalone 'erős' STILL flagged", findHypeAdjectivesInBody("Ez egy erős ajánlat a csapatának.", "hu").includes("erős"));
// inflected 'erősebb' (stronger) must still be caught
check("hu inflected 'erősebb' STILL flagged", findHypeAdjectivesInBody("Sokkal erősebb eredmény.", "hu").length > 0);
// DIACRITIC-BOUNDED adjectives — these broke under ASCII \b; must be caught now
check("hu 'kiváló' (ends in ó) STILL flagged", findHypeAdjectivesInBody("Ez egy kiváló ajánlat.", "hu").includes("kiváló"));
check("hu 'vezető' (ends in ő) STILL flagged", findHypeAdjectivesInBody("A vezető megoldás.", "hu").includes("vezető"));
check("tr 'önemli' (starts with ö) STILL flagged", findHypeAdjectivesInBody("Bu önemli bir teklif.", "tr").includes("önemli"));
check("tr 'güçlü' (starts with g, has ü/ç) STILL flagged", findHypeAdjectivesInBody("Bu güçlü bir sonuç.", "tr").includes("güçlü"));
check("tr 'olağanüstü' STILL flagged", findHypeAdjectivesInBody("olağanüstü kampanya.", "tr").includes("olağanüstü"));
// pure-ASCII path unchanged: English 'strong' still flagged
check("en 'strong' STILL flagged (ASCII path intact)", findHypeAdjectivesInBody("This is a strong offer.", "en").length > 0);
// stem inside a longer word must still NOT flag (the original false positive)
check("hu 'erős' NOT flagged inside 'megerősített'", !findHypeAdjectivesInBody("A megerősített vásárlás után fizetsz.", "hu").includes("erős"));
// an email with NO prior-outreach reference must STILL trip FOLLOWUP-ACK
check("it no-reference email STILL trips FOLLOWUP-ACK",
  ackFired("Buongiorno Alex, volevo parlarti di una nuova opportunità per i tuoi giochi mobile. Saresti disponibile?", "it"));
check("tr no-reference email STILL trips FOLLOWUP-ACK",
  ackFired("Sayın Alex, oyununuz için yeni bir fırsattan bahsetmek istiyorum. Müsait misiniz?", "tr"));

console.log(`\n${fail === 0 ? "ALL CHECKS PASS" : "CHECKS FAILED"} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
