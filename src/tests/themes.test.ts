/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { Registry, IToken, IGrammar, RegistryOptions, StackElement, IRawTheme, IRawThemeSetting } from '../main';
import { createMatcher } from '../matcher';
import { parse as JSONparse } from '../json';
import { StackElementMetadata } from '../grammar';
import {
	Theme, strcmp, strArrCmp, ThemeTrieElement, ThemeTrieElementRule,
	parseTheme, ParsedThemeRule,
	FontStyle, ColorMap
} from '../theme';
import * as plist from 'fast-plist';

const THEMES_TEST_PATH = path.join(__dirname, '../../test-cases/themes');

// console.log(THEMES_TEST_PATH);

interface ILanguageRegistration {
	id: string;
	extensions: string[];
	filenames: string[];
}

interface IGrammarRegistration {
	language: string;
	scopeName: string;
	path: string;
	embeddedLanguages: { [scopeName: string]: string; };
}

interface IExpected {
	[theme: string]: IExpectedTokenization[];
}

interface IExpectedTokenization {
	content: string;
	color: string;
}

class Resolver implements RegistryOptions {
	public readonly language2id: { [languages: string]: number; };
	private _lastLanguageId: number;
	private _id2language: string[];
	private readonly _grammars: IGrammarRegistration[];
	private readonly _languages: ILanguageRegistration[];

	constructor(grammars: IGrammarRegistration[], languages: ILanguageRegistration[]) {
		this._grammars = grammars;
		this._languages = languages;

		this.language2id = Object.create(null);
		this._lastLanguageId = 0;
		this._id2language = [];

		for (let i = 0; i < this._languages.length; i++) {
			let languageId = ++this._lastLanguageId;
			this.language2id[this._languages[i].id] = languageId;
			this._id2language[languageId] = this._languages[i].id;
		}
	}

	public findLanguageByExtension(fileExtension: string): string {
		for (let i = 0; i < this._languages.length; i++) {
			let language = this._languages[i];

			if (!language.extensions) {
				continue;
			}

			for (let j = 0; j < language.extensions.length; j++) {
				let extension = language.extensions[j];

				if (extension === fileExtension) {
					return language.id;
				}
			}
		}

		return null;
	}

	public findLanguageByFilename(filename: string): string {
		for (let i = 0; i < this._languages.length; i++) {
			let language = this._languages[i];

			if (!language.filenames) {
				continue;
			}

			for (let j = 0; j < language.filenames.length; j++) {
				let lFilename = language.filenames[j];

				if (filename === lFilename) {
					return language.id;
				}
			}
		}

		return null;
	}

	public findGrammarByLanguage(language: string): IGrammarRegistration {
		for (let i = 0; i < this._grammars.length; i++) {
			let grammar = this._grammars[i];

			if (grammar.language === language) {
				return grammar;
			}
		}

		throw new Error('Could not findGrammarByLanguage for ' + language);
	}

	public getFilePath(scopeName: string): string {
		for (let i = 0; i < this._grammars.length; i++) {
			let grammar = this._grammars[i];

			if (grammar.scopeName === scopeName) {
				return path.join(THEMES_TEST_PATH, grammar.path);
			}
		}
		console.warn('missing gramamr for ' + scopeName);
	}
}

interface IExplainedThemeScope {
	scopeName: string;
	themeMatches: IRawThemeSetting[];
}

function explainThemeScope(theme: IRawTheme, scope: string): IRawThemeSetting[] {
	let result: IRawThemeSetting[] = [], resultLen = 0;
	for (let i = 0, len = theme.settings.length; i < len; i++) {
		let setting = theme.settings[i];
		let selectors: string[];
		if (typeof setting.scope === 'string') {
			selectors = setting.scope.split(/,/).map(scope => scope.trim());
		} else if (Array.isArray(setting.scope)) {
			selectors = setting.scope;
		} else {
			continue;
		}
		for (let j = 0, lenJ = selectors.length; j < lenJ; j++) {
			let rawSelector = selectors[j];

			let selector: string;
			let lastSpaceIndex = rawSelector.lastIndexOf(' ');
			if (lastSpaceIndex >= 0) {
				selector = rawSelector.substr(lastSpaceIndex + 1);
			} else {
				selector = rawSelector;
			}
			let selectorPrefix = selector + '.';

			if (selector === scope || scope.substring(0, selectorPrefix.length) === selectorPrefix) {
				// match!
				result[resultLen++] = setting;
				// break the loop
				j = lenJ;
			}

		}
	}
	return result;
}

