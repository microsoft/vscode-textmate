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
	parseTheme, resolveParsedThemeRules, ParsedThemeRule,
	FontStyle
} from '../theme';

const THEMES_TEST_PATH = path.join(__dirname, '../../test-cases/themes');

// console.log(THEMES_TEST_PATH);

describe('Theme', () => {

	let light_vs = JSON.parse(fs.readFileSync(path.join(THEMES_TEST_PATH, 'light_vs.json')).toString());
	// let light_vs_theme = new Theme(light_vs);



	// console.log(light_vs_theme);

	// console.log(light_vs);

	// var light_vs

	it('works', () => {
		let registry = new Registry();
		registry.setTheme(light_vs);
		let grammar = registry.loadGrammarFromPathSync(path.join(THEMES_TEST_PATH, 'go/go.json'));

		console.log(grammar);
	});

});

describe('Theme matching', () => {
	it('can match', () => {
		let theme = new Theme({
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

		function assertMatch(scopeName: string, expected: ThemeTrieElementRule[]): void {
			let actual = theme.match(scopeName);
			assert.deepEqual(actual, expected, 'when matching ' + scopeName);
		}

		function assertSimpleMatch(scopeName: string, fontStyle: FontStyle, foreground: string, background: string): void {
			assertMatch(scopeName, [
				new ThemeTrieElementRule(null, fontStyle, foreground, background)
			]);
		}

		// matches defaults
		assertSimpleMatch('', FontStyle.None, '#F8F8F2', '#272822');
		assertSimpleMatch('bazz', FontStyle.None, '#F8F8F2', '#272822');
		assertSimpleMatch('asdfg', FontStyle.None, '#F8F8F2', '#272822');

		// matches source
		assertSimpleMatch('source', FontStyle.None, '#F8F8F2', '#100000');
		assertSimpleMatch('source.ts', FontStyle.None, '#F8F8F2', '#100000');
		assertSimpleMatch('source.tss', FontStyle.None, '#F8F8F2', '#100000');

		// matches something
		assertSimpleMatch('something', FontStyle.None, '#F8F8F2', '#100000');
		assertSimpleMatch('something.ts', FontStyle.None, '#F8F8F2', '#100000');
		assertSimpleMatch('something.tss', FontStyle.None, '#F8F8F2', '#100000');

		// matches baz
		assertSimpleMatch('baz', FontStyle.None, '#F8F8F2', '#200000');
		assertSimpleMatch('baz.ts', FontStyle.None, '#F8F8F2', '#200000');
		assertSimpleMatch('baz.tss', FontStyle.None, '#F8F8F2', '#200000');

		// matches constant
		assertSimpleMatch('constant', FontStyle.Italic, '#300000', '#272822');
		assertSimpleMatch('constant.string', FontStyle.Italic, '#300000', '#272822');
		assertSimpleMatch('constant.hex', FontStyle.Italic, '#300000', '#272822');

		// matches constant.numeric
		assertSimpleMatch('constant.numeric', FontStyle.Italic, '#400000', '#272822');
		assertSimpleMatch('constant.numeric.baz', FontStyle.Italic, '#400000', '#272822');

		// matches constant.numeric.hex
		assertSimpleMatch('constant.numeric.hex', FontStyle.Bold, '#400000', '#272822');
		assertSimpleMatch('constant.numeric.hex.baz', FontStyle.Bold, '#400000', '#272822');

		// matches constant.numeric.oct
		assertSimpleMatch('constant.numeric.oct', FontStyle.Bold | FontStyle.Italic | FontStyle.Underline, '#400000', '#272822');
		assertSimpleMatch('constant.numeric.oct.baz', FontStyle.Bold | FontStyle.Italic | FontStyle.Underline, '#400000', '#272822');

		// matches constant.numeric.dec
		assertSimpleMatch('constant.numeric.dec', FontStyle.None, '#500000', '#272822');
		assertSimpleMatch('constant.numeric.dec.baz', FontStyle.None, '#500000', '#272822');

		// matches storage.object.bar
		assertSimpleMatch('storage.object.bar', FontStyle.None, '#600000', '#272822');
		assertSimpleMatch('storage.object.bar.baz', FontStyle.None, '#600000', '#272822');

		// does not match storage.object.bar
		assertSimpleMatch('storage.object.bart', FontStyle.None, '#F8F8F2', '#272822');
		assertSimpleMatch('storage.object', FontStyle.None, '#F8F8F2', '#272822');
		assertSimpleMatch('storage', FontStyle.None, '#F8F8F2', '#272822');


		assertMatch('bar', [
			new ThemeTrieElementRule(null, FontStyle.None, '#F8F8F2', '#200000'),
			new ThemeTrieElementRule(['selector', 'source.css'], FontStyle.Bold, '#F8F8F2', '#200000')
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
		let actual = resolveParsedThemeRules([]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.None, '#000000', '#ffffff')
		);
		assert.deepEqual(actual, expected);
	});

	it('respects incoming defaults 1', () => {
		let actual = resolveParsedThemeRules([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, null, null)
		]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.None, '#000000', '#ffffff')
		);
		assert.deepEqual(actual, expected);
	});

	it('respects incoming defaults 2', () => {
		let actual = resolveParsedThemeRules([
			new ParsedThemeRule('', null, -1, FontStyle.None, null, null)
		]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.None, '#000000', '#ffffff')
		);
		assert.deepEqual(actual, expected);
	});

	it('respects incoming defaults 3', () => {
		let actual = resolveParsedThemeRules([
			new ParsedThemeRule('', null, -1, FontStyle.Bold, null, null)
		]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.Bold, '#000000', '#ffffff')
		);
		assert.deepEqual(actual, expected);
	});

	it('respects incoming defaults 4', () => {
		let actual = resolveParsedThemeRules([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#ff0000', null)
		]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.None, '#ff0000', '#ffffff')
		);
		assert.deepEqual(actual, expected);
	});

	it('respects incoming defaults 5', () => {
		let actual = resolveParsedThemeRules([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, null, '#ff0000')
		]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.None, '#000000', '#ff0000')
		);
		assert.deepEqual(actual, expected);
	});

	it('can merge incoming defaults', () => {
		let actual = resolveParsedThemeRules([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, null, '#ff0000'),
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#00ff00', null),
			new ParsedThemeRule('', null, -1, FontStyle.Bold, null, null),
		]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.Bold, '#00ff00', '#ff0000'),
			[],
			{}
		);
		assert.deepEqual(actual, expected);
	});

	it('defaults are inherited', () => {
		let actual = resolveParsedThemeRules([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#F8F8F2', '#272822'),
			new ParsedThemeRule('var', null, -1, FontStyle.NotSet, '#ff0000', null)
		]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.None, '#F8F8F2', '#272822'), [],
			{
				'var': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.None, '#ff0000', '#272822'))
			}
		);
		assert.deepEqual(actual, expected);
	});

	it('same rules get merged', () => {
		let actual = resolveParsedThemeRules([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#F8F8F2', '#272822'),
			new ParsedThemeRule('var', null, 1, FontStyle.Bold, null, null),
			new ParsedThemeRule('var', null, 0, FontStyle.NotSet, '#ff0000', null),
		]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.None, '#F8F8F2', '#272822'), [],
			{
				'var': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, '#ff0000', '#272822'))
			}
		);
		assert.deepEqual(actual, expected);
	});

	it('rules are inherited', () => {
		let actual = resolveParsedThemeRules([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#F8F8F2', '#272822'),
			new ParsedThemeRule('var', null, -1, FontStyle.Bold, '#ff0000', null),
			new ParsedThemeRule('var.identifier', null, -1, FontStyle.NotSet, '#00ff00', null),
		]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.None, '#F8F8F2', '#272822'), [], {
				'var': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, '#ff0000', '#272822'), [], {
					'identifier': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, '#00ff00', '#272822'))
				})
			}
		);
		assert.deepEqual(actual, expected);
	});

	it('rules are inherited', () => {
		let actual = resolveParsedThemeRules([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#F8F8F2', '#272822'),
			new ParsedThemeRule('var', null, -1, FontStyle.Bold, '#ff0000', null),
			new ParsedThemeRule('var.identifier', null, -1, FontStyle.NotSet, '#00ff00', null),
			new ParsedThemeRule('constant', null, 4, FontStyle.Italic, '#100000', null),
			new ParsedThemeRule('constant.numeric', null, 5, FontStyle.NotSet, '#200000', null),
			new ParsedThemeRule('constant.numeric.hex', null, 6, FontStyle.Bold, null, null),
			new ParsedThemeRule('constant.numeric.oct', null, 7, FontStyle.Bold | FontStyle.Italic | FontStyle.Underline, null, null),
			new ParsedThemeRule('constant.numeric.dec', null, 8, FontStyle.None, '#300000', null),
		]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.None, '#F8F8F2', '#272822'), [], {
				'var': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, '#ff0000', '#272822'), [], {
					'identifier': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, '#00ff00', '#272822'))
				}),
				'constant': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Italic, '#100000', '#272822'), [], {
					'numeric': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Italic, '#200000', '#272822'), [], {
						'hex': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold, '#200000', '#272822')),
						'oct': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.Bold | FontStyle.Italic | FontStyle.Underline, '#200000', '#272822')),
						'dec': new ThemeTrieElement(new ThemeTrieElementRule(null, FontStyle.None, '#300000', '#272822')),
					})
				})
			}
		);
		assert.deepEqual(actual, expected);
	});

	it('rules with parent scopes', () => {
		let actual = resolveParsedThemeRules([
			new ParsedThemeRule('', null, -1, FontStyle.NotSet, '#F8F8F2', '#272822'),
			new ParsedThemeRule('var', null, -1, FontStyle.Bold, '#100000', null),
			new ParsedThemeRule('var.identifier', null, -1, FontStyle.NotSet, '#200000', null),
			new ParsedThemeRule('var', ['source.css'], 1, FontStyle.Italic, '#300000', null),
			new ParsedThemeRule('var', ['source.css'], 2, FontStyle.Underline, null, null),
		]);
		let expected = new ThemeTrieElement(
			new ThemeTrieElementRule(null, FontStyle.None, '#F8F8F2', '#272822'), [], {
				'var': new ThemeTrieElement(
					new ThemeTrieElementRule(null, FontStyle.Bold, '#100000', '#272822'),
					[new ThemeTrieElementRule(['source.css'], FontStyle.Underline, '#300000', '#272822')],
					{
						'identifier': new ThemeTrieElement(
							new ThemeTrieElementRule(null, FontStyle.Bold, '#200000', '#272822'),
							[/*new ThemeTrieElementRule(['source.css'], FontStyle.Underline, '#200000', '#272822')*/]
						)
					}
				)
			}
		);
		assert.deepEqual(actual, expected);
	});

});
