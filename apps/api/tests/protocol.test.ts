import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as core from '@skysa/draw-core';
import * as kit from '@skysa/protocol';
import { describe, expect, it } from 'vitest';

const MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@skysa');

/** A kit package's manifest, as this package has it installed. */
const manifestOf = (name: string): { version: string; dependencies?: Record<string, string> } =>
	JSON.parse(readFileSync(join(MODULES, name, 'package.json'), 'utf8')) as {
		version: string;
		dependencies?: Record<string, string>;
	};

/**
 * The server speaks the kit's protocol (`@skysa/protocol`), and the app still
 * reads it with core's own copy until core takes the kit's (skysa-notes'
 * record 0018, step 4b): the error codes, the operator's seams and their
 * limits, the relay's frames and the providers. Every value the kit's offers,
 * core must say the same, or the app would read a good answer as one it does
 * not know. Its values, that is: the seams' defaults (`alwaysAllowed`,
 * `neverLimited`) are behavior, which each side has its own of.
 */
const isData = (value: unknown): boolean =>
	typeof value !== 'function' &&
	(typeof value !== 'object' || value === null || Object.values(value).every(isData));

const SPOKEN = Object.entries(kit).filter(([, value]) => isData(value));

describe("the server's protocol and the app's", () => {
	it('are compared at the version the server is built on', () => {
		expect(manifestOf('protocol').version).toBe(
			manifestOf('server').dependencies?.['@skysa/protocol']
		);
	});

	it('share some values', () => {
		expect(SPOKEN.length).toBeGreaterThan(0);
	});

	it.each(SPOKEN)('say the same %s', (name, value) => {
		expect(core).toHaveProperty([name]);
		expect(core[name as keyof typeof core]).toEqual(value);
	});
});
