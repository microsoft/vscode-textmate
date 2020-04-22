/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as tape from 'tape';
import { StandardTokenType } from '../main';
import { StackElementMetadata, TemporaryStandardTokenType } from '../grammar';
import { FontStyle } from '../theme';

function assertEquals(t: tape.Test, metadata: number, languageId: number, tokenType: StandardTokenType, fontStyle: FontStyle, foreground: number, background: number): void {
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

	t.deepEqual(actual, expected, 'equals for ' + StackElementMetadata.toBinaryStr(metadata));
}

tape('StackElementMetadata works', (t: tape.Test) => {
	let value = StackElementMetadata.set(0, 1, TemporaryStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(t, value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	t.end();
});

tape('StackElementMetadata can overwrite languageId', (t: tape.Test) => {
	let value = StackElementMetadata.set(0, 1, TemporaryStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(t, value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 2, TemporaryStandardTokenType.Other, FontStyle.NotSet, 0, 0);
	assertEquals(t, value, 2, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	t.end();
});

tape('StackElementMetadata can overwrite tokenType', (t: tape.Test) => {
	let value = StackElementMetadata.set(0, 1, TemporaryStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(t, value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, TemporaryStandardTokenType.Comment, FontStyle.NotSet, 0, 0);
	assertEquals(t, value, 1, StandardTokenType.Comment, FontStyle.Underline | FontStyle.Bold, 101, 102);
	t.end();
});

tape('StackElementMetadata can overwrite font style', (t: tape.Test) => {
	let value = StackElementMetadata.set(0, 1, TemporaryStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(t, value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, TemporaryStandardTokenType.Other, FontStyle.None, 0, 0);
	assertEquals(t, value, 1, StandardTokenType.RegEx, FontStyle.None, 101, 102);
	t.end();
});

tape('StackElementMetadata can overwrite foreground', (t: tape.Test) => {
	let value = StackElementMetadata.set(0, 1, TemporaryStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(t, value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, TemporaryStandardTokenType.Other, FontStyle.NotSet, 5, 0);
	assertEquals(t, value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 5, 102);
	t.end();
});

tape('StackElementMetadata can overwrite background', (t: tape.Test) => {
	let value = StackElementMetadata.set(0, 1, TemporaryStandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);
	assertEquals(t, value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 102);

	value = StackElementMetadata.set(value, 0, TemporaryStandardTokenType.Other, FontStyle.NotSet, 0, 7);
	assertEquals(t, value, 1, StandardTokenType.RegEx, FontStyle.Underline | FontStyle.Bold, 101, 7);
	t.end();
});

tape('StackElementMetadata can work at max values', (t: tape.Test) => {
	const maxLangId = 255;
	const maxTokenType = StandardTokenType.Comment | StandardTokenType.Other | StandardTokenType.RegEx | StandardTokenType.String;
	const maxFontStyle = FontStyle.Bold | FontStyle.Italic | FontStyle.Underline;
	const maxForeground = 511;
	const maxBackground = 511;

	let value = StackElementMetadata.set(0, maxLangId, maxTokenType, maxFontStyle, maxForeground, maxBackground);
	assertEquals(t, value, maxLangId, maxTokenType, maxFontStyle, maxForeground, maxBackground);
	t.end();
});
