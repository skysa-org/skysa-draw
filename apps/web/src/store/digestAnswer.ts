import { withDrawingId } from '@skysa/draw-core';
import { bytesHash } from '@skysa/storage';

/**
 * What the digest worker does (`./digest.worker.ts` runs it, `./digest.ts`
 * asks it): a drawing's text in, its `contentHash` out, worked out as the
 * kit's works it out — the text's UTF-8 bytes, their SHA-256, lowercase hex — so
 * the two are the same hash for every text, a lone surrogate and all. Where
 * an id is asked for, it is written into the text first (`withDrawingId`),
 * and the hash is the file's that makes: a save's whole digest, so the page
 * neither copies the text to write the id nor digests what that made.
 *
 * And, where it is asked for, the file back, held one byte to a character.
 * V8 keeps a string two bytes to a character when anything that went into it
 * was, even where every character is ASCII — one attribute the browser held
 * so is enough, in a drawing of 15 MB — and Chrome stores and reads such a
 * string many times slower: that drawing is put into IndexedDB in some 60 ms
 * rather than 5, and read back in 25 rather than 4. The copy is the very same
 * text, character for character, so what is stored is what it was; only the
 * way it is held changes.
 */

export interface DigestRequest {
	/** Which request a reply answers: the page may have several waiting. */
	readonly seq: number;
	readonly text: string;
	/** The drawing's id, to be written into the text before it is digested. */
	readonly id?: string;
	/** Whether to send back a compact copy of the file, where there is one. */
	readonly compact: boolean;
}

interface DigestDone {
	readonly seq: number;
	readonly hash: string;
	/**
	 * The file, where it is not the text that was sent: compacted, or with the
	 * id written in. Absent where the text sent is the file, as it was held.
	 */
	readonly text?: string;
}

interface DigestFailed {
	readonly seq: number;
	readonly error: string;
}

export type DigestReply = DigestDone | DigestFailed;

/** The file a text makes: itself, or itself with the drawing's id written in. */
export const fileOf = (text: string, id: string | undefined): string =>
	id === undefined ? text : withDrawingId(text, id);

/**
 * The file decoded again from its own bytes, which makes a new string of one
 * byte to a character. Only for a file that is ASCII throughout, which is a
 * file whose UTF-8 is as long as it is: every other code unit takes two bytes
 * or more. Checked against the file all the same, since it is about to be
 * stored in its place.
 */
const compactCopy = (file: string, bytes: Uint8Array): string | undefined => {
	if (bytes.length !== file.length) return undefined;
	const copy = new TextDecoder().decode(bytes);
	return copy === file ? copy : undefined;
};

/** The worker's answer to a request: the hash, the file where it is new, or why there is neither. */
export const answer = async ({ seq, text, id, compact }: DigestRequest): Promise<DigestReply> => {
	try {
		const file = fileOf(text, id);
		const bytes = new TextEncoder().encode(file);
		const hash = await bytesHash(bytes);
		const copy = compact ? compactCopy(file, bytes) : undefined;
		if (copy !== undefined) return { seq, hash, text: copy };
		return file === text ? { seq, hash } : { seq, hash, text: file };
	} catch (error) {
		return { seq, error: String(error) };
	}
};
