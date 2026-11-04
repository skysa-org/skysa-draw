import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Menu } from '../../src/components/ui/Menu.js';
import { ToolBar } from '../../src/components/ui/ToolBar.js';

/**
 * The tool bar (docs/ARCHITECTURE.md §7, "The interface"), as the WAI-ARIA
 * toolbar pattern has it: one tab stop, the arrows along its axis, Home and
 * End, wrapping, and a disabled button passed over.
 */

const Bar = ({
	orientation = 'horizontal',
	disabled = [],
	extra,
}: {
	orientation?: 'horizontal' | 'vertical';
	disabled?: readonly string[];
	extra?: ReactNode;
}) => (
	<>
		<button type="button">Before</button>
		<ToolBar orientation={orientation} label="Tools">
			{['Select', 'Hand', 'Pencil', 'Brush'].map((name) => (
				<button key={name} type="button" disabled={disabled.includes(name)}>
					{name}
				</button>
			))}
			{extra}
		</ToolBar>
		<button type="button">After</button>
	</>
);

const button = (name: string) => screen.getByRole('button', { name });

const tabIndexes = () => ['Select', 'Hand', 'Pencil', 'Brush'].map((name) => button(name).tabIndex);

describe('ToolBar', () => {
	it('is a toolbar named for a screen reader, running the way it says', () => {
		const { rerender } = render(<Bar />);
		const bar = screen.getByRole('toolbar', { name: 'Tools' });
		expect(bar.getAttribute('aria-orientation')).toBe('horizontal');
		expect(bar.className).toContain('toolbar-horizontal');

		rerender(<Bar orientation="vertical" />);
		expect(bar.getAttribute('aria-orientation')).toBe('vertical');
		expect(bar.className).toContain('toolbar-vertical');
	});

	it('is one tab stop, on the first button, and Tab passes over the rest', async () => {
		const user = userEvent.setup();
		render(<Bar />);
		expect(tabIndexes()).toEqual([0, -1, -1, -1]);

		button('Before').focus();
		await user.tab();
		expect(document.activeElement).toBe(button('Select'));
		await user.tab();
		expect(document.activeElement).toBe(button('After'));
	});

	it('moves along a horizontal bar with the left and right arrows, wrapping at the ends', async () => {
		const user = userEvent.setup();
		render(<Bar />);
		button('Select').focus();

		await user.keyboard('{ArrowRight}');
		expect(document.activeElement).toBe(button('Hand'));
		await user.keyboard('{ArrowDown}');
		expect(document.activeElement).toBe(button('Hand'));
		await user.keyboard('{ArrowLeft}{ArrowLeft}');
		expect(document.activeElement).toBe(button('Brush'));
		await user.keyboard('{ArrowRight}');
		expect(document.activeElement).toBe(button('Select'));
	});

	it('moves down a vertical bar with the up and down arrows', async () => {
		const user = userEvent.setup();
		render(<Bar orientation="vertical" />);
		button('Select').focus();

		await user.keyboard('{ArrowDown}');
		expect(document.activeElement).toBe(button('Hand'));
		await user.keyboard('{ArrowRight}');
		expect(document.activeElement).toBe(button('Hand'));
		await user.keyboard('{ArrowUp}{ArrowUp}');
		expect(document.activeElement).toBe(button('Brush'));
	});

	it('goes to the first and the last with Home and End', async () => {
		const user = userEvent.setup();
		render(<Bar />);
		button('Hand').focus();

		await user.keyboard('{End}');
		expect(document.activeElement).toBe(button('Brush'));
		await user.keyboard('{Home}');
		expect(document.activeElement).toBe(button('Select'));
	});

	it('passes over a disabled button, and never makes one the tab stop', async () => {
		const user = userEvent.setup();
		render(<Bar disabled={['Select', 'Pencil']} />);
		expect(button('Hand').tabIndex).toBe(0);

		button('Hand').focus();
		await user.keyboard('{ArrowRight}');
		expect(document.activeElement).toBe(button('Brush'));
		await user.keyboard('{ArrowRight}');
		expect(document.activeElement).toBe(button('Hand'));
		await user.keyboard('{Home}');
		expect(document.activeElement).toBe(button('Hand'));
	});

	it('comes back by Tab to the button focused last, even after a render', async () => {
		const user = userEvent.setup();
		const { rerender } = render(<Bar />);
		button('Select').focus();
		await user.keyboard('{ArrowRight}{ArrowRight}');
		expect(tabIndexes()).toEqual([-1, -1, 0, -1]);

		await user.tab();
		expect(document.activeElement).toBe(button('After'));
		rerender(<Bar disabled={['Brush']} />);
		expect(button('Pencil').tabIndex).toBe(0);

		await user.tab({ shift: true });
		expect(document.activeElement).toBe(button('Pencil'));
	});

	it('leaves the keys of a control that is not one of its buttons to that control', async () => {
		const user = userEvent.setup();
		render(<Bar extra={<input aria-label="Size" />} />);
		const field = screen.getByRole('textbox', { name: 'Size' });
		field.focus();

		await user.keyboard('{ArrowRight}{Home}');
		expect(document.activeElement).toBe(field);
	});

	it("leaves an open menu's arrows to the menu", async () => {
		const user = userEvent.setup();
		const items = ['Zoom in', 'Zoom out'].map((label) => ({
			id: label,
			label,
			onSelect: vi.fn(),
		}));
		render(<Bar orientation="vertical" extra={<Menu label="More" icon="…" items={items} />} />);
		await user.click(button('More'));
		expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Zoom in' }));

		await user.keyboard('{ArrowDown}');
		expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Zoom out' }));
	});

	it('leaves a modified arrow alone', async () => {
		const user = userEvent.setup();
		render(<Bar />);
		button('Select').focus();
		await user.keyboard('{Control>}{ArrowRight}{/Control}');
		expect(document.activeElement).toBe(button('Select'));
	});
});
