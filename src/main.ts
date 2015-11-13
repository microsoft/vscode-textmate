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

	constructor(locator:IGrammarLocator = DEFAULT_LOCATOR) {
		this._locator = locator;
		this._syncRegistry = new SyncRegistry();
	}

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

				let deps = this._syncRegistry.addGrammar(grammar);
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

	public loadGrammarFromPathSync(path:string): IGrammar {
		let rawGrammar = readGrammarSync(path);
		this._syncRegistry.addGrammar(rawGrammar);
		return this.grammarForScopeName(rawGrammar.scopeName);
	}

	public grammarForScopeName(scopeName:string): IGrammar {
		return this._syncRegistry.grammarForScopeName(scopeName);
	}
}
