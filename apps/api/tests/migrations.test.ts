import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The D1 migrations are the kit's (`@skysa/server`), and `wrangler.toml`
 * reaches them in `node_modules`. A database 0.1.0 made is reset onto them
 * rather than migrated (docs/self-hosting.md): its one migration was this
 * repository's own, under the name the kit's first has, so wrangler takes the
 * kit's first for applied and stops at its second, changing nothing.
 */

const API = join(dirname(fileURLToPath(import.meta.url)), '..');

const folder = (): string => {
	const named = /^migrations_dir = "([^"]+)"$/mu.exec(
		readFileSync(join(API, 'wrangler.toml'), 'utf8')
	)?.[1];
	expect(named).toBeDefined();
	return resolve(API, named ?? '');
};

/** The kit's migrations, by name, in the order wrangler applies them. */
const migrations = (): string[] =>
	readdirSync(folder())
		.filter((name) => name.endsWith('.sql'))
		.sort();

/** 0.1.0's one migration, as it was released (`fixtures/`). */
const OLD = join(API, 'tests', 'fixtures', '0.1.0-0000_init.sql');

/** Runs a migration's statements, as wrangler does, on a database in memory. */
const apply = (db: DatabaseSync, file: string): void => {
	db.exec(readFileSync(file, 'utf8'));
};

/** Every table and index a database has, as SQLite holds it. */
const schemaOf = (db: DatabaseSync): unknown[] =>
	db
		.prepare(
			"SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
		)
		.all();

/** A database from the kit's migrations, every one of them. */
const fresh = (): DatabaseSync => {
	const db = new DatabaseSync(':memory:');
	migrations().forEach((name) => {
		apply(db, join(folder(), name));
	});
	return db;
};

/** A database as 0.1.0 left it, holding a connection and a device's grant. */
const fromOld = (): DatabaseSync => {
	const db = new DatabaseSync(':memory:');
	apply(db, OLD);
	db.exec(
		"INSERT INTO storage_connections (id, provider, account_id, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES ('c1', 'dropbox', 'a1', 'Me', 'x', 'iv', 'k1', 0);" +
			"INSERT INTO grants (id, connection_id, secret_hash, created_at, last_used_at) VALUES ('g1', 'c1', 'h1', 0, 0);"
	);
	return db;
};

describe('the D1 migrations wrangler.toml applies', () => {
	it('are the kit’s, where it says', () => {
		expect(folder()).toMatch(/node_modules\/@skysa\/server\/migrations$/u);
		expect(existsSync(folder())).toBe(true);
		expect(migrations().length).toBeGreaterThan(1);
	});

	/**
	 * What docs/self-hosting.md, "A database from 0.1.0", rests on. Wrangler
	 * knows a migration by its name, and runs each in a transaction of its own,
	 * stopping at the first that fails; these hold the kit's migrations to what
	 * the reset assumes of them, so a kit that changed them would say so here.
	 */
	describe('over a database 0.1.0 made', () => {
		it('begin with the name 0.1.0’s one migration had, so wrangler takes it for applied', () => {
			expect(migrations()[0]).toBe('0000_init.sql');
		});

		it('fail at the kit’s second, so a database migrated as it is goes no further', () => {
			const db = fromOld();
			const second = migrations()[1] ?? '';
			expect(() => {
				apply(db, join(folder(), second));
			}).toThrow();
		});

		it('make, once its tables are dropped, what they make of an empty database, and hold no connection', () => {
			const db = fromOld();
			db.exec('DROP TABLE grants; DROP TABLE storage_connections;');
			migrations().forEach((name) => {
				apply(db, join(folder(), name));
			});
			expect(schemaOf(db)).toEqual(schemaOf(fresh()));
			expect(db.prepare('SELECT count(*) AS n FROM storage_connections').get()).toEqual({
				n: 0,
			});
		});
	});
});
