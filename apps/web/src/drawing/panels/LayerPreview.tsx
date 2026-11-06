import '../../styles/layerPreview.css';

import { type CSSProperties, type ReactNode, useCallback, useSyncExternalStore } from 'react';

import type { EditorDocument } from '../document/model.js';
import { PREVIEW_ROOM, type PreviewFit, type PreviewTarget } from './layerPreviews.js';
import { previewPicture, subscribePreview } from './layerPreviewStore.js';

/** Which picture a preview shows: a layer, or one item of a vector layer (`layerPreviews.ts`). */
export type { PreviewTarget } from './layerPreviews.js';

/** The canvas's share of the room either way, in the box's own units, so the picture fits at whatever size a rem is. */
const sizeOf = (fit: PreviewFit): CSSProperties => ({
	inlineSize: `calc(var(--layer-preview-room-width) * ${fit.width / PREVIEW_ROOM.width})`,
	blockSize: `calc(var(--layer-preview-room-height) * ${fit.height / PREVIEW_ROOM.height})`,
});

/**
 * A layer's preview in the layers panel, or one of a vector layer's items'
 * (docs/decisions/0004-the-interface.md, "The layers panel's previews").
 *
 * The box is `--layer-preview-width` by `--layer-preview-height`
 * (`styles/layerPreview.css`), the canvas fitted inside it at its own aspect,
 * Photoshop's transparency grid under the canvas alone, a hairline around
 * it. What is drawn is the layer as it paints by itself, or the one item
 * alone (`layerPreviews.ts`), through an `<img>` of a `blob:` URL, never the
 * DOM, kept up to date by one watch on the document shared by every preview
 * (`layerPreviewStore.ts`); `children` are drawn over the box, placed by the
 * row (a vector layer's mark, a caret). The picture is decorative: the row's
 * name says what the layer is. Where the browser makes no object URLs, the
 * box is empty.
 */
export const LayerPreview = ({
	document,
	target,
	className,
	children,
}: Readonly<{
	document: EditorDocument;
	target: PreviewTarget;
	className?: string;
	children?: ReactNode;
}>) => {
	const { layerId, position } = target;
	const subscribe = useCallback(
		(listener: () => void) => subscribePreview(document, { layerId, position }, listener),
		[document, layerId, position]
	);
	const picture = useSyncExternalStore(subscribe, () =>
		previewPicture(document, { layerId, position })
	);
	return (
		<span className={className === undefined ? 'layer-preview' : `layer-preview ${className}`}>
			{picture === undefined ? null : (
				<img
					className="layer-preview-picture"
					src={picture.url}
					alt=""
					aria-hidden="true"
					draggable={false}
					decoding="async"
					style={sizeOf(picture.fit)}
				/>
			)}
			{children}
		</span>
	);
};
