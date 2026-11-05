import type { Ref } from 'react';

import { canvasClip, type View, type ViewBox } from './transform.js';

/**
 * The live raster canvas over the whole viewport (`.viewport-screen`), in
 * device pixels, that a stroke, a smudge or a float of moved pixels is
 * painted on while it lasts: clipped to the drawing's canvas on the screen
 * (`canvasClip`), so what shows is what will once it lands, the drawing being
 * cut to its canvas.
 */
export const LiveCanvas = ({
	ref,
	view,
	box,
}: Readonly<{ ref: Ref<HTMLCanvasElement>; view: View; box: ViewBox }>) => (
	<canvas
		className="viewport-screen"
		ref={ref}
		style={{ clipPath: canvasClip(view, box) }}
		aria-hidden="true"
	/>
);
