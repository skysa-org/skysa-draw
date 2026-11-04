import type { Catalog } from '../catalog.js';
import { common } from './common.js';
import { drawings } from './drawings.js';
import { editor } from './editor.js';
import { exporting } from './exporting.js';
import { folders } from './folders.js';
import { layers } from './layers.js';
import { paths } from './paths.js';
import { raster } from './raster.js';
import { regions } from './regions.js';
import { shell } from './shell.js';
import { text } from './text.js';
import { tools } from './tools.js';
import { ui } from './ui.js';

/**
 * The English catalog, and the one every other is checked against: its keys
 * are the app's message keys, and its placeholders and tags are what a
 * translation has to keep.
 */
export const en = {
	common,
	shell,
	folders,
	drawings,
	ui,
	editor,
	layers,
	tools,
	raster,
	paths,
	text,
	regions,
	exporting,
} as const satisfies Catalog;
