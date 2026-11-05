/* eslint-disable */
// Připraví optimalizované fotky webu z content.json (pick.slots) do public/web/photos/.
// Spuštění: node scripts/web/build-photos.cjs
// Zdroje: /home/user/md-photos/own/ (NIKDY maybe-stock), sharp z enter-cockpit/node_modules.
// Ořez: poměr stran + fokus (cx, cy = střed výřezu jako podíl šířky/výšky originálu)
// + zoom (1 = největší výřez daného poměru, který se do fotky vejde).
const path = require('path');
const fs = require('fs');
const sharp = require(process.env.SHARP_PATH || '/home/user/enter-cockpit/node_modules/sharp');

const CONTENT = process.env.MD_CONTENT || '/home/user/md-site/content.json';
const SRC = process.env.MD_PHOTOS || '/home/user/md-photos/own';
const OUT = path.join(__dirname, '..', '..', 'public', 'web', 'photos');
const PUBLIC_PREFIX = '/web/photos/';
const MAX = 2400;
const MID = 1200;
const Q = 80;

// Úpravy barev podle poznámek v pick (jemné, žádná velká retuš).
const ADJ = {
  soft: { sat: 0.92 },          // „jemně ubrat saturaci“
  desat: { sat: 0.85 },         // přesycené fotky z mobilu / filtry
  desatLight: { sat: 0.9 },
  warmFix: { sat: 0.8, linear: [[0.98, 1.0, 1.1], [0, 0, 4]] }, // žluté světlo -> neutrálnější
  blueFix: { sat: 0.9, linear: [[1.22, 1.05, 0.8], [8, 3, 0]] }, // modré světlo -> neutrálnější
  highlights: { bright: 0.97 }, // přepálené okraje
  banner: { bright: 0.88, blur: 0.6 }, // pás pod text: ztmavit, zjemnit
};

