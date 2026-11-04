// First: before any module that builds a zod schema (see the module).
import './jitless.js';
import './styles/index.css';

import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { routeTree } from './routeTree.gen';
import { makeWayWhenAsked, updateChannel } from './sync/beforeUpdate.js';
import { syncScheduler } from './sync/runtime.js';
import { keepAwakeWhileSyncing } from './sync/wakeLock.js';

const router = createRouter({
	routeTree,
	// The app renders from local state before any network call, so there is
	// nothing to wait on at boot.
	defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}

// Before the first render, and never stopped: it follows the connection on
// its own, and syncs nothing while there is none (docs/ARCHITECTURE.md §7,
// "Sync loop").
syncScheduler.start();
// The screen kept on through a long sync, so a phone's timeout does not stop
// a first import part-way. Never stopped either, for the same reason.
keepAwakeWhileSyncing(syncScheduler);
// Another tab's Reload pauses syncing here too, so the new build can take over
// (`sync/beforeUpdate.ts`). Never stopped either.
makeWayWhenAsked(syncScheduler, updateChannel());

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root is missing from index.html');

createRoot(rootElement).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>
);
