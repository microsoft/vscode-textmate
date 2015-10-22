/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import fs = require('fs');
import path = require('path');
import {Registry, createMatcher} from '../main';
import {IToken, StackElement, IGrammar} from '../grammar';
import 'colors';

var errCnt = 0;

export function runDescriptiveTests(testLocation: string) {
	let tests:IRawTest[] = JSON.parse(fs.readFileSync(testLocation).toString());

	errCnt = 0;
	tests.forEach(function(test, index) {
		let desc = test.desc;
		if (test.feature === 'injection') {
			console.log(index + ' - SKIPPING TEST ' + desc + ': injection');
			return;
		}
		let noAsserts = (test.feature === 'endless-loop');

		console.log(index + ' - RUNNING ' + desc);
		let registry = new Registry();
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
			console.error('I HAVE NO GRAMMAR FOR TEST ' + desc);
			return;
		}
		for (let i = 0; i < test.lines.length; i++) {
			prevState = assertTokenization(noAsserts, grammar, test.lines[i], prevState, desc);
		}
	});

	if (errCnt === 0) {
		var msg = 'Test suite at ' + testLocation + ' finished ok';
		console.log((<any>msg).green);
	} else {
		var msg = 'Test suite at ' + testLocation + ' finished with ' + errCnt + ' errors.';
		console.log((<any>msg).red);
	}

}

interface IRawTest {
	desc: string;
	feature: string;
	grammars: string[];
	grammarPath?: string;
	grammarScopeName?: string;
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

function assertTokenization(noAsserts:boolean, grammar:IGrammar, testCase:IRawTestLine, prevState: StackElement[], desc:string): StackElement[] {
	let r = grammar.tokenizeLine(testCase.line, prevState);
	if (!noAsserts) {
		assertTokens(r.tokens, testCase.line, testCase.tokens, desc);
	}
	return r.ruleStack;
}

function fail<T>(message:string, actual:T, expected:T): void {
	errCnt++;
	console.error((<any>message).red);
	console.log(JSON.stringify(actual, null, '\t'));
	console.log(JSON.stringify(expected, null, '\t'));
}

function assertTokens(actual:IToken[], line:string, expected:IRawToken[], desc:string): void {
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
		fail('test: GOT DIFFERENT LENGTHS FOR ' + desc, actualTokens, expected);
		return;
	}
	for (let i = 0, len = actualTokens.length; i < len; i++) {
		assertToken(actualTokens[i], expected[i], desc);
	}
}

function assertToken(actual:IRawToken, expected:IRawToken, desc:string): void {
	if (actual.value !== expected.value) {
		fail('test: GOT DIFFERENT VALUES FOR ' + desc, actual.value, expected.value);
		return;
	}
	if (actual.scopes.length !== expected.scopes.length) {
		fail('test: GOT DIFFERENT scope lengths FOR ' + desc, actual.scopes, expected.scopes);
		return;
	}
	for (let i = 0, len = actual.scopes.length; i < len; i++) {
		if (actual.scopes[i] !== expected.scopes[i]) {
			fail('test: GOT DIFFERENT scopes FOR ' + desc, actual.scopes, expected.scopes);
			return;
		}
	}
}

interface IMatcherTest {
	expression: string;
	input: string[];
	result: boolean;
}

export function runMatcherTests(testLocation: string) {
	let tests:IMatcherTest[] = JSON.parse(fs.readFileSync(testLocation).toString());

	var nameMatcher = (name: string, input: string[]) => {
		return input.indexOf(name) !== -1
	}
	var errCnt = 0;
	tests.forEach((test, index) => {
		var matcher = createMatcher(test.expression, nameMatcher);
		var result = matcher(test.input);
		if (result === test.result) {
			console.log(index + ': passed');
		} else {
			var message = index + ': failed , expected ' +  test.result;
			console.error((<any>message).red);
			errCnt++;
		}
	});
	if (errCnt === 0) {
		var msg = 'Test suite at ' + testLocation + ' finished ok';
		console.log((<any>msg).green);
	} else {
		var msg = 'Test suite at ' + testLocation + ' finished with ' + errCnt + ' errors.';
		console.log((<any>msg).red);
	}
}
