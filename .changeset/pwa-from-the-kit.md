---
'@skysa/draw-web': patch
---

The PWA build is the shared kit's `@skysa/pwa` 1.0.0 (skysa-notes' record 0018, step 4): the brand plugin, the manifest, the service worker's options and the size budget.
What the app hands it of its own, its one route and its default brand, is `apps/web/pwaApp.ts`.
The built app is the same, manifest and service worker rules included, and `DRAW_BRAND` works as before: a brand file that built before builds now.
One that does not is refused in the kit's words, which spell a bad color "a colour is #RRGGBB".
The brand file's schema is unchanged, and is now the kit's: point your own brand file's `$schema` at `apps/web/node_modules/@skysa/pwa/brand.schema.json` if your editor used it.
