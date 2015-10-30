/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import {SyncRegistry as SyncRegistry} from './registry';
import {IGrammar} from './grammar';
import {readGrammar, readGrammarSync} from './grammarReader';
import {IRawGrammar} from './types';
import * as expressionMatcher from './matcher';
export import createMatcher = expressionMatcher.createMatcher;

export interface IGrammarLocator {
	getFilePath(scopeName:string): string;
}

export interface IGrammarInfo {
	fileTypes: string[];
	name: string;
	scopeName: string;
	firstLineMatch: string;
}

interface IBarrier {
	(): void;
}

let DEFAULT_LOCATOR:IGrammarLocator = {
	getFilePath: (scopeName:string) => null
};

export class Registry {

	private static _extractInfo(rawGrammar:IRawGrammar): IGrammarInfo {
		return {
			fileTypes: rawGrammar.fileTypes,
			name: rawGrammar.name,
			scopeName: rawGrammar.scopeName,
			firstLineMatch: rawGrammar.firstLineMatch
		};
	}

	public static readGrammarInfo(path:string, callback:(err:any, grammarInfo:IGrammarInfo)=>void): void {
		readGrammar(path, (err, grammar) => {
			if (err) {
				callback(err, null);
				return;
			}
			callback(null, this._extractInfo(grammar));
		});
	}

	public static readGrammarInfoSync(path:string): IGrammarInfo {
		return this._extractInfo(readGrammarSync(path));
	}

	private _locator: IGrammarLocator;
	private _syncRegistry: SyncRegistry;

	private _loadingGrammars: { [scopeName:string]: IBarrier[]; };
	private _erroredGrammars: { [scopeName:string]: any; };

	constructor(locator:IGrammarLocator = DEFAULT_LOCATOR) {
		this._locator = locator;
		this._syncRegistry = new SyncRegistry();
		this._loadingGrammars = {};
		this._erroredGrammars = {};
	}

	public loadGrammar(scopeName:string, callback:(err:any, grammar:IGrammar)=>void): void {
		this._cachedLoadGrammar(scopeName, () => {
			if (this._erroredGrammars[scopeName]) {
				callback(this._erroredGrammars[scopeName], null);
				return;
			}

			callback(null, this.grammarForScopeName(scopeName));
		});
	}

	public loadGrammarFromPathSync(path:string): IGrammar {
		let rawGrammar = readGrammarSync(path);
		this._syncRegistry.addGrammar(rawGrammar);
		return this.grammarForScopeName(rawGrammar.scopeName);
	}

	public grammarForScopeName(scopeName:string): IGrammar {
		return this._syncRegistry.grammarForScopeName(scopeName);
	}

	private _cachedLoadGrammar(scopeName:string, callback:IBarrier): void {
		// Check if grammar is currently loading
		if (this._loadingGrammars[scopeName]) {
			this._loadingGrammars[scopeName].push(callback);
			return;
		}

		// Check if grammar has been attempted before but has failed
		if (this._erroredGrammars[scopeName]) {
			callback();
			return;
		}

		// Check if grammar is already loaded
		let grammar = this._syncRegistry.lookup(scopeName);
		if (grammar) {
			callback();
			return;
		}

		// Ok, this is the first mention of this grammar
		this._loadGrammar(scopeName, callback);
	}

	private _loadGrammar(scopeName:string, callback:IBarrier): void {
		this._loadingGrammars[scopeName] = [callback];

		let filePath = this._locator.getFilePath(scopeName);
		if (!filePath) {
			this._onLoadedGrammar(scopeName, new Error('Unknown location for grammar <' + scopeName + '>'), null);
			return;
		}

		readGrammar(filePath, (err, grammar) => {
			if (err) {
				this._onLoadedGrammar(scopeName, err, null);
				return;
			}
			if (scopeName !== grammar.scopeName) {
				this._onLoadedGrammar(scopeName, new Error('Expected grammar at location ' + filePath + ' to define scope ' + scopeName + ', but instead discovered scope ' + grammar.scopeName), null);
				return;
			}

			this._onLoadedGrammar(scopeName, null, grammar);
		});
	}

	private _onLoadedGrammar(scopeName:string, err:any, grammar:IRawGrammar): void {
		if (err) {
			this._erroredGrammars[scopeName] = err;
			this._releaseBarrier(scopeName);
			return;
		}

		let referencedScopes = this._syncRegistry.addGrammar(grammar);

		let remainingDeps = referencedScopes.length + 1;

		let onDepResolved = () => {
			remainingDeps--;
			if (remainingDeps === 0) {
				this._releaseBarrier(scopeName);
			}
		};

		for (let i = 0; i < referencedScopes.length; i++) {
			this._cachedLoadGrammar(referencedScopes[i], onDepResolved);
		}

		onDepResolved();
	}

	private _releaseBarrier(scopeName:string): void {
		let waitingParties = this._loadingGrammars[scopeName];
		delete this._loadingGrammars[scopeName];

		for (let i = 0; i < waitingParties.length; i++) {
			process.nextTick(waitingParties[i]);
		}
	}
}
