import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import { createCover } from './cover.js';
import { stageTransform, type View, type ViewBox } from './transform.js';

/**
 * The cover's stage (`cover.ts`): over the live raster canvas and under the
 * marks, moved and scaled as the drawing's stage is, holding the copy of the
 * layers over the one a stroke is painted on, while it is. It takes no press.
 */
export const StageCover = ({
	view,
	box,
	host,
}: Readonly<{ view: View; box: ViewBox; host: RefObject<HTMLDivElement | null> }>) => (
	<div
		className="viewport-stage viewport-cover"
		style={{ transform: stageTransform(view, box), width: box.width, height: box.height }}
	>
		<div className="viewport-mount" ref={host} />
	</div>
);

/**
 * The cover for a drawing's root, mounted in `mount`'s shadow root, over the
 * live `canvas`: the element its copy goes on, and its lift, for the screen
 * canvas's `paintsOn`. What it lifted is put back when the drawing or the
 * viewport goes.
 */
export const useCover = (
	root: SVGSVGElement,
	mount: RefObject<HTMLDivElement | null>,
	canvas: RefObject<HTMLCanvasElement | null>
): Readonly<{
	host: RefObject<HTMLDivElement | null>;
	lift: (layerId: string | undefined) => void;
}> => {
	const host = useRef<HTMLDivElement>(null);
	const [cover] = useState(createCover);
	useEffect(
		() => () => {
			cover.lift(undefined);
		},
		[cover, root]
	);
	const lift = useCallback(
		(layerId: string | undefined) => {
			cover.lift(layerId, {
				root,
				drawing: mount.current?.shadowRoot ?? undefined,
				host: host.current,
				canvas: canvas.current,
			});
		},
		[cover, root, mount, canvas]
	);
	return { host, lift };
};
