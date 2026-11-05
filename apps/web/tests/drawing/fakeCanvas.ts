import { vi } from 'vitest';

import { areaPolygons } from '../../src/drawing/tools/raster/area.js';
import { parseColor, type Rgba } from '../../src/drawing/tools/raster/pixels.js';

/**
 * A 2D canvas for jsdom, which has none, that composites: enough of one to
 * see what the area's inverse and feather do to pixels, not only which calls
 * were made. Pixels are sampled at their centers, so an edge has no
 * anti-aliasing; a path is the area's own kind, straight subpaths filled by
 * `nonzero`, and one drawn with `moveTo`, `lineTo` and `arcTo` is its
 * corners, as a rectangle's is at a radius of 0; a `blur(…px)` filter is a Gaussian of that deviation over the
 * shape, drawn as on an infinite bitmap, as the canvas's spec says; and
 * `source-over`, `source-in`, `source-out`, `destination-in`,
 * `destination-out`, `destination-over`, `copy` and `lighter` are
 * composited, unbounded, inside the clip.
 * A transform is read for a point and for a scale, not for a turn.
 *
 * Pictures round-trip: `toBlob` keeps the canvas's pixels under the `href`
 * a `FileReader` will read the blob as, and an `<img>` of that `href`
 * decodes to them, so a layer's picture can be written and read back; an
 * SVG `<image>` of it draws them.
 * What this cannot show is a real browser's anti-aliasing, its blur's exact
 * kernel, its bounds for a composite, or PNG.
 */

/** `Path2D` as the tests stub it: the path, kept to be read back and filled. */
class FakePath2D {
	constructor(readonly d: string) {}
}

type Matrix = [number, number, number, number, number, number];

/** Whether a point in the canvas's pixels is inside a shape. */
type Inside = (x: number, y: number) => boolean;

type Picture = Readonly<{ width: number; height: number; data: Uint8ClampedArray }>;

type Call = Readonly<{
	name: string;
	args: readonly unknown[];
	composite: string;
	alpha: number;
	filter: string | undefined;
	fillStyle: unknown;
}>;

type State = {
	globalAlpha: number;
	globalCompositeOperation: string;
	fillStyle: unknown;
	strokeStyle: unknown;
	lineWidth: number;
	filter?: string;
	transform: Matrix;
	clips: Inside[];
};

export type FakeContext = Readonly<{
	canvas: HTMLCanvasElement;
	calls: Call[];
	named: (name: string) => Call[];
	/** The canvas's pixels, RGBA, made when first asked for and again when its size changes. */
	pixels: () => Uint8ClampedArray;
	/** One pixel's RGBA. */
	at: (x: number, y: number) => number[];
}> &
	State;

type Gradient = { stops: string[]; addColorStop: (offset: number, color: string) => void };

const apply = (m: Matrix, x: number, y: number): [number, number] => [
	m[0] * x + m[2] * y + m[4],
	m[1] * x + m[3] * y + m[5],
];

const inverseOf = (m: Matrix): Matrix => {
	const [a, b, c, d, e, f] = m;
	const det = a * d - b * c;
	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};

/** The winding of a polygon around a point: 0 outside it under `nonzero`. */
const winding = (polygon: readonly (readonly [number, number])[], x: number, y: number): number =>
	polygon.reduce((sum, [ax, ay], i) => {
		const [bx, by] = polygon[(i + 1) % polygon.length] ?? [ax, ay];
		const cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
		if (ay <= y && by > y && cross > 0) return sum + 1;
		if (ay > y && by <= y && cross < 0) return sum - 1;
		return sum;
	}, 0);

const polygonShape =
	(polygons: readonly (readonly (readonly [number, number])[])[]): Inside =>
	(x, y) =>
		polygons.reduce((sum, polygon) => sum + winding(polygon, x, y), 0) !== 0;

type Blend = (
	as: number,
	ad: number,
	s: readonly number[],
	d: readonly number[]
) => readonly [number, readonly number[]];

const over: Blend = (as, ad, s, d) => {
	const alpha = as + ad * (1 - as);
	if (alpha <= 0) return [0, [0, 0, 0]];
	return [alpha, s.map((c, k) => (c * as + (d[k] ?? 0) * ad * (1 - as)) / alpha)];
};

