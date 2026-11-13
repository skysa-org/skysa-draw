import type { AppFolderSpec } from '@skysa/storage';

/**
 * Values that must agree with the operator's provider app registrations.
 *
 * `APP_FOLDER_NAME` governs the folder Google Drive creates. OneDrive and
 * Dropbox derive their app-folder name from the provider registration, so
 * those registrations must be named to match. Dropbox's app name is immutable
 * after creation — changing this constant means re-creating the Dropbox app.
 * See docs/ARCHITECTURE.md §5.
 */
export const APP_FOLDER_NAME = 'skysa-draw';

/**
 * This app's folder, as the kit's adapters are handed it (`AppFolderSpec`,
 * skysa-notes' record 0018). Every value is in the user's storage
 * already, in every library ever connected, so none of them changes: renamed,
 * the app no longer finds them.
 *
 * - `driveTag`: Google Drive finds the folder by `drawapp: root` in its
 *   `appProperties`, and marks one the app has left `drawappLeft: 1`
 *   (docs/ARCHITECTURE.md §5.1).
 * - `marker`: written at the folder's root on first connect, naming this app.
 *   Its `version` is the folder's layout version: a client that finds a marker
 *   with a higher one opens the connection read-only — see `parseMarker`.
 */
export const DRAW_FOLDER: AppFolderSpec = {
	name: APP_FOLDER_NAME,
	driveTag: 'drawapp',
	marker: { file: '.drawapp.json', app: 'skysa-draw', version: 1 },
};

/**
 * Extension of a drawing file on every provider: a drawing is an SVG document
 * (docs/decisions/0001-the-drawing-file.md).
 */
export const DRAWING_EXTENSION = '.svg';

/**
 * Which hidden paths sync, as the kit's engine and scheduler ask it (a name
 * that starts with `.` is hidden, `isHidden` in `@skysa/storage`): none. The
 * marker is one, and so is whatever a provider or another app keeps in the
 * folder, and this app keeps nothing of its own there, as 0.1.0's engine never
 * synced any of them.
 */
export const syncsHidden = (_path: string): boolean => false;
