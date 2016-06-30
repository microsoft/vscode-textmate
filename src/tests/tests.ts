/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import fs = require('fs');
import path = require('path');
import {Registry, createMatcher, IGrammarLocator} from '../main';
import {IToken, StackElement, IGrammar} from '../grammar';
import 'colors';
import {parseSAX, parse} from '../plistParser';

enum TestResult {
	Pending,
	Success,
	Failed
}

class Test {
	testName:string;
	result:TestResult;
	failReason: string;

	private _runner: (ctx:TestContext) => void;

	constructor(testName:string, runner: (ctx:TestContext) => void) {
		this.testName = testName;
		this._runner = runner;
		this.result = TestResult.Pending;
		this.failReason = null;
	}

	public run(): void {
		let ctx = new TestContext(this);
		try {
			this.result = TestResult.Success;
			this._runner(ctx);
		} catch(err) {
			this.result = TestResult.Failed;
			this.failReason = err;
		}
	}

	public fail<T>(message:string, actual:T, expected:T): void {
		this.result = TestResult.Failed;
		let reason = [
			message
		];
		if (actual) {
			'ACTUAL: ' + reason.push(JSON.stringify(actual, null, '\t'))
		}
		if (expected) {
			'EXPECTED: ' + reason.push(JSON.stringify(expected, null, '\t'))
		}
		this.failReason = reason.join('\n');
	}
}

class TestContext {

	private _test: Test;

	constructor(test: Test) {
		this._test = test;
	}

	public fail<T>(message:string, actual?:T, expected?:T): void {
		this._test.fail(message, actual, expected);
	}
}

class TestManager {

	private _tests:Test[];

	constructor() {
		this._tests = [];
	}

	registerTest(testName: string, runner:(ctx:TestContext)=>void): void {
		this._tests.push(new Test(testName, runner));
	}

	runTests(): void {

		let len = this._tests.length;

		for (let i = 0; i < len; i++) {
			let test = this._tests[i];
			let progress = (i + 1) + '/' + len;
			console.log((<any>progress).yellow, ': ' + test.testName);
			test.run();
			if (test.result === TestResult.Failed) {
				console.log((<any>'FAILED').red);
				console.log(test.failReason);
			}
		}

		let passed = this._tests.filter(t => t.result === TestResult.Success);

		if (passed.length === len) {
			console.log((<any>(passed.length + '/' + len + ' PASSED.')).green);
		} else {
			console.log((<any>(passed.length + '/' + len + ' PASSED.')).red);
		}
	}
}

export function runTests(tokenizationTestPaths:string[], matcherTestPaths:string[], plistParserPaths:string[]): void {
	let manager = new TestManager();

	plistParserPaths.forEach((path) => {
		generatePListParserTests(manager, path);
	});

	matcherTestPaths.forEach((path) => {
		generateMatcherTests(manager, path);
	});

	tokenizationTestPaths.forEach((path) => {
		generateTokenizationTests(manager, path)
	});

	manager.runTests();
}

function generateTokenizationTests(manager:TestManager, testLocation: string): void {
	let tests:IRawTest[] = JSON.parse(fs.readFileSync(testLocation).toString());

	let suiteName = path.join(path.basename(path.dirname(testLocation)), path.basename(testLocation));
	tests.forEach(function(test, index) {
		manager.registerTest(suiteName + ' > ' + test.desc, (ctx) => {
			let locator : IGrammarLocator = {
				getFilePath: (scopeName:string) => null,
				getInjections: (scopeName:string) => {
					if (scopeName === test.grammarScopeName) {
						return test.grammarInjections;
					}
					return void 0;
				}
			}

			let registry = new Registry(locator, true);
			let grammar: IGrammar = null;
			test.grammars.forEach(function(grammarPath) {
				let tmpGrammar = registry.loadGrammarFromPathSync(path.join(path.dirname(testLocation), grammarPath));
				if (test.grammarPath === grammarPath) {
					grammar = tmpGrammar;
				}
			});
			if (test.grammarScopeName) {
				grammar = registry.grammarForScopeName(test.grammarScopeName);
			}
			let prevState: StackElement[] = null;
			if (!grammar) {
				ctx.fail('I HAVE NO GRAMMAR FOR TEST');
				return;
			}
			for (let i = 0; i < test.lines.length; i++) {
				prevState = assertTokenization(ctx, grammar, test.lines[i], prevState);
			}
		});
	});
}

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