/** Porter–Duff, as the canvas composites, on colors that are not premultiplied. */
const BLENDS: Readonly<Record<string, Blend>> = {
	'source-over': over,
	'destination-out': (as, ad, _s, d) => [ad * (1 - as), d],
	'destination-in': (as, ad, _s, d) => [ad * as, d],
	'source-in': (as, ad, s) => [as * ad, s],
	'source-out': (as, ad, s) => [as * (1 - ad), s],
	'destination-over': (as, ad, s, d) => over(ad, as, d, s),
	copy: (as, _ad, s) => [as, s],
	// The two added, premultiplied, as far as a pixel holds.
	lighter: (as, ad, s, d) => {
		const alpha = Math.min(1, as + ad);
		if (alpha <= 0) return [0, [0, 0, 0]];
		return [alpha, s.map((c, k) => Math.min(255, c * as + (d[k] ?? 0) * ad) / alpha)];
	},
};

const BLUR = /^blur\(\s*([\d.]+)px\s*\)$/;

/** The canvas's pictures, by the `href` they were written as or registered under. */
const pictures = new Map<string, Picture>();

/** How many pictures have been encoded since the fake was installed. */
let encoded = 0;

/** A picture of `width` × `height` whose pixels `paint` gives, under an `href` an `<img>` decodes. */
export const registerPicture = (
	width: number,
	height: number,
	paint: (x: number, y: number) => Rgba
): string => {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i += 1) {
		data.set(paint(i % width, Math.floor(i / width)), i * 4);
	}
	const href = `data:image/png;base64,${btoa(`picture-${pictures.size}`)}`;
	pictures.set(href, { width, height, data });
	return href;
};

/** The pixels a written `href` holds, as `[r, g, b, a]` at a point. */
export const pictureAt = (href: string | null | undefined, x: number, y: number): number[] => {
	const picture = href === null || href === undefined ? undefined : pictures.get(href);
	if (picture === undefined) throw new Error(`no picture under ${String(href)}`);
	const offset = (y * picture.width + x) * 4;
	return Array.from(picture.data.subarray(offset, offset + 4));
};

export const pictureSize = (
	href: string | null | undefined
): Readonly<{ width: number; height: number }> => {
	const picture = href === null || href === undefined ? undefined : pictures.get(href);
	if (picture === undefined) throw new Error(`no picture under ${String(href)}`);
	return { width: picture.width, height: picture.height };
};

let contexts = new Map<HTMLCanvasElement, FakeContext>();

