import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Notice } from '../../src/components/ui/Notice.js';

/**
 * A line said in passing (docs/ARCHITECTURE.md §7, "The interface"): a polite
 * live region that is always there, so that a screen reader is told when the
 * message changes, and a card in it only while there is one.
 */

describe('Notice', () => {
	it('is a polite status region, empty while there is nothing to say', () => {
		render(<Notice message={undefined} />);
		const region = screen.getByRole('status');
		expect(region.getAttribute('aria-live')).toBe('polite');
		expect(region.textContent).toBe('');
		expect(region.querySelector('.notice-card')).toBeNull();
	});

	it('says a message in a card, in the one region it keeps as the message changes', () => {
		const { rerender } = render(<Notice message="Saved" />);
		const region = screen.getByRole('status');
		expect(region.querySelector('.notice-card')?.textContent).toBe('Saved');

		rerender(<Notice message="Pencil does not work on a raster layer" />);
		expect(screen.getByRole('status')).toBe(region);
		expect(region.textContent).toBe('Pencil does not work on a raster layer');

		rerender(<Notice message={undefined} />);
		expect(screen.getByRole('status')).toBe(region);
		expect(region.textContent).toBe('');
	});
});