function explainThemeScopes(theme: IRawTheme, scopes: string[]): IExplainedThemeScope[] {
	return scopes.map(scope => {
		return {
			scopeName: scope,
			themeMatches: explainThemeScope(theme, scope)
		};
	});
}

function assertTokenization(theme: IRawTheme, colorMap: string[], fileContents: string, grammar: IGrammar, expected: IExpectedTokenization[]): void {

	interface ITokenExplanation {
		content: string;
		scopes: IExplainedThemeScope[];
	}
	interface IToken {
		content: string;
		color: string;
		explanation: ITokenExplanation[];
	}
	let lines = fileContents.split(/\r\n|\r|\n/);

	let ruleStack: StackElement = null;
	let actual: IToken[] = [], actualLen = 0;

	for (let i = 0, len = lines.length; i < len; i++) {
		let line = lines[i];
		let resultWithScopes = grammar.tokenizeLine(line, ruleStack);
		let tokensWithScopes = resultWithScopes.tokens;

		let result = grammar.tokenizeLine2(line, ruleStack);

		let tokensLength = result.tokens.length / 2;
		let tokensWithScopesIndex = 0;
		for (let j = 0; j < tokensLength; j++) {
			let startIndex = result.tokens[2 * j];
			let nextStartIndex = j + 1 < tokensLength ? result.tokens[2 * j + 2] : line.length;
			let tokenText = line.substring(startIndex, nextStartIndex);
			if (tokenText === '') {
				continue;
			}
			let metadata = result.tokens[2 * j + 1];
			let foreground = StackElementMetadata.getForeground(metadata);
			let foregroundColor = colorMap[foreground];

			let explanation: ITokenExplanation[] = [];
			let tmpTokenText = tokenText;
			while (tmpTokenText.length > 0) {
				let tokenWithScopes = tokensWithScopes[tokensWithScopesIndex];

				let tokenWithScopesText = line.substring(tokenWithScopes.startIndex, tokenWithScopes.endIndex);
				tmpTokenText = tmpTokenText.substring(tokenWithScopesText.length);
				explanation.push({
					content: tokenWithScopesText,
					scopes: explainThemeScopes(theme, tokenWithScopes.scopes)
				});

				tokensWithScopesIndex++;
			}
			actual[actualLen++] = {
				content: tokenText,
				color: foregroundColor,
				explanation: explanation
			};
		}
		ruleStack = result.ruleStack;
	}

	let fail = (reason: string) => {
		fs.writeFileSync('actual.txt', JSON.stringify(actual, null, '\t'));
		fs.writeFileSync('expected.txt', JSON.stringify(expected, null, '\t'));
		assert.fail(reason);
	};

	let i = 0, j = 0, len = actual.length, lenJ = expected.length;
	do {
		if (i >= len && j >= lenJ) {
			// ok
			break;
		}

		if (i >= len) {
			// will fail
			fail('reached end of actual before end of expected');
			break;
		}

		if (j >= lenJ) {
			// will fail
			fail('reached end of expected before end of actual');
			break;
		}

		let actualContent = actual[i].content;
		let actualColor = actual[i].color;

		while (actualContent.length > 0 && j < lenJ) {
			let expectedContent = expected[j].content;
			let expectedColor = expected[j].color;

			let contentIsInvisible = /^\s+$/.test(expectedContent);
			if (!contentIsInvisible && actualColor !== expectedColor) {
				fail(`at ${actualContent} (${i}-${j}), color mismatch: ${actualColor}, ${expectedColor}`);
				break;
			}

			if (actualContent.substr(0, expectedContent.length) !== expectedContent) {
				fail(`at ${actualContent} (${i}-${j}), content mismatch: ${actualContent}, ${expectedContent}`);
				break;
			}

			actualContent = actualContent.substr(expectedContent.length);

			j++;
		}

		i++;
	} while (true);
}

