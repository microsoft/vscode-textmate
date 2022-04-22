/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IGrammar, StackElement } from '../main';
import { StackElementMetadata } from '../metadata';

export interface IThemedToken {
	content: string;
	color: string;
}

export function tokenizeWithTheme(colorMap: string[], fileContents: string, grammar: IGrammar): IThemedToken[] {

	const lines = fileContents.split(/\r\n|\r|\n/);

	let ruleStack: StackElement | null = null;
	let actual: IThemedToken[] = [], actualLen = 0;

	for (let i = 0, len = lines.length; i < len; i++) {
		const line = lines[i];
		const result = grammar.tokenizeLine2(line, ruleStack);
		const tokensLength = result.tokens.length / 2;
		for (let j = 0; j < tokensLength; j++) {
			const startIndex = result.tokens[2 * j];
			const nextStartIndex = j + 1 < tokensLength ? result.tokens[2 * j + 2] : line.length;
			const tokenText = line.substring(startIndex, nextStartIndex);
			if (tokenText === '') {
				continue;
			}
			const metadata = result.tokens[2 * j + 1];
			const foreground = StackElementMetadata.getForeground(metadata);
			const foregroundColor = colorMap[foreground];

			actual[actualLen++] = {
				content: tokenText,
				color: foregroundColor
			};
		}
		ruleStack = result.ruleStack;
	}

	return actual;
}
