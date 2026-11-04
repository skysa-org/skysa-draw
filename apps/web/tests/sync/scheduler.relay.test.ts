import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindConnection, detachConnection } from '../../src/store/connection.js';
import { createDrawing } from '../../src/store/drawings.js';
import type { RelayFactory } from '../../src/sync/relay.js';
import { holdCredential } from '../support/connection.js';
import { svgOf } from '../support/drawingRows.js';
import {
	ACCOUNT,
	bound,
	focused,
	INTERVAL,
	nextTimer,
	quiet,
	reaches,
	started,
	stopSchedulers,
} from '../support/scheduler.js';

afterEach(stopSchedulers);

describe('the change relay', () => {
	/** Links as the scheduler asks for them, with a way to say another device pushed. */
	const relayed = () => {
		const links: {
			connectionId: string;
			told: number;
			closed: boolean;
			changed: () => void;
		}[] = [];
		const relay = vi.fn<RelayFactory>(({ connectionId, onChanged }) => {
			const link = { connectionId, told: 0, closed: false, changed: onChanged };
			links.push(link);
			return {
				pushed: () => {
					link.told += 1;
				},
				close: () => {
					link.closed = true;
				},
			};
		});
		const only = () => {
			expect(links).toHaveLength(1);
			const [link] = links;
			if (link === undefined) throw new Error('no link');
			return link;
		};
		return { relay, links, only };
	};

	it('runs a round when another device says it has pushed', async () => {
		const db = await bound();
		const { relay, only } = relayed();
		const h = started(db, { relay });
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();

		only().changed();

		await vi.waitFor(() => {
			expect(h.remote.pulls()).toBe(before + 1);
		});
		expect(only().connectionId).toBe('c1');
	});

	it('looks again 3 and 10 seconds after the last notice, and then leaves it to the poll', async () => {
		const db = await bound();
		const { relay, only } = relayed();
		const h = started(db, { relay });
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();
		const pulled = async (count: number) => {
			await vi.waitFor(() => {
				expect(h.remote.pulls()).toBe(before + count);
			});
			await quiet();
			expect(h.remote.pulls()).toBe(before + count);
		};

		only().changed();
		await pulled(1);
		h.env.advance(2000);
		// A burst: the looks are counted from the last of it.
		only().changed();
		await pulled(2);
		h.env.advance(2999);
		await pulled(2);
		h.env.advance(1);
		await pulled(3);
		h.env.advance(7000);
		await pulled(4);
		h.env.advance(INTERVAL - 1);
		await pulled(4);
	});

	it('does not look again from a hidden tab, which looks on coming forward', async () => {
		const db = await bound();
		const { relay, only } = relayed();
		const h = started(db, { relay });
		await reaches(h.scheduler, 'idle');

		only().changed();
		await vi.waitFor(() => {
			expect(h.scheduler.status().phase).toBe('idle');
		});
		await quiet();
		const before = h.remote.pulls();
		h.env.state.visible = false;
		h.env.advance(10_000);
		await quiet();

		expect(h.remote.pulls()).toBe(before);
	});

	it('tells the other devices after a round that pushed, and not after one that only pulled', async () => {
		const db = await bound();
		const { relay, only } = relayed();
		const h = started(db, { relay });
		await reaches(h.scheduler, 'idle');
		const before = only().told;

		const drawing = await createDrawing(db, { title: 'Sent', text: svgOf('sent\n') });
		await nextTimer(h);
		expect(h.remote.fake.contentAt(drawing.path)).toContain('sent');
		expect(only().told).toBe(before + 1);

		await focused(h);
		expect(only().told).toBe(before + 1);
	});

	it('lets the link go with its session, and gives the next session its own', async () => {
		const db = await bound('c1');
		const { relay, links } = relayed();
		const h = started(db, { relay });
		await reaches(h.scheduler, 'idle');

		await bindConnection(db, { ...ACCOUNT, connectionId: 'c2' });
		await holdCredential(db, 'c2');
		await vi.waitFor(() => {
			expect(links.map((link) => [link.connectionId, link.closed])).toEqual([
				['c1', true],
				['c2', false],
			]);
		});

		h.scheduler.stop();
		expect(links.map((link) => link.closed)).toEqual([true, true]);
	});

	it('lets the link go when the device is disconnected', async () => {
		const db = await bound();
		const { relay, only } = relayed();
		const h = started(db, { relay });
		await reaches(h.scheduler, 'idle');

		await detachConnection(db, { connectionId: 'c1' });
		await reaches(h.scheduler, 'local');

		expect(only().closed).toBe(true);
	});

	it('opens no link for a source this build has no adapter for', async () => {
		const db = await bound();
		const { relay } = relayed();
		const h = started(db, { relay, createProvider: () => undefined });
		await reaches(h.scheduler, 'attention');

		expect(relay).not.toHaveBeenCalled();
	});
});
