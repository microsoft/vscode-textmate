/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

export interface IRawThemeSetting {
	readonly name?: string;
	readonly scope?: string | string[];
	readonly settings: {
		readonly fontStyle?: string;
		readonly foreground?: string;
		readonly background?: string;
	};
}
export interface IRawTheme {
	readonly name?: string;
	readonly settings: IRawThemeSetting[];
}

export const enum FontStyle {
	NotSet = -1,
	None = 0,
	Italic = 1,
	Bold = 2,
	Underline = 4
}

export class ParsedThemeRule {
	_parsedThemeRuleBrand: void;

	readonly scope: string;
	readonly parentScopes: string[];
	readonly index: number;

	/**
	 * -1 if not set. An or mask of `FontStyle` otherwise.
	 */
	readonly fontStyle: number;
	readonly foreground: string;
	readonly background: string;

	constructor(
		scope: string,
		parentScopes: string[],
		index: number,
		fontStyle: number,
		foreground: string,
		background: string,
	) {
		this.scope = scope;
		this.parentScopes = parentScopes;
		this.index = index;
		this.fontStyle = fontStyle;
		this.foreground = foreground;
		this.background = background;
	}
}

/**
 * Parse a raw theme into rules.
 */
export function parseTheme(source: IRawTheme): ParsedThemeRule[] {
	if (!source) {
		return [];
	}
	if (!source.settings || !Array.isArray(source.settings)) {
		return [];
	}
	let settings = source.settings;
	let result: ParsedThemeRule[] = [], resultLen = 0;
	for (let i = 0, len = settings.length; i < len; i++) {
		let entry = settings[i];

		if (!entry.settings) {
			continue;
		}

		let scopes: string[];
		if (typeof entry.scope === 'string') {
			scopes = entry.scope.split(',');
		} else if (Array.isArray(entry.scope)) {
			scopes = entry.scope;
		} else {
			scopes = [''];
		}

		let fontStyle: number = FontStyle.NotSet;
		if (typeof entry.settings.fontStyle === 'string') {
			fontStyle = FontStyle.None;

			let segments = entry.settings.fontStyle.split(' ');
			for (let j = 0, lenJ = segments.length; j < lenJ; j++) {
				let segment = segments[j];
				switch (segment) {
					case 'italic':
						fontStyle = fontStyle | FontStyle.Italic;
						break;
					case 'bold':
						fontStyle = fontStyle | FontStyle.Bold;
						break;
					case 'underline':
						fontStyle = fontStyle | FontStyle.Underline;
						break;
				}
			}
		}

		let foreground: string = null;
		if (typeof entry.settings.foreground === 'string') {
			foreground = entry.settings.foreground;
		}

		let background: string = null;
		if (typeof entry.settings.background === 'string') {
			background = entry.settings.background;
		}

		for (let j = 0, lenJ = scopes.length; j < lenJ; j++) {
			let _scope = scopes[j].trim();

			let segments = _scope.split(' ');

			let scope = segments[segments.length - 1];
			let parentScopes: string[] = null;
			if (segments.length > 1) {
				parentScopes = segments.slice(0, segments.length - 1);
				parentScopes.reverse();
			}

			result[resultLen++] = new ParsedThemeRule(
				scope,
				parentScopes,
				i,
				fontStyle,
				foreground,
				background
			);
		}
	}

	return result;
}

/**
 * Resolve rules (i.e. inheritance).
 */
export function resolveParsedThemeRules(parsedThemeRules: ParsedThemeRule[]): ThemeTrieElement {

	// Sort rules lexicographically, and then by index if necessary
	parsedThemeRules.sort((a, b) => {
		let r = strcmp(a.scope, b.scope);
		if (r !== 0) {
			return r;
		}
		r = strArrCmp(a.parentScopes, b.parentScopes);
		if (r !== 0) {
			return r;
		}
		return a.index - b.index;
	});

	let defaults: ParsedThemeRule;

	if (parsedThemeRules.length >= 1 && parsedThemeRules[0].scope === '') {
		let incomingDefaults = parsedThemeRules.shift();
		let fontStyle = incomingDefaults.fontStyle;
		let foreground = incomingDefaults.foreground;
		let background = incomingDefaults.background;
		if (fontStyle === FontStyle.NotSet) {
			fontStyle = FontStyle.None;
		}
		if (foreground === null) {
			foreground = '#000000';
		}
		if (background === null) {
			background = '#ffffff';
		}
		defaults = new ParsedThemeRule('', null, incomingDefaults.index, fontStyle, foreground, background);
	} else {
		defaults = new ParsedThemeRule('', null, -1, FontStyle.None, '#000000', '#ffffff');
	}

	let root = new ThemeTrieElement(new ThemeTrieElementRule(null, defaults.fontStyle, defaults.foreground, defaults.background), []);
	for (let i = 0, len = parsedThemeRules.length; i < len; i++) {
		root.insert(parsedThemeRules[i]);
	}

	return root;
}

export class Theme {

	private _root: ThemeTrieElement;
	private _cache: { [scopeName: string]: ThemeTrieElementRule[]; };

	constructor(source: IRawTheme) {
		this._root = resolveParsedThemeRules(parseTheme(source));
		this._cache = {};
	}

