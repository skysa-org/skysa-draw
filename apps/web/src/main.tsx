// First: before any module that builds a zod schema (see the module).
import './jitless.js';
import './styles/index.css';

import { keepAwakeWhileSyncing, makeWay, makeWayWhenAsked, updateChannel } from '@skysa/client';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { StaleTabGate } from './components/shell/StaleTabGate.js';
import { UpdatePrompt } from './components/shell/UpdatePrompt.js';
import { routeTree } from './routeTree.gen';
import { syncScheduler } from './sync/runtime.js';

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
// (`makeWayWhenAsked`, the kit's client's). Never stopped either.
makeWayWhenAsked(syncScheduler, updateChannel());

/**
 * Before a new build takes over: syncing paused here and in every other tab,
 * so no request of the old build's is cut off half way (`makeWay`, the kit's
 * client's).
 */
const beforeUpdate = (): Promise<void> => makeWay(syncScheduler, updateChannel());

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root is missing from index.html');

// The bars along the window's foot, the stale window's over the new build's,
// beside the router rather than in its root route, so that a screen put in
// place of the app on an error still has them.
createRoot(rootElement).render(
	<StrictMode>
		<RouterProvider router={router} />
		<div className="app-foot">
			<StaleTabGate />
			<UpdatePrompt beforeUpdate={beforeUpdate} />
		</div>
	</StrictMode>
);