function assertThemeTokenization(themeName:string, theme: IRawTheme, resolver: Resolver): void {
	describe('Theme suite ' + themeName, () => {
		let registry = new Registry(resolver);
		registry.setTheme(theme);

		let colorMap = registry.getColorMap();

		// Discover all tests
		let testFiles = fs.readdirSync(path.join(THEMES_TEST_PATH, 'tests'));
		testFiles = testFiles.filter(testFile => !/\.result$/.test(testFile));
		testFiles.forEach((testFile) => {
			it(testFile, (done) => {
				let testFileContents = fs.readFileSync(path.join(THEMES_TEST_PATH, 'tests', testFile)).toString('utf8');
				let testFileExpected: IExpected = JSON.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'tests', testFile + '.result')).toString('utf8'));

				// Determine the language
				let testFileExtension = path.extname(testFile);

				let language = resolver.findLanguageByExtension(testFileExtension) || resolver.findLanguageByFilename(testFile);
				if (!language) {
					throw new Error('Could not determine language for ' + testFile);
				}
				let grammar = resolver.findGrammarByLanguage(language);

				let embeddedLanguages: { [scopeName: string]: number; } = Object.create(null);
				if (grammar.embeddedLanguages) {
					for (let scopeName in grammar.embeddedLanguages) {
						embeddedLanguages[scopeName] = resolver.language2id[grammar.embeddedLanguages[scopeName]];
					}
				}

				registry.loadGrammarWithEmbeddedLanguages(grammar.scopeName, resolver.language2id[language], embeddedLanguages, (err, grammar) => {
					if (err) {
						return done(err);
					}
					assertTokenization(theme, colorMap, testFileContents, grammar, testFileExpected[themeName]);
					done();
				});
			});
		});
	});
}

(function() {
	// Load all themes
	let light_vs: IRawTheme = JSON.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'light_vs.json')).toString());
	let light_plus: IRawTheme = JSON.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'light_plus.json')).toString());
	(<any>light_plus).settings = light_vs.settings.concat(light_plus.settings);
	let dark_vs: IRawTheme = JSON.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'dark_vs.json')).toString());
	let dark_plus: IRawTheme = JSON.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'dark_plus.json')).toString());
	(<any>dark_plus).settings = dark_vs.settings.concat(dark_plus.settings);
	let hc_black: IRawTheme = JSON.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'hc_black.json')).toString());

	let abyss: IRawTheme = plist.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'Abyss.tmTheme')).toString());
	let monokai: IRawTheme = plist.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'Monokai.tmTheme')).toString());

	// Load all language/grammar metadata
	let _grammars: IGrammarRegistration[] = JSON.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'grammars.json')).toString('utf8'));
	let _languages: ILanguageRegistration[] = JSON.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'languages.json')).toString('utf8'));
	let resolver = new Resolver(_grammars, _languages);

	// assertThemeTokenization('abyss', abyss, resolver);
	// assertThemeTokenization('light_vs', light_vs, resolver);
	// assertThemeTokenization('light_plus', light_plus, resolver);
	// assertThemeTokenization('dark_vs', dark_vs, resolver);
	// assertThemeTokenization('dark_plus', dark_plus, resolver);
	// assertThemeTokenization('hc_black', hc_black, resolver);
	// assertThemeTokenization('monokai', monokai, resolver);
})();