function assertTokenization(ctx:TestContext, grammar:IGrammar, testCase:IRawTestLine, prevState: StackElement[]): StackElement[] {
	let r = grammar.tokenizeLine(testCase.line, prevState);
	assertTokens(ctx, r.tokens, testCase.line, testCase.tokens);
	return r.ruleStack;
}

function assertTokens(ctx:TestContext, actual:IToken[], line:string, expected:IRawToken[]): void {
	let actualTokens:IRawToken[] = actual.map(function(token) {
		return {
			value: line.substring(token.startIndex, token.endIndex),
			scopes: token.scopes
		};
	});
	if (line.length > 0) {
		// Remove empty tokens...
		expected = expected.filter(function(token) {
			return (token.value.length > 0);
		});
	}
	if (actualTokens.length !== expected.length) {
		ctx.fail('GOT DIFFERENT LENGTHS FOR ', actualTokens, expected);
		return;
	}
	for (let i = 0, len = actualTokens.length; i < len; i++) {
		assertToken(ctx, actualTokens[i], expected[i]);
	}
}

function assertToken(ctx:TestContext, actual:IRawToken, expected:IRawToken): void {
	if (actual.value !== expected.value) {
		ctx.fail('test: GOT DIFFERENT VALUES FOR ', actual.value, expected.value);
		return;
	}
	if (actual.scopes.length !== expected.scopes.length) {
		ctx.fail('test: GOT DIFFERENT scope lengths FOR ', actual.scopes, expected.scopes);
		return;
	}
	for (let i = 0, len = actual.scopes.length; i < len; i++) {
		if (actual.scopes[i] !== expected.scopes[i]) {
			ctx.fail('test: GOT DIFFERENT scopes FOR ', actual.scopes, expected.scopes);
			return;
		}
	}
}

interface IMatcherTest {
	expression: string;
	input: string[];
	result: boolean;
}

function generateMatcherTests(manager:TestManager, testLocation: string) {
	let tests:IMatcherTest[] = JSON.parse(fs.readFileSync(testLocation).toString());
	let suiteName = path.join(path.basename(path.dirname(testLocation)), path.basename(testLocation));

	var nameMatcher = (identifers: string[], stackElements: string[]) => {
		var lastIndex = 0;
		return identifers.every(identifier => {
			for (var i = lastIndex; i < stackElements.length; i++) {
				if (stackElements[i] === identifier) {
					lastIndex = i + 1;
					return true;
				}
			}
			return false;
		});
	};
	tests.forEach((test, index) => {
		manager.registerTest(suiteName + ' > ' + index, (ctx) => {
			var matcher = createMatcher(test.expression, nameMatcher);
			var result = matcher(test.input);
			if (result !== test.result) {
				ctx.fail('matcher expected', result, test.result);
			}
		});
	});
}

function generatePListParserTests(manager:TestManager, p:string) {
	manager.registerTest('PLIST > ' + p, (ctx) => {
		let contents = fs.readFileSync(p).toString();
		let expectedObj = parseSAX(contents);
		let actualObj = parse(contents);

		let expected = JSON.stringify(expectedObj.value, null, '\t');
		let actual = JSON.stringify(actualObj.value, null, '\t');

		if (expected !== actual) {
			console.log('bubu');
			fs.writeFileSync(path.join(__dirname, '../../good.txt'), expected);
			fs.writeFileSync(path.join(__dirname, '../../bad.txt'), actual);
			ctx.fail('plist parsers disagree');
			process.exit(0);
		}
	});
}