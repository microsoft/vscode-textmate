/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import fs = require('fs');
import path = require('path');
import {createGrammar, collectIncludedScopes, IGrammarRepository, IGrammar, IScopeNameSet} from './grammar';
import {IRawGrammar} from './types';

export class SyncRegistry implements IGrammarRepository {

	private _grammars: {[scopeName:string]:IGrammar;};
	private _rawGrammars: {[scopeName:string]:IRawGrammar;};
	private _injectionGrammars: {[scopeName:string]:string[];};

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
