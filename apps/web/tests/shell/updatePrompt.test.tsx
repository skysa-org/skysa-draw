import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { UpdatePrompt } from '../../src/components/shell/UpdatePrompt.js';
import { beforeClosing } from '../../src/store/heldEdits.js';

const worker = vi.hoisted(() => ({ update: vi.fn(() => Promise.resolve()) }));

// A new build waiting, which the stub never has.
vi.mock('virtual:pwa-register/react', () => ({
	useRegisterSW: () => ({
		needRefresh: [true, () => undefined],
		offlineReady: [false, () => undefined],
		updateServiceWorker: worker.update,
	}),
}));

describe("the new build's bar", () => {
	it('has the open drawing write what it holds before the new build takes over', async () => {
		const user = userEvent.setup();
		const order: string[] = [];
		const held: { release: () => void } = { release: () => undefined };
		const withdraw = beforeClosing(
			() =>
				new Promise<void>((resolve) => {
					held.release = () => {
						order.push('written');
						resolve();
					};
				})
		);
		const beforeUpdate = vi.fn(() => {
			order.push('sync paused');
			return Promise.resolve();
		});
		worker.update.mockImplementation(() => {
			order.push('reloaded');
			return Promise.resolve();
		});
		render(<UpdatePrompt beforeUpdate={beforeUpdate} />);

		await user.click(screen.getByRole('button', { name: 'Reload' }));
		expect(await screen.findByText(/Updating/)).toBeDefined();
		expect(beforeUpdate).not.toHaveBeenCalled();
		held.release();

		await vi.waitFor(() => expect(order).toEqual(['written', 'sync paused', 'reloaded']));
		expect(worker.update).toHaveBeenCalledWith(true);
		withdraw();
	});
});
