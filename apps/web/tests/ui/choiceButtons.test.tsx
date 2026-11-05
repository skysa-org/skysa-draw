import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { type Choice, ChoiceButtons } from '../../src/components/ui/ChoiceButtons.js';
import { CheckIcon, CloseIcon } from '../../src/components/ui/icons.js';
import { Toggle } from '../../src/components/ui/Toggle.js';
import { ToolBar } from '../../src/components/ui/ToolBar.js';

/**
 * One of a few options, each by its icon (docs/ARCHITECTURE.md §7, "The
 * interface"), as the selection tools' modes are: a group named for what it
 * chooses, of buttons named in words, the one in force pressed, reached by a
 * tool bar's arrow keys as its other buttons are.
 */

type Fruit = 'apple' | 'pear' | 'plum';

const CHOICES: readonly Choice<Fruit>[] = [
	{ value: 'apple', label: 'Apple', icon: <CheckIcon /> },
	{ value: 'pear', label: 'Pear', icon: <CloseIcon />, shortcut: 'Shift' },
	{ value: 'plum', label: 'Plum', icon: <CheckIcon />, shortcut: '⌥⇧' },
];

const renderChoices = (value: Fruit) => {
	const onChange = vi.fn();
	render(<ChoiceButtons label="Fruit" choices={CHOICES} value={value} onChange={onChange} />);
	return { onChange, group: screen.getByRole('group', { name: 'Fruit' }) };
};

describe('ChoiceButtons', () => {
	it('is a group named for what it chooses, of a button per choice, in order, named in words', () => {
		const { group } = renderChoices('apple');
		const buttons = [...group.querySelectorAll('button')];
		expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
			'Apple',
			'Pear',
			'Plum',
		]);
		buttons.forEach((button) => {
			expect(button.getAttribute('type')).toBe('button');
			// A target either way, as every icon button is (`ui.css`).
			expect(button.classList.contains('icon-button')).toBe(true);
			expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
		});
	});

	it('presses the one in force, and only that one', () => {
		renderChoices('pear');
		expect(screen.getByRole('button', { name: 'Apple' }).getAttribute('aria-pressed')).toBe(
			'false'
		);
		expect(screen.getByRole('button', { name: 'Pear' }).getAttribute('aria-pressed')).toBe(
			'true'
		);
		expect(screen.getByRole('button', { name: 'Plum' }).getAttribute('aria-pressed')).toBe(
			'false'
		);
	});

	it('puts a choice’s key in its tooltip after its name, and only its name where it has none', () => {
		renderChoices('apple');
		expect(screen.getByRole('button', { name: 'Apple' }).getAttribute('title')).toBe('Apple');
		expect(screen.getByRole('button', { name: 'Pear' }).getAttribute('title')).toBe(
			'Pear (Shift)'
		);
		expect(screen.getByRole('button', { name: 'Plum' }).getAttribute('title')).toBe(
			'Plum (⌥⇧)'
		);
	});

	it('asks for the choice pressed, and for nothing when the one in force is pressed again', async () => {
		const user = userEvent.setup();
		const { onChange } = renderChoices('apple');
		await user.click(screen.getByRole('button', { name: 'Plum' }));
		expect(onChange).toHaveBeenCalledWith('plum');
		await user.click(screen.getByRole('button', { name: 'Apple' }));
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('is reached by a tool bar’s arrow keys, one button at a time and on past its end, and pressed by Space and Enter', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const onToggle = vi.fn();
		render(
			<ToolBar orientation="horizontal" label="Tool options">
				<ChoiceButtons label="Fruit" choices={CHOICES} value="apple" onChange={onChange} />
				<Toggle label="Constrain" pressed={false} onChange={onToggle} />
			</ToolBar>
		);
		await user.tab();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Apple' }));
		await user.keyboard('{ArrowRight}');
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pear' }));
		// The arrow moves the focus and chooses nothing, as it does along the bar.
		expect(onChange).not.toHaveBeenCalled();
		await user.keyboard(' ');
		expect(onChange).toHaveBeenLastCalledWith('pear');
		await user.keyboard('{ArrowRight}{Enter}');
		expect(onChange).toHaveBeenLastCalledWith('plum');
		await user.keyboard('{ArrowRight}');
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Constrain' }));
		// One tab stop for the bar, the choices among its buttons.
		expect(
			[...screen.getByRole('toolbar').querySelectorAll('button')].filter(
				(button) => button.tabIndex === 0
			)
		).toHaveLength(1);
	});
});
