import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdatePrompt } from '../../src/components/shell/UpdatePrompt.js';
import { beforeClosing } from '../../src/store/heldEdits.js';

const worker = vi.hoisted(() => ({ update: vi.fn(() => Promise.resolve()) }));
const registration = vi.hoisted(
	(): { registered: boolean; options: { onNeedReload?: () => void } } => ({
		registered: false,
		options: {},
	})
);

// A new build waiting, which the stub never has; and what the prompt asks of
// the registration, the first render's alone, as the hook reads it once.
vi.mock('virtual:pwa-register/react', () => ({
	useRegisterSW: (options: { onNeedReload?: () => void } = {}) => {
		if (!registration.registered) {
			registration.registered = true;
			registration.options = options;
		}
		return {
			needRefresh: [true, () => undefined],
			offlineReady: [false, () => undefined],
			updateServiceWorker: worker.update,
		};
	},
}));

beforeEach(() => {
	worker.update.mockReset();
	worker.update.mockResolvedValue(undefined);
	registration.registered = false;
	registration.options = {};
});

describe("the new build's bar", () => {
	it('pauses syncing before it asks the new build to take over', async () => {
		const user = userEvent.setup();
		const order: string[] = [];
		const beforeUpdate = vi.fn(() => {
			order.push('sync paused');
			return Promise.resolve();
		});
		worker.update.mockImplementation(() => {
			order.push('take-over asked');
			return Promise.resolve();
		});
		render(<UpdatePrompt beforeUpdate={beforeUpdate} />);

		await user.click(screen.getByRole('button', { name: 'Reload' }));

		expect(await screen.findByText('Updating…')).toBeDefined();
		await vi.waitFor(() => expect(order).toEqual(['sync paused', 'take-over asked']));
		expect(worker.update).toHaveBeenCalledWith(true);
	});

	it('has the open drawing write what it holds before the new build reloads the window', async () => {
		const held: { release: () => void } = { release: () => undefined };
		const withdraw = beforeClosing(
			() =>
				new Promise<void>((resolve) => {
					held.release = resolve;
				})
		);
		const reload = vi.fn();
		render(<UpdatePrompt reload={reload} />);

		try {
			// The new worker has taken over: in this window, whichever pressed Reload.
			registration.options.onNeedReload?.();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(reload).not.toHaveBeenCalled();
			held.release();

			await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
		} finally {
			withdraw();
		}
	});

	it("reloads however settling went, the page being the new build's", async () => {
		const withdraw = beforeClosing(
			() => Promise.resolve(),
			() => {
				throw new Error('an editor that cannot say what it holds');
			}
		);
		const reload = vi.fn();
		render(<UpdatePrompt reload={reload} />);

		try {
			registration.options.onNeedReload?.();

			await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
		} finally {
			withdraw();
		}
	});
});
