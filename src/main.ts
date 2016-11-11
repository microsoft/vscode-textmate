/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import { SyncRegistry } from './registry';
import { readGrammarSync } from './grammarReader';
import { Theme } from './theme';

let DEFAULT_OPTIONS: RegistryOptions = {
	getFilePath: (scopeName: string) => null,
	getInjections: (scopeName: string) => null
};

/**
 * A single theme setting.
 */
export interface IRawThemeSetting {
	readonly name?: string;
	readonly scope?: string | string[];
	readonly settings: {
		readonly fontStyle?: string;
		readonly foreground?: string;
		readonly background?: string;
	};
}

/**
 * A TextMate theme.
 */
export interface IRawTheme {
	readonly name?: string;
	readonly settings: IRawThemeSetting[];
}

/**
 * A registry helper that can locate grammar file paths given scope names.
 */
export interface RegistryOptions {
	theme?: IRawTheme;
	getFilePath(scopeName: string): string;
	getInjections?(scopeName: string): string[];
}

/**
 * A map from scope name to a language id. Please do not use language id 0.
 */
export interface IEmbeddedLanguagesMap {
	[scopeName: string]: number;
}

export const enum StandardTokenType {
	Other = 0,
	Comment = 1,
	String = 2,
	RegEx = 4
}

/**
 * The registry that will hold all grammars.
 */
export class Registry {

	private readonly _locator: RegistryOptions;
	private readonly _syncRegistry: SyncRegistry;

	constructor(locator: RegistryOptions = DEFAULT_OPTIONS) {
		this._locator = locator;
		this._syncRegistry = new SyncRegistry(Theme.createFromRawTheme(locator.theme));
	}

	/**
	 * Change the theme. Once called, no previous `ruleStack` should be used anymore.
	 */
	public setTheme(theme: IRawTheme): void {
		this._syncRegistry.setTheme(Theme.createFromRawTheme(theme));
	}

	/**
	 * Load the grammar for `scopeName` and all referenced included grammars asynchronously.
	 * Please do not use language id 0.
	 */
	public loadGrammarWithEmbeddedLanguages(initialScopeName: string, initialLanguage: number, embeddedLanguages: IEmbeddedLanguagesMap, callback: (err: any, grammar: IGrammar) => void): void {
		this._loadGrammar(initialScopeName, (err) => {
			if (err) {
				callback(err, null);
				return;
			}

			callback(null, this.grammarForScopeName(initialScopeName, initialLanguage, embeddedLanguages));
		});
	}

	/**
	 * Load the grammar for `scopeName` and all referenced included grammars asynchronously.
	 */
	public loadGrammar(initialScopeName: string, callback: (err: any, grammar: IGrammar) => void): void {
		this._loadGrammar(initialScopeName, (err) => {
			if (err) {
				callback(err, null);
				return;
			}

			callback(null, this.grammarForScopeName(initialScopeName));
		});
	}

	private _loadGrammar(initialScopeName: string, callback: (err: any) => void): void {

		let remainingScopeNames = [initialScopeName];

		let seenScopeNames: { [name: string]: boolean; } = {};
		seenScopeNames[initialScopeName] = true;

		while (remainingScopeNames.length > 0) {
			let scopeName = remainingScopeNames.shift();

			if (this._syncRegistry.lookup(scopeName)) {
				continue;
			}

			let filePath = this._locator.getFilePath(scopeName);
			if (!filePath) {
				if (scopeName === initialScopeName) {
					callback(new Error('Unknown location for grammar <' + initialScopeName + '>'));
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
			} catch (err) {
				if (scopeName === initialScopeName) {
					callback(new Error('Unknown location for grammar <' + initialScopeName + '>'));
					return;
				}
			}
		}

		callback(null);
	}

	/**
	 * Load the grammar at `path` synchronously.
	 */
	public loadGrammarFromPathSync(path: string, initialLanguage: number = 0, embeddedLanguages: IEmbeddedLanguagesMap = null): IGrammar {
		let rawGrammar = readGrammarSync(path);
		let injections = this._locator.getInjections(rawGrammar.scopeName);
		this._syncRegistry.addGrammar(rawGrammar, injections);
		return this.grammarForScopeName(rawGrammar.scopeName, initialLanguage, embeddedLanguages);
	}

	/**
	 * Get the grammar for `scopeName`. The grammar must first be created via `loadGrammar` or `loadGrammarFromPathSync`.
	 */
	public grammarForScopeName(scopeName: string, initialLanguage: number = 0, embeddedLanguages: IEmbeddedLanguagesMap = null): IGrammar {
		return this._syncRegistry.grammarForScopeName(scopeName, initialLanguage, embeddedLanguages);
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

	equals(other: StackElement): boolean;
}
