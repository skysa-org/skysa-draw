import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ItemRows } from '../../src/drawing/panels/ItemRows.js';
import { runsOf, WINDOW_FROM, windowOf } from '../../src/drawing/panels/itemWindow.js';
import type { LayerItem } from '../../src/drawing/panels/layerItems.js';

/**
 * A long run of a vector layer's items' rows in the layers panel drawn as a
 * window onto it (docs/ARCHITECTURE.md §7, "The interface"): the window's
 * arithmetic, and the rows drawn as the body scrolls under them.
 */

describe('windowOf', () => {
	it('is every row where the height is not known', () => {
		expect(windowOf(1000, 0, 0, 0, 440)).toEqual({ from: 0, to: 1000 });
	});

	it('is the rows seen and six either side, from where the rows begin', () => {
		// Rows from 44 px down, a view of 440: rows 0 to 8 seen, 6 more under.
		expect(windowOf(1000, 44, 44, 0, 440)).toEqual({ from: 0, to: 15 });
		expect(windowOf(1000, 44, 44, 22000, 22440)).toEqual({ from: 493, to: 515 });
	});

	it('holds to the rows there are', () => {
		expect(windowOf(100, 44, 0, 4400, 4840)).toEqual({ from: 94, to: 100 });
		expect(windowOf(100, 44, 4000, 0, 440)).toEqual({ from: 0, to: 0 });
	});
});

describe('runsOf', () => {
	it('is the window, and each row kept outside it a run of its own', () => {
		expect(runsOf(100, { from: 10, to: 20 }, [0, 99, 50])).toEqual([
			{ from: 0, to: 1 },
			{ from: 10, to: 20 },
			{ from: 50, to: 51 },
			{ from: 99, to: 100 },
		]);
	});

	it('takes a row kept next to a run, or inside it, into the run', () => {
		expect(runsOf(100, { from: 10, to: 20 }, [9, 20, 15, 15])).toEqual([{ from: 9, to: 21 }]);
	});

	it('keeps no row that is not there', () => {
		expect(runsOf(5, { from: 3, to: 9 }, [-1, 7, 2.5])).toEqual([{ from: 3, to: 5 }]);
		expect(runsOf(0, { from: 0, to: 0 }, [0])).toEqual([]);
	});
});

const SVG = 'http://www.w3.org/2000/svg';

/** A layer's `count` items, top first, as the panel lists them. */
const itemsOf = (count: number): readonly LayerItem[] =>
	Array.from({ length: count }, (_, nth) => ({
		position: count - 1 - nth,
		element: document.createElementNS(SVG, 'path'),
		name: `Path ${String(count - nth)}`,
	}));

const Rows = ({
	count,
	kept = [],
	under,
}: Readonly<{ count: number; kept?: readonly number[]; under?: number }>) => (
	<div className="panel-body">
		<ul>
			<li data-layer-id="layer-1">Layer 1</li>
			<ItemRows
				layerId="layer-1"
				items={itemsOf(count)}
				kept={kept}
				under={under === undefined ? undefined : { at: 'after', depth: under }}
				row={(item, line) => (
					<li
						key={item.position}
						className="layer-row layer-item"
						data-item-of="layer-1"
						data-position={item.position}
						data-under={line === undefined ? undefined : ''}
					>
						<button type="button">{item.name}</button>
					</li>
				)}
			/>
		</ul>
	</div>
);

/** The positions of the rows drawn, top first. */
const drawn = (container: HTMLElement): readonly number[] =>
	[...container.querySelectorAll<HTMLElement>('li[data-position]')].map((row) =>
		Number(row.dataset.position)
	);

/** The heights of the spaces standing for rows not drawn, top first. */
const gaps = (container: HTMLElement): readonly string[] =>
	[...container.querySelectorAll<HTMLElement>('li[data-gap]')].map((gap) => gap.style.blockSize);

/** The positions of items `from` to `to` rows down a layer of `count`, top first. */
const positions = (count: number, from: number, to: number): readonly number[] =>
	Array.from({ length: to - from }, (_, step) => count - 1 - from - step);

describe('ItemRows', () => {
	it('draws every row of a layer of fewer items than a window is made for', () => {
		const { container } = render(<Rows count={WINDOW_FROM - 1} under={0} />);
		expect(drawn(container)).toHaveLength(WINDOW_FROM - 1);
		expect(gaps(container)).toEqual([]);
		expect(container.querySelector('[data-under]')?.getAttribute('data-position')).toBe('0');
	});

	it('draws every row where the body has no height to measure', () => {
		const { container } = render(<Rows count={200} />);
		expect(drawn(container)).toHaveLength(200);
	});

	describe('with a body to measure', () => {
		const shown = (selector: string): HTMLElement => {
			const found = document.querySelector<HTMLElement>(selector);
			if (found === null) throw new Error(`no ${selector}`);
			return found;
		};
		const placed = (element: HTMLElement, box: () => DOMRect) => {
			Object.defineProperty(element, 'getBoundingClientRect', {
				configurable: true,
				value: box,
			});
		};
		const scrolled = (top: number) => {
			const body = shown('.panel-body');
			Object.defineProperty(body, 'scrollTop', {
				configurable: true,
				writable: true,
				value: top,
			});
			return act(async () => {
				body.dispatchEvent(new Event('scroll'));
				await new Promise((done) => requestAnimationFrame(() => done(undefined)));
			});
		};

		/**
		 * The rows drawn as a body 440 px tall at the page's top shows them:
		 * the layer's row 44 px tall at the top of what it scrolls, and every
		 * item's row 44 px under it, measured from the first.
		 */
		const mount = async (props: Parameters<typeof Rows>[0]) => {
			vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(440);
			const result = render(<Rows {...props} />);
			const body = shown('.panel-body');
			placed(body, () => new DOMRect(0, 0, 300, 440));
			placed(shown('li[data-gap]'), () => new DOMRect(0, 44 - body.scrollTop, 300, 0));
			placed(shown('li[data-position]'), () => new DOMRect(0, 44 - body.scrollTop, 300, 44));
			await scrolled(0);
			return result;
		};

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('draws the rows the body shows, six more, and the last, with space for the rest', async () => {
			const { container } = await mount({ count: 1000, under: 0 });
			expect(drawn(container)).toEqual([...positions(1000, 0, 15), 0]);
			expect(gaps(container)).toEqual(['0px', `${String(984 * 44)}px`]);
			expect(container.querySelector('[data-under]')?.getAttribute('data-position')).toBe(
				'0'
			);
		});

		it('draws the rows a scroll shows, and the first and the last', async () => {
			const { container } = await mount({ count: 1000 });
			await scrolled(22000);
			expect(drawn(container)).toEqual([999, ...positions(1000, 493, 515), 0]);
			expect(gaps(container)).toEqual([
				'0px',
				`${String(492 * 44)}px`,
				`${String(484 * 44)}px`,
			]);
		});

		it('keeps the row with the focus and those either side of it, and the rows kept', async () => {
			const { container } = await mount({ count: 1000, kept: [300] });
			const focused = container.querySelector<HTMLElement>('li[data-position="985"] button');
			act(() => focused?.focus());
			await scrolled(22000);
			expect(drawn(container)).toEqual([
				999,
				986,
				985,
				984,
				...positions(1000, 493, 515),
				300,
				0,
			]);
		});

		it('keeps the rows, and what they hold, that stay in the window', async () => {
			const { container } = await mount({ count: 1000 });
			await scrolled(4400);
			const row = container.querySelector('li[data-position="900"]');
			await scrolled(4444);
			expect(container.querySelector('li[data-position="900"]')).toBe(row);
		});
	});
});
