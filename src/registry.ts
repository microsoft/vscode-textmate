/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import {createGrammar, collectIncludedScopes, IGrammarRepository, IScopeNameSet} from './grammar';
import {IRawGrammar} from './types';
import {IGrammar} from './main';

export class SyncRegistry implements IGrammarRepository {

	private readonly _grammars: {[scopeName:string]:IGrammar;};
	private readonly _rawGrammars: {[scopeName:string]:IRawGrammar;};
	private readonly _injectionGrammars: {[scopeName:string]:string[];};

	constructor() {
		this._grammars = {};
		this._rawGrammars = {};
		this._injectionGrammars = {};
	}

	/**
	 * Add `grammar` to registry and return a list of referenced scope names
	 */
	public addGrammar(grammar:IRawGrammar, injectionScopeNames?: string[]): string[] {
		this._rawGrammars[grammar.scopeName] = grammar;

		let includedScopes: IScopeNameSet = {};
		collectIncludedScopes(includedScopes, grammar);

		if (injectionScopeNames) {
			this._injectionGrammars[grammar.scopeName] = injectionScopeNames;
			injectionScopeNames.forEach(scopeName => {
				includedScopes[scopeName] = true;
			});
		}
		return Object.keys(includedScopes);
	}

	/**
	 * Lookup a raw grammar.
	 */
	public lookup(scopeName:string): IRawGrammar {
		return this._rawGrammars[scopeName];
	}

	/**
	 * Returns the injections for the given grammar
	 */
	public injections(targetScope:string): string[] {
		return this._injectionGrammars[targetScope];
	}

	/**
	 * Lookup a grammar.
	 */
	public grammarForScopeName(scopeName:string): IGrammar {
		if (!this._grammars[scopeName]) {
			let rawGrammar = this._rawGrammars[scopeName];
			if (!rawGrammar) {
				return null;
			}

			this._grammars[scopeName] = createGrammar(rawGrammar, this);
		}
		return this._grammars[scopeName];
	}
}