const createContext = (canvas: HTMLCanvasElement, filters: boolean): FakeContext => {
	const state: State = {
		globalAlpha: 1,
		globalCompositeOperation: 'source-over',
		fillStyle: '#000000',
		strokeStyle: '#000000',
		lineWidth: 1,
		...(filters ? { filter: 'none' } : {}),
		transform: [1, 0, 0, 1, 0, 0],
		clips: [],
	};
	const calls: Call[] = [];
	const saved: State[] = [];
	let path: Inside[] = [];
	/** The corners of the subpaths drawn since `beginPath`, in the canvas's pixels. */
	let corners: [number, number][][] = [];
	const corner = (x: number, y: number): void => {
		const last = corners.at(-1);
		if (last === undefined) corners = [[apply(state.transform, x, y)]];
		else last.push(apply(state.transform, x, y));
	};
	let store: Uint8ClampedArray | undefined;
	const pixels = (): Uint8ClampedArray => {
		const length = canvas.width * canvas.height * 4;
		if (store?.length !== length) store = new Uint8ClampedArray(length);
		return store;
	};
	const record = (name: string, args: readonly unknown[]): void => {
		calls.push({
			name,
			args,
			composite: state.globalCompositeOperation,
			alpha: state.globalAlpha,
			filter: state.filter,
			fillStyle: state.fillStyle,
		});
	};
	const inClip = (x: number, y: number): boolean => state.clips.every((inside) => inside(x, y));

	/** Each pixel of the canvas given a source color and alpha, composited by the state's operation. */
	const composite = (
		source: (x: number, y: number) => readonly [number, number, number, number]
	): void => {
		const all = pixels();
		const op = state.globalCompositeOperation;
		for (let i = 0; i < canvas.width * canvas.height; i += 1) {
			const x = i % canvas.width;
			const y = Math.floor(i / canvas.width);
			if (!inClip(x + 0.5, y + 0.5)) continue;
			const [sr, sg, sb, sa] = source(x, y);
			const as = Math.max(0, Math.min(1, sa * state.globalAlpha));
			const o = i * 4;
			const ad = (all[o + 3] ?? 0) / 255;
			const d = [all[o] ?? 0, all[o + 1] ?? 0, all[o + 2] ?? 0];
			const s = [sr, sg, sb];
			const blend = BLENDS[op];
			if (blend === undefined) throw new Error(`the fake canvas does not composite ${op}`);
			const [alpha, color] = blend(as, ad, s, d);
			// A canvas keeps its pixels premultiplied: one with no alpha has no color.
			const kept = Math.round(alpha * 255);
			all[o] = kept === 0 ? 0 : Math.round(color[0] ?? 0);
			all[o + 1] = kept === 0 ? 0 : Math.round(color[1] ?? 0);
			all[o + 2] = kept === 0 ? 0 : Math.round(color[2] ?? 0);
			all[o + 3] = kept;
		}
	};

	/** How much of each pixel a shape covers, 0 or 1 at its center, blurred by the filter. */
	const coverage = (inside: Inside): ((x: number, y: number) => number) => {
		const sigma = Number(BLUR.exec(state.filter ?? '')?.[1] ?? 0);
		if (!(sigma > 0)) return (x, y) => (inside(x + 0.5, y + 0.5) ? 1 : 0);
		const pad = Math.ceil(3 * sigma);
		const width = canvas.width + 2 * pad;
		const height = canvas.height + 2 * pad;
		const kernel = Array.from({ length: 2 * pad + 1 }, (_, k) =>
			Math.exp(-((k - pad) ** 2) / (2 * sigma * sigma))
		);
		const total = kernel.reduce((sum, w) => sum + w, 0);
		const hard = new Float64Array(width * height);
		for (let i = 0; i < width * height; i += 1) {
			hard[i] = inside((i % width) - pad + 0.5, Math.floor(i / width) - pad + 0.5) ? 1 : 0;
		}
		const across = new Float64Array(width * height);
		for (let i = 0; i < width * height; i += 1) {
			const x = i % width;
			across[i] =
				kernel.reduce((sum, w, k) => {
					const sx = x + k - pad;
					return sx < 0 || sx >= width ? sum : sum + w * (hard[i - x + sx] ?? 0);
				}, 0) / total;
		}
		const down = new Float64Array(width * height);
		for (let i = 0; i < width * height; i += 1) {
			const y = Math.floor(i / width);
			down[i] =
				kernel.reduce((sum, w, k) => {
					const sy = y + k - pad;
					return sy < 0 || sy >= height
						? sum
						: sum + w * (across[sy * width + (i % width)] ?? 0);
				}, 0) / total;
		}
		return (x, y) => down[(y + pad) * width + x + pad] ?? 0;
	};

	const colorOf = (style: unknown): Rgba => {
		const css =
			typeof style === 'string'
				? style
				: ((style as Gradient | undefined)?.stops[0] ?? '#000000');
		const rgba = parseColor(css);
		if (rgba === undefined) throw new Error(`the fake canvas does not read ${css}`);
		return rgba;
	};

	const fillShape = (inside: Inside): void => {
		const [r, g, b, a] = colorOf(state.fillStyle);
		const cover = coverage(inside);
		composite((x, y) => [r, g, b, (a / 255) * cover(x, y)]);
	};

	const pathShape = (subject: unknown): Inside => {
		if (subject instanceof FakePath2D) {
			const inverse = inverseOf(state.transform);
			const polygons = areaPolygons(subject.d).map((polygon) =>
				polygon.map((p): [number, number] => [p.x, p.y])
			);
			const inside = polygonShape(polygons);
			return (x, y) => {
				const [ux, uy] = apply(inverse, x, y);
				return inside(ux, uy);
			};
		}
		const current = path;
		const drawn = corners.filter((polygon) => polygon.length > 2);
		const cornered = polygonShape(drawn);
		return (x, y) =>
			current.some((inside) => inside(x, y)) || (drawn.length > 0 && cornered(x, y));
	};

	const rectShape = (x: number, y: number, width: number, height: number): Inside => {
		const corners: [number, number][] = [
			apply(state.transform, x, y),
			apply(state.transform, x + width, y),
			apply(state.transform, x + width, y + height),
			apply(state.transform, x, y + height),
		];
		return polygonShape([corners]);
	};

	const sourcePixels = (image: unknown): Picture => {
		if (image instanceof HTMLCanvasElement) {
			const data = fakeOf(image).pixels();
			return { width: image.width, height: image.height, data };
		}
		if (image instanceof HTMLImageElement) {
			const picture = pictures.get(image.getAttribute('src') ?? '');
			if (picture === undefined) throw new Error('the fake canvas cannot draw that image');
			return picture;
		}
		// An SVG `<image>`, which a browser draws by its `href` once it has loaded.
		if (image instanceof Element && image.localName === 'image') {
			const picture = pictures.get(image.getAttribute('href') ?? '');
			if (picture === undefined) throw new Error('the fake canvas cannot draw that image');
			return picture;
		}
		throw new Error('the fake canvas draws canvases and images only');
	};

	const methods = {
		canvas,
		calls,
		pixels,
		named: (name: string) => calls.filter((call) => call.name === name),
		at: (x: number, y: number) => {
			const offset = (y * canvas.width + x) * 4;
			return Array.from(pixels().subarray(offset, offset + 4));
		},
		save: () => {
			saved.push({ ...state, transform: [...state.transform], clips: [...state.clips] });
			record('save', []);
		},
		restore: () => {
			const last = saved.pop();
			if (last !== undefined) Object.assign(state, last);
			record('restore', []);
		},
		setTransform: (...args: number[]) => {
			record('setTransform', args);
			state.transform = args as Matrix;
		},
		beginPath: () => {
			record('beginPath', []);
			path = [];
			corners = [];
		},
		rect: (x: number, y: number, width: number, height: number) => {
			record('rect', [x, y, width, height]);
			path = [...path, rectShape(x, y, width, height)];
		},
		arc: (x: number, y: number, radius: number) => {
			record('arc', [x, y, radius]);
			const [cx, cy] = apply(state.transform, x, y);
			const r = radius * Math.hypot(state.transform[0], state.transform[1]);
			path = [...path, (px, py) => Math.hypot(px - cx, py - cy) <= r];
		},
		moveTo: (x: number, y: number) => {
			record('moveTo', [x, y]);
			corners = [...corners, [apply(state.transform, x, y)]];
		},
		lineTo: (x: number, y: number) => {
			record('lineTo', [x, y]);
			corner(x, y);
		},
		arcTo: (x1: number, y1: number, ...rest: number[]) => {
			record('arcTo', [x1, y1, ...rest]);
			corner(x1, y1);
		},
		ellipse: (...args: unknown[]) => record('ellipse', args),
		closePath: () => record('closePath', []),
		stroke: (...args: unknown[]) => record('stroke', args),
		strokeRect: (...args: unknown[]) => record('strokeRect', args),
		clip: (...args: unknown[]) => {
			record('clip', args);
			state.clips = [...state.clips, pathShape(args[0])];
		},
		fill: (...args: unknown[]) => {
			record('fill', args);
			fillShape(pathShape(args[0]));
		},
		fillRect: (x: number, y: number, width: number, height: number) => {
			record('fillRect', [x, y, width, height]);
			fillShape(rectShape(x, y, width, height));
		},
		clearRect: (x: number, y: number, width: number, height: number) => {
			record('clearRect', [x, y, width, height]);
			const inside = rectShape(x, y, width, height);
			const all = pixels();
			for (let i = 0; i < canvas.width * canvas.height; i += 1) {
				const px = (i % canvas.width) + 0.5;
				const py = Math.floor(i / canvas.width) + 0.5;
				if (inside(px, py) && inClip(px, py)) all.fill(0, i * 4, i * 4 + 4);
			}
		},
		createRadialGradient: (...args: number[]) => {
			record('createRadialGradient', args);
			const gradient: Gradient = {
				stops: [],
				addColorStop: (_offset, color) => {
					gradient.stops.push(color);
				},
			};
			return gradient;
		},
		drawImage: (image: unknown, ...args: number[]) => {
			record('drawImage', [image, ...args]);
			const source = sourcePixels(image);
			const [sx = 0, sy = 0, sw = 0, sh = 0, dx = 0, dy = 0, dw = 1, dh = 1] =
				args.length === 8
					? args
					: [
							0,
							0,
							source.width,
							source.height,
							args[0] ?? 0,
							args[1] ?? 0,
							args[2] ?? source.width,
							args[3] ?? source.height,
						];
			const inverse = inverseOf(state.transform);
			composite((x, y) => {
				const [ux, uy] = apply(inverse, x + 0.5, y + 0.5);
				const px = Math.floor(sx + ((ux - dx) * sw) / dw);
				const py = Math.floor(sy + ((uy - dy) * sh) / dh);
				const outside =
					ux < dx || uy < dy || ux >= dx + dw || uy >= dy + dh || px < 0 || py < 0;
				if (outside || px >= source.width || py >= source.height) return [0, 0, 0, 0];
				const o = (py * source.width + px) * 4;
				const data = source.data;
				return [data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0, (data[o + 3] ?? 0) / 255];
			});
		},
		getImageData: (x: number, y: number, width: number, height: number) => {
			record('getImageData', [x, y, width, height]);
			const all = pixels();
			const data = new Uint8ClampedArray(width * height * 4);
			for (let i = 0; i < width * height; i += 1) {
				const column = x + (i % width);
				const row = y + Math.floor(i / width);
				if (column < 0 || row < 0 || column >= canvas.width || row >= canvas.height)
					continue;
				const from = (row * canvas.width + column) * 4;
				data.set(all.subarray(from, from + 4), i * 4);
			}
			return { data, width, height, colorSpace: 'srgb' };
		},
		putImageData: (
			image: Readonly<{ data: Uint8ClampedArray; width: number; height: number }>,
			x: number,
			y: number
		) => {
			record('putImageData', [image, x, y]);
			const all = pixels();
			for (let row = 0; row < image.height; row += 1) {
				const from = row * image.width * 4;
				all.set(
					image.data.subarray(from, from + image.width * 4),
					((y + row) * canvas.width + x) * 4
				);
			}
		},
	};
	return Object.assign(state, methods);
};