describe('Theme matching', () => {
	it('can match', () => {
		let theme = Theme.createFromRawTheme({
			settings: [
				{ settings: { foreground: '#F8F8F2', background: '#272822' } },
				{ scope: 'source, something', settings: { background: '#100000' } },
				{ scope: ['bar', 'baz'], settings: { background: '#200000' } },
				{ scope: 'source.css selector bar', settings: { fontStyle: 'bold' } },
				{ scope: 'constant', settings: { fontStyle: 'italic', foreground: '#300000' } },
				{ scope: 'constant.numeric', settings: { foreground: '#400000' } },
				{ scope: 'constant.numeric.hex', settings: { fontStyle: 'bold' } },
				{ scope: 'constant.numeric.oct', settings: { fontStyle: 'bold italic underline' } },
				{ scope: 'constant.numeric.dec', settings: { fontStyle: '', foreground: '#500000' } },
				{ scope: 'storage.object.bar', settings: { fontStyle: '', foreground: '#600000' } },
			]
		});

		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#F8F8F2');
		const _B = colorMap.getId('#272822');
		const _C = colorMap.getId('#200000');
		const _D = colorMap.getId('#300000');
		const _E = colorMap.getId('#400000');
		const _F = colorMap.getId('#500000');
		const _G = colorMap.getId('#100000');
		const _H = colorMap.getId('#600000');

		function assertMatch(scopeName: string, expected: ThemeTrieElementRule[]): void {
			let actual = theme.match(scopeName);
			assert.deepEqual(actual, expected, 'when matching <<' + scopeName + '>>');
		}

		function assertSimpleMatch(scopeName: string, fontStyle: FontStyle, foreground: number, background: number): void {
			assertMatch(scopeName, [
				new ThemeTrieElementRule(null, fontStyle, foreground, background)
			]);
		}

		function assertNoMatch(scopeName: string): void {
			assertMatch(scopeName, [
				new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET)
			]);
		}

		// matches defaults
		assertNoMatch('');
		assertNoMatch('bazz');
		assertNoMatch('asdfg');

		// matches source
		assertSimpleMatch('source', FontStyle.NotSet, _NOT_SET, _G);
		assertSimpleMatch('source.ts', FontStyle.NotSet, _NOT_SET, _G);
		assertSimpleMatch('source.tss', FontStyle.NotSet, _NOT_SET, _G);

		// matches something
		assertSimpleMatch('something', FontStyle.NotSet, _NOT_SET, _G);
		assertSimpleMatch('something.ts', FontStyle.NotSet, _NOT_SET, _G);
		assertSimpleMatch('something.tss', FontStyle.NotSet, _NOT_SET, _G);

		// matches baz
		assertSimpleMatch('baz', FontStyle.NotSet, _NOT_SET, _C);
		assertSimpleMatch('baz.ts', FontStyle.NotSet, _NOT_SET, _C);
		assertSimpleMatch('baz.tss', FontStyle.NotSet, _NOT_SET, _C);

		// matches constant
		assertSimpleMatch('constant', FontStyle.Italic, _D, _NOT_SET);
		assertSimpleMatch('constant.string', FontStyle.Italic, _D, _NOT_SET);
		assertSimpleMatch('constant.hex', FontStyle.Italic, _D, _NOT_SET);

		// matches constant.numeric
		assertSimpleMatch('constant.numeric', FontStyle.Italic, _E, _NOT_SET);
		assertSimpleMatch('constant.numeric.baz', FontStyle.Italic, _E, _NOT_SET);

		// matches constant.numeric.hex
		assertSimpleMatch('constant.numeric.hex', FontStyle.Bold, _E, _NOT_SET);
		assertSimpleMatch('constant.numeric.hex.baz', FontStyle.Bold, _E, _NOT_SET);

		// matches constant.numeric.oct
		assertSimpleMatch('constant.numeric.oct', FontStyle.Bold | FontStyle.Italic | FontStyle.Underline, _E, _NOT_SET);
		assertSimpleMatch('constant.numeric.oct.baz', FontStyle.Bold | FontStyle.Italic | FontStyle.Underline, _E, _NOT_SET);

		// matches constant.numeric.dec
		assertSimpleMatch('constant.numeric.dec', FontStyle.None, _F, _NOT_SET);
		assertSimpleMatch('constant.numeric.dec.baz', FontStyle.None, _F, _NOT_SET);

		// matches storage.object.bar
		assertSimpleMatch('storage.object.bar', FontStyle.None, _H, _NOT_SET);
		assertSimpleMatch('storage.object.bar.baz', FontStyle.None, _H, _NOT_SET);

		// does not match storage.object.bar
		assertSimpleMatch('storage.object.bart', FontStyle.NotSet, _NOT_SET, _NOT_SET);
		assertSimpleMatch('storage.object', FontStyle.NotSet, _NOT_SET, _NOT_SET);
		assertSimpleMatch('storage', FontStyle.NotSet, _NOT_SET, _NOT_SET);


		assertMatch('bar', [
			new ThemeTrieElementRule(['selector', 'source.css'], FontStyle.Bold, _NOT_SET, _C)
			new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _C),
		]);
	});
});

