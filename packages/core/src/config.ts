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

/** Name the app reports as its own in the marker file. */
export const APP_NAME = 'skysa-draw';

/** Marker file written at the root of the app folder on first connect. */
export const MARKER_FILE = '.drawapp.json';

/**
 * Layout version of the remote folder. A client that finds a marker with a
 * higher version than this opens the connection read-only — see `parseMarker`.
 */
export const MARKER_SCHEMA_VERSION = 1;

/** Storage providers this codebase knows. `dropbox`, `onedrive` and `gdrive`
 * have adapters; `webdav` is deferred indefinitely (docs/ARCHITECTURE.md §5). */
export const PROVIDER_KINDS = ['gdrive', 'onedrive', 'dropbox', 'webdav'] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * Extension of a drawing file on every provider: a drawing is an SVG document
 * (docs/decisions/0001-the-drawing-file.md).
 */
export const DRAWING_EXTENSION = '.svg';

/** Anything at a path segment starting with this is invisible to the UI. */
export const HIDDEN_PREFIX = '.';
