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

	it('lets a panel’s title take the header’s room, so its close control sits at the end', () => {
		const title = declarationsOf('.panel-title');
		expect(title).toContain('flex: 1;');
		expect(title).toContain('text-overflow: ellipsis;');
		expect(title).not.toMatch(/flex: none/);
	});

	it('parts a bar’s groups with one hairline rule, across the bar either way', () => {
		expect(declarationsOf('.toolbar-rule')).toContain('background: var(--border);');
		expect(declarationsOf('.toolbar-horizontal .toolbar-rule')).toContain('width: 1px;');
		expect(declarationsOf('.toolbar-vertical .toolbar-rule')).toContain('height: 1px;');
	});

	it('marks a tool with a menu in its corner, and draws a menu’s chosen item as a pressed tool', () => {
		expect(declarationsOf(".tool-button[aria-haspopup='menu']::after")).toContain(
			'position: absolute;'
		);
		expect(declarationsOf(".menu-item[aria-checked='true']")).toContain(
			'background: var(--on-bg);'
		);
	});

	it('docks a column the width of --dock', () => {
		expect(declarationsOf('.panel-dock')).toContain('width: var(--dock);');
	});

	it('sits the colors’ button in the bar as any tool’s, the mark its face, with the edge its squares are drawn in', () => {
		expect(declarationsOf('.color-pair')).toContain('display: contents;');
		expect(declarationsOf('.tool-button-icon > .color-pair-mark')).toMatch(
			/height: [\d.]+rem;/
		);
		// Wherever the mark is drawn, the tool bar and the color panel's header alike.
		expect(declarationsOf('.color-pair-mark')).toMatch(/--pair-edge: /);
		expect(css).not.toMatch(/\.color-pair-(slot|fill|stroke|swap|both)\b/);
	});

	it('keeps a color’s row of swatch, hex and None whole, and stacks the name over it in a panel or a dialog', () => {
		expect(declarationsOf('.color-field-row')).toContain('flex: none;');
		expect(declarationsOf('.color-field-row')).not.toContain('flex-wrap: wrap;');
		expect(declarationsOf('.color-none')).toContain('white-space: nowrap;');
		expect(declarationsOf('.color-field-inline')).toContain('flex: none;');
		expect(declarationsOf('.color-field-stacked')).toContain('flex-direction: column;');
		expect(declarationsOf('.color-field-stacked .color-hex')).toContain('flex: 1 1 0;');
	});

	it('gives a stacked color and Fill…’s groups the one look: a step apart, a hair within, a quiet name over each', () => {
		expect(declarationsOf('.field-groups')).toContain('gap: var(--space-m);');
		const group = declarationsOf('.field-group');
		expect(group).toBe(declarationsOf('.color-field-stacked'));
		expect(group).toContain('gap: var(--space-2xs);');
		expect(declarationsOf('.field-legend')).toContain('color: var(--muted);');
		expect(declarationsOf('.field-legend')).toContain('font-size: var(--text-s);');
		expect(declarationsOf('legend.field-legend')).toContain(
			'margin-block-end: var(--space-2xs);'
		);
	});

	it('covers the whole window while work is under way, over every sheet, clear of the safe areas', () => {
		const cover = declarationsOf('.applying');
		expect(cover).toContain('position: fixed;');
		expect(cover).toContain('inset: 0;');
		expect(cover).toContain('z-index: var(--z-dialog-menu);');
		expect(cover).toContain('touch-action: none;');
		['top', 'right', 'bottom', 'left'].forEach((side) => {
			expect(cover).toContain(`env(safe-area-inset-${side})`);
		});
		// The page dimmed as behind a sheet, and the card edged as a notice is.
		expect(cover).toContain('background: rgb(0 0 0 / 0.25);');
		expect(declarationsOf('.panel-backdrop')).toContain('background: rgb(0 0 0 / 0.25);');
		['border: 1px solid var(--border);', 'border-radius: var(--radius-m);'].forEach((edge) => {
			expect(declarationsOf('.applying-card')).toContain(edge);
			expect(declarationsOf('.notice-card')).toContain(edge);
		});
	});

	it('fades the cover in and moves its bar by what the compositor runs: opacity and transform', () => {
		expect(declarationsOf('.applying')).toMatch(/animation: fade-in var\(--duration-l\)/);
		expect(declarationsOf('.applying-bar::before')).toMatch(
			/animation: applying-bar calc\(var\(--duration-xl\) \* 4\) linear infinite;/
		);
		const bar = /@keyframes applying-bar \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
		expect(bar).toContain('transform: translateX(-100%);');
		expect(bar).not.toMatch(/(^|[^-])(left|width|margin|inset)[^-]*:/m);
	});
});
