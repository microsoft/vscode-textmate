/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { Registry, IGrammar, RegistryOptions, StackElement } from '../main';
import { createMatchers } from '../matcher';
import { parse as JSONparse } from '../json';
import './themes.test';
import './grammar.test';

const REPO_ROOT = path.join(__dirname, '../../');

function assertTokenizationSuite(testLocation: string): void {

	interface IRawTest {
		desc: string;
		grammars: string[];
		grammarPath?: string;
		grammarScopeName?: string;
		grammarInjections?: string[];
		lines: IRawTestLine[];
	}
	interface IRawTestLine {
		line: string;
		tokens: IRawToken[];
	}
	interface IRawToken {
		value: string;
		scopes: string[];
	}

	let tests: IRawTest[] = JSON.parse(fs.readFileSync(testLocation).toString());

	tests.forEach((test) => {
		it(test.desc, () => {
			let locator: RegistryOptions = {
				getFilePath: (scopeName: string) => null,
				getInjections: (scopeName: string) => {
					if (scopeName === test.grammarScopeName) {
						return test.grammarInjections;
					}
					return void 0;
				}
			}

			let registry = new Registry(locator);

			let grammar: IGrammar = null;
			test.grammars.forEach((grammarPath) => {
				let tmpGrammar = registry.loadGrammarFromPathSync(path.join(path.dirname(testLocation), grammarPath));
				if (test.grammarPath === grammarPath) {
					grammar = tmpGrammar;
				}
			});

			if (test.grammarScopeName) {
				grammar = registry.grammarForScopeName(test.grammarScopeName);
			}

			if (!grammar) {
				throw new Error('I HAVE NO GRAMMAR FOR TEST');
			}

			let prevState: StackElement = null;
			for (let i = 0; i < test.lines.length; i++) {
				prevState = assertLineTokenization(grammar, test.lines[i], prevState);
			}
		});
	});

	function assertLineTokenization(grammar: IGrammar, testCase: IRawTestLine, prevState: StackElement): StackElement {
		let actual = grammar.tokenizeLine(testCase.line, prevState);

		let actualTokens: IRawToken[] = actual.tokens.map((token) => {
			return {
				value: testCase.line.substring(token.startIndex, token.endIndex),
				scopes: token.scopes
			};
		});

		// TODO@Alex: fix tests instead of working around
		if (testCase.line.length > 0) {
			// Remove empty tokens...
			testCase.tokens = testCase.tokens.filter((token) => {
				return (token.value.length > 0);
			});
		}
		
		assert.deepEqual(actualTokens, testCase.tokens, 'Tokenizing line ' + testCase.line);

		return actual.ruleStack;
	}
}

describe('Tokenization /first-mate/', () => {
	assertTokenizationSuite(path.join(REPO_ROOT, 'test-cases/first-mate/tests.json'));
});

describe('Tokenization /suite1/', () => {
	assertTokenizationSuite(path.join(REPO_ROOT, 'test-cases/suite1/tests.json'));
	assertTokenizationSuite(path.join(REPO_ROOT, 'test-cases/suite1/whileTests.json'));
});

describe('Matcher', () => {
	let tests = [
		{ "expression": "foo", "input": ["foo"], "result": true },
		{ "expression": "foo", "input": ["bar"], "result": false },
		{ "expression": "- foo", "input": ["foo"], "result": false },
		{ "expression": "- foo", "input": ["bar"], "result": true },
		{ "expression": "- - foo", "input": ["bar"], "result": false },
		{ "expression": "bar foo", "input": ["foo"], "result": false },
		{ "expression": "bar foo", "input": ["bar"], "result": false },
		{ "expression": "bar foo", "input": ["bar", "foo"], "result": true },
		{ "expression": "bar - foo", "input": ["bar"], "result": true },
		{ "expression": "bar - foo", "input": ["foo", "bar"], "result": false },
		{ "expression": "bar - foo", "input": ["foo"], "result": false },
		{ "expression": "bar, foo", "input": ["foo"], "result": true },
		{ "expression": "bar, foo", "input": ["bar"], "result": true },
		{ "expression": "bar, foo", "input": ["bar", "foo"], "result": true },
		{ "expression": "bar, -foo", "input": ["bar", "foo"], "result": true },
		{ "expression": "bar, -foo", "input": ["yo"], "result": true },
		{ "expression": "bar, -foo", "input": ["foo"], "result": false },
		{ "expression": "(foo)", "input": ["foo"], "result": true },
		{ "expression": "(foo - bar)", "input": ["foo"], "result": true },
		{ "expression": "(foo - bar)", "input": ["foo", "bar"], "result": false },
		{ "expression": "foo bar - (yo man)", "input": ["foo", "bar"], "result": true },
		{ "expression": "foo bar - (yo man)", "input": ["foo", "bar", "yo"], "result": true },
		{ "expression": "foo bar - (yo man)", "input": ["foo", "bar", "yo", "man"], "result": false },
		{ "expression": "foo bar - (yo | man)", "input": ["foo", "bar", "yo", "man"], "result": false },
		{ "expression": "foo bar - (yo | man)", "input": ["foo", "bar", "yo"], "result": false },
		{ "expression": "R:text.html - (comment.block, text.html source)", "input": ["text.html", "bar", "source"], "result": false },
		{ "expression": "text.html.php - (meta.embedded | meta.tag), L:text.html.php meta.tag, L:source.js.embedded.html", "input": ["text.html.php", "bar", "source.js"], "result": true }
	];

	let nameMatcher = (identifers: string[], stackElements: string[]) => {
		let lastIndex = 0;
		return identifers.every(identifier => {
			for (let i = lastIndex; i < stackElements.length; i++) {
				if (stackElements[i] === identifier) {
					lastIndex = i + 1;
					return true;
				}
			}
			return false;
		});
	};

	tests.forEach((test, index) => {
		it('Test #' + index, () => {
			let matchers = createMatchers(test.expression, nameMatcher);
			let result = matchers.some(m => m.matcher(test.input));
			assert.equal(result, test.result);
		});
	});
});

