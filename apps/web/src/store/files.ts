import type { FileBytesRecord, FileKey, FileRecord } from './db.js';

/**
 * Files beside drawings (skysa-notes #187 in skysa-notes): what the sync store, a move
 * between sources and a download need to know of one. The writers that add a
 * file and the rules a drawing's move applies to the files it links come with
 * attachments (docs/ARCHITECTURE.md §10); skysa-notes' `store/files.ts` has
 * them for a note's links.
 *
 * A file the provider has beside the drawings already syncs: the engine lists
 * it, the store keeps its row, and its bytes are read when asked for
 * (`sync/fileReads.ts`).
 */

export const fileKey = (file: Pick<FileRecord, 'connectionId' | 'id'>): FileKey => [
	file.connectionId,
	file.id,
];

/**
 * Whether held bytes are the file's: held because they are not up yet, or
 * cached under the version the row is bound to. The rule `fileBytes` in
 * `sync/store.ts` hands bytes back by, and stated once for both.
 */
export const heldBytesAreCurrent = (file: FileRecord, held: FileBytesRecord): boolean =>
	held.pinned === 1 || (held.version !== undefined && held.version === file.remoteVersion);