// Klíč = slot (u opakovaných slotů slot#n podle pořadí v pick.slots, od 1).
// ar = [w, h] | 'native'; cx, cy = fokus; z = zoom; adj = úprava; alt = český alt text.
const SPEC = {
  'home.hero': { ar: [16, 9], cx: 0.5, cy: 0.577, adj: 'soft', alt: 'Svatební raut s roastbeefem na břidlici, grissini, dipy a citrony na kovových etažérách' },
  'home.hero.mobile': { ar: [4, 5], cx: 0.5, cy: 0.5, adj: 'soft', alt: 'Bohatý svatební raut na etažérách: chlebíčky, pomazánky ve skleničkách, mozzarella a uzeniny' },
  'home.hero.alt-1': { ar: [16, 9], cx: 0.5, cy: 0.53, alt: 'Kuchař strouhá parmazán na talíře houbového rizota s rukolou' },
  // Cedulka s cenami je v x 0,37–0,57 a y od 0,62 dolů -> výřez končí nad ní (y ≤ 0,615).
  'home.hero.alt-2': { ar: [16, 9], cx: 0.6925, cy: 0.3075, z: 0.615, alt: 'Garden party: chlebíčky a slané pečivo na dřevěných bednách s růžovými hortenziemi' },
  'home.grid.firemni': { ar: [4, 5], cx: 0.45, cy: 0.5, adj: 'desat', alt: 'Obsluha Mummies and Daddies v zástěrách u bohatého cateringového bufetu ve stanu' },
  'home.grid.snidane': { ar: [4, 5], cx: 0.575, cy: 0.4, z: 0.85, alt: 'Snídaňový bufet s croissanty, sladkým pečivem a skořicovými šneky' },
  'home.grid.coffee-break': { ar: [4, 5], cx: 0.29, cy: 0.5, alt: 'Mini cheesecaky s karamelovým krémem a meruňkou' },
  'home.grid.obedy': { ar: [4, 5], cx: 0.62, cy: 0.5, alt: 'Servírované talíře caprese s mozzarellou, rajčaty, bazalkou a bagetou' },
  'home.grid.vecere-a-bankety': { ar: [4, 5], cx: 0.4, cy: 0.5, alt: 'Talíř houbového rizota s rukolou a čerstvě strouhaným parmazánem' },
  'home.grid.spolecenske-akce': { ar: [4, 5], cx: 0.5, cy: 0.541, alt: 'Raut ve stodole s jednohubkami ve skleničkách, zeleninou a ručně psanou cedulkou' },
  'home.grid.svatby': { ar: [4, 5], cx: 0.5, cy: 0.52, alt: 'Svatební bufet s ovocem a sýry v rustikální stodole se světýlky' },
  // Pravá polovina bez cedulky s cenami (cedulka končí na x ≈ 0,57).
  'home.grid.oslavy-a-piknik': { ar: [4, 5], cx: 0.785, cy: 0.5, z: 0.975, alt: 'Chlebíčky na dřevěných bednách s růžovými hortenziemi na zahradní oslavě' },
  'home.grid.teambuilding': { ar: [4, 5], cx: 0.5, cy: 0.417, alt: 'Šéfkuchař Mummies and Daddies krájí maso z grilu na venkovní akci' },
  'home.references.bvlgari': { ar: [4, 3], cx: 0.5, cy: 0.6, alt: 'Prostor butiku Bvlgari s knihami značky při klientské akci' },
  'home.references.jitka-rostislav': { ar: [4, 3], cx: 0.5, cy: 0.48, alt: 'Svatební dezertní bar s pohárky panna cotty a čokoládovými košíčky s ovocem' },
  'home.references.katka-jirka': { ar: [4, 3], cx: 0.5, cy: 0.315, alt: 'Servírka Mummies and Daddies s novomanželi při tradičním rozbíjení talíře' },
  'home.kitchen.1': { ar: [1, 1], cx: 0.6, cy: 0.5, alt: 'Terina z kachních jater s toastem, mikrobylinkami a brusinkovou redukcí' },
  'home.kitchen.2': { ar: [1, 1], cx: 0.5, cy: 0.5, alt: 'Plátky kuřecích prsou s pestem, jahodami a jedlým květem na břidlici' },
  'home.kitchen.3': { ar: [1, 1], cx: 0.5, cy: 0.652, alt: 'Předkrm s roastbeefem a rukolou, který šéfkuchař dokončuje na talíři' },
  'home.kitchen.4': { ar: [1, 1], cx: 0.5, cy: 0.6, z: 0.8, adj: 'desat', alt: 'Chlebíček s hráškovou pomazánkou, sušenými rajčaty a semínky' },
  'home.kitchen.5': { ar: [1, 1], cx: 0.5, cy: 0.5, alt: 'Svatební dort zdobený růžemi a gypsophilou na bílém stole' },
  'home.kitchen.6': { ar: [1, 1], cx: 0.5, cy: 0.6, alt: 'Čokoládové cupcaky s krémem a lesním ovocem a cedulkou „dobrou chuť“' },
  'home.venues.u-dvou-stodol': { ar: [3, 2], cx: 0.5, cy: 0.45, alt: 'Eventová stodola s dřevěným krovem, světelnými řetězy a prosklenou stěnou' },
  'home.venues.hudlicka-stodola': { ar: [3, 2], cx: 0.5, cy: 0.5, alt: 'Stodola s cihlovými zdmi, světelnými řetězy a prostřenými stoly' },
  'home.venues.stary-tyn': { ar: [4, 3], cx: 0.5, cy: 0.55, alt: 'Kamenná stodola s prosklenou fasádou a koktejlovým stolkem s welcome drinkem' },
  'home.cheesecakes.daddy-vanilkovy': { ar: [1, 1], cx: 0.5, cy: 0.5, adj: 'warmFix', alt: 'Vanilkový cheesecake Daddy celý na talíři' },
  'home.cheesecakes.daddy-pistaciovo-malinovy': { ar: [1, 1], cx: 0.5, cy: 0.5, adj: 'highlights', alt: 'Pistáciovo-malinový cheesecake Daddy shora s vykrojenými dílky' },
  'home.cheesecakes.mini-10ks': { ar: [4, 5], cx: 0.5, cy: 0.5, alt: 'Čokoládový mini cheesecake, v pozadí další příchutě' },
  'home.team': { ar: [4, 5], cx: 0.4, cy: 0.53, z: 0.6, alt: 'Členka týmu Mummies and Daddies s kuchařem v kuchyni' },
  'og.default': { ar: [1200, 630], cx: 0.5, cy: 0.607, adj: 'soft', og: true, alt: 'Svatební raut s roastbeefem na břidlici od Mummies and Daddies' },
  'catering.hero': { ar: [4, 5], cx: 0.5, cy: 0.5, adj: 'soft', alt: 'Bohatý raut na etažérách s chlebíčky, pomazánkami, mozzarellou a uzeninami' },
  'catering.formats.bufet': { ar: [3, 2], cx: 0.5, cy: 0.54, adj: 'desat', alt: 'Cateringový bufet s obsluhou ve stanu' },
  'catering.formats.raut': { ar: [3, 2], cx: 0.5, cy: 0.5, adj: 'soft', alt: 'Studený raut s roastbeefem a citrony na břidlicových etažérách' },
  'catering.formats.finger-food': { ar: [1, 1], cx: 0.45, cy: 0.7, z: 0.8, alt: 'Jednohubky ve skleničkách na rautu ve stodole' },
  'catering.formats.banket': { ar: [3, 2], cx: 0.5, cy: 0.45, alt: 'Servírované talíře caprese připravené pro hosty' },
  'catering.formats.bbq-live-cooking': { ar: [1, 1], cx: 0.5, cy: 0.38, alt: 'Šéfkuchař krájí maso z grilu při live cookingu venku' },
  'catering.firemni.hero': { ar: [16, 9], cx: 0.5, cy: 0.55, alt: 'Studený bufet s roastbeefem, sýry, lososem a ovocem na břidlici' },
  'catering.firemni.gallery#1': { ar: [3, 2], cx: 0.5, cy: 0.5, adj: 'blueFix', alt: 'Sushi rolky na podnosu na firemní akci' },
  'catering.firemni.gallery#2': { ar: [4, 5], cx: 0.5, cy: 0.583, alt: 'Firemní raut s dezerty, chlebíčky a studenou mísou' },
  'catering.firemni.gallery#3': { ar: [1, 1], cx: 0.5, cy: 0.5, adj: 'desat', alt: 'Dřevěný stojan s uzeninami, sýry, zeleninou a ovocem' },
  'catering.snidane.hero': { ar: [4, 5], cx: 0.575, cy: 0.4, z: 0.85, alt: 'Snídaňový bufet s croissanty, sladkým pečivem a skořicovými šneky' },
  'catering.snidane.gallery#1': { ar: [1, 1], cx: 0.5, cy: 0.45, alt: 'Půlky avokáda plněné cottage sýrem a řeřichou' },
  'catering.snidane.gallery#2': { ar: [1, 1], cx: 0.5, cy: 0.5, adj: 'desat', alt: 'Chlebíčky s hráškovou pomazánkou a sušenými rajčaty' },
  'catering.coffee-break.hero': { ar: [2, 1], cx: 0.5, cy: 0.5, alt: 'Tartaletky a mini dezerty na etážových stojanech' },
  'catering.coffee-break.gallery': { ar: [4, 3], cx: 0.5, cy: 0.5, alt: 'Mini cheesecaky s karamelovým krémem a meruňkou' },
  'catering.obedy.hero': { ar: [16, 9], cx: 0.5, cy: 0.42, alt: 'Servírované talíře caprese s mozzarellou, rajčaty a bagetou' },
  'catering.obedy.gallery': { ar: [3, 2], cx: 0.5, cy: 0.62, alt: 'Číšník nese talíře s kuřecím ve slanině a pečenými brambory' },
  'catering.vecere-a-bankety.hero': { ar: [16, 9], cx: 0.5, cy: 0.53, alt: 'Kuchař strouhá parmazán na talíře houbového rizota s rukolou' },
  'catering.vecere-a-bankety.gallery#1': { ar: [4, 5], cx: 0.5, cy: 0.5, alt: 'Šéfkuchař aranžuje předkrm s roastbeefem a rukolou' },
  'catering.vecere-a-bankety.gallery#2': { ar: [3, 2], cx: 0.5, cy: 0.5, alt: 'Terina z kachních jater s toastem jako předkrm' },
  'catering.spolecenske-akce.hero': { ar: [4, 5], cx: 0.5, cy: 0.541, alt: 'Raut s jednohubkami ve skleničkách, zeleninou a uzeninami' },
  'catering.spolecenske-akce.gallery#1': { ar: [4, 5], cx: 0.425, cy: 0.55, z: 0.85, alt: 'Ústřice na ledu, jahody a sklenky šampaňského na večerní akci' },
  'catering.spolecenske-akce.gallery#2': { ar: [4, 5], cx: 0.5, cy: 0.5, alt: 'Hosteska nalévá šampaňské do pyramidy sklenic' },
  'catering.spolecenske-akce.bvlgari': { ar: [1, 1], cx: 0.5, cy: 0.5, alt: 'Prostor butiku Bvlgari při klientské akci' },
  // 2:3 bez kotouče papírových utěrek (začíná na y ≈ 0,8).
  'catering.teambuilding.hero': { ar: [2, 3], cx: 0.575, cy: 0.395, z: 0.79, alt: 'Šéfkuchař krájí grilované maso na venkovní akci' },
  'catering.svatby.hero': { ar: [2, 3], cx: 0.5, cy: 0.5, alt: 'Kuchař Mummies and Daddies přináší třípatrový svatební dort s růžemi' },
  'catering.svatby.gallery#1': { ar: [4, 5], cx: 0.5, cy: 0.5, adj: 'soft', alt: 'Svatební raut s etažéry, chlebíčky a pomazánkami' },
  'catering.svatby.gallery#2': { ar: [4, 5], cx: 0.5, cy: 0.52, alt: 'Svatební bufet s ovocem a sýry ve stodole se světýlky' },
  'catering.svatby.sweet-bar': { ar: [4, 5], cx: 0.5, cy: 0.5, alt: 'Sladký bar v pastelové růžové s pohárky, košíčky a ovocem' },
  'catering.svatby.cake': { ar: [1, 1], cx: 0.5, cy: 0.5, alt: 'Svatební dort zdobený růžemi a gypsophilou' },
  'catering.svatby.gallery#3': { ar: [4, 5], cx: 0.5, cy: 0.5, adj: 'desat', alt: 'Svatební dort s čerstvými květy v rozkvetlé zámecké zahradě' },
  'catering.oslavy-a-piknik.hero': { ar: [16, 9], cx: 0.6925, cy: 0.3075, z: 0.615, alt: 'Garden party: chlebíčky a slané pečivo na dřevěných bednách s růžovými hortenziemi' },
  'catering.oslavy-a-piknik.gallery#1': { ar: [4, 5], cx: 0.41, cy: 0.64, z: 0.82, adj: 'desatLight', alt: 'Hostka s burgerem na venkovní oslavě' },
  'catering.oslavy-a-piknik.gallery#2': { ar: [3, 2], cx: 0.575, cy: 0.597, z: 0.85, adj: 'desat', alt: 'Venkovní raut s prosciuttem, krevetami a slaným pečivem na etažéru' },
  'reference.jitka-rostislav.cover': { ar: [16, 9], cx: 0.5, cy: 0.577, adj: 'soft', alt: 'Svatební raut Jitky a Rostislava s roastbeefem na břidlicových etažérách' },
  'reference.katka-jirka.cover': { ar: [16, 9], cx: 0.5, cy: 0.75, alt: 'Jednohubky ve skleničkách na svatebním rautu Katky a Jirky ve stodole' },
  'reference.bvlgari.cover': { ar: [1, 1], cx: 0.5, cy: 0.5, alt: 'Prostor butiku Bvlgari při klientské akci' },
  'prostory.hero': { ar: [16, 9], cx: 0.5, cy: 0.5, alt: 'Stodola s cihlovými zdmi, světelnými řetězy a prostřenými stoly' },
  'prostory.u-dvou-stodol': { ar: [3, 2], cx: 0.5, cy: 0.45, alt: 'Eventová stodola s dřevěným krovem a světelnými řetězy' },
  'prostory.gallery': { ar: [3, 2], cx: 0.5, cy: 0.5, alt: 'Prostřený svatební sál ve stodole s dřevěným krovem a záclonami' },
  'prostory.stary-tyn': { ar: [4, 5], cx: 0.5, cy: 0.5, alt: 'Kamenná stodola s welcome drinkem na terase' },
  'prostory.palac': { ar: [4, 5], cx: 0.5, cy: 0.5, alt: 'Barokní palác se zahradou jako prostor pro společenské akce' },
  'o-nas.hero': { ar: [2, 3], cx: 0.5, cy: 0.5, alt: 'Kuchař Mummies and Daddies přináší třípatrový svatební dort' },
  'o-nas.rudolf': { ar: [4, 5], cx: 0.425, cy: 0.354, z: 0.85, alt: 'Šéfkuchař Rudolf Nikolai krájí maso z grilu' },
  'o-nas.monika': { ar: [4, 5], cx: 0.4, cy: 0.48, z: 0.5, alt: 'Členka týmu Mummies and Daddies v kuchyni' },
  'o-nas.team#1': { ar: [4, 5], cx: 0.42, cy: 0.44, z: 0.88, alt: 'Servírka Mummies and Daddies se zástěrou s logem a novomanželé' },
  'o-nas.team#2': { ar: [4, 5], cx: 0.575, cy: 0.44, z: 0.85, adj: 'desat', alt: 'Cukrářka Mummies and Daddies s bílým svatebním dortem zdobeným květy' },
  'cheesecaky.hero': { ar: [16, 9], cx: 0.5, cy: 0.47, adj: 'highlights', alt: 'Detail pistáciovo-malinového cheesecaku s malinami a granátovým jablkem' },
  'cheesecaky.daddy-pistaciovo-malinovy.main': { ar: [1, 1], cx: 0.5, cy: 0.5, adj: 'highlights', alt: 'Pistáciovo-malinový cheesecake Daddy shora s vykrojenými dílky' },
  'cheesecaky.daddy-vanilkovy.main': { ar: [1, 1], cx: 0.5, cy: 0.5, adj: 'warmFix', alt: 'Vanilkový cheesecake Daddy celý na talíři' },
  'cheesecaky.daddy-cokoladovo-liskooriskovy.main': { ar: [1, 1], cx: 0.52, cy: 0.5, alt: 'Čokoládovo-lískooříškový cheesecake Daddy s ostružinami a borůvkami shora' },
  'cheesecaky.daddy-vanilkovo-karamelovy.main': { ar: [1, 1], cx: 0.5, cy: 0.5, alt: 'Vanilkovo-karamelový cheesecake Daddy s karamelovým zdobením' },
  'cheesecaky.mummy-vanilkovo-ovocny.main': { ar: [1, 1], cx: 0.5, cy: 0.5, alt: 'Vanilkovo-ovocný cheesecake Mummy s malinami a borůvkami' },
  'cheesecaky.mummy-vanilkovo-pomerancovy-vanocni.main': { ar: [1, 1], cx: 0.45, cy: 0.5, alt: 'Vánoční vanilkovo-pomerančový cheesecake Mummy' },
  'cheesecaky.mini-cheesecaky-10-ks.main': { ar: [4, 5], cx: 0.5, cy: 0.5, alt: 'Čokoládový mini cheesecake, v pozadí další příchutě' },
  'cheesecaky.na-akci-banner': { ar: [21, 9], cx: 0.5, cy: 0.5, adj: 'banner', alt: 'Desítky mini cheesecaků připravených na akci' },
  'vanoce.hero': { ar: [16, 9], cx: 0.5, cy: 0.45, alt: 'Bufet na vánočním firemním večírku se světelnými řetězy' },
  'vanoce.gallery#1': { ar: [4, 3], cx: 0.5, cy: 0.575, z: 0.85, alt: 'Vánoční raut s cukrovím, zákusky a chlebíčky na etážových stojanech' },
  'vanoce.gallery#2': { ar: [4, 5], cx: 0.5, cy: 0.583, alt: 'Vánoční firemní bufet s dezerty a studenou mísou' },
  'poptavka.trust': { ar: [3, 2], cx: 0.5, cy: 0.54, adj: 'desat', alt: 'Obsluha Mummies and Daddies připravuje cateringový bufet' },
  'blog.svatebni-catering': { ar: [16, 9], cx: 0.5, cy: 0.42, adj: 'soft', alt: 'Svatební raut s etažéry, mozzarellou a uzeninami na břidlici' },
};

