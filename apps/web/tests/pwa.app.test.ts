import { loadBrand, pwaManifest, pwaWorkbox } from '@skysa/pwa';
import { workerOf } from '@skysa/pwa/testing';
import { createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { DEFAULT_BRAND, DRAW_PWA } from '../pwaApp.js';
import { routeTree } from '../src/routeTree.gen';

/**
 * What this app hands the build of its own (`pwaApp.ts`): its one route. The
 * build's own checklist is the kit's (`@skysa/pwa`).
 */

const manifest = pwaManifest(loadBrand(DEFAULT_BRAND), DRAW_PWA);
const workbox = pwaWorkbox(DRAW_PWA);
const { shellAnswers } = workerOf(workbox);

describe('the web app manifest, in this app', () => {
	it('names the app as its default brand does', () => {
		expect(manifest.name).toBe('Draw');
	});

	it('is no share target', () => {
		expect(manifest.share_target).toBeUndefined();
	});
});

describe('the service worker, in this app', () => {
	it('answers a deep link into the app with the shell', () => {
		// What the app opens is in the query (`routes/index.tsx`).
		expect(shellAnswers('/')).toBe(true);
		expect(shellAnswers('/?f=Work&d=abc')).toBe(true);
		expect(shellAnswers('/?connect=ok')).toBe(true);
	});

	it("leaves any other page on the origin to the network, such as an operator's", () => {
		// A gate's action may link a page served beside the app. Answered with
		// the shell, it would open as the app's "Not found".
		expect(shellAnswers('/subscribe')).toBe(false);
		expect(shellAnswers('/about?x=1')).toBe(false);
	});

	it('answers every route the router has with the shell', () => {
		// So a route added under `src/routes` cannot be left out of the allowlist.
		const paths = Object.keys(createRouter({ routeTree }).routesByPath);
		expect(paths).not.toHaveLength(0);
		paths.forEach((path) => {
			expect(shellAnswers(path), path).toBe(true);
		});
	});

	it('answers no POST itself', () => {
		// It is no share target, and nothing else posts to it.
		expect(workbox.runtimeCaching?.filter((rule) => (rule.method ?? 'GET') !== 'GET')).toEqual(
			[]
		);
	});
});
