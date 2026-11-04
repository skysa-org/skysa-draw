import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Menu, type MenuItem } from '../../src/components/ui/Menu.js';

/**
 * A menu under an icon button (docs/ARCHITECTURE.md §7, "The interface"),
 * after the WAI-ARIA menu button pattern: the trigger says it has a menu and
 * whether it is open; the arrows move among the items, passing over a disabled
 * one; Enter and Space choose; Escape closes and gives the focus back; a press
 * anywhere else closes it.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

const makeItems = () => {
	const chosen = vi.fn<(id: string) => void>();
	const item = (id: string, extra: Partial<MenuItem> = {}): MenuItem => ({
		id,
		label: id,
		onSelect: () => chosen(id),
		...extra,
	});
	return {
		chosen,
		items: [
			item('Header', { disabled: true }),
			item('Rename', { shortcut: 'F2' }),
			item('Duplicate'),
			item('Archive', { disabled: true }),
			item('Delete', { danger: true }),
		],
	};
};

const renderMenu = (align?: 'start' | 'end') => {
	const { chosen, items } = makeItems();
	render(
		<>
			<Menu label="More" icon={<svg />} items={items} align={align} />
			<button type="button">Elsewhere</button>
		</>
	);
	return { chosen, trigger: screen.getByRole('button', { name: 'More' }) };
};

const focusedItem = () => document.activeElement?.textContent;

describe('Menu', () => {
	it('has a trigger that says it opens a menu, and whether it is open', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
		expect(trigger.getAttribute('aria-controls')).toBeNull();
		expect(screen.queryByRole('menu')).toBeNull();

		await user.click(trigger);
		const menu = screen.getByRole('menu', { name: 'More' });
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
		expect(screen.getAllByRole('menuitem')).toHaveLength(5);
	});

	it('opens on the first item that can be chosen, and moves among those with the arrows, wrapping', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		expect(focusedItem()).toBe('RenameF2');

		await user.keyboard('{ArrowDown}');
		expect(focusedItem()).toBe('Duplicate');
		await user.keyboard('{ArrowDown}');
		expect(focusedItem()).toBe('Delete');
		await user.keyboard('{ArrowDown}');
		expect(focusedItem()).toBe('RenameF2');
		await user.keyboard('{ArrowUp}');
		expect(focusedItem()).toBe('Delete');
		await user.keyboard('{Home}');
		expect(focusedItem()).toBe('RenameF2');
		await user.keyboard('{End}');
		expect(focusedItem()).toBe('Delete');
	});

	it('opens from the trigger with ArrowDown on the first item and ArrowUp on the last', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		trigger.focus();
		await user.keyboard('{ArrowDown}');
		expect(focusedItem()).toBe('RenameF2');

		await user.keyboard('{Escape}');
		await user.keyboard('{ArrowUp}');
		expect(focusedItem()).toBe('Delete');
	});

	it('chooses with Enter and with Space, closing and giving the focus back', async () => {
		const user = userEvent.setup();
		const { chosen, trigger } = renderMenu();
		await user.click(trigger);
		await user.keyboard('{ArrowDown}{Enter}');
		expect(chosen).toHaveBeenCalledWith('Duplicate');
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(trigger);

		await user.keyboard('{ArrowUp}');
		await user.keyboard(' ');
		expect(chosen).toHaveBeenLastCalledWith('Delete');
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('chooses with a click', async () => {
		const user = userEvent.setup();
		const { chosen, trigger } = renderMenu();
		await user.click(trigger);
		await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
		expect(chosen).toHaveBeenCalledWith('Rename');
		expect(document.activeElement).toBe(trigger);
	});

	it('shows a disabled item as one, and does nothing when it is pressed', async () => {
		const user = userEvent.setup();
		const { chosen, trigger } = renderMenu();
		await user.click(trigger);
		const archive = screen.getByRole('menuitem', { name: 'Archive' });
		expect(archive.getAttribute('aria-disabled')).toBe('true');

		await user.click(archive);
		expect(chosen).not.toHaveBeenCalled();
		expect(screen.getByRole('menu')).toBeDefined();
	});

	it('closes on Escape, gives the focus back, and keeps the key from what holds it', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		const outer = vi.fn();
		document.addEventListener('keydown', outer);
		await user.click(trigger);

		await user.keyboard('{Escape}');
		document.removeEventListener('keydown', outer);
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		expect(outer).not.toHaveBeenCalled();
	});

	it('closes on Escape from the trigger while it is open', () => {
		const { trigger } = renderMenu();
		fireEvent.click(trigger);
		expect(fireEvent.keyDown(trigger, { key: 'Escape' })).toBe(false);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('closes on a press anywhere else, and not on one inside it', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		fireEvent.pointerDown(screen.getByRole('menu'));
		expect(screen.getByRole('menu')).toBeDefined();

		await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Elsewhere' }));
	});

	it('closes on Tab, and on a second press of the trigger', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		await user.tab();
		expect(screen.queryByRole('menu')).toBeNull();

		await user.click(trigger);
		await user.click(trigger);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('marks an item that destroys, and shows an item’s key as its description, not its name', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		expect(screen.getByRole('menuitem', { name: 'Delete' }).className).toContain(
			'menu-item-danger'
		);
		const rename = screen.getByRole('menuitem', { name: 'Rename' });
		const key = screen.getByText('F2');
		expect(key.tagName).toBe('KBD');
		expect(rename.getAttribute('aria-describedby')).toBe(key.id);
		expect(
			screen.getByRole('menuitem', { name: 'Duplicate' }).hasAttribute('aria-describedby')
		).toBe(false);
	});

	it('lines up with the side it is told', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu('end');
		await user.click(trigger);
		expect(screen.getByRole('menu').className).toBe('menu-list menu-end');
	});

	it('hangs from the start, unless it would run past the end of the window', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		expect(screen.getByRole('menu').className).toBe('menu-list menu-start');
		await user.keyboard('{Escape}');

		vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1000);
		vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(192);
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
			x: 900,
			y: 0,
			left: 900,
			right: 944,
			top: 0,
			bottom: 44,
			width: 44,
			height: 44,
			toJSON: () => ({}),
		});
		await user.click(trigger);
		expect(screen.getByRole('menu').className).toBe('menu-list menu-end');
	});
});
