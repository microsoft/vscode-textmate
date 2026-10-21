/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { test } from 'vitest';
import * as assert from 'assert';
import { EncodedTokenAttributes, OptionalStandardTokenType, StandardTokenType } from '../encodedTokenAttributes';
import { Registry, parseRawGrammar } from '../main';
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

test('Fonts are correctly set', async function () {
	const registry = new Registry({ loadGrammar: async () => undefined, onigLib: getOniguruma() });
	try {
		registry.setTheme({
			settings: [{
				scope: 'bar.test',
				settings: {
					fontFamily: 'monospace',
					fontSize: 1.2,
					lineHeight: 3
				}
			}]
		});
		const grammar = await registry.addGrammar({
			scopeName: 'source.test',
			repository: { $self: undefined!, $base: undefined! },
			patterns: [
				{ match: '\\bbar\\b', name: 'bar.test' }
			]
		});
		const result = grammar.tokenizeLine2('bar hello', null, undefined);
		assert.deepStrictEqual(result.fonts, [new FontInfo(0, 3, "monospace", 1.2, 3)]);
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
					fontSize: 1.3,
					lineHeight: 3
				}
			}]
		});
		const grammar = await registry.addGrammar({
			scopeName: 'source.ts',
			repository: { $self: undefined!, $base: undefined! },
			patterns: [
				{ match: 'g', name: 'entity.name.function.ts' }
			]
		});
		const result = grammar.tokenizeLine2('function g() {}', null, undefined);
		assert.deepStrictEqual(result.fonts, [new FontInfo(9, 10, 'Times New Roman', 1.3, 3)]);
	} finally {
		registry.dispose();
	}
});
for (const id of ['metadata', 1, 999]) {
	for (const location of ['pattern', 'repository', 'capture', 'injection', 'external']) {
		test(`Raw rule id metadata does not affect ${location} tokenization (${id})`, async () => {
			const raw = {
				scopeName: 'source.test',
				patterns: [{ begin: '"', end: '"', name: 'string', patterns: [{ include: '#id' }] }, { include: '#captured' }, { include: 'source.external' }],
				repository: {
					id: { match: '\\\\.', name: 'escape' },
					captured: { match: '(x)', name: 'word', captures: { '1': { name: 'capture', patterns: [{ match: 'x', name: 'inner' }] } } }
				},
				injections: { 'L:source.test': { match: 'z', name: 'injected' } }
			};
			const external = { scopeName: 'source.external', patterns: [{ match: 'y', name: 'external' }], repository: {} };
			const target = location === 'pattern' ? raw.patterns[0]
				: location === 'repository' ? raw.repository.id
					: location === 'capture' ? raw.repository.captured.captures['1']
						: location === 'injection' ? raw.injections['L:source.test'] : external.patterns[0];
			Object.assign(target, { id });
			const input = JSON.stringify(raw);
			const externalInput = JSON.stringify(external);
			const grammarInput = parseRawGrammar(input, 'test.json');
			const externalGrammarInput = parseRawGrammar(externalInput, 'external.json');
			for (let pass = 0; pass < 2; pass++) {
				const registry = new Registry({
					onigLib: getOniguruma(),
					loadGrammar: async scope => scope === 'source.test' ? grammarInput : externalGrammarInput
				});
				try {
					const grammar = await registry.loadGrammar('source.test');
					assert.ok(grammar);
					const result = grammar.tokenizeLine('"\\n" x y z', null);
					assert.deepStrictEqual(result.tokens, [
						{ startIndex: 0, endIndex: 1, scopes: ['source.test', 'string'] },
						{ startIndex: 1, endIndex: 3, scopes: ['source.test', 'string', 'escape'] },
						{ startIndex: 3, endIndex: 4, scopes: ['source.test', 'string'] },
						{ startIndex: 4, endIndex: 5, scopes: ['source.test'] },
						{ startIndex: 5, endIndex: 6, scopes: ['source.test', 'word', 'capture', 'inner'] },
						{ startIndex: 6, endIndex: 7, scopes: ['source.test'] },
						{ startIndex: 7, endIndex: 8, scopes: ['source.test', 'external'] },
						{ startIndex: 8, endIndex: 9, scopes: ['source.test'] },
						{ startIndex: 9, endIndex: 10, scopes: ['source.test', 'injected'] }
					]);
					assert.strictEqual(JSON.stringify(grammarInput), input);
					assert.strictEqual(JSON.stringify(externalGrammarInput), externalInput);
				} finally {
					registry.dispose();
				}
			}
		});
	}
}

for (const capture of ['beginCaptures', 'endCaptures', 'whileCaptures']) {
	test(`Raw rule id metadata does not affect ${capture}`, async () => {
		const raw = {
			scopeName: 'source.test', repository: {},
			patterns: [{
				begin: '(x)',
				...(capture === 'whileCaptures' ? { while: '(y)' } : { end: '(y)' }),
				name: 'block',
				[capture]: { '1': { id: 'metadata', patterns: [{ match: '[xy]', name: 'captured' }] } }
			}]
		};
		const registry = new Registry({ onigLib: getOniguruma(), loadGrammar: async () => parseRawGrammar(JSON.stringify(raw), 'test.json') });
		try {
			const grammar = await registry.loadGrammar('source.test');
			assert.ok(grammar);
			const first = grammar.tokenizeLine('x', null);
			const result = capture === 'beginCaptures' ? first : grammar.tokenizeLine('y', first.ruleStack);
			assert.deepStrictEqual(result.tokens[0], { startIndex: 0, endIndex: 1, scopes: ['source.test', 'block', 'captured'] });
		} finally {
			registry.dispose();
		}
	});
}
