import type { Point } from '../geometry.js';
import {
	type Cubic,
	isLine,
	type PathData,
	roundForPath,
	segmentsOf,
	type Subpath,
} from './model.js';

/**
 * Anchors written back as a compact `d`: a moveto for each subpath, an `L` for
 * a segment whose handles sit on its anchors and a `C` for any other, and a
 * `Z` for a closed one, whose last segment is the `Z` itself where it is
 * straight. Every number to two decimals, as the other vector tools write
 * them (`geometry.ts`).
 */
const coords = (p: Point): string => `${roundForPath(p.x)} ${roundForPath(p.y)}`;

const segmentText = (c: Cubic): string =>
	isLine(c) ? `L ${coords(c[3])}` : `C ${coords(c[1])} ${coords(c[2])} ${coords(c[3])}`;

const subpathText = (subpath: Subpath): string => {
	const first = subpath.anchors[0];
	if (first === undefined) return '';
	const segments = segmentsOf(subpath);
	const closing = subpath.closed ? segments.at(-1) : undefined;
	const open = closing === undefined ? segments : segments.slice(0, -1);
	const end = closing === undefined ? [] : isLine(closing) ? ['Z'] : [segmentText(closing), 'Z'];
	return [`M ${coords(first.point)}`, ...open.map(segmentText), ...end].join(' ');
};

export const formatPath = (data: PathData): string =>
	data
		.map(subpathText)
		.filter((text) => text !== '')
		.join(' ');
