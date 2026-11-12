import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PwaApp } from '@skysa/pwa';

/**
 * What this app hands the build of its own: its one route (`PwaApp`, the kit's
 * `@skysa/pwa`), and the brand it builds with when a deployment names none
 * (the kit's `loadBrand`).
 */

/**
 * The brand the app is built with when `DRAW_BRAND` names none: `brand/`'s,
 * "Draw", in gray, on the system fonts (docs/ARCHITECTURE.md §8, "Brand").
 */
// Not `new URL(…, import.meta.url)`, which Vite would read as an asset to serve.
export const DEFAULT_BRAND = join(dirname(fileURLToPath(import.meta.url)), 'brand/brand.json');

/**
 * This app's routes. It has one, `/`, and what it opens is in the query
 * (`routes/index.tsx`); a route added under `src/routes` is added here too,
 * which `tests/pwa.app.test.ts` checks. It is no share target.
 */
export const DRAW_PWA: PwaApp = {
	routes: [/^\/(?:\?|$)/],
};
