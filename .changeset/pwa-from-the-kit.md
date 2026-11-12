---
'@skysa/draw-web': patch
---

The PWA build is the shared kit's `@skysa/pwa` 1.0.0 (skysa-notes' record 0018, step 4): the brand plugin, the manifest, the service worker's options and the size budget.
What the app hands it of its own, its one route and its default brand, is `apps/web/pwaApp.ts`.
The built app is the same, manifest and service worker rules included, and `DRAW_BRAND` works as before.
A brand file of your own reads the same schema, now the kit's: point its `$schema` at `apps/web/node_modules/@skysa/pwa/brand.schema.json` if your editor used it.
