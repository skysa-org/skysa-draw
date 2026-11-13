import { hashCredential } from '@skysa/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { returnPath } from '../../src/components/account/AccountPanel.js';
import {
	bindConnection,
	detachConnection,
	finishImport,
	showConnection,
} from '../../src/store/connection.js';
import { PENDING_CREDENTIAL_ID } from '../../src/store/db.js';
import { createDrawing } from '../../src/store/drawings.js';
import { freshDatabase } from '../support/db.js';
import {
	backFromConsent,
	choose,
	clientWith,
	connectVia,
	dropbox,
	fakeSync,
	holding,
	offers,
	openAdd,
	options,
	renderPanel,
	row,
	settled,
	statusLine,
} from './support.js';

/** Nothing is connected: what the line at the end of the panel says then. */
const NOTHING_CONNECTED = 'On this device only';

/** A connected source in front, synced, with its credential held. */
const connected = async () => {
	const db = freshDatabase();
	await bindConnection(db, {
		connectionId: 'c1',
		provider: 'dropbox',
		accountId: 'dbid:1',
		displayName: 'ada@example.com',
	});
	await finishImport(db, 'c1');
	await holding(db, 'c1');
	return db;
};

describe('the account panel, with nothing connected', () => {
	it('says where the drawings are, and the `+` says what it is', async () => {
		renderPanel(clientWith(), freshDatabase());

		const line = await screen.findByText(NOTHING_CONNECTED);
		// No account to name, so no tooltip.
		expect(line.getAttribute('title')).toBeNull();
		expect(
			await screen.findByRole('button', { name: 'Connect storage provider' })
		).toBeTruthy();
	});

	it('asks the server what it offers once, for the sources and the panel together', async () => {
		const config = vi.fn(() => Promise.resolve({ providers: ['dropbox' as const] }));
		renderPanel(clientWith({ config }), freshDatabase());

		await screen.findByText(NOTHING_CONNECTED);
		await settled();
		expect(config).toHaveBeenCalledTimes(1);
	});

	it('offers a download of this device’s drawings once there are some, and hands them over', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const { downloadedAll } = renderPanel(clientWith(), db);

		await screen.findByText(NOTHING_CONNECTED);
		await settled();
		// A device that holds nothing has no row for its drawings, and nothing
		// to download.
		expect(screen.queryByRole('button', { name: 'Options for “This device”' })).toBeNull();

		await createDrawing(db, { title: 'Plan' });
		await choose(user, 'This device', 'Download all drawings');

		await waitFor(() => {
			expect(downloadedAll).toEqual([['Plan']]);
		});
	});
});

describe('connecting storage', () => {
	it('asks before moving the drawings on this device into the account, and can stay', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		await createDrawing(db, { title: 'Plan', folderPath: 'Work' });
		await createDrawing(db, { title: 'List', folderPath: 'Work' });
		const started = vi.fn(() =>
			Promise.resolve({ ok: true as const, value: 'https://dropbox.example/authorize' })
		);
		const { went } = renderPanel(clientWith({ startConnect: started }), db);

		await connectVia(user, 'Dropbox');

		const question = await screen.findByRole('alertdialog', {
			name: 'Move your drawings to Dropbox?',
		});
		expect(within(question).getByText(/will move/).textContent).toBe(
			'Your 1 folder and 2 drawings on this device will move into Dropbox and sync there. Cancel to keep them on this device only.'
		);
		// The answer has the focus, as in every question this app asks.
		await waitFor(() => {
			expect(document.activeElement).toBe(
				within(question).getByRole('button', { name: 'Connect and move' })
			);
		});
		// Nothing has been started while the question is out.
		expect(started).not.toHaveBeenCalled();
		expect(await db.credentials.get(PENDING_CREDENTIAL_ID)).toBeUndefined();

		await user.click(within(question).getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('alertdialog')).toBeNull();
		const menu = screen.getByRole('group', { name: 'Storage providers' });
		const button = within(menu).getByRole('button', { name: 'Dropbox' });
		expect(document.activeElement).toBe(button);

		// Escape is Cancel too, and closes the question rather than the `+`.
		await user.click(button);
		await screen.findByRole('alertdialog');
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(screen.getByRole('group', { name: 'Storage providers' })).toBeTruthy();
		expect(started).not.toHaveBeenCalled();
		expect(went).toEqual([]);
	});

	it('writes the credential down first, and sends the server only its hash', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const hashes: string[] = [];
		const { went } = renderPanel(
			clientWith({
				// The server knows a credential only once its flow comes back, so
				// the claim the panel makes as it opens leaves this one pending,
				// whenever it runs.
				connection: () => Promise.resolve({ ok: false, refusal: 'credential_revoked' }),
				startConnect: async (_provider, hash, returnTo) => {
					// Already written down when the server is asked.
					expect(await db.credentials.get(PENDING_CREDENTIAL_ID)).toBeDefined();
					hashes.push(hash);
					return { ok: true, value: `https://dropbox.example/authorize?rt=${returnTo}` };
				},
			}),
			db,
			{ url: '/?f=Work&connect=denied' }
		);

		await connectVia(user, 'Dropbox');

		await waitFor(() => {
			expect(went).toHaveLength(1);
		});
		const pending = await db.credentials.get(PENDING_CREDENTIAL_ID);
		const credential = pending?.credential ?? '';
		expect(credential).toMatch(/^sk1_/);
		expect(hashes).toEqual([await hashCredential(credential)]);
		// Back to exactly here, without the outcome of the connect before.
		expect(went).toEqual(['https://dropbox.example/authorize?rt=/?f=Work']);
		// And the secret itself is nowhere the page shows or sends.
		expect(went.join(' ')).not.toContain(credential);
		expect(document.body.innerHTML).not.toContain(credential);
	});

	it('says why when the server will not start connecting', async () => {
		const user = userEvent.setup();
		renderPanel(
			clientWith({
				startConnect: () => Promise.resolve({ ok: false, refusal: 'not_found' }),
			}),
			freshDatabase()
		);

		await connectVia(user, 'Dropbox');

		expect((await screen.findByRole('alert')).textContent).toBe(
			'This deployment does not offer that provider.'
		);
	});

	it('offers no provider while the server cannot be reached', async () => {
		renderPanel(
			clientWith({ config: () => Promise.reject(new TypeError('offline')) }),
			freshDatabase()
		);

		expect(
			await screen.findByText('Connecting storage needs the server, which cannot be reached.')
		).toBeTruthy();
		const add = screen.getByRole('button', { name: 'Connect storage provider' });
		expect(add.hasAttribute('disabled')).toBe(true);
	});
});

