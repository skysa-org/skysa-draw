import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A drawing fixture's text, by its file name in this folder. The path is made
 * with Node's own URL handling: under jsdom the global `URL` is jsdom's, which
 * `readFileSync` does not take.
 */
export const drawingFixture = (name: string): string =>
	readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), 'utf8');
