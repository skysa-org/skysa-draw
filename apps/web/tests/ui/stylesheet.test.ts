import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * What the components' stylesheet promises (docs/ARCHITECTURE.md §7, "The
 * interface"), read from the file, since jsdom lays nothing out: the shared
 * sizes on `:root`, every control at least a target either way, the sheet and
 * the drawer clear of the safe areas and over the canvas at `--z-sheet`.
 */

const here = dirname(fileURLToPath(import.meta.url));

const css = readFileSync(join(here, '../../src/styles/ui.css'), 'utf8').replace(
	/\/\*[\s\S]*?\*\//g,
	''
);

/** Every declaration of every top-level rule whose selector list names `selector`. */
const declarationsOf = (selector: string): string => {
	const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
	return rules
		.filter(([, selectors]) =>
			(selectors ?? '')
				.split(',')
				.map((each) => each.trim())
				.includes(selector)
		)
		.map(([, , body]) => body)
		.join('\n');
};

describe('ui.css', () => {
	it('sets the shared sizes on :root', () => {
		const root = declarationsOf(':root');
		expect(root).toContain('--target: 2.75rem;');
		expect(root).toContain('--rail: 3.25rem;');
		expect(root).toContain('--dock: 17.5rem;');
		expect(root).toContain('--sheet-max: 70dvh;');
	});

	it.each([
		'.icon-button',
		'.toggle',
		'.color-none',
		'.color-recent-swatch',
		'.menu-item',
		'.select select',
		'.color-hex',
	])('keeps %s at least a target in either direction', (selector) => {
		const rule = declarationsOf(selector);
		expect(rule).toMatch(/min-height: var\(--target\)/);
		expect(rule).toMatch(/min-width: var\(--target\)/);
	});

	it.each(['.color-swatch', '.sheet-handle', '.slider input'])(
		'makes %s a target tall',
		(selector) => {
			expect(declarationsOf(selector)).toMatch(/(^|[^-])height: var\(--target\)/m);
		}
	);

	it('puts a sheet and a drawer over the canvas, at --z-sheet, on a backdrop', () => {
		expect(declarationsOf('.panel-host')).toContain('position: fixed;');
		expect(declarationsOf('.panel-host')).toContain('z-index: var(--z-sheet);');
		expect(declarationsOf('.panel-backdrop')).toContain('z-index: var(--z-sheet);');
		expect(declarationsOf('.panel-sheet')).toContain('max-height: var(--sheet-max);');
	});

	it('keeps a sheet and a drawer clear of the safe areas', () => {
		const sheet = declarationsOf('.panel-sheet');
		['bottom', 'left', 'right'].forEach((side) => {
			expect(sheet).toContain(`env(safe-area-inset-${side})`);
		});
		expect(declarationsOf('.panel-drawer')).toContain('env(safe-area-inset-top)');
		expect(declarationsOf('.panel-drawer')).toContain('env(safe-area-inset-bottom)');
		expect(declarationsOf('.panel-drawer-end')).toContain('env(safe-area-inset-right)');
		expect(declarationsOf('.panel-drawer-start')).toContain('env(safe-area-inset-left)');
	});

	it('keeps a group of choices whole along a bar, whose buttons are each a target', () => {
		// The bar scrolls where it runs short, rather than squeeze its controls.
		expect(declarationsOf('.choice-buttons')).toContain('flex: none;');
		expect(declarationsOf('.icon-button')).toMatch(/min-width: var\(--target\)/);
	});

	it('docks a column the width of --dock', () => {
		expect(declarationsOf('.panel-dock')).toContain('width: var(--dock);');
	});

	it('lights a color of the pair under the pointer by its square, not by the target it is drawn across', () => {
		// Above `shell.css`'s `button:not(.primary):hover` (0,2,1), which would light the target.
		expect(declarationsOf('.color-pair-slot:hover:enabled')).toContain('background: none;');
		expect(declarationsOf('.color-pair-slot:hover > .color-pair-square')).toMatch(
			/outline: [^;]+ solid /
		);
	});
});