describe('Theme parsing', () => {

	it('can parse', () => {

		let actual = parseTheme({
			settings: [
				{ settings: { foreground: '#F8F8F2', background: '#272822' } },
				{ scope: 'source, something', settings: { background: '#100000' } },
				{ scope: ['bar', 'baz'], settings: { background: '#010000' } },
				{ scope: 'source.css selector bar', settings: { fontStyle: 'bold' } },
				{ scope: 'constant', settings: { fontStyle: 'italic', foreground: '#ff0000' } },
				{ scope: 'constant.numeric', settings: { foreground: '#00ff00' } },
				{ scope: 'constant.numeric.hex', settings: { fontStyle: 'bold' } },
				{ scope: 'constant.numeric.oct', settings: { fontStyle: 'bold italic underline' } },
				{ scope: 'constant.numeric.dec', settings: { fontStyle: '', foreground: '#0000ff' } },
			]
		});

		let expected = [
			new ParsedThemeRule('', null, 0, FontStyle.NotSet, '#F8F8F2', '#272822'),
			new ParsedThemeRule('source', null, 1, FontStyle.NotSet, null, '#100000'),
			new ParsedThemeRule('something', null, 1, FontStyle.NotSet, null, '#100000'),
			new ParsedThemeRule('bar', null, 2, FontStyle.NotSet, null, '#010000'),
			new ParsedThemeRule('baz', null, 2, FontStyle.NotSet, null, '#010000'),
			new ParsedThemeRule('bar', ['selector', 'source.css'], 3, FontStyle.Bold, null, null),
			new ParsedThemeRule('constant', null, 4, FontStyle.Italic, '#ff0000', null),
			new ParsedThemeRule('constant.numeric', null, 5, FontStyle.NotSet, '#00ff00', null),
			new ParsedThemeRule('constant.numeric.hex', null, 6, FontStyle.Bold, null, null),
			new ParsedThemeRule('constant.numeric.oct', null, 7, FontStyle.Bold | FontStyle.Italic | FontStyle.Underline, null, null),
			new ParsedThemeRule('constant.numeric.dec', null, 8, FontStyle.None, '#0000ff', null),
		];

		assert.deepEqual(actual, expected);
	});
});

