/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import { Registry, IGrammar, RegistryOptions, StackElement, parseRawGrammar } from '../main';
import { IOnigLib } from '../types';
import { getOnigasm, getOniguruma } from '../onigLibs';

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
		it(test.desc + '-onigasm', () => {
			return performTest(test, getOnigasm());
		});
		it(test.desc + '-oniguruma', () => {
			return performTest(test, getOniguruma());
		});
	});

	async function performTest(test: IRawTest, onigLib: Promise<IOnigLib>): Promise<void> {
		let locator: RegistryOptions = {
			loadGrammar: (scopeName: string) => null,
			getInjections: (scopeName: string) => {
				if (scopeName === test.grammarScopeName) {
					return test.grammarInjections;
				}
				return void 0;
			},
			getOnigLib: () => onigLib
		};
		let registry = new Registry(locator);
		let grammar: IGrammar = null;
		for (let grammarPath of test.grammars) {
			let content = fs.readFileSync(path.join(path.dirname(testLocation), grammarPath)).toString();
			let rawGrammar = parseRawGrammar(content, grammarPath);
			let tmpGrammar = await registry.addGrammar(rawGrammar);
			if (test.grammarPath === grammarPath) {
				grammar = tmpGrammar;
			}
		};

		if (test.grammarScopeName) {
			grammar = await registry.grammarForScopeName(test.grammarScopeName);
		}

		if (!grammar) {
			throw new Error('I HAVE NO GRAMMAR FOR TEST');
		}
		let prevState: StackElement = null;
		for (let i = 0; i < test.lines.length; i++) {
			prevState = assertLineTokenization(grammar, test.lines[i], prevState);
		}
	}

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

