/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as tape from 'tape';
import { createMatchers } from '../matcher';

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
	tape('Matcher Test #' + index, (t: tape.Test) => {
		let matchers = createMatchers(test.expression, nameMatcher);
		let result = matchers.some(m => m.matcher(test.input));
		t.equal(result, test.result);
		t.end();
	});
});
