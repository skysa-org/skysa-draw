import type { Ref } from 'react';

import { antsPath } from '../tools/raster/area.js';
import type { Region } from '../tools/types.js';
import { stageTransform, type View, type ViewBox } from './transform.js';

/**
 * What the viewport draws over the picture, on a stage of its own over the
 * live raster canvas (`LiveCanvas`): the area's marching ants, the tools'
 * overlay with the brush's outline, and the transform's box. It is moved and
 * scaled as the drawing's stage is, so its marks stay in the drawing's user
 * units, and it comes after the live canvas, so a stroke being painted is
 * under the outline that paints it and under the ants, as in Photoshop. Each
 * layer, and the stage itself, is out of the pointer's way.
 */
export const StageMarks = ({
	view,
	box,
	area,
	overlay,
	transformed,
}: Readonly<{
	view: View;
	box: ViewBox;
	area: Region | undefined;
	overlay: Ref<SVGSVGElement>;
	transformed: Ref<SVGSVGElement>;
}>) => {
	const viewBox = `${box.x} ${box.y} ${box.width} ${box.height}`;
	return (
		<div
			className="viewport-stage viewport-marks"
			style={{ transform: stageTransform(view, box), width: box.width, height: box.height }}
		>
			<svg
				className="viewport-area"
				viewBox={viewBox}
				width={box.width}
				height={box.height}
				aria-hidden="true"
			>
				{area === undefined ? null : (
					<>
						<path
							className="viewport-ants viewport-ants-under"
							d={antsPath(area, box)}
							fillRule="nonzero"
							vectorEffect="non-scaling-stroke"
						/>
						<path
							className="viewport-ants viewport-ants-over"
							d={antsPath(area, box)}
							fillRule="nonzero"
							vectorEffect="non-scaling-stroke"
						/>
					</>
				)}
			</svg>
			<svg
				className="viewport-overlay"
				ref={overlay}
				viewBox={viewBox}
				width={box.width}
				height={box.height}
				aria-hidden="true"
			/>
			<svg
				className="viewport-transform"
				ref={transformed}
				viewBox={viewBox}
				width={box.width}
				height={box.height}
				aria-hidden="true"
			/>
		</div>
	);
};
