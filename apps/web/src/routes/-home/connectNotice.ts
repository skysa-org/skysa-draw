import type { ConnectGate, EntitlementCode } from '@skysa/draw-core';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../api/client.js';
import { answer, useInstanceConfig } from '../../api/instanceConfig.js';
import type { ConnectNoticeShown } from '../../components/shell/ConnectNotice.js';
import { t } from '../../i18n/t.js';
import {
	connectCodeAskedAt,
	dropConnectCode,
	heldConnectCode,
	heldConnectCodeShown,
	holdAcceptedCode,
} from '../../store/connectCode.js';

/**
 * What the app says on the way back from connecting storage (`?connect=…`),
 * and asking again for a connect code the operator's gate turned down. The
 * server sends the browser back to where it was with the outcome in the query
 * (`back` in `apps/api/src/routes/connect.ts`): `?connect=ok`, or a reason,
 * and `&code=` for the kind of no an operator's policy gave.
 */

export const CONNECT_OUTCOMES = [
	'ok',
	'denied',
	'failed',
	'partial',
	'refused',
	'expired',
] as const;

type ConnectOutcome = (typeof CONNECT_OUTCOMES)[number];

/**
 * A refused connect, by the kind of no the operator's policy gave. The account
 * panel says the same reasons in its own sentences (`refusalMessage` in
 * `components/account/statusWords.ts`); here each is a whole one about the
 * connect.
 */
const refusedText = (code: EntitlementCode | undefined): string => {
	switch (code) {
		case 'not_allowed':
			return t('connect.outcome.refused.notAllowed');
		case 'lapsed':
			return t('connect.outcome.refused.lapsed');
		case 'limit_reached':
			return t('connect.outcome.refused.limitReached');
		case undefined:
			return t('connect.outcome.refused.cannotSync');
	}
};

/**
 * What to tell the user on the way back from connecting a storage account.
 * `codeRefused` is a plain no to a connect that carried the gate's code
 * (`codeWasRefused`), which is said to be about the code.
 */
const connectMessage = (
	outcome: ConnectOutcome,
	code: EntitlementCode | undefined,
	gate: ConnectGate | undefined,
	codeRefused: boolean
): ConnectNoticeShown => {
	switch (outcome) {
		case 'ok':
			return { message: t('connect.outcome.ok'), tone: 'success' };
		// The user's own choice, and nothing is broken — but nothing is
		// connected either, which is not what they will assume from a screen
		// that looks the same as before they started.
		case 'denied':
			return { message: t('connect.outcome.denied'), tone: 'warning' };
		case 'failed':
			return { message: t('connect.outcome.failed'), tone: 'error' };
		// A warning rather than an error: this one worked exactly as it was
		// asked to, and what to do about it is a checkbox away.
		case 'partial':
			return { message: t('connect.outcome.partial'), tone: 'warning' };
		// Trying again will not help: this server will not have the account.
		// What might is whatever its operator offers instead, when they do.
		case 'refused':
			return {
				message: codeRefused ? t('connect.outcome.refused.code') : refusedText(code),
				tone: 'error',
				...(gate === undefined ? {} : { action: gate.action }),
			};
		// The browser came back from the provider with no flow of its own for the
		// server to finish: one that took too long, or a callback opened again
		// long after it was answered. Whether anything was connected by then is
		// not known here, and the sources already say, so it is not guessed.
		case 'expired':
			return { message: t('connect.outcome.expired'), tone: 'warning' };
	}
};

/**
 * Whether a refusal is the operator's policy turning down the code typed into
 * its gate (`ConnectGate.connectCode`): a plain no — `not_allowed`, or no code
 * at all — to a connect made while this tab held one. The code is what the
 * person offered, and what they can put right. A `lapsed` or a `limit_reached`
 * is about the account or the instance, whatever was typed, and is said as it
 * is.
 *
 * Not a value the policy gave to hold in a code's place: nothing was typed
 * this time, and a pass that cost an email to get is not thrown away on a no
 * that may be about the account. The policy is asked about it instead
 * (`useCodeAskedAgain`), and lets it go if it no longer takes it.
 */
const codeWasRefused = (
	connect: ConnectOutcome | undefined,
	code: EntitlementCode | undefined
): boolean =>
	connect === 'refused' &&
	(code === undefined || code === 'not_allowed') &&
	heldConnectCode() !== undefined &&
	heldConnectCodeShown();

/** How long the policy's word on a held value stands before the app asks again as it loads. */
const ASK_AGAIN_MS = 60 * 60_000;

