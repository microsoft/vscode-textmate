/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

export interface Matcher<T> {
	(matcherInput: T): boolean;
}

export function createMatcher<T>(expression: string, matchesName: (names: string[], matcherInput: T) => boolean): Matcher<T> {
	var tokenizer = newTokenizer(expression);
	var token = tokenizer.next();

	function parseOperand(): Matcher<T> {
		if (token === '-') {
			token = tokenizer.next();
			var expressionToNegate = parseOperand();
			return matcherInput => expressionToNegate && !expressionToNegate(matcherInput);
		}
		if (token === '(') {
			token = tokenizer.next();
			var expressionInParents = parseExpression('|');
			if (token === ')') {
				token = tokenizer.next();
			}
			return expressionInParents;
		}
		if (isIdentifier(token)) {
			var identifiers: string[] = [];
			do {
				identifiers.push(token);
				token = tokenizer.next();
			} while (isIdentifier(token));
			return matcherInput => matchesName(identifiers, matcherInput);
		}
		return null;
	}
	function parseConjunction(): Matcher<T> {
		var matchers: Matcher<T>[] = [];
		var matcher = parseOperand();
		while (matcher) {
			matchers.push(matcher);
			matcher = parseOperand();
		}
		return matcherInput => matchers.every(matcher => matcher(matcherInput)); // and
	}
	function parseExpression(orOperatorToken: string = ','): Matcher<T> {
		var matchers: Matcher<T>[] = [];
		var matcher = parseConjunction();
		while (matcher) {
			matchers.push(matcher);
			if (token === orOperatorToken) {
				do {
					token = tokenizer.next();
				} while (token === orOperatorToken); // ignore subsequent commas
			} else {
				break;
			}
			matcher = parseConjunction();
		}
		return matcherInput => matchers.some(matcher => matcher(matcherInput)); // or
	}

	return parseExpression() || (matcherInput => false);
}

function isIdentifier(token: string) {
	return token && token.match(/[\w\.:]+/);
}

function newTokenizer(input: string): { next: () => string } {
	let regex = /([\w\.:]+|[\,\|\-\(\)])/g;
	var match = regex.exec(input);
	return {
		next: () => {
			if (!match) {
				return null;
			}
			var res = match[0];
			match = regex.exec(input);
			return res;
		}
	};
}
