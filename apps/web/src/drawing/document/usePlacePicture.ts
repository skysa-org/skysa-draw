import { type DragEvent, useEffect, useEffectEvent } from 'react';

import { useApply } from '../../components/ui/Applying.js';
import { t } from '../../i18n/t.js';
import { placePicture } from '../export/place.js';
import { isTyping } from '../keys.js';
import type { EditorDocument } from './model.js';

/**
 * A picture placed in the drawing as a new raster layer above the active one
 * (docs/ARCHITECTURE.md §3, "Layers": "a picture placed from a file keeps its
 * bytes and its type"), however it comes: chosen in a file field, pasted, or
 * dropped on the canvas. The reading is asynchronous; the layer is one step
 * to undo, and the active one once it is there. A file that is not a picture
 * the app reads is said so and placed nowhere.
 *
 * A large picture holds the page a while as it is decoded and drawn, so it is
 * placed under the frame's indicator (`components/ui/Applying.tsx`), which
 * shows once that takes a while, and goes once the layer is there. The job is
 * the document's pending work from the moment it is asked for, so a save
 * waits for it even before the indicator has begun it.
 */

const isPicture = (file: File): boolean => file.type.startsWith('image/');

const firstPicture = (files: FileList | null | undefined): File | undefined =>
	[...(files ?? [])].find(isPicture);

export type Placing = Readonly<{
	place: (file: Blob) => void;
	/** On the canvas: lets a file be dropped there. */
	onDragOver: (event: DragEvent<HTMLElement>) => void;
	onDrop: (event: DragEvent<HTMLElement>) => void;
}>;

export const usePlacePicture = (
	document: EditorDocument | undefined,
	above: string | undefined,
	onPlaced: (id: string) => void,
	onNotify: (message: string) => void
): Placing => {
	const apply = useApply();
	const place = (file: Blob): void => {
		if (document === undefined) return;
		const job = apply(
			() =>
				placePicture(document, file, above).then(
					(command) => {
						if (command === undefined) {
							onNotify(t('exporting.cannotPlace'));
							return;
						}
						document.execute(command);
						onPlaced(command.id);
					},
					() => onNotify(t('exporting.cannotPlace'))
				),
			t('editor.placingPicture')
		);
		document.pending(job);
	};

	// A picture pasted anywhere but into a field, where a paste is the field's.
	const onPaste = useEffectEvent((event: ClipboardEvent) => {
		if (event.defaultPrevented || isTyping(event.target)) return;
		const picture = firstPicture(event.clipboardData?.files);
		if (picture === undefined) return;
		event.preventDefault();
		place(picture);
	});
	useEffect(() => {
		const listener = (event: ClipboardEvent) => {
			onPaste(event);
		};
		window.addEventListener('paste', listener);
		return () => window.removeEventListener('paste', listener);
	}, []);

	return {
		place,
		onDragOver: (event) => {
			if (![...event.dataTransfer.types].includes('Files')) return;
			event.preventDefault();
			// eslint-disable-next-line functional/immutable-data -- the drag's answer, as the DOM asks for it
			event.dataTransfer.dropEffect = 'copy';
		},
		onDrop: (event) => {
			const files = event.dataTransfer.files;
			if (files.length === 0) return;
			event.preventDefault();
			const picture = firstPicture(files);
			if (picture === undefined) {
				onNotify(t('exporting.cannotPlace'));
				return;
			}
			place(picture);
		},
	};
};
