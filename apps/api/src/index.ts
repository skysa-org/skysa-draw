/**
 * What a Worker entry builds on (docs/self-hosting.md), the stock one in
 * `worker.ts` included: the server is the kit's (`@skysa/server`), and these
 * are the names this package has offered for it, so a deployment's own entry
 * written against them builds unchanged. `misconfigured`, the answer while the
 * config is wrong, is new with the kit; an entry copied from 0.1.0's has its
 * own, which still works.
 */

export {
	type App,
	type AppConfig,
	type AppEnv,
	type AuthedEnv,
	type Bindings,
	createApp,
	type CreateAppOptions,
	envWarnings,
	misconfigured,
	parseEnv,
	type Variables,
} from '@skysa/server';