function cropBox(W, H, s) {
  let a = s.ar === 'native' ? W / H : s.ar[0] / s.ar[1];
  let w, h;
  if (W / H > a) { h = H; w = H * a; } else { w = W; h = W / a; }
  const z = s.z || 1;
  w *= z; h *= z;
  let left = s.cx * W - w / 2;
  let top = s.cy * H - h / 2;
  left = Math.max(0, Math.min(W - w, left));
  top = Math.max(0, Math.min(H - h, top));
  return { left: Math.round(left), top: Math.round(top), width: Math.floor(w), height: Math.floor(h) };
}

function applyAdj(img, name) {
  const a = ADJ[name];
  if (!a) return img;
  if (a.linear) img = img.linear(a.linear[0], a.linear[1]);
  if (a.sat || a.bright) img = img.modulate({ saturation: a.sat || 1, brightness: a.bright || 1 });
  if (a.blur) img = img.blur(a.blur);
  return img;
}

function slug(key) {
  return key.replace('#', '.').replace(/\./g, '-');
}

async function render(file, box, adj, width, height, fit) {
  let img = sharp(path.join(SRC, file)).rotate().extract(box);
  img = applyAdj(img, adj);
  img = img.resize({ width, height, fit: fit || 'inside', withoutEnlargement: !fit });
  return img.jpeg({ quality: Q, mozjpeg: true, progressive: true }); // bez withMetadata => bez EXIF/ICC
}

