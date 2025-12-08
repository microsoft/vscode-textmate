/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as path from 'path';
import * as assert from 'assert';
import { Registry, IGrammar, RegistryOptions, parseRawGrammar } from '../main';
import { getOniguruma } from './onigLibs';
import * as fs from 'fs';

const REPO_ROOT = path.join(__dirname, '../../');

suite('Scope Comments', () => {
	test('should expose scope comments in tokens', async () => {
		const grammarPath = path.join(REPO_ROOT, 'test-cases/scope-comments/test.grammar.json');
		const grammarContent = fs.readFileSync(grammarPath).toString();
		const rawGrammar = parseRawGrammar(grammarContent, grammarPath);

		const options: RegistryOptions = {
			onigLib: getOniguruma(),
			loadGrammar: () => Promise.resolve(rawGrammar)
		};

		const registry = new Registry(options);
		const grammar: IGrammar | null = await registry.loadGrammar('source.test');

		assert.ok(grammar, 'Grammar should be loaded');

		// Test line with comment
		const result1 = grammar.tokenizeLine('hello world test', null);

		// Filter out whitespace tokens for easier testing
		const nonWhitespaceTokens = result1.tokens.filter(t => {
			const text = 'hello world test'.substring(t.startIndex, t.endIndex);
			return text.trim().length > 0;
		});

		assert.strictEqual(nonWhitespaceTokens.length, 3, 'Should have 3 non-whitespace tokens');

		// First token: "hello" - should have comment
		assert.strictEqual(nonWhitespaceTokens[0].scopes.length, 2);
		assert.strictEqual(nonWhitespaceTokens[0].scopes[0], 'source.test');
		assert.strictEqual(nonWhitespaceTokens[0].scopes[1], 'keyword.test');
		assert.strictEqual(nonWhitespaceTokens[0].scopeComments.length, 2);
		assert.strictEqual(nonWhitespaceTokens[0].scopeComments[0], null); // root scope has no comment
		assert.strictEqual(nonWhitespaceTokens[0].scopeComments[1], 'Matches the hello keyword');

		// Second token: "world" - should have comment
		assert.strictEqual(nonWhitespaceTokens[1].scopes.length, 2);
		assert.strictEqual(nonWhitespaceTokens[1].scopes[0], 'source.test');
		assert.strictEqual(nonWhitespaceTokens[1].scopes[1], 'string.test');
		assert.strictEqual(nonWhitespaceTokens[1].scopeComments.length, 2);
		assert.strictEqual(nonWhitespaceTokens[1].scopeComments[0], null); // root scope has no comment
		assert.strictEqual(nonWhitespaceTokens[1].scopeComments[1], 'Matches the world keyword');

		// Third token: "test" - should have no comment (null)
		assert.strictEqual(nonWhitespaceTokens[2].scopes.length, 2);
		assert.strictEqual(nonWhitespaceTokens[2].scopes[0], 'source.test');
		assert.strictEqual(nonWhitespaceTokens[2].scopes[1], 'variable.test');
		assert.strictEqual(nonWhitespaceTokens[2].scopeComments.length, 2);
		assert.strictEqual(nonWhitespaceTokens[2].scopeComments[0], null); // root scope has no comment
		assert.strictEqual(nonWhitespaceTokens[2].scopeComments[1], null); // this scope has no comment
	});
});