describe('JSON', () => {
	function isValid(json: string): void {
		let expected = JSON.parse(json);
		let actual = JSONparse(json, null, false);
		assert.deepEqual(actual, expected);

		// let actual2 = JSONparse(json, true);
		// assert.deepEqual(actual2, expected);
	}

	function isInvalid(json: string): void {
		let hadErr = false;
		try {
			var actual = JSONparse(json, null, false);
		} catch (err) {
			hadErr = true;
		}
		assert.equal(hadErr, true, 'expected invalid: ' + json);
	}

	it('Invalid body', function () {
		isInvalid('{}[]');
		isInvalid('*');
	});

	it('Trailing Whitespace', function () {
		isValid('{}\n\n');
	});

	it('Objects', function () {
		isValid('{}');
		isValid('{"key": "value"}');
		isValid('{"key1": true, "key2": 3, "key3": [null], "key4": { "nested": {}}}');
		isValid('{"constructor": true }');

		isInvalid('{');
		isInvalid('{3:3}');
		isInvalid('{\'key\': 3}');
		isInvalid('{"key" 3}');
		isInvalid('{"key":3 "key2": 4}');
		isInvalid('{"key":42, }');
		isInvalid('{"key:42');
	});

	it('Arrays', function () {
		isValid('[]');
		isValid('[1, 2]');
		isValid('[1, "string", false, {}, [null]]');

		isInvalid('[');
		isInvalid('[,]');
		isInvalid('[1 2]');
		isInvalid('[true false]');
		isInvalid('[1, ]');
		isInvalid('[[]');
		isInvalid('["something"');
		isInvalid('[magic]');
	});

	it('Strings', function () {
		isValid('["string"]');
		isValid('["\\"\\\\\\/\\b\\f\\n\\r\\t\\u1234\\u12AB"]');
		isValid('["\\\\"]');

		isInvalid('["');
		isInvalid('["]');
		isInvalid('["\\z"]');
		isInvalid('["\\u"]');
		isInvalid('["\\u123"]');
		isInvalid('["\\u123Z"]');
		isInvalid('[\'string\']');
	});

	it('Numbers', function () {
		isValid('[0, -1, 186.1, 0.123, -1.583e+4, 1.583E-4, 5e8]');

		// isInvalid('[+1]');
		// isInvalid('[01]');
		// isInvalid('[1.]');
		// isInvalid('[1.1+3]');
		// isInvalid('[1.4e]');
		// isInvalid('[-A]');
	});

	it('misc', function () {
		isValid('{}');
		isValid('[null]');
		isValid('{"a":true}');
		isValid('{\n\t"key" : {\n\t"key2": 42\n\t}\n}');
		isValid('{"key":[{"key2":42}]}');
		isValid('{\n\t\n}');
		isValid('{\n"first":true\n\n}');
		isValid('{\n"key":32,\n\n"key2":45}');
		isValid('{"a": 1,\n\n"d": 2}');
		isValid('{"a": 1, "a": 2}');
		isValid('{"a": { "a": 2, "a": 3}}');
		isValid('[{ "a": 2, "a": 3}]');
		isValid('{"key1":"first string", "key2":["second string"]}');

		isInvalid('{\n"key":32,\nerror\n}');
	});
});
