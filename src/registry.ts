/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import fs = require('fs');
import path = require('path');
import {createGrammar, extractIncludedScopes, IGrammarRepository, IGrammar} from './grammar';
import {IRawGrammar} from './types';
import {parse} from './plistParser';

export class SyncRegistry implements IGrammarRepository {

	private _grammars: {[scopeName:string]:IGrammar;};
	private _rawGrammars: {[scopeName:string]:IRawGrammar;};

	constructor() {
		this._grammars = {};
		this._rawGrammars = {};
	}

	/**
	 * Add `grammar` to registry and return a list of referenced scope names
	 */
	public addGrammar(grammar:IRawGrammar): string[] {
		this._rawGrammars[grammar.scopeName] = grammar;
		return extractIncludedScopes(grammar);
	}

	/**
	 * Lookup a raw grammar.
	 */
	public lookup(scopeName:string): IRawGrammar {
		return this._rawGrammars[scopeName];
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