describe('the account panel, connected', () => {
	it('binds the device to the account it just consented to, and names it', async () => {
		const db = freshDatabase();
		await backFromConsent(db);
		const client = clientWith();
		renderPanel(client, db, { sync: fakeSync() });

		expect(await row('Dropbox')).toBeTruthy();
		const line = await statusLine();
		expect(line.getAttribute('title')?.split('\n')[0]).toBe(
			'Syncing with Dropbox · ada@example.com'
		);
		expect(line.textContent).toBe('Synced');
		// The credential is presented to the server, and never drawn.
		const [presented] = client.asked;
		expect(presented).toMatch(/^sk1_/);
		expect(document.body.innerHTML).not.toContain(presented);
		expect((await db.syncState.get(dropbox.id))?.connectionId).toBe('c1');
	});

	it('has what can be done to it in the `⋯` at the end of its row, in order', async () => {
		const user = userEvent.setup();
		const db = await connected();
		await createDrawing(db, { title: 'Plan', connectionId: 'c1' });
		renderPanel(clientWith(), db, { sync: fakeSync() });

		await statusLine();
		await waitFor(async () => {
			expect(await offers(user, 'Dropbox')).toEqual([
				'Rename',
				'Sync now',
				'Re-scan from scratch',
				'Download all drawings',
				'Disconnect',
			]);
		});
	});

	it('syncs now, and says how it is going over the library, with the way to pause it', async () => {
		const user = userEvent.setup();
		const sync = fakeSync();
		renderPanel(clientWith(), await connected(), { sync });

		await statusLine();
		await choose(user, 'Dropbox', 'Sync now');
		expect(sync.syncNow).toHaveBeenCalledOnce();

		sync.say({ phase: 'syncing' });
		const line = await statusLine();
		await user.click(within(line).getByRole('button', { name: 'Syncing…' }));

		const details = await screen.findByRole('dialog', {
			name: 'Syncing with Dropbox · ada@example.com',
		});
		await user.click(within(details).getByRole('button', { name: 'Pause syncing' }));
		expect(sync.pause).toHaveBeenCalledOnce();
	});

	it('asks before disconnecting, gives the focus back on Cancel, and lets the source go on the answer', async () => {
		const user = userEvent.setup();
		const db = await connected();
		const signOut = vi.fn(() =>
			Promise.resolve({ ok: true as const, value: { disconnected: true } })
		);
		renderPanel(clientWith({ signOut }), db, { sync: fakeSync() });

		await statusLine();
		await choose(user, 'Dropbox', 'Disconnect');
		const question = await screen.findByRole('group', { name: 'Disconnect' });
		await user.click(within(question).getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByRole('group', { name: 'Disconnect' })).toBeNull();
		expect(document.activeElement).toBe(await options('Dropbox'));
		expect(signOut).not.toHaveBeenCalled();

		await choose(user, 'Dropbox', 'Disconnect');
		const asked = await screen.findByRole('group', { name: 'Disconnect' });
		await user.click(within(asked).getByRole('button', { name: 'Disconnect' }));

		await waitFor(() => {
			expect(signOut).toHaveBeenCalledOnce();
		});
		expect(await screen.findByText(NOTHING_CONNECTED)).toBeTruthy();
		expect(await db.syncState.get('c1')).toBeUndefined();
	});

	it('is renamed from its `⋯`, its row becoming the field', async () => {
		const user = userEvent.setup();
		const db = await connected();
		renderPanel(clientWith(), db, { sync: fakeSync() });

		await statusLine();
		await choose(user, 'Dropbox', 'Rename');
		const field = await screen.findByRole('textbox', { name: 'Source name' });
		await user.clear(field);
		await user.type(field, 'Work{Enter}');

		expect(await row('Work')).toBeTruthy();
		expect((await db.syncState.get('c1'))?.label).toBe('Work');
		await waitFor(async () => {
			expect(document.activeElement).toBe(await row('Work'));
		});
	});

	it('marks the source that needs connecting again, and offers the way to', async () => {
		const sync = fakeSync();
		renderPanel(clientWith(), await connected(), { sync });

		await statusLine();
		sync.say({ phase: 'attention', refusal: 'credential_revoked' });

		expect(await row('Dropbox — needs to be connected again')).toBeTruthy();
		expect(await screen.findByRole('button', { name: 'Connect again' })).toBeTruthy();
	});
});

