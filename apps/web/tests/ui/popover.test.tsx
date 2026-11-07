import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Popover, spotBeside } from '../../src/components/ui/Popover.js';
import type { Orientation } from '../../src/components/ui/ToolBar.js';

/**
 * A panel opened beside its button (docs/ARCHITECTURE.md §7, "The
 * interface"), as the color panel is from the colors' button: placed beside
 * the button toward the canvas, flipped and held in where the window has not
 * the room; a dialog that takes the focus and gives it back to the button,
 * closed by Escape and by a press outside, which goes on to what it landed on
 * unless it is spent closing it.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

/** A button's box, from the window's top left. */
const box = (left: number, top: number, size = 44) => ({
	left,
	top,
	right: left + size,
	bottom: top + size,
});

describe('spotBeside', () => {
	const view = { width: 1200, height: 800 };

	it('opens beside a rail toward the end of the line, its top at the button’s', () => {
		const spot = spotBeside({
			box: box(0, 100),
			width: 280,
			height: 330,
			view,
			rtl: false,
			orientation: 'vertical',
		});
		expect(spot).toMatchObject({ position: 'fixed', top: 100, left: 48, maxHeight: 692 });
		// Growing from the button's middle.
		expect(spot.transformOrigin).toBe('-26px 22px');
	});

	it('lines its foot up with the button’s where there is no room under it, as at the rail’s end', () => {
		const spot = spotBeside({
			box: box(0, 600),
			width: 280,
			height: 330,
			view,
			rtl: false,
			orientation: 'vertical',
		});
		expect(spot).toMatchObject({ top: 314, left: 48, maxHeight: 478 });
	});

	it('opens leftward in a right-to-left language, and back from the edge where it would run past it', () => {
		const rtl = spotBeside({
			box: box(1156, 100),
			width: 280,
			height: 330,
			view,
			rtl: true,
			orientation: 'vertical',
		});
		expect(rtl.left).toBe(872);
		const cramped = spotBeside({
			box: box(1100, 100),
			width: 280,
			height: 330,
			view,
			rtl: false,
			orientation: 'vertical',
		});
		expect(cramped.left).toBe(816);
	});

	it('is as tall as the window has room for, never past its edges', () => {
		const spot = spotBeside({
			box: box(0, 300),
			width: 280,
			height: 2000,
			view,
			rtl: false,
			orientation: 'vertical',
		});
		expect(spot).toMatchObject({ top: 8, maxHeight: 784 });
	});

	it('rises over a bar at the foot of a compact window, its end at the button’s end', () => {
		const phone = { width: 390, height: 844 };
		const spot = spotBeside({
			box: box(290, 790),
			width: 280,
			height: 330,
			view: phone,
			rtl: false,
			orientation: 'horizontal',
		});
		expect(spot).toMatchObject({ top: 456, left: 54, maxHeight: 778 });
	});

	it('never covers the button across the bar, however tall it is', () => {
		const spot = spotBeside({
			box: box(290, 790),
			width: 280,
			height: 1000,
			view: { width: 390, height: 844 },
			rtl: false,
			orientation: 'horizontal',
		});
		expect(spot).toMatchObject({ top: 8, maxHeight: 778 });
		expect(spot.top + spot.maxHeight).toBe(786);
	});

	it('hangs under a bar across the top, its start at the button’s', () => {
		const spot = spotBeside({
			box: box(100, 0),
			width: 280,
			height: 330,
			view,
			rtl: false,
			orientation: 'horizontal',
		});
		expect(spot).toMatchObject({ top: 48, left: 100, maxHeight: 744 });
	});
});

/** A button and the popover it opens, as the colors' button and the color panel are. */
const Harness = ({
	open,
	onClose,
	spends,
	orientation = 'vertical',
}: Readonly<{
	open: boolean;
	onClose: () => void;
	spends?: (path: readonly EventTarget[]) => boolean;
	orientation?: Orientation;
}>) => {
	const anchor = useRef<HTMLButtonElement>(null);
	return (
		<>
			<button ref={anchor} type="button">
				Colors
			</button>
			<Popover
				id="panel"
				label="Color"
				open={open}
				anchor={anchor}
				orientation={orientation}
				onClose={onClose}
				spends={spends}
			>
				<input
					aria-label="Hex"
					onKeyDown={(event) => {
						if (event.key === 'Escape') event.preventDefault();
					}}
				/>
				<button type="button">Swap</button>
			</Popover>
			<button type="button">Layers</button>
		</>
	);
};