async function main() {
  const content = JSON.parse(fs.readFileSync(CONTENT, 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });
  const seen = {};
  const byCrop = new Map(); // dedupe: stejný originál + stejný ořez + úprava => jeden soubor
  const manifest = {};
  const missingSpec = [];
  for (const slot of content.pick.slots) {
    if (/maybe-stock/.test(slot.original)) throw new Error('maybe-stock je zakázaný: ' + slot.original);
    seen[slot.slot] = (seen[slot.slot] || 0) + 1;
    const dup = content.pick.slots.filter((s) => s.slot === slot.slot).length > 1;
    const key = dup ? `${slot.slot}#${seen[slot.slot]}` : slot.slot;
    const s = SPEC[key];
    if (!s) { missingSpec.push(key); continue; }
    const srcPath = path.join(SRC, slot.original);
    const meta = await sharp(srcPath).rotate().metadata();
    // metadata() po rotate() vrací rozměry před rotací; prohoď u orientací 5–8
    let W = meta.width, H = meta.height;
    if (meta.orientation && meta.orientation >= 5) [W, H] = [H, W];
    const box = cropBox(W, H, s);
    const sig = [slot.original, box.left, box.top, box.width, box.height, s.adj || '', s.og ? 'og' : ''].join('|');
    const manifestKey = dup ? `${slot.slot}.${seen[slot.slot]}` : slot.slot;
    let rec = byCrop.get(sig);
    if (!rec) {
      const name = slug(key);
      rec = { name };
      if (s.og) {
        const fn = `${name}.jpg`;
        const info = await (await render(slot.original, box, s.adj, 1200, 630, 'cover')).toFile(path.join(OUT, fn));
        rec.file = fn; rec.width = info.width; rec.height = info.height;
      } else {
        const fn = `${name}.jpg`;
        const fn12 = `${name}-1200.jpg`;
        const info = await (await render(slot.original, box, s.adj, MAX, MAX)).toFile(path.join(OUT, fn));
        rec.file = fn; rec.width = info.width; rec.height = info.height;
        if (Math.max(info.width, info.height) > MID) {
          const info12 = await (await render(slot.original, box, s.adj, MID, MID)).toFile(path.join(OUT, fn12));
          rec.file1200 = fn12; rec.width1200 = info12.width; rec.height1200 = info12.height;
        } else {
          // originál je menší než 1200 px -> menší verze = hlavní soubor
          rec.file1200 = fn; rec.width1200 = info.width; rec.height1200 = info.height;
        }
      }
      byCrop.set(sig, rec);
    }
    const entry = {
      file: PUBLIC_PREFIX + rec.file,
      width: rec.width,
      height: rec.height,
      alt: s.alt,
      provisional: !!slot.provisional,
    };
    if (rec.file1200) Object.assign(entry, { file1200: PUBLIC_PREFIX + rec.file1200, width1200: rec.width1200, height1200: rec.height1200 });
    entry.source = slot.original;
    manifest[manifestKey] = entry;
  }
  if (missingSpec.length) throw new Error('Chybí SPEC pro sloty: ' + missingSpec.join(', '));

  // Varianta OG s pudrově růžovým panelem vlevo a názvem (pick: „vlevo místo pro logo na růžovém panelu“).
  // Písmo je systémový serif (logo ve vektoru zatím chybí) -> provisional; po dodání SVG loga nahradit.
  const og = manifest['og.default'];
  if (og) {
    const base = path.join(OUT, path.basename(og.file));
    const panel = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stop-color="#F2D4D2" stop-opacity="0.97"/>
        <stop offset="0.36" stop-color="#F2D4D2" stop-opacity="0.95"/>
        <stop offset="0.5" stop-color="#F2D4D2" stop-opacity="0"/>
      </linearGradient></defs>
      <rect width="1200" height="630" fill="url(#g)"/>
      <g fill="#3B2418" font-family="Liberation Serif, DejaVu Serif, serif">
        <text x="72" y="270" font-size="50" letter-spacing="7">MUMMIES</text>
        <text x="72" y="336" font-size="50" letter-spacing="7">&amp; DADDIES</text>
      </g>
      <rect x="74" y="370" width="64" height="2" fill="#D9466F"/>
      <text x="72" y="418" fill="#3B2418" font-family="Liberation Sans, DejaVu Sans, sans-serif" font-size="24" letter-spacing="3">CATERING · PRAHA</text>
    </svg>`;
    const fn = 'og-default-brand.jpg';
    const info = await sharp(base).composite([{ input: Buffer.from(panel), top: 0, left: 0 }])
      .jpeg({ quality: Q, mozjpeg: true, progressive: true }).toFile(path.join(OUT, fn));
    manifest['og.default.brand'] = {
      file: PUBLIC_PREFIX + fn, width: info.width, height: info.height,
      alt: 'Mummies & Daddies – catering Praha', provisional: true, source: og.source,
    };
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`slotů: ${Object.keys(manifest).length}, unikátních ořezů: ${byCrop.size}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
