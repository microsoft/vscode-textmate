/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as tape from 'tape';
import { Registry, IGrammar, RegistryOptions, StackElement, parseRawGrammar } from '../main';
import { IOnigLib, IRawGrammar } from '../types';
import { getOnigasm, getOniguruma, getVSCodeOniguruma } from './onigLibs';

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

		tape(test.desc + '-onigasm', async (t: tape.Test) => {
			await performTest(t, test, getOnigasm());
			t.end();
		});

		tape(test.desc + '-oniguruma', async (t: tape.Test) => {
			await performTest(t, test, getOniguruma());
			t.end();
		});

		tape(test.desc + '-vscode-oniguruma', async (t: tape.Test) => {
			await performTest(t, test, getVSCodeOniguruma());
			t.end();
		});
	});

	async function performTest(t: tape.Test, test: IRawTest, onigLib: Promise<IOnigLib>): Promise<void> {

		let grammarScopeName = test.grammarScopeName;
		let grammarByScope : { [scope:string]:IRawGrammar } = {};
		for (let grammarPath of test.grammars) {
			let content = fs.readFileSync(path.join(path.dirname(testLocation), grammarPath)).toString();
			let rawGrammar = parseRawGrammar(content, grammarPath);
			grammarByScope[rawGrammar.scopeName] = rawGrammar;
			if (!grammarScopeName && grammarPath === test.grammarPath) {
				grammarScopeName = rawGrammar.scopeName;
			}
		}
		if (!grammarScopeName) {
			throw new Error('I HAVE NO GRAMMAR FOR TEST');
		}

		let options: RegistryOptions = {
			onigLib: onigLib,
			loadGrammar: (scopeName: string) => Promise.resolve(grammarByScope[scopeName]),
			getInjections: (scopeName: string) => {
				if (scopeName === grammarScopeName) {
					return test.grammarInjections;
				}
			}
		};
		let registry = new Registry(options);
		let grammar: IGrammar | null = await registry.loadGrammar(grammarScopeName);
		if (!grammar) {
			throw new Error('I HAVE NO GRAMMAR FOR TEST');
		}
		let prevState: StackElement | null = null;
		for (let i = 0; i < test.lines.length; i++) {
			prevState = assertLineTokenization(t, grammar, test.lines[i], prevState);
		}
	}

	function assertLineTokenization(t: tape.Test, grammar: IGrammar, testCase: IRawTestLine, prevState: StackElement | null): StackElement {
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

		t.deepEqual(actualTokens, testCase.tokens, 'Tokenizing line ' + testCase.line);

		return actual.ruleStack;
	}
}

assertTokenizationSuite(path.join(REPO_ROOT, 'test-cases/first-mate/tests.json'));
assertTokenizationSuite(path.join(REPO_ROOT, 'test-cases/suite1/tests.json'));
assertTokenizationSuite(path.join(REPO_ROOT, 'test-cases/suite1/whileTests.json'));
