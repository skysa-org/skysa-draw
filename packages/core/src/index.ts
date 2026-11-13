/**
 * What the apps may use of core, by name. A name is here because something in
 * `apps/` imports it, in its source or its tests, or, for the entitlement and
 * rate-limit types, because an operator's policy is written against them. One
 * nothing outside core needs stays in its module, so the surface is chosen
 * rather than whatever a module happens to export. `tests/exports.test.ts`
 * lists the values and the types, so a change to this list is a change a
 * reviewer sees. The test doubles are the kit's (`@skysa/storage/testing`,
 * `@skysa/sync/testing`, `@skysa/client/testing`).
 */

export { APP_FOLDER_NAME, DRAW_FOLDER, DRAWING_EXTENSION, syncsHidden } from './config.js';
export {
	cleanDrawingTitle,
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
export { conflictContent, DRAW_FORMAT } from './drawing/format.js';
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
export {
	imageInfo,
	type PictureInfo,
	pictureVariant,
	type PictureVariant,
} from './files/pictures.js';
export {
	attachmentName,
	drawingFilename,
	sanitizeFolderName,
	slugify,
	titleFromFilename,
	uniqueFilename,
	UNTITLED_SLUG,
} from './names/slug.js';
export { conflictPath, isDrawingName } from './names/drawings.js';
// The kit's protocol (`@skysa/protocol`, skysa-notes' record 0018),
// as this barrel offered it before the kit: the app imports it from there, but
// an operator's code outside this repo imports it from here, the types its
// policy is written against among it (CLAUDE.md, the `EntitlementProvider`
// and `RateLimiter` seams).
export {
	alwaysAllowed,
	API_ERROR_CODES,
	type ApiErrorCode,
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
	PROVIDER_KINDS,
	type ProviderKind,
	type RateLimitDecision,
	type RateLimiter,
	RELAY_CHANGED,
	RELAY_CLOSE,
	RELAY_PING,
	RELAY_PONG,
	RELAY_PUSHED,
	RELAY_PUSHED_INTERVAL_MS,
} from '@skysa/protocol';
