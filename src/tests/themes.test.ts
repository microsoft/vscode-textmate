/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { Registry, IToken, IGrammar, RegistryOptions, StackElement } from '../main';
import { createMatcher } from '../matcher';
import { parse as JSONparse } from '../json';
import {
	Theme, strcmp, strArrCmp, ThemeTrieElement, ThemeTrieElementRule,
	parseTheme, ParsedThemeRule,
	FontStyle, ColorMap
} from '../theme';

const THEMES_TEST_PATH = path.join(__dirname, '../../test-cases/themes');

// console.log(THEMES_TEST_PATH);

describe('Theme', () => {

	let light_vs = JSON.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'light_vs.json')).toString());
	// let light_vs_theme = new Theme(light_vs);



	// console.log(light_vs_theme);

	// console.log(light_vs);

	// var light_vs

	// console.log(light_vs._colorMap);

	it('works', () => {
		let registry = new Registry();
		registry.setTheme(light_vs);
		// console.log(registry._syncRegistry._theme._colorMap);
		let grammar = registry.loadGrammarFromPathSync(path.join(THEMES_TEST_PATH, 'go/go.json'));

		let testFile = fs.readFileSync(path.join(THEMES_TEST_PATH, 'go/colorize-fixtures/test.go')).toString('utf8');
		let testLines = testFile.split(/\r\n|\r|\n/);

		let prevState:StackElement = null;
		for (let i = 0, len = testLines.length; i < len; i++) {

			let r = grammar.tokenizeLine(testLines[i], prevState);
			// console.log(JSON.stringify(r, null, '\t'));
			prevState = r.ruleStack;

			if (i === 0) {
				break;
			}
		}

		// console.log(grammar);
	});

});

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
			new ThemeTrieElementRule(null, FontStyle.NotSet, _NOT_SET, _C),
			new ThemeTrieElementRule(['selector', 'source.css'], FontStyle.Bold, _NOT_SET, _C)
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
