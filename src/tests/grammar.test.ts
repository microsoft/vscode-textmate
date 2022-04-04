/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as assert from 'assert';
import { StandardTokenType } from '../main';
import { StackElementMetadata, OptionalStandardTokenType } from '../grammar';
import { FontStyle } from '../theme';

function assertEquals(metadata: number, languageId: number, tokenType: StandardTokenType, fontStyle: FontStyle, foreground: number, background: number): void {
	let actual = {
		languageId: StackElementMetadata.getLanguageId(metadata),
		tokenType: StackElementMetadata.getTokenType(metadata),
		fontStyle: StackElementMetadata.getFontStyle(metadata),
		foreground: StackElementMetadata.getForeground(metadata),
		background: StackElementMetadata.getBackground(metadata),
	};

	let expected = {
		languageId: languageId,
		tokenType: tokenType,
		fontStyle: fontStyle,
		foreground: foreground,
		background: background,
	};

	assert.deepStrictEqual(actual, expected, 'equals for ' + StackElementMetadata.toBinaryStr(metadata));
}

test('StackElementMetadata works', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
});

test('StackElementMetadata can overwrite languageId', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 2, OptionalStandardTokenType.NotSet, FontStyle.NotSet, 0, 0);
	assertEquals(value, 2, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
});

test('StackElementMetadata can overwrite tokenType', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.Comment, FontStyle.NotSet, 0, 0);
	assertEquals(value, 1, StandardTokenType.Comment, FontStyle.Underline | FontStyle.Bold, 101, 102);
});

test('StackElementMetadata can overwrite font style', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.NotSet, FontStyle.None, 0, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, FontStyle.None, 101, 102);
});

test('StackElementMetadata can overwrite font style with strikethrough', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, FontStyle.Strikethrough, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, FontStyle.Strikethrough, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.NotSet, FontStyle.None, 0, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, FontStyle.None, 101, 102);
});

test('StackElementMetadata can overwrite foreground', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.NotSet, FontStyle.NotSet, 5, 0);
	assertEquals(value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 5, 102);
});

test('StackElementMetadata can overwrite background', () => {
	let value = StackElementMetadata.set(0, 1, OptionalStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, OptionalStandardTokenType.NotSet, FontStyle.NotSet, 0, 7);
	assertEquals(value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 7);
});

test('StackElementMetadata can work at max values', () => {
	const maxLangId = 255;
	const maxTokenType = StandardTokenType.Comment | StandardTokenType.Other | StandardTokenType.RegEx | StandardTokenType.String;
	const maxFontStyle = FontStyle.Bold | FontStyle.Italic | FontStyle.Underline;
	const maxForeground = 511;
	const maxBackground = 511;

	let value = StackElementMetadata.set(0, maxLangId, maxTokenType, maxFontStyle, maxForeground, maxBackground);
	assertEquals(value, maxLangId, maxTokenType, maxFontStyle, maxForeground, maxBackground);
});