	public match(scopeName: string): ThemeTrieElementRule[] {
		if (!this._cache.hasOwnProperty(scopeName)) {
			this._cache[scopeName] = this._root.match(scopeName);
		}
		return this._cache[scopeName];
	}
}

export function strcmp(a: string, b: string): number {
	if (a < b) {
		return -1;
	}
	if (a > b) {
		return 1;
	}
	return 0;
}

export function strArrCmp(a: string[], b: string[]): number {
	if (a === null && b === null) {
		return 0;
	}
	if (!a) {
		return -1;
	}
	if (!b) {
		return 1;
	}
	let len1 = a.length;
	let len2 = b.length;
	if (len1 === len2) {
		for (let i = 0; i < len1; i++) {
			let res = strcmp(a[i], b[i]);
			if (res !== 0) {
				return res;
			}
		}
		return 0;
	}
	return len1 - len2;
}

export class ThemeTrieElementRule {
	_themeTrieElementRuleBrand: void;

	parentScopes: string[];
	fontStyle: number;
	foreground: string;
	background: string;

	constructor(parentScopes: string[], fontStyle: number, foreground: string, background: string) {
		this.parentScopes = parentScopes;
		this.fontStyle = fontStyle;
		this.foreground = foreground;
		this.background = background;
	}

	public clone(): ThemeTrieElementRule {
		return new ThemeTrieElementRule(this.parentScopes, this.fontStyle, this.foreground, this.background);
	}

	public acceptOverwrite(fontStyle: number, foreground: string, background: string): void {
		if (fontStyle !== FontStyle.NotSet) {
			this.fontStyle = fontStyle;
		}
		if (foreground !== null) {
			this.foreground = foreground;
		}
		if (background !== null) {
			this.background = background;
		}
	}
}

export interface ITrieChildrenMap {
	[segment: string]: ThemeTrieElement;
}

export class ThemeTrieElement {
	_themeTrieElementBrand: void;

	private readonly _mainRule: ThemeTrieElementRule;
	private readonly _rulesWithParentScopes: ThemeTrieElementRule[];
	private readonly _children: ITrieChildrenMap;

	constructor(
		mainRule: ThemeTrieElementRule,
		rulesWithParentScopes: ThemeTrieElementRule[] = [],
		children: ITrieChildrenMap = {}
	) {
		this._mainRule = mainRule;
		this._rulesWithParentScopes = rulesWithParentScopes;
		this._children = children;
	}

	public match(scope: string): ThemeTrieElementRule[] {
		if (scope === '') {
			return [].concat(this._mainRule).concat(this._rulesWithParentScopes);
		}

		let dotIndex = scope.indexOf('.');
		let head: string;
		let tail: string;
		if (dotIndex === -1) {
			head = scope;
			tail = '';
		} else {
			head = scope.substring(0, dotIndex);
			tail = scope.substring(dotIndex + 1);
		}

		if (this._children.hasOwnProperty(head)) {
			return this._children[head].match(tail);
		}

		return [].concat(this._mainRule).concat(this._rulesWithParentScopes);
	}

	public insert(rule: ParsedThemeRule): void {
		this._doInsert(rule.scope, rule.parentScopes, rule.fontStyle, rule.foreground, rule.background);
	}

	private _doInsert(scope: string, parentScopes: string[], fontStyle: number, foreground: string, background: string): void {
		if (scope === '') {
			this._doInsertHere(parentScopes, fontStyle, foreground, background);
			return;
		}

		let dotIndex = scope.indexOf('.');
		let head: string;
		let tail: string;
		if (dotIndex === -1) {
			head = scope;
			tail = '';
		} else {
			head = scope.substring(0, dotIndex);
			tail = scope.substring(dotIndex + 1);
		}

		let child: ThemeTrieElement;
		if (this._children[head]) {
			child = this._children[head];
		} else {
			child = new ThemeTrieElement(this._mainRule.clone());
			this._children[head] = child;
		}

		// TODO: In the case that this element has `parentScopes`, should we generate one insert for each parentScope ?
		child._doInsert(tail, parentScopes, fontStyle, foreground, background);
	}

	private _doInsertHere(parentScopes: string[], fontStyle: number, foreground: string, background: string): void {

		if (parentScopes === null) {
			// Merge into the main rule
			this._mainRule.acceptOverwrite(fontStyle, foreground, background);
			return;
		}

		// Try to merge into existing rule
		for (let i = 0, len = this._rulesWithParentScopes.length; i < len; i++) {
			let rule = this._rulesWithParentScopes[i];

			if (strArrCmp(rule.parentScopes, parentScopes) === 0) {
				// bingo! => we get to merge this into an existing one
				rule.acceptOverwrite(fontStyle, foreground, background);
				return;
			}
		}

		// Must add a new rule

		// Inherit from main rule
		if (fontStyle === FontStyle.NotSet) {
			fontStyle = this._mainRule.fontStyle;
		}
		if (foreground === null) {
			foreground = this._mainRule.foreground;
		}
		if (background === null) {
			background = this._mainRule.background;
		}

		this._rulesWithParentScopes.push(new ThemeTrieElementRule(parentScopes, fontStyle, foreground, background));
	}
}
