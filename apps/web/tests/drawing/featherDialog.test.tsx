import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FEATHER_MAX, FeatherDialog } from '../../src/drawing/panels/FeatherDialog.js';

/**
 * Feather… (docs/decisions/0004-the-interface.md, "The context menu"): the
 * area's feather, as a slider and a number that are one value, starting at
 * the area's own; Apply sets it, Cancel and Escape leave it.
 */

const open = (feather = 4, placement: 'sheet' | 'drawer' = 'drawer') => {
	const onApply = vi.fn<(feather: number) => void>();
	const onClose = vi.fn();
	render(
		<FeatherDialog
			placement={placement}
			open
			feather={feather}
			onApply={onApply}
			onClose={onClose}
		/>
	);
	const dialog = screen.getByRole('dialog', { name: 'Feather selection' });
	const slider = screen.getByRole('slider', { name: 'Feather radius' });
	const field = screen.getByRole('spinbutton', { name: 'Feather radius in pixels' });
	return { onApply, onClose, dialog, slider, field };
};

describe('the feather dialog', () => {
	it('starts at the area’s feather, in a drawer or a sheet as the frame places it', () => {
		const { dialog, slider, field } = open(4);
		expect(dialog.classList.contains('panel-drawer')).toBe(true);
		expect(slider).toHaveProperty('value', '4');
		expect(field).toHaveProperty('value', '4');
		expect(slider.getAttribute('max')).toBe(String(FEATHER_MAX));
		expect(slider.getAttribute('aria-valuetext')).toBe('4 px');
	});

	it('opens as a sheet on compact', () => {
		expect(open(0, 'sheet').dialog.classList.contains('panel-sheet')).toBe(true);
	});

	it('keeps the slider and the number one value, within 0 to the most', () => {
		const { slider, field } = open(4);
		fireEvent.change(slider, { target: { value: '30' } });
		expect(field).toHaveProperty('value', '30');
		fireEvent.change(field, { target: { value: '12.5' } });
		expect(slider).toHaveProperty('value', '12.5');
		fireEvent.change(field, { target: { value: '900' } });
		expect(field).toHaveProperty('value', String(FEATHER_MAX));
		fireEvent.change(field, { target: { value: '-3' } });
		expect(field).toHaveProperty('value', '0');
	});

	it('applies what was chosen, and closes', async () => {
		const user = userEvent.setup();
		const { slider, onApply, onClose } = open(4);
		fireEvent.change(slider, { target: { value: '18' } });
		await user.click(screen.getByRole('button', { name: 'Apply' }));
		expect(onApply).toHaveBeenCalledWith(18);
		expect(onClose).toHaveBeenCalled();
	});

	it('applies on Enter in the number field', () => {
		const { field, onApply } = open(4);
		fireEvent.change(field, { target: { value: '7' } });
		fireEvent.submit(field);
		expect(onApply).toHaveBeenCalledWith(7);
	});

	it('changes nothing on Cancel or Escape', async () => {
		const user = userEvent.setup();
		const { onApply, onClose } = open(4);
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		await user.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(onApply).not.toHaveBeenCalled();
	});
});
