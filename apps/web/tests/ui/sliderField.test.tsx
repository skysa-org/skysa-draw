import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SliderField } from '../../src/components/ui/SliderField.js';

/**
 * A slider and the number field beside it (`SliderField.tsx`): Fill…'s
 * opacity, Modify…'s radius. What is typed is held to the range, or by the
 * dialog's own rule; what is not a number keeps the value.
 */

const show = (clamp?: (value: number) => number) => {
	const onChange = vi.fn();
	render(
		<SliderField
			label="Opacity"
			fieldLabel="Opacity value"
			value={40}
			min={0}
			max={100}
			step={1}
			clamp={clamp}
			onChange={onChange}
		/>
	);
	return { onChange, field: screen.getByRole('spinbutton', { name: 'Opacity value' }) };
};

describe('SliderField', () => {
	it('names the slider by its label and the field by its own', () => {
		show();
		expect(screen.getByRole<HTMLInputElement>('slider', { name: 'Opacity' }).value).toBe('40');
		expect(
			screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Opacity value' }).value
		).toBe('40');
	});

	it('passes on what the slider is moved to', () => {
		const { onChange } = show();
		fireEvent.change(screen.getByRole('slider', { name: 'Opacity' }), {
			target: { value: '70' },
		});
		expect(onChange).toHaveBeenLastCalledWith(70);
	});

	it('holds a typed number to the range', () => {
		const { onChange, field } = show();
		fireEvent.change(field, { target: { value: '250' } });
		expect(onChange).toHaveBeenLastCalledWith(100);
		fireEvent.change(field, { target: { value: '-5' } });
		expect(onChange).toHaveBeenLastCalledWith(0);
		fireEvent.change(field, { target: { value: '12.5' } });
		expect(onChange).toHaveBeenLastCalledWith(12.5);
	});

	it("holds a typed number by the dialog's own rule where it has one", () => {
		const { onChange, field } = show((value) => Math.round(Math.min(100, Math.max(1, value))));
		fireEvent.change(field, { target: { value: '12.5' } });
		expect(onChange).toHaveBeenLastCalledWith(13);
		fireEvent.change(field, { target: { value: '0' } });
		expect(onChange).toHaveBeenLastCalledWith(1);
	});

	it('keeps the value when what is typed is not a number', () => {
		const { onChange, field } = show();
		fireEvent.change(field, { target: { value: '' } });
		expect(onChange).toHaveBeenLastCalledWith(40);
	});
});
