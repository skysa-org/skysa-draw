import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CloseIcon, ICONS } from '../../src/components/ui/icons.js';

/**
 * The icons (docs/ARCHITECTURE.md §7, "The interface"): drawn by hand on a 24
 * px grid, in `currentColor`, and decoration only, since the control around
 * one carries its name.
 */

describe('icons', () => {
	it('has an icon for every tool in the table, under the tool’s id', () => {
		const tools = ['select', 'node', 'hand', 'zoom', 'pencil', 'brush', 'eraser', 'smudge'];
		const more = ['fill', 'eyedropper', 'rectangle', 'ellipse', 'line', 'pen', 'text'];
		const last = ['marquee', 'lasso', 'crop'];
		expect(Object.keys(ICONS)).toEqual(expect.arrayContaining([...tools, ...more, ...last]));
	});

	it.each(Object.entries(ICONS))(
		'draws %s at 24 px, in currentColor, hidden from a screen reader',
		(_, Icon) => {
			const { container } = render(<Icon />);
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
			expect(svg?.getAttribute('width')).toBe('24');
			expect(svg?.getAttribute('stroke')).toBe('currentColor');
			expect(svg?.getAttribute('aria-hidden')).toBe('true');
			expect(svg?.getAttribute('focusable')).toBe('false');
			expect(svg?.childElementCount).toBeGreaterThan(0);
		}
	);

	it('takes a size and a class', () => {
		const { container } = render(<CloseIcon size={16} className="small" />);
		const svg = container.querySelector('svg');
		expect(svg?.getAttribute('width')).toBe('16');
		expect(svg?.getAttribute('height')).toBe('16');
		expect(svg?.getAttribute('class')).toBe('small');
	});
});
