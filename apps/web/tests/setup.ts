// Dexie needs a real IndexedDB; Node has none.
import 'fake-indexeddb/auto';

import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

import { deleteFreshDatabases, resetSharedDb } from './support/db.js';

// After every test, in this order: what it rendered is unmounted, then every
// test starts from an empty database (tests/support/db.ts). Testing Library
// only cleans up by itself where `afterEach` is a global, and here it is
// imported.
afterEach(async () => {
	cleanup();
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
