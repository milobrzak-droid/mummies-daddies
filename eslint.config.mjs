import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Hranice v kódu (viz docs/PROVOZ.md, oddíl Architektura).
// Vrstvy: lib (sdílené jádro) <- core <- domain <- app; connectors stojí
// vedle domain a vidí jen lib a core; worker smí volat všechno.
//
// no-restricted-imports se v ESLintu nesčítá — pozdější blok pro stejný
// soubor pravidlo celé přepíše. Proto každý blok skládá svůj seznam vzorů
// z těchto dílů a hlídání hluboké cesty do konektoru (`deep`) je v každém
// bloku, který se týká i jiných souborů než connectors/.
const deep = {
  // Konektor má jediný veřejný vstup connectors/<jméno>/index.ts. Import
  // hlubší cesty (@/connectors/graph/token) obchází rozhraní.
  group: ["@/connectors/*/**", "**/connectors/*/**"],
  message:
    "Konektor importuj jen přes jeho veřejný vstup (@/connectors/<jméno>), ne z hlubšího souboru.",
};
const fromDomain = {
  group: ["@/domain", "@/domain/**", "**/domain/**"],
  message: "Tato vrstva nesmí záviset na domain/ (doménová logika stojí nad ní).",
};
const fromConnectors = {
  // core/connectors/ je KONTRAKT konektorů (kapitola 11), ne konektor:
  // čisté typy a funkce Loop Core, které konektory implementují. Proto je
  // z tohoto vzoru vyjmutý (import vždy absolutně přes @/core/connectors/…).
  group: ["@/connectors", "@/connectors/**", "**/connectors/**", "!@/core/connectors", "!@/core/connectors/**"],
  message: "Tato vrstva nesmí záviset na connectors/.",
};
const fromWorker = {
  group: ["@/worker", "@/worker/**", "**/worker/**"],
  message: "Na worker/ se nikdo neodkazuje; worker volá ostatní, ne naopak.",
};
const fromCore = {
  group: ["@/core", "@/core/**", "**/core/**"],
  message: "Tato vrstva nesmí záviset na core/.",
};

// Konfigurace firmy: jediný vstup je `@/config` (index.ts). Import
// konkrétního souboru (@/config/mummiesDaddies) obchází jediný vstup.
// Platí všude mimo config/ — proto je v každém bloku.
const configDeep = {
  group: ["@/config/*", "**/config/*"],
  message: "Konfiguraci firmy importuj jen přes @/config, ne z konkrétního souboru v config/.",
};

const restrict = (...patterns) => ({
  rules: { "no-restricted-imports": ["error", { patterns: [...patterns, configDeep] }] },
});

// Literály jedné konkrétní firmy, které nesmí zpátky do core/ (kapitola 11).
// Hodnoty žijí v config/mummiesDaddies.ts; Loop Core je čte přes `@/config`.
// Seznam odpovídá tomu, co do core/ nepatří: doména a SharePoint tenant
// firmy, časové pásmo a názvy uzlů (literál rovný klíči uzlu). Komentáře
// lint nehlídá. Uzel „vedeni" se jmenuje stejně jako role týmu, proto v seznamu není.
const COMPANY_LITERAL =
  "/mummiesdaddies|Europe.Prague|^(obchod|eventy)$/i";
const COMPANY_LITERAL_MESSAGE =
  "Hodnota konkrétní firmy nepatří do core/ (Loop Core). Dej ji do config/mummiesDaddies.ts a čti přes @/config.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // Výchozí: všude mimo connectors/ jen přes veřejný vstup konektoru.
  { files: ["**/*.{ts,tsx,mjs}"], ignores: ["connectors/**"], ...restrict(deep) },

  // core: nezná domain, connectors ani worker; hodnoty firmy jen z @/config.
  {
    files: ["core/**"],
    ...restrict(fromDomain, fromConnectors, fromWorker, deep),
  },
  {
    files: ["core/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: `Literal[value=${COMPANY_LITERAL}]`, message: COMPANY_LITERAL_MESSAGE },
        { selector: `TemplateElement[value.raw=${COMPANY_LITERAL}]`, message: COMPANY_LITERAL_MESSAGE },
      ],
    },
  },

  // config: čistá data pod všemi vrstvami. Z core/ smí jen typy
  // (CompanyConfig), jinak nic z projektu — i lib/ config importuje.
  {
    files: ["config/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { ...fromCore, allowTypeImports: true, message: "config/ smí z core/ importovat jen typy (import type)." },
            fromDomain,
            fromConnectors,
            fromWorker,
            {
              group: ["@/lib", "@/lib/**", "@/app/**", "@/components/**"],
              message: "config/ je čistá data; nesmí záviset na lib/, app/ ani components/.",
            },
          ],
        },
      ],
    },
  },

  // domain: konektory jen přes index; na worker nikdy.
  { files: ["domain/**"], ...restrict(fromWorker, deep) },

  // connectors: nezná domain ani worker (smí lib a core).
  { files: ["connectors/**"], ...restrict(fromDomain, fromWorker) },

  // Veřejný web (balík P6) má záchytnou stránku app/(web)/[...nenalezeno]
  // (vlastní 404 webu). Pravidlo no-html-link-for-pages pak bere každou
  // interní cestu jako „stránku" a hlásí i záměrné celé navigace (<a> na
  // /api/ms/connect, /auth/mfa/enroll), proto je vypnuté.
  { rules: { "@next/next/no-html-link-for-pages": "off" } },

  // Komponenty webu čtou po hydrataci localStorage / sessionStorage (košík,
  // rozpracovaná poptávka, potvrzení) a výsledek ukládají do stavu v efektu.
  // Na serveru úložiště není, takže render musí začít prázdný; jde o záměrný
  // vzor, ne o kaskádu renderů.
  { files: ["components/web/**"], rules: { "react-hooks/set-state-in-effect": "off" } },

  // lib (sdílené jádro): nezná žádnou vyšší vrstvu ...
  {
    files: ["lib/**"],
    ...restrict(fromCore, fromDomain, fromConnectors, fromWorker, deep),
  },
  // ... až na API adaptér, který skládá domain do MCP nástrojů.
  { files: ["lib/mcpServer.ts"], ...restrict(fromWorker, deep) },
]);

export default eslintConfig;
