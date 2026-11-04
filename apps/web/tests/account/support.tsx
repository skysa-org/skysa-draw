/**
 * The sources and the account panel under test: a client with the answers a
 * test names, the two drawn over it as the library has them (`Sidebar`), and
 * the steps through their menus.
 */
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
	useRouterState,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { expect, vi } from 'vitest';

import type { ApiClient, InstanceConfig } from '../../src/api/client.js';
import {
	AccountPanel,
	AccountProvider,
	returnPath,
} from '../../src/components/account/AccountPanel.js';
import { SourcePanel } from '../../src/components/sources/SourcePanel.js';
import { beginConnect } from '../../src/store/credentials.js';
import { DatabaseProvider } from '../../src/store/database.js';
import type { DrawDatabase } from '../../src/store/db.js';
import type { Library } from '../../src/store/exportDrawings.js';
import { createKeeping } from '../../src/store/keeping.js';
import type { SchedulerStatus } from '../../src/sync/scheduler.js';
import { holdCredential } from '../support/connection.js';

const STORAGE_FIRST: InstanceConfig = { authMode: 'storage-first', providers: ['dropbox'] };

export const dropbox = {
	id: 'c1',
	provider: 'dropbox' as const,
	displayName: 'ada@example.com',
	accountId: 'dbid:1',
	createdAt: 1,
	lastUsedAt: null,
	grantId: 'g1',
};

type Client = Pick<ApiClient, 'config' | 'withCredential' | 'startConnect' | 'checkConnectCode'>;

/** What the server answers, by call: the rest answer as a quiet server would. */
interface Answers extends Partial<Client> {
	readonly connection?: ApiClient['connection'];
	readonly grants?: ApiClient['grants'];
	readonly revokeGrant?: ApiClient['revokeGrant'];
	readonly signOut?: ApiClient['signOut'];
}

/**
 * A client giving the answers named, with every credential it is shown kept
 * in `asked`: `withCredential` is the seam every authenticated call goes
 * through.
 */
export const clientWith = (answers: Answers = {}): Client & { asked: string[] } => {
	const asked: string[] = [];
	return {
		asked,
		config: answers.config ?? (() => Promise.resolve(STORAGE_FIRST)),
		checkConnectCode:
			answers.checkConnectCode ??
			(() => Promise.resolve({ ok: true, value: { accepted: true, expiresIn: 900 } })),
		startConnect:
			answers.startConnect ??
			((_provider, _hash, returnTo) =>
				Promise.resolve({
					ok: true,
					value: `https://dropbox.example/authorize?rt=${encodeURIComponent(returnTo)}`,
				})),
		withCredential: (credential: string) => {
			asked.push(credential);
			return {
				connection:
					answers.connection ?? (() => Promise.resolve({ ok: true, value: dropbox })),
				grants: answers.grants ?? (() => Promise.resolve({ ok: true, value: [] })),
				revokeGrant:
					answers.revokeGrant ??
					(() => Promise.resolve({ ok: true, value: { ok: true } })),
				signOut:
					answers.signOut ??
					(() => Promise.resolve({ ok: true, value: { disconnected: false } })),
			} as unknown as ApiClient;
		},
	};
};

/** A device back from the provider's consent page, with the credential it wrote down before it left. */
export const backFromConsent = (db: DrawDatabase) => beginConnect(db, 'dropbox');

/** A device holding a credential for `connectionId`, as connecting leaves it. */
export const holding = (db: DrawDatabase, connectionId: string, credential = 'sk1_held') =>
	holdCredential(db, connectionId, { credential, createdAt: Date.now() });

/** Long enough for the panel's live queries to have answered. */
export const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

export type User = ReturnType<typeof userEvent.setup>;