describe('the devices on a connection', () => {
	it('counts the others, lists them over the library, and takes one off', async () => {
		const user = userEvent.setup();
		const revokeGrant = vi.fn(() =>
			Promise.resolve({ ok: true as const, value: { ok: true } })
		);
		const grants = vi.fn(() =>
			Promise.resolve({
				ok: true as const,
				value: [
					{ id: 'g1', current: true, createdAt: 1, lastUsedAt: 1, expired: false },
					{
						id: 'g2',
						current: false,
						createdAt: 1,
						lastUsedAt: Date.now(),
						expired: false,
						device: 'Safari on iPhone',
					},
				],
			})
		);
		renderPanel(clientWith({ grants, revokeGrant }), await connected(), { sync: fakeSync() });

		const count = await screen.findByRole('button', { name: /1 other device/ });
		await user.click(count);
		const sheet = await screen.findByRole('dialog', { name: /devices/i });
		expect(within(sheet).getByText(/Safari on iPhone/)).toBeTruthy();

		await user.click(within(sheet).getByRole('button', { name: 'Remove' }));
		await waitFor(() => {
			expect(revokeGrant).toHaveBeenCalledWith('g2');
		});
	});
});

describe('returnPath', () => {
	it('keeps where the user is, without the outcome of a connect before', () => {
		expect(returnPath('/?f=Work&d=1&connect=ok&code=lapsed')).toBe('/?f=Work&d=1');
		expect(returnPath('/')).toBe('/');
	});
});

describe('the `+`', () => {
	it('closes on Escape, giving the focus back to itself, and on a press outside', async () => {
		const user = userEvent.setup();
		renderPanel(clientWith(), freshDatabase());

		await openAdd(user);
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('group', { name: 'Storage providers' })).toBeNull();
		expect(document.activeElement).toBe(
			screen.getByRole('button', { name: 'Connect storage provider' })
		);

		await openAdd(user);
		await user.click(screen.getByText(NOTHING_CONNECTED));
		expect(screen.queryByRole('group', { name: 'Storage providers' })).toBeNull();
	});
});

describe('another source’s `⋯`', () => {
	it('shows that source, then asks there what was chosen', async () => {
		const user = userEvent.setup();
		const db = await connected();
		await bindConnection(db, { connectionId: 'c2', provider: 'dropbox', accountId: 'dbid:2' });
		await finishImport(db, 'c2');
		await holding(db, 'c2', 'sk1_other');
		await showConnection(db, 'c1');
		renderPanel(clientWith(), db, { sync: fakeSync() });

		await statusLine();
		await choose(user, 'Dropbox 2', 'Disconnect');

		await waitFor(async () => {
			expect((await row('Dropbox 2')).getAttribute('aria-current')).toBe('true');
		});
		expect(await screen.findByRole('group', { name: 'Disconnect' })).toBeTruthy();
	});
});

describe('a detached source', () => {
	it('names what it still holds, and discards it only after saying what goes', async () => {
		const user = userEvent.setup();
		const db = await connected();
		await createDrawing(db, { title: 'Unsent', connectionId: 'c1' });
		await detachConnection(db, { connectionId: 'c1' });
		renderPanel(clientWith(), db, { sync: fakeSync() });

		expect(await row('Dropbox — disconnected')).toBeTruthy();
		await user.click(await screen.findByRole('button', { name: 'Discard…' }));

		const question = await screen.findByRole('group', { name: 'Discard for good' });
		expect(
			within(within(question).getByRole('list'))
				.getAllByRole('listitem')
				.map((item) => item.textContent)
		).toEqual(['Unsent']);
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('group', { name: 'Discard for good' })).toBeNull();
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Discard…' }));
		});

		await user.click(screen.getByRole('button', { name: 'Discard…' }));
		await user.click(
			within(await screen.findByRole('group', { name: 'Discard for good' })).getByRole(
				'button',
				{
					name: 'Discard for good',
				}
			)
		);
		await waitFor(async () => {
			expect(await db.syncState.get('c1')).toBeUndefined();
		});
	});
});
