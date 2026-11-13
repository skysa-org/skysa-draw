import { registerSW } from 'vite-plugin-pwa/dist/client/build/register.js';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { WorkboxLifecycleEvent } from 'workbox-window';
import { Workbox } from 'workbox-window';

type Heard = (event: WorkboxLifecycleEvent) => unknown;

/**
 * A new build found and then in control, as the registration hears it from
 * workbox-window's `Workbox`; and whether the page reloaded, which jsdom
 * cannot, so a stand-in for its `location` keeps count while the take-over is
 * heard.
 */
const takeOver = async (options: { onNeedReload?: () => void }): Promise<boolean> => {
	const heard = new Map<string, Heard[]>();
	Object.defineProperty(navigator, 'serviceWorker', {
		value: { addEventListener: () => undefined, removeEventListener: () => undefined },
		configurable: true,
	});
	const listening = vi
		.spyOn(Workbox.prototype, 'addEventListener')
		.mockImplementation((type, listener) => {
			heard.set(type, [...(heard.get(type) ?? []), listener]);
		});
	const registering = vi.spyOn(Workbox.prototype, 'register').mockResolvedValue(undefined);
	onTestFinished(() => {
		listening.mockRestore();
		registering.mockRestore();
		Reflect.deleteProperty(navigator, 'serviceWorker');
	});
	const emit = (event: WorkboxLifecycleEvent) => {
		(heard.get(event.type) ?? []).forEach((listener) => {
			listener(event);
		});
	};
	const onNeedRefresh = vi.fn();

	registerSW({ immediate: true, onNeedRefresh, ...options });
	await vi.waitFor(() => expect(heard.has('waiting')).toBe(true));
	emit({ type: 'waiting' });
	expect(onNeedRefresh).toHaveBeenCalledOnce();
	const reload = vi.fn();
	const located = vi
		.spyOn(window, 'location', 'get')
		.mockReturnValue({ reload } as unknown as Location);
	try {
		emit({ type: 'controlling', isUpdate: true });
	} finally {
		located.mockRestore();
	}

	return reload.mock.calls.length > 0;
};

// `UpdatePrompt` writes what the open drawing holds before the page reloads at
// a take-over, which it can do only while the registration leaves the reload
// to it: a version of the plugin that reloaded as well would lose the strokes
// again, with every other test still passing.
describe("vite-plugin-pwa's registration, as the new build's bar leans on it", () => {
	it('leaves the reload at the take-over to onNeedReload', async () => {
		const onNeedReload = vi.fn();

		expect(await takeOver({ onNeedReload })).toBe(false);
		expect(onNeedReload).toHaveBeenCalledOnce();
	});

	it('reloads the page itself where nothing is given to', async () => {
		expect(await takeOver({})).toBe(true);
	});
});