/**
 * What the operator's policy gave to hold in place of the gate's code,
 * asked about again once as the app loads, where the instance's gate asks for
 * a code: at most once an hour since the policy last answered, and at once
 * after a refused connect.
 *
 * A typed code is not asked about again: it is good for as long as the policy
 * said when it took it, minutes as a rule. Each asking costs one of the
 * guesses the instance allows an address, which the people behind one
 * carrier's or one office's address share, and someone typing a fresh code
 * must not find them spent by the others opening the app.
 *
 * One the policy no longer takes is let go of here, and the gate asks for a
 * code again before any consent screen rather than after one. Not asked, or
 * not answered, it is kept: the callback still decides. An answer about a
 * value no longer held, because a new code was typed meanwhile, changes
 * nothing.
 */
export const useCodeAskedAgain = (connect: ConnectOutcome | undefined) => {
	const config = useInstanceConfig(api);
	const asksForCode = answer(config)?.connectGate?.connectCode !== undefined;
	const asked = useRef(false);
	const [refused] = useState(connect === 'refused');
	useEffect(() => {
		if (!asksForCode || asked.current) return;
		asked.current = true;
		const held = heldConnectCode();
		if (held === undefined || heldConnectCodeShown()) return;
		if (!refused && Date.now() - (connectCodeAskedAt() ?? 0) < ASK_AGAIN_MS) return;
		void api.checkConnectCode(held).then(
			(result) => {
				if (!result.ok || heldConnectCode() !== held) return;
				if (result.value.accepted) holdAcceptedCode(held, result.value);
				else dropConnectCode();
			},
			() => {
				// A limit reached or no answer at all: kept, as it was.
			}
		);
	}, [asksForCode, refused]);
};

/**
 * The notice for how a connect went, read once as the app opens on the way
 * back from the provider and taken out of the URL straight away: left there,
 * a reload or a bookmark would say "connected" again about a connection that
 * may since have gone.
 *
 * A refusal waits for the instance's config, answered or not: its link is
 * part of the message, and an alert that grows a link a moment after it
 * appears is an alert a screen reader reads twice. Never for long — the
 * server has only just sent the browser here.
 */
export const useConnectNotice = (
	connect: ConnectOutcome | undefined,
	code: EntitlementCode | undefined
) => {
	const navigate = useNavigate({ from: '/' });
	const [outcome, setOutcome] = useState(connect);
	const [refusedAs] = useState(code);
	const [codeRefused] = useState(() => codeWasRefused(connect, code));
	// So the field is empty for the next code, rather than offering again the one
	// just turned down.
	useEffect(() => {
		if (codeRefused) dropConnectCode();
	}, [codeRefused]);
	// The operator's gate, whose action is the one thing a refusal can offer to
	// do. The same request the connect buttons make (`useInstanceConfig`).
	const config = useInstanceConfig(api);
	const gate = answer(config)?.connectGate;
	useEffect(() => {
		if (connect === undefined && code === undefined) return;
		void navigate({
			search: ({ connect: _outcome, code: _code, ...rest }) => rest,
			replace: true,
		});
	}, [connect, code, navigate]);

	const dismissConnect = useCallback(() => {
		setOutcome(undefined);
	}, []);
	const waiting = outcome === 'refused' && config.kind === 'asking';
	const connectNotice =
		outcome === undefined || waiting
			? undefined
			: connectMessage(outcome, refusedAs, gate, codeRefused);
	return { connectNotice, dismissConnect };
};

/**
 * The code field asked for by the app's URL (`?enter=code`), which is where
 * the operator's page sends the user back to with a code to type: counted, so
 * each ask opens the `+` at the field once (`useAdding`), and taken out of
 * the URL at once, so a reload does not open it again.
 */
export const useEnterCode = (enter: 'code' | undefined): number => {
	const navigate = useNavigate({ from: '/' });
	const [asked, setAsked] = useState(0);
	// Counted in render, as React has state follow a prop: the URL arriving
	// with it is the change, and the effect below takes it out again.
	const [seen, setSeen] = useState<'code' | undefined>(undefined);
	if (enter !== seen) {
		setSeen(enter);
		if (enter !== undefined) setAsked(asked + 1);
	}
	useEffect(() => {
		if (enter === undefined) return;
		void navigate({ search: ({ enter: _enter, ...rest }) => rest, replace: true });
	}, [enter, navigate]);
	return asked;
};
