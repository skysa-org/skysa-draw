import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import { brandCss, loadBrand } from '@skysa/pwa';
import { describe, expect, it } from 'vitest';

import { DEFAULT_BRAND } from '../pwaApp.js';

/**
 * This app's own brand, which it builds with when a deployment names none
 * (`DEFAULT_BRAND` in `pwaApp.ts`). How a brand file is read and checked is
 * the kit's (`@skysa/pwa`).
 */

// The schema is named apart: its path is the kit's package, which is no one's brand.
const { $schema: schema, ...defaults } = JSON.parse(readFileSync(DEFAULT_BRAND, 'utf8')) as Record<
	string,
	unknown
>;

describe('the default brand', () => {
	const brand = loadBrand(DEFAULT_BRAND);

	it('is "Draw", in gray, carrying no one’s name', () => {
		expect(brand.name).toBe('Draw');
		expect(brand.shortName).toBe('Draw');
		expect(brand.colors.light.brand).toBe('#4B5563');
		expect(brand.colors.dark.brand).toBe('#9CA3AF');
		expect(JSON.stringify(defaults).toLowerCase()).not.toContain('skysa');
	});

	it('keeps the system fonts', () => {
		expect(brand.fonts).toEqual({});
		expect(brandCss(brand)).not.toContain('@font-face');
	});

	it('has all six icons, at their sizes', () => {
		// The kit's loader refuses a brand missing one, or with one at the wrong size.
		expect(() => loadBrand(DEFAULT_BRAND)).not.toThrow();
	});

	it("points an editor at the kit's JSON Schema", () => {
		const kit = createRequire(import.meta.url).resolve('@skysa/pwa/brand.schema.json');
		expect(realpathSync(resolve(dirname(DEFAULT_BRAND), String(schema)))).toBe(
			realpathSync(kit)
		);
	});
});
