/**
 * What the apps may use of core, by name. A name is here because something in
 * `apps/` imports it, in its source or its tests, or, for the entitlement and
 * rate-limit types, because an operator's policy is written against them. One
 * nothing outside core needs stays in its module, so the surface is chosen
 * rather than whatever a module happens to export. `tests/exports.test.ts`
 * lists the values and the types, so a change to this list is a change a
 * reviewer sees. The test doubles are `@skysa/draw-core/testing`.
 */

export { API_ERROR_CODES, type ApiErrorCode, AUTH_MODES, type AuthMode } from './api.js';
export { type Cell, cell } from './cell.js';
export { APP_FOLDER_NAME, DRAWING_EXTENSION, PROVIDER_KINDS, type ProviderKind } from './config.js';
export {
	DEFAULT_DRAWING_SIZE,
	DRAWING_NAMESPACE,
	type DrawingSize,
	emptyDrawing,
	isDrawingText,
	readDrawingId,
	readDrawingProlog,
	readDrawingSize,
	readDrawingTitle,
	SVG_NAMESPACE,
	withDrawingId,
	withDrawingTitle,
} from './drawing/document.js';
export {
	BLEND_MODES,
	type BlendMode,
	GRAPHICS_ELEMENTS,
	isBlendMode,
	isGraphicsElement,
	LAYER_ATTRIBUTES,
	LAYER_KINDS,
	layerId,
	type LayerKind,
	layerNumber,
	RASTER_MAX_SIDE,
} from './drawing/layers.js';
export { messageOf } from './errors.js';
// With the types a deployment's policy is written against (CLAUDE.md, the
// `EntitlementProvider` and `RateLimiter` seams): no app imports them, but an
// operator's code outside this repo does.
export {
	alwaysAllowed,
	type ConnectCodeCheck,
	type ConnectGate,
	ENTITLEMENT_CODES,
	type EntitlementCode,
	type EntitlementContext,
	type EntitlementDecision,
	type EntitlementProvider,
	type EntitlementSubject,
	GATE_LIMITS,
	MAX_CODE_HOLD_SECONDS,
	MAX_CODE_REASON,
	MAX_CONNECT_CODE,
	neverLimited,
	type RateLimitDecision,
	type RateLimiter,
} from './entitlements.js';
export { extensionForType, type FileKind, isImageExtension, mediaOf } from './files/mediaTypes.js';
export {
	imageInfo,
	type PictureInfo,
	pictureVariant,
	type PictureVariant,
} from './files/pictures.js';
export { bytesHash, contentHash } from './hash.js';
export { clusters } from './names/bytes.js';
export {
	conflictFilePath,
	conflictFolderPath,
	conflictPath,
	conflictStamp,
} from './names/conflicts.js';
export { extensionOf } from './names/extension.js';
export { foldName, isDrawingName } from './names/fold.js';
export {
	attachmentName,
	drawingFilename,
	sanitizeFolderName,
	slugify,
	titleFromFilename,
	uniqueFilename,
	UNTITLED_SLUG,
} from './names/slug.js';
export {
	ancestorPaths,
	basename,
	isHidden,
	isWithin,
	joinPath,
	normalizePath,
	parentPath,
	pathSegments,
	rebasePath,
	replaceBasename,
	ROOT,
} from './paths.js';
export { createDropboxProvider } from './providers/dropbox.js';
export { createGDriveProvider } from './providers/gdrive/index.js';
export type { FetchLike } from './providers/http.js';
export { createOneDriveProvider } from './providers/onedrive.js';
export { withoutNul } from './providers/text.js';
export {
	AuthError,
	type ChangeEntry,
	type ChangeSet,
	ConflictError,
	type CreateFileOptions,
	CursorResetError,
	type EntryRef,
	isAuthError,
	isConflictError,
	isCursorResetError,
	isNotFoundError,
	isRateLimitError,
	isUnreadableError,
	NotFoundError,
	RateLimitError,
	type RemoteEntry,
	type StorageProvider,
	UnreadableError,
	type WriteOptions,
} from './providers/types.js';
export {
	RELAY_CHANGED,
	RELAY_CLOSE,
	RELAY_PING,
	RELAY_PONG,
	RELAY_PUSHED,
	RELAY_PUSHED_INTERVAL_MS,
} from './relay.js';
// The sync engine, and what a store under it is written against: the web
// app's Dexie store implements `SyncStore`, and its scheduler runs the engine.
export { conflictContent } from './sync/document.js';
export { createSyncEngine, type SyncEngine } from './sync/engine.js';
export type { SyncOutcome } from './sync/outcome.js';
export type { SyncProgress } from './sync/progress.js';
export {
	type ConflictResolution,
	isFileChange,
	type NewSyncOp,
	type OpOutcome,
	type PullBatch,
	type PullChange,
	type SyncDrawing,
	type SyncFile,
	type SyncFolder,
	type SyncOp,
	type SyncOperation,
	type SyncStore,
	type UnreadableFile,
} from './sync/store.js';
