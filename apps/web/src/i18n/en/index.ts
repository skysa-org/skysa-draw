import type { Catalog } from '../catalog.js';
import { account } from './account.js';
import { colorPair } from './colorPair.js';
import { common } from './common.js';
import { connect } from './connect.js';
import { connection } from './connection.js';
import { drawings } from './drawings.js';
import { editor } from './editor.js';
import { exporting } from './exporting.js';
import { firstImport } from './firstImport.js';
import { folders } from './folders.js';
import { layers } from './layers.js';
import { paths } from './paths.js';
import { raster } from './raster.js';
import { redEye } from './redEye.js';
import { regions } from './regions.js';
import { remove } from './remove.js';
import { scheduler } from './scheduler.js';
import { selection } from './selection.js';
import { shell } from './shell.js';
import { sources } from './sources.js';
import { text } from './text.js';
import { tools } from './tools.js';
import { ui } from './ui.js';
import { unsent } from './unsent.js';

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
	colorPair,
	layers,
	tools,
	raster,
	paths,
	text,
	regions,
	remove,
	redEye,
	selection,
	exporting,
	connection,
	scheduler,
	account,
	connect,
	sources,
	unsent,
	firstImport,
} as const satisfies Catalog;
