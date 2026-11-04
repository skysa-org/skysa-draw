import type { BlendMode } from '@skysa/draw-core';

import type { MessageKey } from '../../i18n/t.js';

/**
 * The catalog key for a blend mode's name: `color-dodge` is said by
 * `layers.blendModes.colorDodge`. A table rather than a case change at run
 * time, so the compiler holds it to both lists: every mode of `BLEND_MODES`
 * has a row, and every row names a key the catalog has.
 */
const BLEND_KEYS = {
	normal: 'layers.blendModes.normal',
	darken: 'layers.blendModes.darken',
	multiply: 'layers.blendModes.multiply',
	'color-burn': 'layers.blendModes.colorBurn',
	lighten: 'layers.blendModes.lighten',
	screen: 'layers.blendModes.screen',
	'color-dodge': 'layers.blendModes.colorDodge',
	overlay: 'layers.blendModes.overlay',
	'soft-light': 'layers.blendModes.softLight',
	'hard-light': 'layers.blendModes.hardLight',
	difference: 'layers.blendModes.difference',
	exclusion: 'layers.blendModes.exclusion',
	hue: 'layers.blendModes.hue',
	saturation: 'layers.blendModes.saturation',
	color: 'layers.blendModes.color',
	luminosity: 'layers.blendModes.luminosity',
} as const satisfies Record<BlendMode, MessageKey>;

/** One of the keys above: none takes a placeholder, so `t()` takes it alone. */
export const blendKey = (mode: BlendMode): (typeof BLEND_KEYS)[BlendMode] => BLEND_KEYS[mode];
