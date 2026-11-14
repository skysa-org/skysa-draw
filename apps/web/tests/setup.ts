// Dexie needs a real IndexedDB; Node has none.
import 'fake-indexeddb/auto';

import { cleanup, configure } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';

import { editorsRegistered } from '../src/store/heldEdits.js';
import { leavingHeld } from '../src/store/leaving.js';
import { deleteFreshDatabases, resetSharedDb } from './support/db.js';

// After every test, in this order: what it rendered is unmounted, an editor
// among it settled as it closes and gone from the registry (`beforeClosing`),
// so that the next test's settling does not find it, then every test starts
// from an empty database (tests/support/db.ts). An editor still settling as
// the wait runs out — it can take `FLUSH_WAIT_MS` — is one its test should
// have waited for itself. Testing Library only cleans up by itself where
// `afterEach` is a global, and here it is imported.
afterEach(async () => {
	cleanup();
	await vi.waitFor(
		() => {
			expect(editorsRegistered()).toBe(0);
			// And none holds the leave prompt (`store/leaving.ts`) once it is gone.
			expect(leavingHeld()).toBe(false);
		},
		{ timeout: 4_000 }
	);
	await deleteFreshDatabases();
	await resetSharedDb();
});

// How long `waitFor` and `findBy…` wait for what they are told will happen:
// longer than Testing Library's second, for a loaded machine, and inside the
// five seconds vitest gives a test.
configure({ asyncUtilTimeout: 4_000 });

// jsdom has no `URL.createObjectURL`: the drawing view shows the SVG through
// one, and a test only needs it to be there.
Object.defineProperty(URL, 'createObjectURL', {
	value: () => `blob:${crypto.randomUUID()}`,
	writable: true,
});
Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, writable: true });
