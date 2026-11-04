import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Panel } from '../../src/components/ui/Panel.js';
import { PanelHost } from '../../src/components/ui/PanelHost.js';

/**
 * A panel, and where the frame puts it (docs/ARCHITECTURE.md §7, "The
 * interface"): a sheet on compact, a drawer on medium, the dock on expanded.
 */

// jsdom has no pointer capture; the sheet's handle asks for it on every drag.
const capture = vi.fn();

beforeEach(() => {
	capture.mockClear();
	Element.prototype.setPointerCapture = capture;
});

afterEach(() => {
	Reflect.deleteProperty(Element.prototype, 'setPointerCapture');
});

/** A host the test opens with a button and that closes itself, as the frame's do. */
const Opened = ({
	placement,
	side,
	children = <p>Inside</p>,
}: {
	placement: 'sheet' | 'drawer' | 'dock';
	side?: 'start' | 'end';
	children?: ReactNode;
}) => {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open
			</button>
			<PanelHost
				placement={placement}
				side={side}
				open={open}
				onClose={() => setOpen(false)}
				label="Layers"
			>
				{children}
			</PanelHost>
		</>
	);
};

describe('Panel', () => {
	it('is a section headed by its title, with its actions, a close control and a body', async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(
			<Panel title="Layers" onClose={onClose} actions={<button type="button">Add</button>}>
				<p>Rows</p>
			</Panel>
		);
		const panel = screen.getByRole('region', { name: 'Layers' });
		expect(screen.getByRole('heading', { level: 2, name: 'Layers' })).toBeDefined();
		expect(panel.querySelector('.panel-actions')?.textContent).toBe('Add');
		expect(panel.querySelector('.panel-body')?.textContent).toBe('Rows');

		await user.click(screen.getByRole('button', { name: 'Close panel' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('has no close control when it cannot be put away', () => {
		render(<Panel title="Properties">body</Panel>);
		expect(screen.queryByRole('button', { name: 'Close panel' })).toBeNull();
	});
});

describe('PanelHost', () => {
	it('is nothing while closed, whatever the placement', () => {
		(['sheet', 'drawer', 'dock'] as const).forEach((placement) => {
			const { container, unmount } = render(
				<PanelHost placement={placement} open={false} onClose={vi.fn()} label="Layers">
					<p>Inside</p>
				</PanelHost>
			);
			expect(container.innerHTML).toBe('');
			expect(screen.queryByText('Inside')).toBeNull();
			unmount();
		});
	});

	it('docks as a column in the flow: no dialog, no backdrop, and Escape is not its own', () => {
		const onClose = vi.fn();
		const { container } = render(
			<PanelHost placement="dock" open onClose={onClose} label="Layers">
				<p>Inside</p>
			</PanelHost>
		);
		const dock = screen.getByRole('complementary', { name: 'Layers' });
		expect(dock.tagName).toBe('ASIDE');
		expect(dock.className).toBe('panel-dock');
		expect(container.contains(dock)).toBe(true);
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.querySelector('.panel-backdrop')).toBeNull();

		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).not.toHaveBeenCalled();
	});

	it('opens a sheet as a dialog over the page, with a handle, outside the frame', () => {
		const { container } = render(
			<PanelHost placement="sheet" open onClose={vi.fn()} label="Layers">
				<p>Inside</p>
			</PanelHost>
		);
		const sheet = screen.getByRole('dialog', { name: 'Layers' });
		expect(sheet.className).toBe('panel-host panel-sheet');
		expect(container.contains(sheet)).toBe(false);
		expect(sheet.parentElement).toBe(document.body);
		expect(screen.getByRole('separator', { name: 'Drag to resize' })).toBeDefined();
		expect(document.querySelector('.panel-backdrop')?.getAttribute('aria-hidden')).toBe('true');
	});

	it('opens a drawer from the end, or from the start when asked, without a handle', () => {
		const { rerender } = render(
			<PanelHost placement="drawer" open onClose={vi.fn()} label="Layers">
				<p>Inside</p>
			</PanelHost>
		);
		expect(screen.getByRole('dialog', { name: 'Layers' }).className).toBe(
			'panel-host panel-drawer panel-drawer-end'
		);
		expect(screen.queryByRole('separator')).toBeNull();

		rerender(
			<PanelHost placement="drawer" side="start" open onClose={vi.fn()} label="Layers">
				<p>Inside</p>
			</PanelHost>
		);
		expect(screen.getByRole('dialog', { name: 'Layers' }).className).toContain(
			'panel-drawer-start'
		);
	});

	it('takes the focus as it opens and gives it back to what opened it as it closes', async () => {
		const user = userEvent.setup();
		render(<Opened placement="sheet" />);
		const opener = screen.getByRole('button', { name: 'Open' });

		await user.click(opener);
		expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Layers' }));

		await user.keyboard('{Escape}');
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it('closes on a tap beside it, on the backdrop', async () => {
		const user = userEvent.setup();
		render(<Opened placement="drawer" />);
		await user.click(screen.getByRole('button', { name: 'Open' }));

		const backdrop = document.querySelector('.panel-backdrop');
		expect(backdrop).not.toBeNull();
		if (backdrop !== null) await user.click(backdrop);
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(document.querySelector('.panel-backdrop')).toBeNull();
	});

	it('leaves Escape to a control inside that has already taken it', async () => {
		const user = userEvent.setup();
		render(
			<Opened placement="sheet">
				<input
					aria-label="Name"
					onKeyDown={(event) => {
						if (event.key === 'Escape') event.preventDefault();
					}}
				/>
			</Opened>
		);
		await user.click(screen.getByRole('button', { name: 'Open' }));
		await user.click(screen.getByRole('textbox', { name: 'Name' }));

		await user.keyboard('{Escape}');
		expect(screen.getByRole('dialog', { name: 'Layers' })).toBeDefined();
	});

	it('closes only the one on top with Escape', () => {
		const under = vi.fn();
		const over = vi.fn();
		render(
			<>
				<PanelHost placement="drawer" side="start" open onClose={under} label="Library">
					<p>Drawings</p>
				</PanelHost>
				<PanelHost placement="drawer" open onClose={over} label="Layers">
					<p>Rows</p>
				</PanelHost>
			</>
		);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(over).toHaveBeenCalledTimes(1);
		expect(under).not.toHaveBeenCalled();
	});

	it('resizes a sheet by its handle, settles back from a short drag down, and closes from a long one', () => {
		const onClose = vi.fn();
		render(
			<PanelHost placement="sheet" open onClose={onClose} label="Layers">
				<p>Inside</p>
			</PanelHost>
		);
		const sheet = screen.getByRole('dialog', { name: 'Layers' });
		const handle = screen.getByRole('separator', { name: 'Drag to resize' });
		Object.defineProperty(sheet, 'offsetHeight', { value: 300, configurable: true });

		fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
		expect(capture).toHaveBeenCalledWith(1);
		fireEvent.pointerMove(handle, { clientY: 440, pointerId: 1 });
		expect(sheet.style.height).toBe('360px');
		fireEvent.pointerUp(handle, { clientY: 440, pointerId: 1 });
		expect(sheet.style.height).toBe('360px');

		fireEvent.pointerDown(handle, { clientY: 500, pointerId: 2 });
		fireEvent.pointerMove(handle, { clientY: 540, pointerId: 2 });
		expect(sheet.style.height).toBe('260px');
		fireEvent.pointerUp(handle, { clientY: 540, pointerId: 2 });
		expect(sheet.style.height).toBe('');
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.pointerDown(handle, { clientY: 500, pointerId: 3 });
		fireEvent.pointerUp(handle, { clientY: 620, pointerId: 3 });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('ignores a move on the handle with no drag begun', () => {
		render(
			<PanelHost placement="sheet" open onClose={vi.fn()} label="Layers">
				<p>Inside</p>
			</PanelHost>
		);
		const sheet = screen.getByRole('dialog', { name: 'Layers' });
		fireEvent.pointerMove(screen.getByRole('separator'), { clientY: 10, pointerId: 1 });
		expect(sheet.style.height).toBe('');
	});
});
