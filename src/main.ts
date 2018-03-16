/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import { SyncRegistry } from './registry';
import { readGrammarSync } from './grammarReader';
import { Theme } from './theme';
import { StackElement as StackElementImpl } from './grammar';

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

/**
 * A map from scope name to a token type.
 */
export interface ITokenTypeMap {
	[scopeName: string]: StandardTokenType;
}

export const enum StandardTokenType {
	Other = 0,
	Comment = 1,
	String = 2,
	RegEx = 4
}

export interface IGrammarConfiguration {
	embeddedLanguages?: IEmbeddedLanguagesMap;
	tokenTypes?: ITokenTypeMap;
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
	 * Returns a lookup array for color ids.
	 */
	public getColorMap(): string[] {
		return this._syncRegistry.getColorMap();
	}

	/**
	 * Load the grammar for `scopeName` and all referenced included grammars asynchronously.
	 * Please do not use language id 0.
	 */
	public loadGrammarWithEmbeddedLanguages(initialScopeName: string, initialLanguage: number, embeddedLanguages: IEmbeddedLanguagesMap, callback: (err: any, grammar: IGrammar) => void): void {
		return this.loadGrammarWithConfiguration(initialScopeName, initialLanguage, { embeddedLanguages }, callback)
	}

	/**
	 * Load the grammar for `scopeName` and all referenced included grammars asynchronously.
	 * Please do not use language id 0.
	 */
	public loadGrammarWithConfiguration(initialScopeName: string, initialLanguage: number, configuration: IGrammarConfiguration, callback: (err: any, grammar: IGrammar) => void): void {
		this._loadGrammar(initialScopeName, (err) => {
			if (err) {
				callback(err, null);
				return;
			}

			callback(null, this.grammarForScopeName(initialScopeName, initialLanguage, configuration.embeddedLanguages, configuration.tokenTypes));
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
					callback(err);
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
	public grammarForScopeName(scopeName: string, initialLanguage: number = 0, embeddedLanguages: IEmbeddedLanguagesMap = null, tokenTypes: ITokenTypeMap = null): IGrammar {
		return this._syncRegistry.grammarForScopeName(scopeName, initialLanguage, embeddedLanguages, tokenTypes);
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

	/**
	 * Tokenize `lineText` using previous line state `prevState`.
	 * The result contains the tokens in binary format, resolved with the following information:
	 *  - language
	 *  - token type (regex, string, comment, other)
	 *  - font style
	 *  - foreground color
	 *  - background color
	 * e.g. for getting the languageId: `(metadata & MetadataConsts.LANGUAGEID_MASK) >>> MetadataConsts.LANGUAGEID_OFFSET`
	 */
	tokenizeLine2(lineText: string, prevState: StackElement): ITokenizeLineResult2;
}

export interface ITokenizeLineResult {
	readonly tokens: IToken[];
	/**
	 * The `prevState` to be passed on to the next line tokenization.
	 */
	readonly ruleStack: StackElement;
}

/**
 * Helpers to manage the "collapsed" metadata of an entire StackElement stack.
 * The following assumptions have been made:
 *  - languageId < 256 => needs 8 bits
 *  - unique color count < 512 => needs 9 bits
 *
 * The binary format is:
 * - -------------------------------------------
 *     3322 2222 2222 1111 1111 1100 0000 0000
 *     1098 7654 3210 9876 5432 1098 7654 3210
 * - -------------------------------------------
 *     xxxx xxxx xxxx xxxx xxxx xxxx xxxx xxxx
 *     bbbb bbbb bfff ffff ffFF FTTT LLLL LLLL
 * - -------------------------------------------
 *  - L = LanguageId (8 bits)
 *  - T = StandardTokenType (3 bits)
 *  - F = FontStyle (3 bits)
 *  - f = foreground color (9 bits)
 *  - b = background color (9 bits)
 */
export const enum MetadataConsts {
	LANGUAGEID_MASK = 0b00000000000000000000000011111111,
	TOKEN_TYPE_MASK = 0b00000000000000000000011100000000,
	FONT_STYLE_MASK = 0b00000000000000000011100000000000,
	FOREGROUND_MASK = 0b00000000011111111100000000000000,
	BACKGROUND_MASK = 0b11111111100000000000000000000000,

	LANGUAGEID_OFFSET = 0,
	TOKEN_TYPE_OFFSET = 8,
	FONT_STYLE_OFFSET = 11,
	FOREGROUND_OFFSET = 14,
	BACKGROUND_OFFSET = 23
}

export interface ITokenizeLineResult2 {
	/**
	 * The tokens in binary format. Each token occupies two array indices. For token i:
	 *  - at offset 2*i => startIndex
	 *  - at offset 2*i + 1 => metadata
	 *
	 */
	readonly tokens: Uint32Array;
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

	clone(): StackElement;
	equals(other: StackElement): boolean;
}

export const INITIAL: StackElement = StackElementImpl.NULL;
