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

/** Where `wrangler.toml` says the migrations are. */
const FOLDER = resolve(
	API,
	/^migrations_dir = "([^"]+)"$/mu.exec(readFileSync(join(API, 'wrangler.toml'), 'utf8'))?.[1] ??
		''
);

/** The kit's migrations, by name, in the order wrangler applies them. */
const MIGRATIONS = existsSync(FOLDER)
	? readdirSync(FOLDER)
			.filter((name) => name.endsWith('.sql'))
			.sort()
	: [];

/**
 * The names wrangler has recorded for a database of this app once it is on the
 * kit: the kit's, through 1.0.0. A kit that renamed one would have wrangler run
 * it again on every such database.
 */
const APPLIED = [
	'0000_init.sql',
	'0001_connection_per_provider.sql',
	'0002_connection_account_id.sql',
	'0003_one_user_per_account.sql',
	'0004_per_connection_credentials.sql',
	'0005_drop_user_connections.sql',
	'0006_grant_device.sql',
	'0007_drop_sign_in_tables.sql',
];

/** 0.1.0's one migration, as it was released (`fixtures/`). */
const OLD = join(API, 'tests', 'fixtures', '0.1.0-0000_init.sql');

/** The reset's statements, as docs/self-hosting.md, "A database from 0.1.0", gives them. */
const RESET =
	/### A database from 0\.1\.0[\s\S]*?--command "([^"]+)"/u.exec(
		readFileSync(join(API, '..', '..', 'docs', 'self-hosting.md'), 'utf8')
	)?.[1] ?? '';

/** A database in memory, with foreign keys held to as D1 holds them. */
const database = (): DatabaseSync => {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON;');
	return db;
};

/**
 * Runs a migration's statements as wrangler does: in a transaction of their
 * own, so a migration that fails leaves the database as it found it.
 */
const apply = (db: DatabaseSync, file: string): void => {
	db.exec('BEGIN;');
	try {
		db.exec(readFileSync(file, 'utf8'));
		db.exec('COMMIT;');
	} catch (error) {
		db.exec('ROLLBACK;');
		throw error;
	}
};

const applyAll = (db: DatabaseSync): DatabaseSync => {
	MIGRATIONS.forEach((name) => {
		apply(db, join(FOLDER, name));
	});
	return db;
};

/** Every table and index a database has, as SQLite holds it. */
const schemaOf = (db: DatabaseSync): unknown[] =>
	db
		.prepare(
			"SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
		)
		.all();

const tablesOf = (db: DatabaseSync): unknown[] =>
	db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
		)
		.all()
		.map((row) => row.name);

/**
 * A database as 0.1.0 left it: its migration applied and recorded as wrangler
 * records one, and a connection with a device's grant.
 */
const fromOld = (): DatabaseSync => {
	const db = database();
	apply(db, OLD);
	db.exec(
		'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);' +
			"INSERT INTO d1_migrations (name) VALUES ('0000_init.sql');" +
			"INSERT INTO storage_connections (id, provider, account_id, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES ('c1', 'dropbox', 'a1', 'Me', 'x', 'iv', 'k1', 0);" +
			"INSERT INTO grants (id, connection_id, secret_hash, created_at, last_used_at) VALUES ('g1', 'c1', 'h1', 0, 0);"
	);
	return db;
};

describe('the D1 migrations wrangler.toml applies', () => {
	it('are the kit’s, where it says', () => {
		expect(FOLDER).toMatch(/node_modules\/@skysa\/server\/migrations$/u);
		expect(existsSync(FOLDER)).toBe(true);
	});

	it('keep every name a database of this app has applied, in order', () => {
		expect(MIGRATIONS.slice(0, APPLIED.length)).toEqual(APPLIED);
	});

	it('make the two tables this app’s database has, and nothing else', () => {
		expect(tablesOf(applyAll(database()))).toEqual(['grants', 'storage_connections']);
	});

	/**
	 * What docs/self-hosting.md, "A database from 0.1.0", rests on. Wrangler
	 * knows a migration by its name, and runs each in a transaction of its own,
	 * stopping at the first that fails. The kit's first has 0.1.0's one name
	 * (above), so wrangler takes it for applied on such a database.
	 */
	describe('over a database 0.1.0 made', () => {
		it('fail at the kit’s second, so a database migrated as it is goes no further and keeps what it held', () => {
			const db = fromOld();
			expect(() => {
				apply(db, join(FOLDER, APPLIED[1] ?? ''));
			}).toThrow(/no such table: (main\.)?connections/u);
			expect(db.prepare('SELECT count(*) AS n FROM grants').get()).toEqual({ n: 1 });
		});

		it('apply whole after the reset self-hosting.md gives, making what they make of an empty database', () => {
			expect(RESET).toMatch(/DROP TABLE/u);
			const db = fromOld();
			db.exec(RESET);
			expect(tablesOf(db)).toEqual([]);
			applyAll(db);
			expect(schemaOf(db)).toEqual(schemaOf(applyAll(database())));
			expect(db.prepare('SELECT count(*) AS n FROM storage_connections').get()).toEqual({
				n: 0,
			});
		});

		it('take the reset twice, for an operator unsure the first went through', () => {
			const db = fromOld();
			db.exec(RESET);
			expect(() => {
				db.exec(RESET);
			}).not.toThrow();
		});
	});
});
