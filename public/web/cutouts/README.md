# Výřezy produktů (bez pozadí)

WebP s alfa kanálem, oříznuté na obsah, delší strana max. 900 px. Pozadí odstraněno modelem BiRefNet (rembg),
pak ruční dočištění (odstranění ostrůvků, u některých ořez elipsou/polygonem). Každý výřez zkontrolován na krémovém
(#FBF3E6) i tmavě hnědém pozadí. Zdrojové fotky jsou v `public/web/photos/`.

| Soubor | Co na něm je | Zdrojová fotka | Doporučené použití |
|---|---|---|---|
| `cheesecake-cokoladovo-liskooriskovy.webp` (900×877) | Celý čokoládový cheesecake shora, lískové ořechy, borůvky a ostružiny | `cheesecaky-daddy-cokoladovo-liskooriskovy-main.jpg` | Hero – velký „levitující“ kruh, natočený; karta Daddy cheesecaky |
| `cheesecake-pistaciovo-malinovy.webp` (800×825) | Celý pistáciovo-malinový cheesecake shora s vyříznutým dílkem | `home-cheesecakes-daddy-pistaciovo-malinovy.jpg` | Hero (protějšek k čokoládovému), sekce příchutí – velká fotka vybrané příchutě |
| `mini-cheesecake-cokoladovy.webp` (749×900) | Mini čokoládový cheesecake z boku s čokoládovými hoblinami | `home-cheesecakes-mini-10ks.jpg` (přední kus) | Sekce příchutí / karta „mini cheesecaky“; plovoucí prvek u CTA |
| `cupcake-malina-boruvka.webp` (486×900) | Cupcake s krémem, malinou, borůvkou a zápichem „dobrou chuť“ | `home-kitchen-6.jpg` (přední kus) | Karta Oslavy / sweet bar; plovoucí prvek v hero (natočit cca −8°) |
| `svatebni-dort-patrovy.webp` (467×900) | Třípatrový bílý svatební dort s růžemi (bez podložky) | `catering-svatby-hero.jpg` | Karta Svatby, sekce svateb |
| `mini-cheesecake-kosicek.webp` (280×264) | Mini cheesecake v papírovém košíčku s meruňkou | `catering-coffee-break-gallery.jpg` | Jen MALÝ dekor (max. ~140 px na šířku, zdroj má nízké rozlišení) – coffee breaky, rozházené „konfety“ |
| `avokado-plnene.webp` (824×900) | Půlka avokáda plněná tatarem, cottage a výhonky | `catering-snidane-gallery-1.jpg` | Karta Snídaně / firemní catering. Pozn.: horní pravá hrana dořezána ručně (sousední avokádo) – použít spíš do 400 px. Obrys vyhlazený (rozmazání alfy + práh, eroze ~3 px), okrajové pixely bez bílého lemu. |
| `lesni-ovoce-okraj.webp` (900×636) | Hromádka malin a borůvek (vrch dortu) | `cheesecaky-mummy-vanilkovo-ovocny-main.jpg` | POUZE u okraje panelu: levý a pravý bok jsou rovně useknuté rámem fotky – umístit tak, aby boky přesahovaly ven z rámu (overflow hidden) |

## Co nevyšlo (vyřazeno)

- Svatební dort s růžemi (`home-kitchen-5.jpg`) – bílý dort na bílém ubruse, zbytky pozadí na boku.
- Dort v zahradě (`catering-svatby-gallery-3.jpg`) – zdroj jen 611 px, výřez by měl ~140 px.
- Talíř caprese (`catering-formats-banket.jpg`) – talíře se překrývají, model vzal jen jídlo bez talíře.
- Verrine (`catering-formats-finger-food.jpg`) – rozostřené sklo, nečitelné hrany.
- Paštika s toastem (`home-kitchen-1.jpg`) – špička paštiky useknutá rámem fotky.
- Vánoční cukroví na tácu (`vanoce-gallery-1.jpg`) – nízké rozlišení, kovový stojan a zbytky dekorace.
- Karamelový a vánoční cheesecake – boky dortu useknuté rámem fotky.
- Jednotlivé maliny vyříznuté z ovocného cheesecaku – částečně zakryté, příliš malé.
