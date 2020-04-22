/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as tape from 'tape';
import { parse as JSONparse } from '../json';

function isValid(t: tape.Test, json: string): void {
	let expected = JSON.parse(json);
	let actual = JSONparse(json, null, false);
	t.deepEqual(actual, expected);

	// let actual2 = JSONparse(json, true);
	// assert.deepEqual(actual2, expected);
}

function isInvalid(t: tape.Test, json: string): void {
	let hadErr = false;
	try {
		JSONparse(json, null, false);
	} catch (err) {
		hadErr = true;
	}
	t.equal(hadErr, true, 'expected invalid: ' + json);
}

tape('JSON Invalid body', function (t: tape.Test) {
	isInvalid(t, '{}[]');
	isInvalid(t, '*');
	t.end();
});

tape('JSON Trailing Whitespace', function (t: tape.Test) {
	isValid(t, '{}\n\n');
	t.end();
});

tape('JSON Objects', function (t: tape.Test) {
	isValid(t, '{}');
	isValid(t, '{"key": "value"}');
	isValid(t, '{"key1": true, "key2": 3, "key3": [null], "key4": { "nested": {}}}');
	isValid(t, '{"constructor": true }');

	isInvalid(t, '{');
	isInvalid(t, '{3:3}');
	isInvalid(t, '{\'key\': 3}');
	isInvalid(t, '{"key" 3}');
	isInvalid(t, '{"key":3 "key2": 4}');
	isInvalid(t, '{"key":42, }');
	isInvalid(t, '{"key:42');
	t.end();
});

tape('JSON Arrays', function (t: tape.Test) {
	isValid(t, '[]');
	isValid(t, '[1, 2]');
	isValid(t, '[1, "string", false, {}, [null]]');

	isInvalid(t, '[');
	isInvalid(t, '[,]');
	isInvalid(t, '[1 2]');
	isInvalid(t, '[true false]');
	isInvalid(t, '[1, ]');
	isInvalid(t, '[[]');
	isInvalid(t, '["something"');
	isInvalid(t, '[magic]');
	t.end();
});

tape('JSON Strings', function (t: tape.Test) {
	isValid(t, '["string"]');
	isValid(t, '["\\"\\\\\\/\\b\\f\\n\\r\\t\\u1234\\u12AB"]');
	isValid(t, '["\\\\"]');

	isInvalid(t, '["');
	isInvalid(t, '["]');
	isInvalid(t, '["\\z"]');
	isInvalid(t, '["\\u"]');
	isInvalid(t, '["\\u123"]');
	isInvalid(t, '["\\u123Z"]');
	isInvalid(t, '[\'string\']');
	t.end();
});

tape('Numbers', function (t: tape.Test) {
	isValid(t, '[0, -1, 186.1, 0.123, -1.583e+4, 1.583E-4, 5e8]');

	// isInvalid(t, '[+1]');
	// isInvalid(t, '[01]');
	// isInvalid(t, '[1.]');
	// isInvalid(t, '[1.1+3]');
	// isInvalid(t, '[1.4e]');
	// isInvalid(t, '[-A]');
	t.end();
});

tape('JSON misc', function (t: tape.Test) {
	isValid(t, '{}');
	isValid(t, '[null]');
	isValid(t, '{"a":true}');
	isValid(t, '{\n\t"key" : {\n\t"key2": 42\n\t}\n}');
	isValid(t, '{"key":[{"key2":42}]}');
	isValid(t, '{\n\t\n}');
	isValid(t, '{\n"first":true\n\n}');
	isValid(t, '{\n"key":32,\n\n"key2":45}');
	isValid(t, '{"a": 1,\n\n"d": 2}');
	isValid(t, '{"a": 1, "a": 2}');
	isValid(t, '{"a": { "a": 2, "a": 3}}');
	isValid(t, '[{ "a": 2, "a": 3}]');
	isValid(t, '{"key1":"first string", "key2":["second string"]}');

	isInvalid(t, '{\n"key":32,\nerror\n}');
	t.end();
});
