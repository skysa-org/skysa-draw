import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DialogForm } from '../../src/components/ui/DialogForm.js';
import { Select } from '../../src/components/ui/Select.js';

/**
 * A dialog's form (docs/decisions/0004-the-interface.md, "The context
 * menu"): where the focus starts, and an Apply that starts work that takes a
 * while, which the dialog says it is busy with and closes itself once done.
 * Enter, Cancel and a disabled Apply are the dialogs' own tests'
 * (`imageDialogs.test.tsx`, `fillDialog.test.tsx`, `modifyDialog.test.tsx`).
 */

const FORMATS: readonly Readonly<{ value: string; label: string }>[] = [
	{ value: 'png', label: 'PNG' },
	{ value: 'jpeg', label: 'JPEG' },
];

const show = (
	setup: Readonly<{
		busy?: boolean;
		closesOnApply?: boolean;
		children?: ReactNode;
	}> = {}
) => {
	const calls: string[] = [];
	const onApply = vi.fn(() => calls.push('apply'));
	const onClose = vi.fn(() => calls.push('close'));
	const form = (busy: boolean | undefined) => (
		<DialogForm
			title="Export"
			applyLabel={busy === true ? 'Exporting…' : 'Export'}
			busy={busy}
			closesOnApply={setup.closesOnApply}
			onApply={onApply}
			onClose={onClose}
		>
			{setup.children ?? (
				<Select label="Format" value="png" options={FORMATS} onChange={vi.fn()} />
			)}
		</DialogForm>
	);
	const view = render(form(setup.busy));
	const element = view.container.querySelector('form');
	if (element === null) throw new Error('a form is shown');
	return {
		calls,
		onApply,
		onClose,
		form: element,
		rerender: (busy: boolean) => view.rerender(form(busy)),
		unmount: view.unmount,
	};
};

describe('DialogForm', () => {
	it('starts the focus on a list to choose from, where it is the first field', async () => {
		show({
			children: (
				<>
					<Select label="Format" value="png" options={FORMATS} onChange={vi.fn()} />
					<input type="text" aria-label="Name" defaultValue="floor-plan" />
				</>
			),
		});
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Format' }))
		);
	});

	it('starts the focus on the choice made, where a text field comes after it in its group', async () => {
		show({
			children: (
				<fieldset>
					<legend>Contents</legend>
					<input type="radio" name="contents" aria-label="Fill color" />
					<input type="radio" name="contents" aria-label="Color…" defaultChecked />
					<input type="text" aria-label="Hex" defaultValue="#ff0000" />
				</fieldset>
			),
		});
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Color…' }))
		);
	});

	it('closes after Apply, unless the dialog closes itself once its work is done', async () => {
		const user = userEvent.setup();
		const closing = show();
		await user.click(screen.getByRole('button', { name: 'Export' }));
		expect(closing.calls).toEqual(['apply', 'close']);
		closing.unmount();

		const staying = show({ closesOnApply: false });
		await user.click(screen.getByRole('button', { name: 'Export' }));
		expect(staying.onApply).toHaveBeenCalledTimes(1);
		expect(staying.onClose).not.toHaveBeenCalled();
	});

	it('says it is busy, and neither Apply nor Enter applies again until it is done', () => {
		const { form, onApply, rerender } = show({ busy: true, closesOnApply: false });
		expect(form.getAttribute('aria-busy')).toBe('true');
		const apply = screen.getByRole('button', { name: 'Exporting…' });
		expect(apply).toHaveProperty('disabled', true);
		fireEvent.keyDown(screen.getByRole('combobox', { name: 'Format' }), { key: 'Enter' });
		fireEvent.submit(form);
		expect(onApply).not.toHaveBeenCalled();
		// Cancel is still there to press.
		expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', false);

		rerender(false);
		expect(form.hasAttribute('aria-busy')).toBe(false);
		fireEvent.keyDown(screen.getByRole('combobox', { name: 'Format' }), { key: 'Enter' });
		expect(onApply).toHaveBeenCalledTimes(1);
	});
});
