/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import {SyncRegistry as SyncRegistry} from './registry';
import {readGrammarSync} from './grammarReader';

let DEFAULT_LOCATOR:IGrammarLocator = {
	getFilePath: (scopeName:string) => null,
	getInjections: (scopeName:string) => null
};

/**
 * A registry helper that can locate grammar file paths given scope names.
 */
export interface IGrammarLocator {
	getFilePath(scopeName:string): string;
	getInjections?(scopeName:string): string[];
}

/**
 * The registry that will hold all grammars.
 */
export class Registry {

	private readonly _locator: IGrammarLocator;
	private readonly _syncRegistry: SyncRegistry;

	constructor(locator:IGrammarLocator = DEFAULT_LOCATOR) {
		this._locator = locator;
		this._syncRegistry = new SyncRegistry();
	}

	/**
	 * Load the grammar for `scopeName` and all referenced included grammars asynchronously.
	 */
	public loadGrammar(initialScopeName:string, callback:(err:any, grammar:IGrammar)=>void): void {

		let remainingScopeNames = [ initialScopeName ];

		let seenScopeNames : {[name:string]: boolean;} = {};
		seenScopeNames[initialScopeName] = true;

		while (remainingScopeNames.length > 0) {
			let scopeName = remainingScopeNames.shift();

			if (this._syncRegistry.lookup(scopeName)) {
				continue;
			}

			let filePath = this._locator.getFilePath(scopeName);
			if (!filePath) {
				if (scopeName === initialScopeName) {
					callback(new Error('Unknown location for grammar <' + initialScopeName + '>'), null);
					return;
				}
				continue;
			}

			try {
				let grammar = readGrammarSync(filePath);
				let injections = (typeof this._locator.getInjections === 'function') && this._locator.getInjections(scopeName);

				let deps = this._syncRegistry.addGrammar(grammar, injections);
				deps.forEach((dep) => {
					if (!seenScopeNames[dep]) {
						seenScopeNames[dep] = true;
						remainingScopeNames.push(dep);
					}
				});
			} catch(err) {
				if (scopeName === initialScopeName) {
					callback(new Error('Unknown location for grammar <' + initialScopeName + '>'), null);
					return;
				}
			}
		}

		callback(null, this.grammarForScopeName(initialScopeName));
	}

	/**
	 * Load the grammar at `path` synchronously.
	 */
	public loadGrammarFromPathSync(path:string): IGrammar {
		let rawGrammar = readGrammarSync(path);
		let injections = this._locator.getInjections(rawGrammar.scopeName);
		this._syncRegistry.addGrammar(rawGrammar, injections);
		return this.grammarForScopeName(rawGrammar.scopeName);
	}

	/**
	 * Get the grammar for `scopeName`. The grammar must first be created via `loadGrammar` or `loadGrammarFromPathSync`.
	 */
	public grammarForScopeName(scopeName:string): IGrammar {
		return this._syncRegistry.grammarForScopeName(scopeName);
	}
}

/**
 * A grammar
 */
export interface IGrammar {
	/**
	 * Tokenize `lineText` using previous line state `prevState`.
	 */
	tokenizeLine(lineText: string, prevState: StackElement): ITokenizeLineResult;
}

export interface ITokenizeLineResult {
	readonly tokens: IToken[];
	/**
	 * The `prevState` to be passed on to the next line tokenization.
	 */
	readonly ruleStack: StackElement;
}

export interface IToken {
	startIndex: number;
	readonly endIndex: number;
	readonly scopes: string[];
}

/**
 * **IMPORTANT** - Immutable!
 */
export interface StackElement {
	_stackElementBrand: void;
	readonly depth: number;

	equals(other:StackElement): boolean;
}
