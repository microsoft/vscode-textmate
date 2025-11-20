/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as assert from 'assert';
import { EncodedTokenAttributes, OptionalStandardTokenType, StandardTokenType } from '../encodedTokenAttributes';
import { Registry } from '../main';
import { FontStyle } from '../theme';
import { getOniguruma } from './onigLibs';
import { FontInfo } from '../grammar/grammar';

function assertEquals(metadata: number, languageId: number, tokenType: StandardTokenType, containsBalancedBrackets: boolean, fontStyle: FontStyle, foreground: number, background: number): void {
	const actual = {
		languageId: EncodedTokenAttributes.getLanguageId(metadata),
		tokenType: EncodedTokenAttributes.getTokenType(metadata),
		containsBalancedBrackets: EncodedTokenAttributes.containsBalancedBrackets(metadata),
		fontStyle: EncodedTokenAttributes.getFontStyle(metadata),
		foreground: EncodedTokenAttributes.getForeground(metadata),
		background: EncodedTokenAttributes.getBackground(metadata),
	};

	const expected = {
		languageId,
		tokenType,
		containsBalancedBrackets,
		fontStyle,
		foreground,
		background,
	};

	assert.deepStrictEqual(actual, expected, 'equals for ' + EncodedTokenAttributes.toBinaryStr(metadata));
}

test('StackElementMetadata works', () => {
	let value = EncodedTokenAttributes.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
});

test('StackElementMetadata can overwrite languageId', () => {
	let value = EncodedTokenAttributes.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = EncodedTokenAttributes.set(value, 2, OptionalStandardTokenType.NotSet, false, FontStyle.NotSet, 0, 0);
	assertEquals(value, 2, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
});

test('StackElementMetadata can overwrite tokenType', () => {
	let value = EncodedTokenAttributes.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = EncodedTokenAttributes.set(value, 0, OptionalStandardTokenType.Comment, false, FontStyle.NotSet, 0, 0);
	assertEquals(value, 1, StandardTokenType.Comment, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
});

test('StackElementMetadata can overwrite font style', () => {
	let value = EncodedTokenAttributes.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = EncodedTokenAttributes.set(value, 0, OptionalStandardTokenType.NotSet, false, FontStyle.None, 0, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.None, 101, 102);
});

test('StackElementMetadata can overwrite font style with strikethrough', () => {
	let value = EncodedTokenAttributes.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Strikethrough, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Strikethrough, 101, 102);

	value = EncodedTokenAttributes.set(value, 0, OptionalStandardTokenType.NotSet, false, FontStyle.None, 0, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.None, 101, 102);
});

test('StackElementMetadata can overwrite foreground', () => {
	let value = EncodedTokenAttributes.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = EncodedTokenAttributes.set(value, 0, OptionalStandardTokenType.NotSet, false, FontStyle.NotSet, 5, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 5, 102);
});

test('StackElementMetadata can overwrite background', () => {
	let value = EncodedTokenAttributes.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = EncodedTokenAttributes.set(value, 0, OptionalStandardTokenType.NotSet, false, FontStyle.NotSet, 0, 7);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 7);
});

test('StackElementMetadata can overwrite balanced backet bit', () => {
	let value = EncodedTokenAttributes.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = EncodedTokenAttributes.set(value, 0, OptionalStandardTokenType.NotSet, true, FontStyle.NotSet, 0, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, true, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = EncodedTokenAttributes.set(value, 0, OptionalStandardTokenType.NotSet, false, FontStyle.NotSet, 0, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
});

test('StackElementMetadata can work at max values', () => {
	const maxLangId = 255;
	const maxTokenType = StandardTokenType.Comment | StandardTokenType.Other | StandardTokenType.RegEx | StandardTokenType.String;
	const maxFontStyle = FontStyle.Bold | FontStyle.Italic | FontStyle.Underline;
	const maxForeground = 511;
	const maxBackground = 254;

	let value = EncodedTokenAttributes.set(0, maxLangId, maxTokenType, true, maxFontStyle, maxForeground, maxBackground);
	assertEquals(value, maxLangId, maxTokenType, true, maxFontStyle, maxForeground, maxBackground);
});

test.skip('Shadowed rules are resolved correctly', async function () {
	const registry = new Registry({ loadGrammar: async () => undefined, onigLib: getOniguruma() });
	try {
		const grammar = await registry.addGrammar({
			scopeName: 'source.test',
			repository: {
				$base: undefined!,
				$self: undefined!,
				foo: { include: '#bar', },
				bar: { match: 'bar1', name: 'outer' }
			},
			patterns: [
				{
					patterns: [{ include: '#foo' }],
					repository: {
						$base: undefined!,
						$self: undefined!,
						bar: { match: 'bar1', name: 'inner' }
					}
				},
				// When you move this up, the test passes
				{
					begin: 'begin',
					patterns: [{ include: '#foo' }],
					end: 'end'
				},
			]
		});
		const result = grammar.tokenizeLine('bar1', null, undefined);
		// TODO this should be inner!
		assert.deepStrictEqual(result.tokens, [{ startIndex: 0, endIndex: 4, scopes: ["source.test", "outer"] }]);
	} finally {
		registry.dispose();
	}
});

test.only('Fonts are correctly set', async function () {
	const registry = new Registry({ loadGrammar: async () => undefined, onigLib: getOniguruma() });
	try {
		registry.setTheme({
			settings: [{
				scope: 'source.test',
				settings: {
					fontStyle: 'bold underline',
					fontFamily: 'monospace',
					fontSize: '12px',
					lineHeight: 20
				}
			}]
		});
		const grammar = await registry.addGrammar({
			scopeName: 'source.test',
			repository: {
				$base: undefined!,
				$self: undefined!,
				bar: { include: '#bar', name: 'entity.name.test' }
			},
			patterns: [
				{
					repository: {
						$base: undefined!,
						$self: undefined!,
						bar: { match: '\\bbar1\\b', name: 'entity.name.test' }
					}
				}
			]
		});
		const result = grammar.tokenizeLine2('bar1 hello', null, undefined);
		console.log('result.fonts : ', result.fonts);
		console.log('result.tokens : ', result.tokens);
		assert.deepStrictEqual(result.fonts, [new FontInfo(0, 4, "monospace", "12px", 20)]);
	} finally {
		registry.dispose();
	}
});

test('Fonts are correctly set 2', async function () {
	const registry = new Registry({ loadGrammar: async () => undefined, onigLib: getOniguruma() });
	try {
		registry.setTheme({
			settings: [{
				scope: 'entity.name.function.ts',
				settings: {
					fontFamily: 'Times New Roman',
					fontSize: '20px',
					lineHeight: 40
				}
			}]
		});
		const grammar = await registry.addGrammar({
			scopeName: 'entity.name.function.ts',
			repository: {
				$base: undefined!,
				$self: undefined!
			},
			patterns: [
				{
					repository: {
						$base: undefined!,
						$self: undefined!,
						bar: { match: 'g' }
					}
				}
			]
		});
		const result = grammar.tokenizeLine2('function g() {}', null, undefined);
		assert.deepStrictEqual(result.fonts, [new FontInfo(9, 10, 'Times New Roman', "20px", 40)]);
	} finally {
		registry.dispose();
	}
});