/** A scheduler that says what the test tells it to. */
export const fakeSync = (initial: Partial<SchedulerStatus> = {}) => {
	const listeners = new Set<(status: SchedulerStatus) => void>();
	const box = new Map<'status', SchedulerStatus>([
		['status', { phase: 'idle', conflicts: [], ...initial }],
	]);
	return {
		status: () => box.get('status') ?? { phase: 'local', conflicts: [] },
		subscribe: (listener: (status: SchedulerStatus) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		syncNow: vi.fn(() => Promise.resolve()),
		resync: vi.fn(() => Promise.resolve()),
		pause: vi.fn<() => void>(),
		halt: vi.fn(() => Promise.resolve(() => undefined)),
		say: (next: Partial<SchedulerStatus>) => {
			const status: SchedulerStatus = { phase: 'idle', conflicts: [], ...next };
			box.set('status', status);
			act(() => {
				listeners.forEach((listener) => {
					listener(status);
				});
			});
		},
	};
};

type FakeSync = ReturnType<typeof fakeSync>;

/**
 * The sources with the account panel under them, inside a router, since both
 * read where they are, and inside the provider that takes up a credential
 * brought back from the provider. What would leave the page or hand the user
 * a file is kept instead: jsdom has neither navigation nor blob URLs.
 */
export const renderPanel = (
	client: Client,
	database: DrawDatabase,
	{ url = '/', sync = fakeSync({ phase: 'local' }) }: { url?: string; sync?: FakeSync } = {}
) => {
	const went: string[] = [];
	const downloaded: string[][] = [];
	const downloadedAll: string[][] = [];
	const Shell = () => {
		const href = useRouterState({ select: (state) => state.location.href });
		return (
			<DatabaseProvider database={database}>
				<AccountProvider client={client}>
					<SourcePanel
						client={client}
						sync={sync}
						returnTo={returnPath(href)}
						navigate={(to) => {
							went.push(to);
						}}
						account={(slot) => (
							<AccountPanel
								sync={sync}
								navigate={(to) => {
									went.push(to);
								}}
								download={(library: Library) => {
									downloaded.push(
										library.drawings.map((drawing) => drawing.title)
									);
								}}
								downloadAll={(library: Library) => {
									downloadedAll.push(
										library.drawings.map((drawing) => drawing.title).sort()
									);
								}}
								keeping={createKeeping(() => undefined)}
								slot={slot}
							/>
						)}
					/>
				</AccountProvider>
			</DatabaseProvider>
		);
	};
	const router = createRouter({
		routeTree: createRootRoute({ component: Shell }),
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);
	return { went, downloaded, downloadedAll };
};

/** The `+`, which has its words while nothing is connected, and is named for "another" once something is. */
export const openAdd = async (user: User) => {
	const add = await screen.findByRole('button', {
		name: /^(Connect another account|Connect storage provider)$/,
	});
	await waitFor(() => {
		expect(add.hasAttribute('disabled')).toBe(false);
	});
	await user.click(add);
	return screen.findByRole('group', { name: 'Storage providers' });
};

/** Open the `+` and start a flow for one provider. */
export const connectVia = async (user: User, provider: string) => {
	const menu = await openAdd(user);
	await user.click(within(menu).getByRole('button', { name: provider }));
};

/** A source's row, by what it is called. */
export const row = async (name: string | RegExp): Promise<HTMLElement> =>
	within(await screen.findByRole('region', { name: 'Sources' })).findByRole('button', { name });

/** A source's `⋯`, once it has something to offer. */
export const options = async (name: string): Promise<HTMLElement> => {
	const button = await screen.findByRole('button', { name: `Options for “${name}”` });
	await waitFor(() => {
		expect(button.hasAttribute('disabled')).toBe(false);
	});
	return button;
};

/** A source's `⋯` menu, opened, or as it is where it is open already. */
const openOptions = async (user: User, name: string): Promise<HTMLElement> => {
	const button = await options(name);
	if (button.getAttribute('aria-expanded') !== 'true') await user.click(button);
	return screen.findByRole('menu', { name: `Options for “${name}”` });
};

/** What a source's `⋯` offers, in order, opened. */
export const offers = async (user: User, name: string): Promise<string[]> => {
	const menu = await openOptions(user, name);
	return within(menu)
		.getAllByRole('menuitem')
		.map((item) => item.textContent);
};

/** `item`, chosen from a source's `⋯`, once it is offered. */
export const choose = async (user: User, name: string, item: string): Promise<void> => {
	await waitFor(async () => {
		expect(await offers(user, name)).toContain(item);
	});
	await user.click(screen.getByRole('menuitem', { name: item }));
};

/** The line a connected source's panel ends in, found by its tooltip, which names the account. */
export const statusLine = (label = 'Dropbox'): Promise<HTMLElement> =>
	screen.findByTitle(new RegExp(`^Syncing with ${label}`));
