/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Github Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import type { ParsedMatcher, GroupPrefix } from './matchers';

import ScopeSelectorParser = require('./matcherParser');

const selectorCache: Record<string, any> = {};

export class ScopeSelector {
	private _matchCache: Record<string, boolean | void> = {};
	private _prefixCache: Record<string, GroupPrefix | null | void> = {};
	private matcher: ParsedMatcher;

	/**
	 *  Create a new scope selector.
	 *  @param {string} source The string to parse as a scope selector.
	 *  @return A newly constructed ScopeSelector.
	 */
	constructor(source: string) {
		if (selectorCache[source]) {
			this.matcher = selectorCache[source];
		} else {
			this.matcher = ScopeSelectorParser.parse(source);
			selectorCache[source] = this.matcher;
		}
	}

	/**
	 *  Check if this scope selector matches the scopes.
	 *  @param {string|string[]} scopes A single scope or an array of them to be compared against.
	 *  @return {boolean} Whether or not this ScopeSelector matched.
	 */
	matches(scopes: string | string[]): boolean {
		if (typeof scopes === 'string') {
			scopes = [scopes];
		}
		const target = scopes.join(' ');
		const entry = this._matchCache[target];

		if (typeof entry !== 'undefined') {
			return entry;
		} else {
			const result = this.matcher.matches(scopes);
			this._matchCache[target] = result;
			return result;
		}
	}

	/**
	 *  Gets the prefix of this scope selector.
	 *  @param {string|string[]} scopes The scopes to match a prefix against.
	 *  @return {string|undefined} The matching prefix, if there is one.
	 */
	getPrefix(scopes: string | string[]): GroupPrefix | void {
		if (typeof scopes === 'string') {
			scopes = [scopes];
		}
		const target = scopes.join(' ');
		const entry = this._prefixCache[target];

		if (typeof entry !== 'undefined') {
			return entry === null ? undefined : entry;
		} else {
			const result = this.matcher.getPrefix(scopes) || null;
			this._prefixCache[target] = result;
			return result === null ? undefined : result;
		}
	}

	/**
	 *  Gets the priority of this scope selector.
	 *  @param {string|string[]} scopes The scopes to match a priority against.
	 *  @return {string|undefined} The matching priority, if there is one.
	 */
	getPriority(scopes: string | string[]): number {
		switch (this.getPrefix(scopes)) {
			case 'L': // left - before non-prefixed rules
				return 1;
			case 'R': // right - after non-prefixed rules
				return -1;
			default:
				return 0;
		}
	}
};
