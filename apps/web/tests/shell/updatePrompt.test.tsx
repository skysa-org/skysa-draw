import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { UpdatePrompt } from '../../src/components/shell/UpdatePrompt.js';
import type * as HeldEdits from '../../src/store/heldEdits.js';
import { beforeClosing } from '../../src/store/heldEdits.js';
import { holdLeaving, letLeave } from '../../src/store/leaving.js';
import { asksBeforeLeaving } from '../support/leaving.js';

const worker = vi.hoisted(() => ({ update: vi.fn(() => Promise.resolve()) }));
const registration = vi.hoisted(
	(): { registered: boolean; options: { onNeedReload?: () => void } } => ({
		registered: false,
		options: {},
	})
);
const settling = vi.hoisted(() => ({ rejects: false }));
/** Whether the bar shows the new build, or was put aside (`needRefresh`). */
const bar = vi.hoisted(() => ({ shown: true }));

// A new build waiting, which the stub never has, its bar shown or put aside
// as a test says; and what the prompt asks of the registration, the first
// render's alone, as the hook reads it once.
vi.mock('virtual:pwa-register/react', () => ({
	useRegisterSW: (options: { onNeedReload?: () => void } = {}) => {
		if (!registration.registered) {
			registration.registered = true;
			registration.options = options;
		}
		return {
			needRefresh: [bar.shown, () => undefined],
			offlineReady: [false, () => undefined],
			updateServiceWorker: worker.update,
		};
	},
}));

// Settling as it is, or, where a test says so, failing outright.
vi.mock('../../src/store/heldEdits.js', async (importOriginal) => {
	const actual = await importOriginal<typeof HeldEdits>();
	return {
		...actual,
		settleEditors: () =>
			settling.rejects
				? Promise.reject(new Error('settling failed'))
				: actual.settleEditors(),
	};
});

beforeEach(() => {
	worker.update.mockReset();
	worker.update.mockResolvedValue(undefined);
	registration.registered = false;
	registration.options = {};
	settling.rejects = false;
	bar.shown = true;
});

/** A registered editor whose write the test lets finish. */
const heldEditor = () => {
	const held: { release: () => void } = { release: () => undefined };
	const withdraw = beforeClosing(
		() =>
			new Promise<void>((resolve) => {
				held.release = resolve;
			})
	);
	return {
		release: () => {
			held.release();
		},
		withdraw,
	};
};

/** The new worker in control, as the registration tells the bar. */
const takeOver = () => {
	act(() => {
		registration.options.onNeedReload?.();
	});
};

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
		const editor = heldEditor();
		try {
			const reload = vi.fn();
			render(<UpdatePrompt reload={reload} />);

			// The new worker has taken over: in this window, whichever pressed Reload.
			takeOver();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(reload).not.toHaveBeenCalled();
			editor.release();

			await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
		} finally {
			editor.release();
			editor.withdraw();
		}
	});

	it.each([
		['whose Reload was pressed', true],
		['whose Reload was not pressed', false],
	] as const)(
		'says it is updating while the drawing is written, and never that it is slow, in a window %s',
		async (_, pressed) => {
			const user = userEvent.setup();
			const editor = heldEditor();
			try {
				render(<UpdatePrompt reload={vi.fn()} slowAfter={200} />);
				if (pressed) await user.click(screen.getByRole('button', { name: 'Reload' }));

				// Before the bar would have said Reload was slow.
				takeOver();

				expect(await screen.findByText('Updating…')).toBeDefined();
				await new Promise((resolve) => setTimeout(resolve, 300));
				expect(screen.getByText('Updating…')).toBeDefined();
			} finally {
				editor.release();
				editor.withdraw();
			}
		}
	);

	it('says it is updating while the drawing is written in a window whose bar was put aside', () => {
		bar.shown = false;
		const editor = heldEditor();
		try {
			render(<UpdatePrompt reload={vi.fn()} />);
			expect(screen.queryByRole('status')).toBeNull();

			takeOver();

			expect(screen.getByRole('status').textContent).toBe('Updating…');
		} finally {
			editor.release();
			editor.withdraw();
		}
	});

	it('takes nothing while the drawing is written: the page behind is inert, and hears no key, paste or drop', async () => {
		const user = userEvent.setup();
		// As the editor's shortcuts listen, and a picture is placed from a paste
		// or a drop: on the window.
		const heard = vi.fn();
		const kinds = ['keydown', 'paste', 'drop'] as const;
		kinds.forEach((kind) => window.addEventListener(kind, heard));
		onTestFinished(() => {
			kinds.forEach((kind) => window.removeEventListener(kind, heard));
		});
		const editor = heldEditor();
		try {
			render(
				<>
					<p>the drawing</p>
					<UpdatePrompt reload={vi.fn()} />
				</>
			);
			expect(screen.getByText('the drawing').closest('[inert]')).toBeNull();

			takeOver();

			expect(screen.getByText('the drawing').closest('[inert]')).not.toBeNull();
			expect(screen.getByRole('status').closest('[inert]')).toBeNull();
			await user.keyboard('z');
			const paste = new Event('paste', { bubbles: true, cancelable: true });
			const drop = new Event('drop', { bubbles: true, cancelable: true });
			screen.getByText('the drawing').dispatchEvent(paste);
			screen.getByText('the drawing').dispatchEvent(drop);
			expect(heard).not.toHaveBeenCalled();
			// Nor is a drop left to the browser, which would open it in the window.
			expect(drop.defaultPrevented).toBe(true);
		} finally {
			editor.release();
			editor.withdraw();
		}
	});

	it('reloads without asking first, whatever the open drawing still holds', async () => {
		const asked: boolean[] = [];
		const reload = vi.fn(() => {
			asked.push(asksBeforeLeaving());
		});
		// Edits the store would not take, which the page asks before it loses.
		holdLeaving(Symbol('a drawing'), () => true);
		try {
			render(<UpdatePrompt reload={reload} />);

			takeOver();

			await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
			expect(asked).toEqual([false]);
		} finally {
			letLeave();
		}
	});

	it("reloads however settling went, the page being the new build's", async () => {
		settling.rejects = true;
		const reload = vi.fn();
		render(<UpdatePrompt reload={reload} />);

		takeOver();

		await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
	});
});
