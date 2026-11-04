import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Toggle } from '../../src/components/ui/Toggle.js';
import { ToolBar } from '../../src/components/ui/ToolBar.js';
import { ToolButton } from '../../src/components/ui/ToolButton.js';

/**
 * An option on or off (docs/ARCHITECTURE.md §7, "The interface"): its name
 * shown beside a check box, a button pressed or not, reached by a tool bar's
 * arrow keys, and pressed by a click, Space or Enter.
 */

const renderToggle = (pressed: boolean) => {
	const onChange = vi.fn();
	render(<Toggle label="Auto-select" pressed={pressed} onChange={onChange} />);
	return { onChange, toggle: screen.getByRole('button', { name: 'Auto-select' }) };
};

describe('Toggle', () => {
	it('shows its name as words, not only in a tooltip, with the box hidden from a screen reader', () => {
		const { toggle } = renderToggle(false);
		expect(toggle.textContent).toBe('Auto-select');
		expect(toggle.getAttribute('title')).toBeNull();
		expect(toggle.querySelector('.toggle-box')?.getAttribute('aria-hidden')).toBe('true');
		expect(toggle.getAttribute('type')).toBe('button');
	});

	it('says whether it is on, and asks for the other on a press', async () => {
		const user = userEvent.setup();
		const off = renderToggle(false);
		expect(off.toggle.getAttribute('aria-pressed')).toBe('false');
		await user.click(off.toggle);
		expect(off.onChange).toHaveBeenLastCalledWith(true);
	});

	it('asks for off when it is on', async () => {
		const user = userEvent.setup();
		const on = renderToggle(true);
		expect(on.toggle.getAttribute('aria-pressed')).toBe('true');
		await user.click(on.toggle);
		expect(on.onChange).toHaveBeenLastCalledWith(false);
	});

	it('is reached by the bar’s arrow keys and pressed by Space and by Enter', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<ToolBar orientation="horizontal" label="Tool options">
				<ToolButton icon={null} label="Before" onClick={vi.fn()} />
				<Toggle label="Contiguous" pressed={false} onChange={onChange} />
			</ToolBar>
		);
		await user.tab();
		await user.keyboard('{ArrowRight}');
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Contiguous' }));
		await user.keyboard(' ');
		await user.keyboard('{Enter}');
		expect(onChange).toHaveBeenCalledTimes(2);
	});
});