describe('Theme resolving', () => {

	it('strcmp works', () => {
		let actual = ['bar', 'z', 'zu', 'a', 'ab', ''].sort(strcmp);

		let expected = ['', 'a', 'ab', 'bar', 'z', 'zu'];
		assert.deepEqual(actual, expected);
	});

	it('strArrCmp works', () => {
		function assertStrArrCmp(testCase: string, a: string[], b: string[], expected: number): void {
			assert.equal(strArrCmp(a, b), expected, testCase);

		}
		assertStrArrCmp('001', null, null, 0);
		assertStrArrCmp('002', null, [], -1);
		assertStrArrCmp('003', null, ['a'], -1);
		assertStrArrCmp('004', [], null, 1);
		assertStrArrCmp('005', ['a'], null, 1);
		assertStrArrCmp('006', [], [], 0);
		assertStrArrCmp('007', [], ['a'], -1);
		assertStrArrCmp('008', ['a'], [], 1);
		assertStrArrCmp('009', ['a'], ['a'], 0);
		assertStrArrCmp('010', ['a', 'b'], ['a'], 1);
		assertStrArrCmp('011', ['a'], ['a', 'b'], -1);
		assertStrArrCmp('012', ['a', 'b'], ['a', 'b'], 0);
		assertStrArrCmp('013', ['a', 'b'], ['a', 'c'], -1);
		assertStrArrCmp('014', ['a', 'c'], ['a', 'b'], 1);
	});

	it('always has defaults', () => {
		let actual = Theme.createFromParsedTheme([]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#000000');
		const _B = colorMap.getId('#ffffff');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.None, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET))
		);
		assert.deepEqual(actual, expected);
	});

	it('respects incoming defaults 1', () => {
		let actual = Theme.createFromParsedTheme([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, null, null)
		]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#000000');
		const _B = colorMap.getId('#ffffff');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.None, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET))
		);
		assert.deepEqual(actual, expected);
	});

	it('respects incoming defaults 2', () => {
		let actual = Theme.createFromParsedTheme([
			new ParsedThemeRule('', null, -1, FontStyle.None, null, null)
		]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#000000');
		const _B = colorMap.getId('#ffffff');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.None, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET))
		);
		assert.deepEqual(actual, expected);
	});

	it('respects incoming defaults 3', () => {
		let actual = Theme.createFromParsedTheme([
			new ParsedThemeRule('', null, -1, FontStyle.Bold, null, null)
		]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#000000');
		const _B = colorMap.getId('#ffffff');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.Bold, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET))
		);
		assert.deepEqual(actual, expected);
	});

	it('respects incoming defaults 4', () => {
		let actual = Theme.createFromParsedTheme([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#ff0000', null)
		]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#ff0000');
		const _B = colorMap.getId('#ffffff');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.None, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET))
		);
		assert.deepEqual(actual, expected);
	});

	it('respects incoming defaults 5', () => {
		let actual = Theme.createFromParsedTheme([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, null, '#ff0000')
		]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#000000');
		const _B = colorMap.getId('#ff0000');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.None, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET))
		);
		assert.deepEqual(actual, expected);
	});

	it('can merge incoming defaults', () => {
		let actual = Theme.createFromParsedTheme([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, null, '#ff0000'),
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#00ff00', null),
			new ParsedThemeRule('', null, -1, FontStyle.Bold, null, null),
		]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#00ff00');
		const _B = colorMap.getId('#ff0000');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.Bold, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET))
		);
		assert.deepEqual(actual, expected);
	});

	it('defaults are inherited', () => {
		let actual = Theme.createFromParsedTheme([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#F8F8F2', '#272822'),
			new ParsedThemeRule('var', null, -1, FontStyle.NotSet, '#ff0000', null)
		]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#F8F8F2');
		const _B = colorMap.getId('#272822');
		const _C = colorMap.getId('#ff0000');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.None, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET), [], {
				'var': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _C, _NOT_SET))
			})
		);
		assert.deepEqual(actual, expected);
	});

	it('same rules get merged', () => {
		let actual = Theme.createFromParsedTheme([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#F8F8F2', '#272822'),
			new ParsedThemeRule('var', null, 1, FontStyle.Bold, null, null),
			new ParsedThemeRule('var', null, 0, FontStyle.NotSet, '#ff0000', null),
		]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#F8F8F2');
		const _B = colorMap.getId('#272822');
		const _C = colorMap.getId('#ff0000');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.None, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET), [], {
				'var': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, _C, _NOT_SET))
			})
		);
		assert.deepEqual(actual, expected);
	});

	it('rules are inherited 1', () => {
		let actual = Theme.createFromParsedTheme([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#F8F8F2', '#272822'),
			new ParsedThemeRule('var', null, -1, FontStyle.Bold, '#ff0000', null),
			new ParsedThemeRule('var.identifier', null, -1, FontStyle.NotSet, '#00ff00', null),
		]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#F8F8F2');
		const _B = colorMap.getId('#272822');
		const _C = colorMap.getId('#ff0000');
		const _D = colorMap.getId('#00ff00');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.None, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET), [], {
				'var': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, _C, _NOT_SET), [], {
					'identifier': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, _D, _NOT_SET))
				})
			})
		);
		assert.deepEqual(actual, expected);
	});

	it('rules are inherited 2', () => {
		let actual = Theme.createFromParsedTheme([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#F8F8F2', '#272822'),
			new ParsedThemeRule('var', null, -1, FontStyle.Bold, '#ff0000', null),
			new ParsedThemeRule('var.identifier', null, -1, FontStyle.NotSet, '#00ff00', null),
			new ParsedThemeRule('constant', null, 4, FontStyle.Italic, '#100000', null),
			new ParsedThemeRule('constant.numeric', null, 5, FontStyle.NotSet, '#200000', null),
			new ParsedThemeRule('constant.numeric.hex', null, 6, FontStyle.Bold, null, null),
			new ParsedThemeRule('constant.numeric.oct', null, 7, FontStyle.Bold | FontStyle.Italic | FontStyle.Underline, null, null),
			new ParsedThemeRule('constant.numeric.dec', null, 8, FontStyle.None, '#300000', null),
		]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#F8F8F2');
		const _B = colorMap.getId('#272822');
		const _C = colorMap.getId('#100000');
		const _D = colorMap.getId('#200000');
		const _E = colorMap.getId('#300000');
		const _F = colorMap.getId('#ff0000');
		const _G = colorMap.getId('#00ff00');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.None, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET), [], {
				'var': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, _F, _NOT_SET), [], {
					'identifier': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, _G, _NOT_SET))
				}),
				'constant': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Italic, _C, _NOT_SET), [], {
					'numeric': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Italic, _D, _NOT_SET), [], {
						'hex': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, _D, _NOT_SET)),
						'oct': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold | FontStyle.Italic | FontStyle.Underline, _D, _NOT_SET)),
						'dec': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.None, _E, _NOT_SET)),
					})
				})
			})
		);
		assert.deepEqual(actual, expected);
	});

	it('rules with parent scopes', () => {
		let actual = Theme.createFromParsedTheme([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#F8F8F2', '#272822'),
			new ParsedThemeRule('var', null, -1, FontStyle.Bold, '#100000', null),
			new ParsedThemeRule('var.identifier', null, -1, FontStyle.NotSet, '#200000', null),
			new ParsedThemeRule('var', ['source.css'], 1, FontStyle.Italic, '#300000', null),
			new ParsedThemeRule('var', ['source.css'], 2, FontStyle.Underline, null, null),
		]);
		let colorMap = new ColorMap();
		const _NOT_SET = 0;
		const _A = colorMap.getId('#F8F8F2');
		const _B = colorMap.getId('#272822');
		const _C = colorMap.getId('#100000');
		const _D = colorMap.getId('#300000');
		const _E = colorMap.getId('#200000');
		let expected = new Theme(
			colorMap,
			new ThemeTrieElementRule(null, FontStyle.None, _A, _B),
			new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _NOT_SET), [], {
				'var': new ThemeTrieElement(
					new ThemeTrieElementRule(null, FontStyle.Bold, _C, 0),
					[new ThemeTrieElementRule(['source.css'], FontStyle.Underline, _D, _NOT_SET)],
					{
						'identifier': new ThemeTrieElement(
							new ThemeTrieElementRule(null, FontStyle.Bold, _E, _NOT_SET),
							[/*new ThemeTrieElementRule(['source.css'], FontStyle.Underline, '#200000', null)*/]
						)
					}
				)
			})
		);
		assert.deepEqual(actual, expected);
	});

});
