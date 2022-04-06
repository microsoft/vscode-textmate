/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as assert from 'assert';
import { ScopeSelector } from '../scope';

let tests = [
	{ "expression": "foo", "input": ["foo"], "result": true },
	{ "expression": "foo", "input": ["bar"], "result": false },
	{ "expression": "- foo", "input": ["foo"], "result": false },
	{ "expression": "- foo", "input": ["bar"], "result": true },
	{ "expression": "- (- foo)", "input": ["bar"], "result": false },
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

tests.forEach((tst, index) => {
	test('Matcher Test #' + index, () => {
		let selector = new ScopeSelector(tst.expression);
		let result = selector.matches(tst.input);
		assert.strictEqual(result, tst.result);
	});
});
