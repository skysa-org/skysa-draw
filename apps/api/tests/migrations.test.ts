import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The D1 migrations are the kit's (`@skysa/server`), and `wrangler.toml`
 * reaches them in `node_modules`. A database 0.1.0 made is reset onto them
 * rather than migrated (docs/self-hosting.md): its one migration was this
 * repository's own, under the name the kit's first has, so wrangler takes the
 * kit's first for applied and stops at its second, changing nothing.
 */

const API = join(dirname(fileURLToPath(import.meta.url)), '..');

const folder = (): string => {
	const named = /^migrations_dir = "([^"]+)"$/mu.exec(
		readFileSync(join(API, 'wrangler.toml'), 'utf8')
	)?.[1];
	expect(named).toBeDefined();
	return resolve(API, named ?? '');
};

describe('the D1 migrations wrangler.toml applies', () => {
	it('are the kit’s, where it says', () => {
		expect(folder()).toMatch(/node_modules\/@skysa\/server\/migrations$/u);
		expect(existsSync(folder())).toBe(true);
	});
});