const renderHarness = (props: Partial<Parameters<typeof Harness>[0]> = {}) => {
	const onClose = vi.fn();
	const utils = render(<Harness open onClose={onClose} {...props} />);
	return { ...utils, onClose };
};

describe('Popover', () => {
	it('is nothing while closed', () => {
		renderHarness({ open: false });
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('is a dialog, not modal, named, that takes the focus as it opens', () => {
		renderHarness();
		const dialog = screen.getByRole('dialog', { name: 'Color' });
		expect(dialog.getAttribute('aria-modal')).toBe('false');
		expect(dialog.id).toBe('panel');
		expect(document.activeElement).toBe(dialog);
	});

	it('comes after its button in the page, so Tab goes from it into the panel and on out', async () => {
		const user = userEvent.setup();
		renderHarness();
		screen.getByRole('button', { name: 'Colors' }).focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByLabelText('Hex'));
		await user.tab();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Layers' }));
	});

	it('closes on Escape, but not on one a field in it has taken already', async () => {
		const user = userEvent.setup();
		const { onClose } = renderHarness();
		screen.getByLabelText('Hex').focus();
		await user.keyboard('{Escape}');
		expect(onClose).not.toHaveBeenCalled();
		screen.getByRole('button', { name: 'Swap' }).focus();
		await user.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('gives the focus back to its button as it closes, if it had the focus', () => {
		const onClose = vi.fn();
		const { rerender } = render(<Harness open onClose={onClose} />);
		screen.getByRole('button', { name: 'Swap' }).focus();
		rerender(<Harness open={false} onClose={onClose} />);
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Colors' }));
	});

	it('leaves the focus where it went, closing after it went elsewhere', () => {
		const onClose = vi.fn();
		const { rerender } = render(<Harness open onClose={onClose} />);
		const layers = screen.getByRole('button', { name: 'Layers' });
		layers.focus();
		rerender(<Harness open={false} onClose={onClose} />);
		expect(document.activeElement).toBe(layers);
	});

	it('closes on a press outside, not on one in it or on its button, whose own press is a toggle', () => {
		const { onClose } = renderHarness();
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Swap' }));
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Colors' }));
		expect(onClose).not.toHaveBeenCalled();
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Layers' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('lets a press outside go on to what it landed on, unless it is spent closing it', () => {
		const heard = vi.fn();
		const spends = (path: readonly EventTarget[]) =>
			path.some((each) => each instanceof Element && each.id === 'canvas');
		const { onClose } = renderHarness({ spends });
		const canvas = document.createElement('div');
		canvas.id = 'canvas';
		document.body.append(canvas);
		canvas.addEventListener('pointerdown', heard);
		const layers = screen.getByRole('button', { name: 'Layers' });
		layers.addEventListener('pointerdown', heard);

		fireEvent.pointerDown(canvas);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(heard).not.toHaveBeenCalled();
		fireEvent.pointerDown(layers);
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(heard).toHaveBeenCalledTimes(1);
		canvas.remove();
	});

	it('stays open when the window loses the focus, as to the system’s color picker', () => {
		const { onClose } = renderHarness();
		fireEvent.blur(window);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('is placed beside its button, and placed again when the window changes size', () => {
		vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1200);
		vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
		const at = { top: 100 };
		vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockImplementation(
			() => ({ ...box(0, at.top), x: 0, y: at.top, width: 44, height: 44 }) as DOMRect
		);
		const { onClose } = renderHarness();
		const dialog = screen.getByRole('dialog');
		expect(dialog.style.top).toBe('100px');
		expect(dialog.style.left).toBe('48px');

		at.top = 300;
		fireEvent(window, new Event('resize'));
		expect(dialog.style.top).toBe('300px');
		expect(onClose).not.toHaveBeenCalled();
	});
});
