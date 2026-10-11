/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { test } from 'vitest';
import * as assert from 'assert';
import { parseRawGrammar } from '../main';

test('JSON grammars load with uppercase file extensions', () => {
	const source = '{"scopeName":"source.example","patterns":[]}';
	const expected = parseRawGrammar(source, 'example.json');
	assert.deepStrictEqual(parseRawGrammar(source, 'example.JSON'), expected);
	assert.deepStrictEqual(parseRawGrammar(source, 'example.Json'), expected);
});
