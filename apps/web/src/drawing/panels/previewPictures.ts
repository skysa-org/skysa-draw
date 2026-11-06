import { releaseCanvas } from '../tools/raster/area.js';
import { decodePicture } from '../tools/raster/surface.js';

/**
 * Small stand-ins for the pictures in a drawing's own bytes, for the layers
 * panel's previews (`layerPreviews.ts`; docs/ARCHITECTURE.md §7, "The
 * interface"). A raster layer's picture is a `data:` URL of the layer's
 * every pixel, megabytes of it for a photo, and a preview that held it would
 * have the browser parse that much SVG and decode every pixel on the page's
 * thread, for a picture 36 px wide, each time the layer changed and each time
 * a preview of it was shown: half a second on a picture of 4000 by 3000.
 * Each picture is decoded once instead, shrunk to `STAND_IN_MOST` pixels on
 * its longer side, at the browser's best smoothing, and kept as a PNG `data:`
 * URL, which a standalone SVG may hold, where a `blob:` one would not load.
 *
 * A stand-in is known by its picture's `href`, the very string, so it is made
 * again only for a picture that changed. Those no preview shows any more are
 * let go of after each round of previews (`keep`), so a stroke's picture
 * leaves no stand-in behind once the next one is shown. A picture the browser
 * cannot decode stands for itself, as it would have.
 */

/** A stand-in's longer side, in pixels: the preview's box at three device pixels to one, with room to frame part of it. */
export const STAND_IN_MOST = 256;

/** A picture's stand-in made from its `href`: shrunk to `most` pixels on its longer side, or the `href` itself where it is no larger. */
export type Shrink = (href: string, most: number) => Promise<string>;

/** Whether the browser can make stand-ins; jsdom cannot, and there a picture stands for itself. */
export const canShrink = (): boolean =>
	typeof createImageBitmap === 'function' && typeof document !== 'undefined';

/** A size held to `most` on its longer side, at its own aspect, a pixel at least either way. */
const shrunkSize = (
	width: number,
	height: number,
	most: number
): Readonly<{ width: number; height: number }> => {
	const scale = most / Math.max(width, height);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
};

/**
 * The browser's: the picture decoded as a raster surface decodes it
 * (`decodePicture`), resized by `createImageBitmap`, which costs the page's
 * thread a fraction of a draw of every pixel onto a canvas, and encoded as
 * PNG, which keeps what is transparent. A picture with no size of its own, an
 * SVG without one, stands for itself.
 */
export const browserShrink: Shrink = async (href, most) => {
	const img = await decodePicture(href);
	const { naturalWidth, naturalHeight } = img;
	if (!(naturalWidth > 0 && naturalHeight > 0) || Math.max(naturalWidth, naturalHeight) <= most) {
		return href;
	}
	const size = shrunkSize(naturalWidth, naturalHeight, most);
	const bitmap = await createImageBitmap(img, {
		resizeWidth: size.width,
		resizeHeight: size.height,
		resizeQuality: 'high',
	});
	const canvas = document.createElement('canvas');
	canvas.width = size.width;
	canvas.height = size.height;
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
	bitmap.close();
	const url = canvas.toDataURL('image/png');
	releaseCanvas(canvas);
	return url;
};

export type StandIns = Readonly<{
	/** The picture's stand-in, where it is made; nothing while it is not. Every picture stands for itself where nothing shrinks. */
	get: (href: string) => string | undefined;
	/** The stand-ins of `hrefs` made, those not made and not under way; done once each is, or has failed. */
	make: (hrefs: readonly string[]) => Promise<void>;
	/** Every stand-in made let go of but those of `hrefs`; one under way is kept once it is made. */
	keep: (hrefs: ReadonlySet<string>) => void;
}>;

/** The stand-ins of one document's previews, made by `shrink`, or none where there is nothing to shrink with. */
export const createStandIns = (shrink: Shrink | undefined): StandIns => {
	const made = new Map<string, string>();
	const making = new Map<string, Promise<void>>();
	const start = (taken: Shrink, href: string): Promise<void> => {
		const work = taken(href, STAND_IN_MOST)
			.catch(() => href)
			.then((small) => {
				made.set(href, small);
				making.delete(href);
			});
		making.set(href, work);
		return work;
	};
	return {
		get: (href) => (shrink === undefined ? href : made.get(href)),
		make: async (hrefs) => {
			if (shrink === undefined) return;
			await Promise.all(
				[...new Set(hrefs)]
					.filter((href) => !made.has(href))
					.map((href) => making.get(href) ?? start(shrink, href))
			);
		},
		keep: (hrefs) => {
			[...made.keys()]
				.filter((href) => !hrefs.has(href))
				.forEach((href) => {
					made.delete(href);
				});
		},
	};
};
