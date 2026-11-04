import { readFileSync } from 'node:fs';

import { createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { loadBrand } from '../brand.js';
import { PWA_WORKBOX, pwaManifest, pwaOptions } from '../pwa.js';
import { routeTree } from '../src/routeTree.gen';

/**
 * The installability checklist.
 *
 * A browser decides whether to offer "install" by applying rules it never
 * reports on: no name, no 192px icon, no `display`, an icon that 404s — and the
 * option simply never appears, with nothing in the build output to explain it.
 * These are those rules, plus the ones that make the app work with no network.
 * See docs/ARCHITECTURE.md §8.
 */

const brand = loadBrand();

/** Width and height out of a PNG's IHDR chunk, which is always the first one. */
const pngSize = (file: string): { width: number; height: number } => {
	const icon = brand.icons.find((given) => given.file === file);
	expect(icon, `the brand has no ${file}`).toBeDefined();
	const bytes = readFileSync(icon?.path ?? '');
	expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const manifest = pwaManifest(brand);
const options = pwaOptions(brand);
const workbox = PWA_WORKBOX;

/**
 * Whether the worker answers a navigation to `pathAndSearch` with the shell,
 * decided as Workbox's `NavigationRoute` decides it: the denylist first, then
 * the allowlist.
 */
const shellAnswers = (pathAndSearch: string): boolean =>
	!(workbox.navigateFallbackDenylist ?? []).some((pattern) => pattern.test(pathAndSearch)) &&
	(workbox.navigateFallbackAllowlist ?? []).some((pattern) => pattern.test(pathAndSearch));

/** The page the worker serves from, for a same-origin request. */
const APP = 'https://draw.example';

/**
 * The runtime rule the worker answers a request with, decided as Workbox's
 * router decides it: the first whose method is the request's and whose pattern
 * matches.
 */
const ruleFor = (href: string, method = 'GET') => {
	const url = new URL(href);
	return (workbox.runtimeCaching ?? []).find((rule) => {
		if ((rule.method ?? 'GET') !== method) return false;
		const pattern = rule.urlPattern;
		if (pattern instanceof RegExp) return pattern.test(href);
		if (typeof pattern === 'function') {
			const asked = { url, sameOrigin: url.origin === APP } as unknown as Parameters<
				typeof pattern
			>[0];
			return Boolean(pattern(asked));
		}
		return pattern === href;
	});
};

describe('the web app manifest', () => {
	it('names the app, for the install prompt and the home screen', () => {
		// The default brand's: a deployment names it in its own (brand.ts).
		expect(manifest.name).toBe('Draw');
		expect(options.manifest).toEqual(manifest);
		// Truncated under an icon, so it has to be short enough to survive.
		expect(manifest.short_name).toBeDefined();
		expect((manifest.short_name ?? '').length).toBeLessThanOrEqual(12);
	});

	it('opens standalone from a start URL inside its own scope', () => {
		expect(manifest.display).toBe('standalone');
		expect(manifest.start_url).toBe('/');
		expect(manifest.scope).toBe('/');
		expect(manifest.start_url?.startsWith(manifest.scope ?? '')).toBe(true);
	});

	it('has the icon sizes an install needs', () => {
		const sizes = (manifest.icons ?? []).map((icon) => icon.sizes);
		expect(sizes).toContain('192x192');
		expect(sizes).toContain('512x512');
	});

	it('has a maskable icon, so Android does not letterbox it', () => {
		const maskable = (manifest.icons ?? []).filter((icon) =>
			(icon.purpose ?? '').includes('maskable')
		);
		expect(maskable).not.toHaveLength(0);
		expect(maskable.map((icon) => icon.sizes)).toContain('512x512');
	});

	it('ships every icon it promises, at the size it promises', () => {
		// A manifest entry pointing at a missing file fails the install silently.
		(manifest.icons ?? []).forEach((icon) => {
			const [width, height] = (icon.sizes ?? '').split('x').map(Number);
			expect(pngSize(icon.src)).toEqual({ width, height });
		});
	});

	it("opens on the brand's background, so it does not start as a white window", () => {
		expect(manifest.background_color).toBeDefined();
	});

	// Chrome paints an installed app's navigation bar with `theme_color` where
	// it can, Android 14 and older; from Android 15 the bar is the
	// `background_color` under it, the brand's `background` (2026-10-11).
	it("colours the navigation bar with the brand's own colour, where Chrome can paint it", () => {
		expect(manifest.theme_color).toBe(brand.colors.light.brand);
	});
});

describe('the service worker', () => {
	it('precaches the app shell, so a cold start needs no network', () => {
		const patterns = workbox.globPatterns ?? [];
		expect(patterns.join(' ')).toContain('js');
		expect(patterns.join(' ')).toContain('css');
		expect(patterns.join(' ')).toContain('html');
	});

	it('serves every route from the shell, so a deep link opens offline', () => {
		expect(workbox.navigateFallback).toBe('index.html');
	});

	it('never answers an API call with the shell', () => {
		const denied = workbox.navigateFallbackDenylist ?? [];
		expect(denied.some((pattern) => pattern.test('/api/token'))).toBe(true);
		expect(denied.some((pattern) => pattern.test('/'))).toBe(false);
		expect(shellAnswers('/api/token')).toBe(false);
	});

	it('answers a deep link into the app with the shell', () => {
		// A link to a drawing is `/?f=Work&d=<id>`: what is open is in the query.
		expect(shellAnswers('/')).toBe(true);
		expect(shellAnswers('/?connect=ok')).toBe(true);
		expect(shellAnswers('/?f=Work&d=abc')).toBe(true);
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

	it.each([
		'https://www.googleapis.com/drive/v3/files',
		'https://content.dropboxapi.com/2/files/download',
		'https://graph.microsoft.com/v1.0/me/drive/special/approot',
		'https://public.dm.files.1drv.com/y4mdownload',
		'https://my.microsoftpersonalcontent.com/personal/download',
		'https://contoso-my.sharepoint.com/personal/download',
	])('never caches a provider response, because drawing content passes through it: %s', (url) => {
		const provider = (workbox.runtimeCaching ?? []).find(
			(rule) => rule.urlPattern instanceof RegExp && rule.urlPattern.test(url)
		);
		expect(provider?.handler).toBe('NetworkOnly');
	});

	it('never answers for the API from a cache', () => {
		['GET', 'POST'].forEach((method) => {
			const api = ruleFor(`${APP}/api/connection`, method);
			if (method === 'GET') {
				expect(api?.handler).toBe('NetworkOnly');
				expect(api?.options).toBeUndefined();
			}
			// A POST to the API matches no rule, and goes to the network as it is.
			if (method === 'POST') expect(api).toBeUndefined();
		});
	});

	it('waits to be told before taking over a page', () => {
		// A worker that claimed the page mid-edit could swap the app out from
		// under a stroke that has not been saved yet.
		expect(options.registerType).toBe('prompt');
	});

	it('is registered by the app, not by a script written into the page', () => {
		// `'inline'` would be refused by the Content-Security-Policy.
		expect(options.injectRegister).toBe(false);
	});
});
