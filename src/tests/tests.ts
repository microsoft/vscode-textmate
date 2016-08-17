/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import {Registry, createMatcher, IGrammarLocator} from '../main';
import {IToken, StackElement, IGrammar} from '../grammar';

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

	let tests:IRawTest[] = JSON.parse(fs.readFileSync(testLocation).toString());

	tests.forEach((test) => {
		it (test.desc, () => {
			let locator : IGrammarLocator = {
				getFilePath: (scopeName:string) => null,
				getInjections: (scopeName:string) => {
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

	function assertLineTokenization(grammar:IGrammar, testCase:IRawTestLine, prevState: StackElement): StackElement {
		let actual = grammar.tokenizeLine(testCase.line, prevState);

		let actualTokens:IRawToken[] = actual.tokens.map((token) => {
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
		{ "expression": "foo bar - (yo | man)", "input": ["foo", "bar", "yo"], "result": false }
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
			let matcher = createMatcher(test.expression, nameMatcher);
			let result = matcher(test.input);
			assert.equal(result, test.result);
		});
	});
});
