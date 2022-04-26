/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { StandardTokenType } from "./main";
import { FontStyle } from "./theme";

export abstract class EncodedScopeMetadata {
	public static toBinaryStr(metadata: number): string {
		let r = metadata.toString(2);
		while (r.length < 32) {
			r = "0" + r;
		}
		return r;
	}

	public static printMetadata(metadata: number): void {
		const languageId = EncodedScopeMetadata.getLanguageId(metadata);
		const tokenType = EncodedScopeMetadata.getTokenType(metadata);
		const fontStyle = EncodedScopeMetadata.getFontStyle(metadata);
		const foreground = EncodedScopeMetadata.getForeground(metadata);
		const background = EncodedScopeMetadata.getBackground(metadata);

		console.log({
			languageId: languageId,
			tokenType: tokenType,
			fontStyle: fontStyle,
			foreground: foreground,
			background: background,
		});
	}

	public static getLanguageId(metadata: number): number {
		return (
			(metadata & EncodedScopeMetadataConsts.LANGUAGEID_MASK) >>>
			EncodedScopeMetadataConsts.LANGUAGEID_OFFSET
		);
	}

	public static getTokenType(metadata: number): StandardTokenType {
		return (
			(metadata & EncodedScopeMetadataConsts.TOKEN_TYPE_MASK) >>>
			EncodedScopeMetadataConsts.TOKEN_TYPE_OFFSET
		);
	}

	public static containsBalancedBrackets(metadata: number): boolean {
		return (metadata & EncodedScopeMetadataConsts.BALANCED_BRACKETS_MASK) !== 0;
	}

	public static getFontStyle(metadata: number): number {
		return (
			(metadata & EncodedScopeMetadataConsts.FONT_STYLE_MASK) >>>
			EncodedScopeMetadataConsts.FONT_STYLE_OFFSET
		);
	}

	public static getForeground(metadata: number): number {
		return (
			(metadata & EncodedScopeMetadataConsts.FOREGROUND_MASK) >>>
			EncodedScopeMetadataConsts.FOREGROUND_OFFSET
		);
	}

	public static getBackground(metadata: number): number {
		return (
			(metadata & EncodedScopeMetadataConsts.BACKGROUND_MASK) >>>
			EncodedScopeMetadataConsts.BACKGROUND_OFFSET
		);
	}

	/**
	 * Updates the fields in `metadata`.
	 * A value of `0`, `NotSet` or `null` indicates that the corresponding field should be left as is.
	 */
	public static set(
		metadata: number,
		languageId: number,
		tokenType: OptionalStandardTokenType,
		containsBalancedBrackets: boolean | null,
		fontStyle: FontStyle,
		foreground: number,
		background: number
	): number {
		let _languageId = EncodedScopeMetadata.getLanguageId(metadata);
		let _tokenType = EncodedScopeMetadata.getTokenType(metadata);
		let _containsBalancedBracketsBit: 0 | 1 =
			EncodedScopeMetadata.containsBalancedBrackets(metadata) ? 1 : 0;
		let _fontStyle = EncodedScopeMetadata.getFontStyle(metadata);
		let _foreground = EncodedScopeMetadata.getForeground(metadata);
		let _background = EncodedScopeMetadata.getBackground(metadata);

		if (languageId !== 0) {
			_languageId = languageId;
		}
		if (tokenType !== OptionalStandardTokenType.NotSet) {
			_tokenType = fromOptionalTokenType(tokenType);
		}
		if (containsBalancedBrackets !== null) {
			_containsBalancedBracketsBit = containsBalancedBrackets ? 1 : 0;
		}
		if (fontStyle !== FontStyle.NotSet) {
			_fontStyle = fontStyle;
		}
		if (foreground !== 0) {
			_foreground = foreground;
		}
		if (background !== 0) {
			_background = background;
		}

		return (
			((_languageId << EncodedScopeMetadataConsts.LANGUAGEID_OFFSET) |
				(_tokenType << EncodedScopeMetadataConsts.TOKEN_TYPE_OFFSET) |
				(_containsBalancedBracketsBit <<
					EncodedScopeMetadataConsts.BALANCED_BRACKETS_OFFSET) |
				(_fontStyle << EncodedScopeMetadataConsts.FONT_STYLE_OFFSET) |
				(_foreground << EncodedScopeMetadataConsts.FOREGROUND_OFFSET) |
				(_background << EncodedScopeMetadataConsts.BACKGROUND_OFFSET)) >>>
			0
		);
	}
}

/**
 * Helpers to manage the "collapsed" metadata of an entire StackElement stack.
 * The following assumptions have been made:
 *  - languageId < 256 => needs 8 bits
 *  - unique color count < 512 => needs 9 bits
 *
 * The binary format is:
 * - -------------------------------------------
 *     3322 2222 2222 1111 1111 1100 0000 0000
 *     1098 7654 3210 9876 5432 1098 7654 3210
 * - -------------------------------------------
 *     xxxx xxxx xxxx xxxx xxxx xxxx xxxx xxxx
 *     bbbb bbbb ffff ffff fFFF FBTT LLLL LLLL
 * - -------------------------------------------
 *  - L = LanguageId (8 bits)
 *  - T = StandardTokenType (2 bits)
 *  - B = Balanced bracket (1 bit)
 *  - F = FontStyle (4 bits)
 *  - f = foreground color (9 bits)
 *  - b = background color (9 bits)
 */
 export const enum EncodedScopeMetadataConsts {
	LANGUAGEID_MASK = 0b00000000000000000000000011111111,
	TOKEN_TYPE_MASK = 0b00000000000000000000001100000000,
	BALANCED_BRACKETS_MASK = 0b00000000000000000000010000000000,
	FONT_STYLE_MASK = 0b00000000000000000111100000000000,
	FOREGROUND_MASK = 0b00000000111111111000000000000000,
	BACKGROUND_MASK = 0b11111111000000000000000000000000,

	LANGUAGEID_OFFSET = 0,
	TOKEN_TYPE_OFFSET = 8,
	BALANCED_BRACKETS_OFFSET = 10,
	FONT_STYLE_OFFSET = 11,
	FOREGROUND_OFFSET = 15,
	BACKGROUND_OFFSET = 24
}

export function toOptionalTokenType(standardType: StandardTokenType): OptionalStandardTokenType {
	return standardType as any as OptionalStandardTokenType;
}

function fromOptionalTokenType(
	standardType:
		| OptionalStandardTokenType.Other
		| OptionalStandardTokenType.Comment
		| OptionalStandardTokenType.String
		| OptionalStandardTokenType.RegEx
): StandardTokenType {
	return standardType as any as StandardTokenType;
}

// Must have the same values as `StandardTokenType`!
export const enum OptionalStandardTokenType {
	Other = 0,
	Comment = 1,
	String = 2,
	RegEx = 3,
	// Indicates that no token type is set.
	NotSet = 8
}
