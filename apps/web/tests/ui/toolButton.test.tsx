import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolButton } from '../../src/components/ui/ToolButton.js';

/**
 * A tool in the tool bar (docs/ARCHITECTURE.md §7, "The interface"): named,
 * pressed when it is the tool in hand, its key in its tooltip, and a long
 * press — which is how a phone asks for a tool's options — instead of a click.
 */

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

const renderTool = (props: Partial<Parameters<typeof ToolButton>[0]> = {}) => {
	const onClick = vi.fn();
	const onLongPress = vi.fn();
	const utils = render(
		<ToolButton
			icon={<svg data-testid="icon" />}
			label="Brush"
			onClick={onClick}
			onLongPress={onLongPress}
			{...props}
		/>
	);
	return {
		...utils,
		onClick,
		onLongPress,
		button: screen.getByRole('button', { name: 'Brush' }),
	};
};

/** A press held for `ms`, then let go over the button, and the click the browser sends after. */
const press = (button: HTMLElement, ms: number) => {
	fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
	act(() => {
		vi.advanceTimersByTime(ms);
	});
	fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
	fireEvent.click(button);
};

describe('ToolButton', () => {
	it('is named by its label, with its key in the tooltip', () => {
		const { button, rerender, onClick } = renderTool({ shortcut: 'B' });
		expect(button.getAttribute('title')).toBe('Brush (B)');
		expect(button.getAttribute('aria-pressed')).toBeNull();

		rerender(<ToolButton icon={null} label="Brush" onClick={onClick} pressed />);
		expect(button.getAttribute('title')).toBe('Brush');
		expect(button.getAttribute('aria-pressed')).toBe('true');
		rerender(<ToolButton icon={null} label="Brush" onClick={onClick} pressed={false} />);
		expect(button.getAttribute('aria-pressed')).toBe('false');
	});

	it('shows its icon, and a badge when it has one', () => {
		const { button, rerender, onClick } = renderTool();
		expect(screen.getByTestId('icon')).toBeDefined();
		expect(button.querySelector('.tool-button-badge')).toBeNull();

		rerender(
			<ToolButton icon={null} label="Brush" onClick={onClick} badge={<span>red</span>} />
		);
		expect(button.querySelector('.tool-button-badge')?.textContent).toBe('red');
	});

	it('calls onClick on a short press, and never onLongPress', () => {
		const { button, onClick, onLongPress } = renderTool();
		press(button, 499);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('calls onLongPress after 500 ms held, and swallows the click that follows', () => {
		const { button, onClick, onLongPress } = renderTool();
		fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
		act(() => {
			vi.advanceTimersByTime(499);
		});
		expect(onLongPress).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(onLongPress).toHaveBeenCalledTimes(1);

		fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
		fireEvent.click(button);
		expect(onClick).not.toHaveBeenCalled();

		// The next press is an ordinary one again.
		press(button, 100);
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(onLongPress).toHaveBeenCalledTimes(1);
	});

	it('is not a long press once the pointer leaves, is canceled, or is not the primary button', () => {
		const { button, onLongPress } = renderTool();
		fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
		fireEvent.pointerLeave(button, { pointerId: 1 });
		fireEvent.pointerDown(button, { button: 0, pointerId: 2 });
		fireEvent.pointerCancel(button, { pointerId: 2 });
		fireEvent.pointerDown(button, { button: 2, pointerId: 3 });
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('takes the click of a key after a long press that was let go off the button', () => {
		const { button, onClick, onLongPress } = renderTool();
		fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
		act(() => {
			vi.advanceTimersByTime(500);
		});
		fireEvent.pointerLeave(button, { pointerId: 1 });
		expect(onLongPress).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(button, { key: 'Enter' });
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("keeps the browser's own menu off a button with a long press, and only there", () => {
		const { button, rerender, onClick } = renderTool();
		expect(fireEvent.contextMenu(button)).toBe(false);
		rerender(<ToolButton icon={null} label="Brush" onClick={onClick} />);
		expect(fireEvent.contextMenu(button)).toBe(true);
	});

	it('without onLongPress, a held press is still a click', () => {
		const onClick = vi.fn();
		render(<ToolButton icon={null} label="Hand" onClick={onClick} />);
		press(screen.getByRole('button', { name: 'Hand' }), 2000);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('leaves no timer behind when taken down mid-press', () => {
		const { button, unmount, onLongPress } = renderTool();
		fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
		unmount();
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('does nothing while disabled', () => {
		const { button, onClick } = renderTool({ disabled: true });
		expect(button).toHaveProperty('disabled', true);
		fireEvent.click(button);
		expect(onClick).not.toHaveBeenCalled();
	});
});
