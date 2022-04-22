/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as assert from 'assert';
import { StandardTokenType } from '../main';
import { StackElementMetadata, OptionalStandardTokenType } from '../metadata';
import { FontStyle } from '../theme';

function assertEquals(metadata: number, languageId: number, tokenType: StandardTokenType, containsBalancedBrackets: boolean, fontStyle: FontStyle, foreground: number, background: number): void {
	const actual = {
		languageId: StackElementMetadata.getLanguageId(metadata),
		tokenType: StackElementMetadata.getTokenType(metadata),
		containsBalancedBrackets: StackElementMetadata.containsBalancedBrackets(metadata),
		fontStyle: StackElementMetadata.getFontStyle(metadata),
		foreground: StackElementMetadata.getForeground(metadata),
		background: StackElementMetadata.getBackground(metadata),
	};

	const expected = {
		languageId,
		tokenType,
		containsBalancedBrackets,
		fontStyle,
		foreground,
		background,
	};

	assert.deepStrictEqual(actual, expected, 'equals for ' + StackElementMetadata.toBinaryStr(metadata));
}

test('StackElementMetadata works', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
});

test('StackElementMetadata can overwrite languageId', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 2, OptionalStandardTokenType.NotSet, false, FontStyle.NotSet, 0, 0);
	assertEquals(value, 2, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
});

test('StackElementMetadata can overwrite tokenType', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.Comment, false, FontStyle.NotSet, 0, 0);
	assertEquals(value, 1, StandardTokenType.Comment, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
});

test('StackElementMetadata can overwrite font style', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.NotSet, false, FontStyle.None, 0, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.None, 101, 102);
});

test('StackElementMetadata can overwrite font style with strikethrough', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Strikethrough, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Strikethrough, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.NotSet, false, FontStyle.None, 0, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.None, 101, 102);
});

test('StackElementMetadata can overwrite foreground', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.NotSet, false, FontStyle.NotSet, 5, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 5, 102);
});

test('StackElementMetadata can overwrite background', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.NotSet, false, FontStyle.NotSet, 0, 7);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 7);
});

test('StackElementMetadata can overwrite balanced backet bit', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.NotSet, true, FontStyle.NotSet, 0, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, true, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.NotSet, false, FontStyle.NotSet, 0, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, false, FontStyle.Underline | FontStyle.Bold, 101, 102);
});

test('StackElementMetadata can work at max values', () => {
	const maxLangId = 255;
	const maxTokenType = StandardTokenType.Comment | StandardTokenType.Other | StandardTokenType.RegEx | StandardTokenType.String;
	const maxFontStyle = FontStyle.Bold | FontStyle.Italic | FontStyle.Underline;
	const maxForeground = 511;
	const maxBackground = 254;

	let value = StackElementMetadata.set(0, maxLangId, maxTokenType, true, maxFontStyle, maxForeground, maxBackground);
	assertEquals(value, maxLangId, maxTokenType, true, maxFontStyle, maxForeground, maxBackground);
});
