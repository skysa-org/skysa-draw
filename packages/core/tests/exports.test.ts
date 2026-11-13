import * as protocol from '@skysa/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type * as Core from '../src/index.js';
import * as core from '../src/index.js';

/**
 * Every value core's main entry offers the apps, in order. Here so a name added
 * to or taken out of `src/index.ts` shows in review as a line in this list: the
 * surface is chosen, not whatever a module exports.
 */
const SURFACE = [
	'API_ERROR_CODES',
	'APP_FOLDER_NAME',
	'BLEND_MODES',
	'DEFAULT_DRAWING_SIZE',
	'DRAWING_EXTENSION',
	'DRAWING_NAMESPACE',
	'DRAW_FOLDER',
	'DRAW_FORMAT',
	'ENTITLEMENT_CODES',
	'GATE_LIMITS',
	'GRAPHICS_ELEMENTS',
	'LAYER_ATTRIBUTES',
	'LAYER_KINDS',
	'MAX_CODE_HOLD_SECONDS',
	'MAX_CODE_REASON',
	'MAX_CONNECT_CODE',
	'PROVIDER_KINDS',
	'RASTER_MAX_SIDE',
	'RELAY_CHANGED',
	'RELAY_CLOSE',
	'RELAY_PING',
	'RELAY_PONG',
	'RELAY_PUSHED',
	'RELAY_PUSHED_INTERVAL_MS',
	'SVG_NAMESPACE',
	'UNTITLED_SLUG',
	'alwaysAllowed',
	'attachmentName',
	'cleanDrawingTitle',
	'conflictContent',
	'conflictPath',
	'drawingFilename',
	'emptyDrawing',
	'freeDrawingPrefixAmong',
	'imageInfo',
	'isBlendMode',
	'isDrawingName',
	'isDrawingText',
	'isGraphicsElement',
	'layerId',
	'layerNumber',
	'messageOf',
	'neverLimited',
	'pictureVariant',
	'readDrawingId',
	'readDrawingProlog',
	'readDrawingSize',
	'readDrawingTitle',
	'sanitizeFolderName',
	'slugify',
	'syncsHidden',
	'titleFromFilename',
	'uniqueFilename',
	'withDrawingId',
	'withDrawingTitle',
];

/** Every type the entry offers; see the last test. */
type Types = [
	Core.ApiErrorCode,
	Core.BlendMode,
	Core.ConnectCodeCheck,
	Core.ConnectGate,
	Core.DrawingSize,
	Core.EntitlementCode,
	Core.EntitlementContext,
	Core.EntitlementDecision,
	Core.EntitlementProvider,
	Core.EntitlementSubject,
	Core.LayerKind,
	Core.PictureInfo,
	Core.PictureVariant,
	Core.ProviderKind,
	Core.RateLimitDecision,
	Core.RateLimiter,
];

describe('core’s main entry', () => {
	it('offers these values and no others', () => {
		expect(Object.keys(core).sort()).toEqual(SURFACE);
	});

	it('offers every value of the kit’s protocol, for an operator’s policy', () => {
		// Its values, that is: what the kit adds there an operator's Worker entry
		// may import from here, as `docs/self-hosting.md` has it import the types.
		// Its schemas and functions are the kit's to use, and only those the
		// barrel names (`alwaysAllowed`, `neverLimited`) are offered.
		const isData = (value: unknown): boolean =>
			typeof value !== 'function' &&
			(typeof value !== 'object' || value === null || Object.values(value).every(isData));
		const spoken = Object.entries(protocol).filter(([, value]) => isData(value));

		expect(spoken.length).toBeGreaterThan(0);
		expect(spoken.filter(([name, value]) => core[name as keyof typeof core] !== value)).toEqual(
			[]
		);
	});

	it('offers these types', () => {
		// Types leave nothing at run time to list, so these are named instead:
		// one taken out of the entry fails typecheck here, whether or not an app
		// uses it — the entitlement types are for an operator's code, not ours.
		expectTypeOf<Types>().not.toBeNever();
	});
});