let withFilters = true;

/** The fake context of a canvas, made when first asked for. */
export const fakeOf = (canvas: HTMLCanvasElement): FakeContext => {
	const found = contexts.get(canvas);
	if (found !== undefined) return found;
	const made = createContext(canvas, withFilters);
	contexts.set(canvas, made);
	return made;
};

/**
 * The fake in place of jsdom's canvas, `toBlob`, `FileReader`'s input and
 * `<img>` decoding, and `Path2D` stubbed; `filters` false for a browser
 * whose canvas has no `filter` (Safari before 18). Undone by
 * `vi.restoreAllMocks()`, `vi.unstubAllGlobals()` and `uninstallFakeCanvas`.
 */
export const installFakeCanvas = (options: Readonly<{ filters?: boolean }> = {}): void => {
	contexts = new Map();
	encoded = 0;
	withFilters = options.filters ?? true;
	vi.stubGlobal('Path2D', FakePath2D);
	const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
	spy.mockImplementation(() => fakeOf(spy.mock.contexts.at(-1) as HTMLCanvasElement) as never);
	const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');
	toBlob.mockImplementation((callback) => {
		const canvas = toBlob.mock.contexts.at(-1) as HTMLCanvasElement;
		encoded += 1;
		const content = `png-${encoded}`;
		pictures.set(`data:image/png;base64,${btoa(content)}`, {
			width: canvas.width,
			height: canvas.height,
			data: new Uint8ClampedArray(fakeOf(canvas).pixels()),
		});
		const blob = new Blob([content], { type: 'image/png' });
		setTimeout(() => callback(blob), 0);
	});
	const decode = vi.fn(() => {
		const img = decode.mock.contexts.at(-1) as HTMLImageElement;
		return pictures.has(img.getAttribute('src') ?? '')
			? Promise.resolve()
			: Promise.reject(new Error('not a picture'));
	});
	Object.defineProperty(HTMLImageElement.prototype, 'decode', {
		configurable: true,
		writable: true,
		value: decode,
	});
};

export const uninstallFakeCanvas = (): void => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
};
