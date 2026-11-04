import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Select } from '../../src/components/ui/Select.js';

/**
 * One of a few named choices (docs/ARCHITECTURE.md §7, "The interface"): the
 * native select, named by its label, giving back the caller's own value.
 */

type Blend = 'normal' | 'multiply' | 'screen';

const OPTIONS: readonly { value: Blend; label: string }[] = [
	{ value: 'normal', label: 'Normal' },
	{ value: 'multiply', label: 'Multiply' },
	{ value: 'screen', label: 'Screen' },
];

describe('Select', () => {
	it('is a select named by its label, showing the value it is given', () => {
		render(<Select label="Blend mode" value="multiply" options={OPTIONS} onChange={vi.fn()} />);
		const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Blend mode' });
		expect(select.value).toBe('multiply');
		expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
			'Normal',
			'Multiply',
			'Screen',
		]);
		expect(screen.getByText('Blend mode').className).toBe('field-label');
	});

	it('gives back the value chosen, as one of its options', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn<(value: Blend) => void>();
		render(<Select label="Blend mode" value="normal" options={OPTIONS} onChange={onChange} />);
		await user.selectOptions(screen.getByRole('combobox', { name: 'Blend mode' }), 'Screen');
		expect(onChange).toHaveBeenCalledWith('screen');
	});

	it('hides the label from the eye, not from a screen reader, when asked', () => {
		render(
			<Select label="Format" value="normal" options={OPTIONS} onChange={vi.fn()} hideLabel />
		);
		expect(screen.getByRole('combobox', { name: 'Format' })).toBeDefined();
		expect(screen.getByText('Format').className).toBe('visually-hidden');
	});
});
