/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { BalancedBracketSelectors, createGrammar, Grammar, IGrammarRepository } from './grammar';
import { IRawGrammar } from './rawGrammar';
import { IGrammar, IEmbeddedLanguagesMap, ITokenTypeMap } from './main';
import { Theme, ThemeTrieElementRule } from './theme';
import { IOnigLib } from './onigLib';

export class SyncRegistry implements IGrammarRepository {

	private readonly _grammars: { [scopeName: string]: Grammar; };
	private readonly _rawGrammars: { [scopeName: string]: IRawGrammar; };
	private readonly _injectionGrammars: { [scopeName: string]: string[]; };
	private _theme: Theme;
	private readonly _onigLibPromise: Promise<IOnigLib>;

	constructor(theme: Theme, onigLibPromise: Promise<IOnigLib>) {
		this._theme = theme;
		this._grammars = {};
		this._rawGrammars = {};
		this._injectionGrammars = {};
		this._onigLibPromise = onigLibPromise;
	}

	public dispose(): void {
		for (const scopeName in this._grammars) {
			if (this._grammars.hasOwnProperty(scopeName)) {
				this._grammars[scopeName].dispose();
			}
		}
	}

	public setTheme(theme: Theme): void {
		this._theme = theme;
		Object.keys(this._grammars).forEach((scopeName) => {
			let grammar = this._grammars[scopeName];
			grammar.onDidChangeTheme();
		});
	}

	public getColorMap(): string[] {
		return this._theme.getColorMap();
	}

	/**
	 * Add `grammar` to registry and return a list of referenced scope names
	 */
	public addGrammar(grammar: IRawGrammar, injectionScopeNames?: string[]): void {
		this._rawGrammars[grammar.scopeName] = grammar;

		if (injectionScopeNames) {
			this._injectionGrammars[grammar.scopeName] = injectionScopeNames;
		}
	}

	/**
	 * Lookup a raw grammar.
	 */
	public lookup(scopeName: string): IRawGrammar | undefined {
		return this._rawGrammars[scopeName];
	}

	/**
	 * Returns the injections for the given grammar
	 */
	public injections(targetScope: string): string[] {
		return this._injectionGrammars[targetScope];
	}

	/**
	 * Get the default theme settings
	 */
	public getDefaults(): ThemeTrieElementRule {
		return this._theme.getDefaults();
	}

	/**
	 * Match a scope in the theme.
	 */
	public themeMatch(scopeName: string): ThemeTrieElementRule[] {
		return this._theme.match(scopeName);
	}

	/**
	 * Lookup a grammar.
	 */
	public async grammarForScopeName(scopeName: string, initialLanguage: number, embeddedLanguages: IEmbeddedLanguagesMap | null, tokenTypes: ITokenTypeMap | null, balancedBracketSelectors: BalancedBracketSelectors | null): Promise<IGrammar | null> {
		if (!this._grammars[scopeName]) {
			let rawGrammar = this._rawGrammars[scopeName];
			if (!rawGrammar) {
				return null;
			}
			this._grammars[scopeName] = createGrammar(scopeName, rawGrammar, initialLanguage, embeddedLanguages, tokenTypes, balancedBracketSelectors, this, await this._onigLibPromise);
		}
		return this._grammars[scopeName];
	}
}
