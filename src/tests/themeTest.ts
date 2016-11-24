/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { IEmbeddedLanguagesMap } from '../main';
import { tokenizeWithTheme, IThemedToken } from './themedTokenizer';
import { Resolver, ThemeData } from './themes.test';

interface IExpected {
	[theme: string]: IExpectedTokenization[];
}

interface IExpectedPatch {
	[theme: string]: IExpectedTokenizationPatch[];
}

export interface IExpectedTokenization {
	content: string;
	color: string;
	_r: string;
	_t: string;
}

interface IExpectedTokenizationPatch {
	index: number;
	content: string;
	color: string;
	newColor: string;
}

export class ThemeTest {

	private static _readFile(filename: string): string {
		try {
			return fs.readFileSync(filename).toString('utf8');
		} catch (err) {
			return null;
		}
	}

	private static _readJSONFile<T>(filename: string): T {
		try {
			return JSON.parse(this._readFile(filename));
		} catch (err) {
			return null;
		}
	}

	private readonly tests: SingleThemeTest[];

	private readonly THEMES_TEST_PATH: string;
	public readonly testName: string;
	// private readonly contents: string;
	// private readonly initialScopeName: string;
	// private readonly initialLanguage: number;
	// private readonly embeddedLanguages: IEmbeddedLanguagesMap;
	// private readonly expected: IExpected;
	// private readonly expectedPatch: IExpectedPatch;

	constructor(THEMES_TEST_PATH: string, testFile: string, resolver: Resolver) {
		this.THEMES_TEST_PATH = THEMES_TEST_PATH;
		const TEST_FILE_PATH = path.join(THEMES_TEST_PATH, 'tests', testFile);
		const testFileContents = ThemeTest._readFile(TEST_FILE_PATH);

		const EXPECTED_FILE_PATH = path.join(THEMES_TEST_PATH, 'tests', testFile + '.result');
		const testFileExpected = ThemeTest._readJSONFile<IExpected>(EXPECTED_FILE_PATH);

		const EXPECTED_PATCH_FILE_PATH = path.join(THEMES_TEST_PATH, 'tests', testFile + '.result.patch');
		console.log(EXPECTED_PATCH_FILE_PATH);
		const testFileExpectedPatch = ThemeTest._readJSONFile<IExpectedPatch>(EXPECTED_PATCH_FILE_PATH);

		// Determine the language
		let language = resolver.findLanguageByExtension(path.extname(testFile)) || resolver.findLanguageByFilename(testFile);
		if (!language) {
			throw new Error('Could not determine language for ' + testFile);
		}
		let grammar = resolver.findGrammarByLanguage(language);

		let embeddedLanguages: IEmbeddedLanguagesMap = Object.create(null);
		if (grammar.embeddedLanguages) {
			for (let scopeName in grammar.embeddedLanguages) {
				embeddedLanguages[scopeName] = resolver.language2id[grammar.embeddedLanguages[scopeName]];
			}
		}

		// console.log(testFileExpected);
		// console.log(testFileExpectedPatch);

		this.tests = [];
		for (let themeName in testFileExpected) {
			this.tests.push(new SingleThemeTest(
				themeName,
				testFile,
				testFileContents,
				grammar.scopeName,
				resolver.language2id[language],
				embeddedLanguages,
				testFileExpected[themeName],
				testFileExpectedPatch ? testFileExpectedPatch[themeName] : []
			));
		}

		this.testName = testFile;
		// this.contents = testFileContents;
		// this.initialScopeName = grammar.scopeName;
		// this.initialLanguage = resolver.language2id[language];
		// this.embeddedLanguages = embeddedLanguages;
		// this.expected = testFileExpected;
		// this.expectedPatch = testFileExpectedPatch;

		// assertTokenizationForThemes(test, themeDatas);
	}

	public evaluate(themeDatas: ThemeData[], callback: (err: any) => void): void {
		let testsMap: { [themeName: string]: SingleThemeTest; } = {};
		for (let i = 0; i < this.tests.length; i++) {
			testsMap[this.tests[i].themeName] = this.tests[i];
		}

		let remaining = themeDatas.length;
		let receiveResult = (err: any) => {
			if (err) {
				return callback(err);
			}
			remaining--;
			if (remaining === 0) {
				callback(null);
			}
		};

		for (let i = 0; i < themeDatas.length; i++) {
			testsMap[themeDatas[i].themeName].evaluate(themeDatas[i], receiveResult);
		}
	}

	private _getDiffPageData(): IDiffPageData[] {
		return this.tests.map(t => t.getDiffPageData());
	}

	public hasDiff(): boolean {
		for (let i = 0; i < this.tests.length; i++) {
			if (this.tests[i].patchedDiff.length > 0) {
				return true;
			}
		}
		return false;
	}

	public writeDiffPage(): void {
		let r = `<html><head>`;
		r += `\n<link rel="stylesheet" type="text/css" href="../diff.css"/>`;
		r += `\n<meta charset="utf-8">`;
		r += `\n</head><body>`;
		r += `\n<script>var allData = "${new Buffer(JSON.stringify(this._getDiffPageData())).toString('base64')}";</script>`;
		r += `\n<script type="text/javascript" src="../diff.js"></script>`;
		r += `\n</body></html>`;

		fs.writeFileSync(path.join(this.THEMES_TEST_PATH, 'tests', this.testName + '.diff.html'), r);
	}
}

interface ITokenizationDiff {
	oldIndex: number;
	oldToken: IExpectedTokenization;
	newToken: IThemedToken;
}

interface IDiffPageData {
	testContent: string;
	themeName: string;
	backgroundColor: string;
	actual: IThemedToken[];
	expected: IExpectedTokenization[];
	diff: ITokenizationDiff[];
	patchedExpected: IExpectedTokenization[];
	patchedDiff: ITokenizationDiff[];
}

class SingleThemeTest {

	public readonly themeName: string;
	private readonly testName: string;
	private readonly contents: string;
	private readonly initialScopeName: string;
	private readonly initialLanguage: number;
	private readonly embeddedLanguages: IEmbeddedLanguagesMap;
	private readonly expected: IExpectedTokenization[];
	private readonly patchedExpected: IExpectedTokenization[];
	private readonly expectedPatch: IExpectedTokenizationPatch[];

	private backgroundColor: string;
	public actual: IThemedToken[];
	public diff: ITokenizationDiff[];
	public patchedDiff: ITokenizationDiff[];

	constructor(
		themeName: string,
		testName: string,
		contents: string,
		initialScopeName: string,
		initialLanguage: number,
		embeddedLanguages: IEmbeddedLanguagesMap,
		expected: IExpectedTokenization[],
		expectedPatch: IExpectedTokenizationPatch[],
	) {
		this.themeName = themeName;
		this.testName = testName;
		this.contents = contents;
		this.initialScopeName = initialScopeName;
		this.initialLanguage = initialLanguage;
		this.embeddedLanguages = embeddedLanguages;
		this.expected = expected;
		this.expectedPatch = expectedPatch;

		this.patchedExpected = this.expected.slice(0);
		for (let i = 0; i < this.expectedPatch.length; i++) {
			let patch = this.expectedPatch[i];

			this.patchedExpected[patch.index] = {
				_r: this.patchedExpected[patch.index]._r,
				_t: this.patchedExpected[patch.index]._t,
				content: patch.content,
				color: patch.newColor
			};
		}

		this.backgroundColor = null;
		this.actual = null;
		this.diff = null;
		this.patchedDiff = null;
	}

	public evaluate(themeData: ThemeData, callback: (err: any) => void): void {
		this.backgroundColor = themeData.theme.settings[0].settings.background;

		this._tokenizeWithThemeAsync(themeData, (err, res) => {
			if (err) {
				return callback(err);
			}

			this.actual = res;
			this.diff = SingleThemeTest.computeThemeTokenizationDiff(this.actual, this.expected);
			this.patchedDiff = SingleThemeTest.computeThemeTokenizationDiff(this.actual, this.patchedExpected);

			return callback(null);
		});
	}

	public getDiffPageData(): IDiffPageData {
		return {
			testContent: this.contents,
			themeName: this.themeName,
			backgroundColor: this.backgroundColor,
			actual: this.actual,
			expected: this.expected,
			diff: this.diff,
			patchedExpected: this.patchedExpected,
			patchedDiff: this.patchedDiff
		};
	}

	private _tokenizeWithThemeAsync(themeData: ThemeData, callback: (err: any, res: IThemedToken[]) => void): void {
		themeData.registry.loadGrammarWithEmbeddedLanguages(this.initialScopeName, this.initialLanguage, this.embeddedLanguages, (err, grammar) => {
			if (err) {
				return callback(err, null);
			}
			let actual = tokenizeWithTheme(themeData.theme, themeData.registry.getColorMap(), this.contents, grammar);
			return callback(null, actual);
		});
	}

	private static computeThemeTokenizationDiff(actual: IThemedToken[], expected: IExpectedTokenization[]): ITokenizationDiff[] {
		let diffs: ITokenizationDiff[] = [];

		let i = 0, j = 0, len = actual.length, lenJ = expected.length;
		do {
			if (i >= len && j >= lenJ) {
				// ok
				break;
			}

			if (i >= len) {
				// will fail
				throw new Error('Reached end of actual before end of expected');
			}

			if (j >= lenJ) {
				// will fail
				throw new Error('Reached end of expected before end of actual');
			}

			let actualContent = actual[i].content;
			let actualColor = actual[i].color;
			if (actualColor.length > 7) {
				// TODO: remove alpha to match expected tests format
				actualColor = actualColor.substring(0, 7);
			}

			while (actualContent.length > 0 && j < lenJ) {
				let expectedContent = expected[j].content;
				let expectedColor = expected[j].color;

				let contentIsInvisible = /^\s+$/.test(expectedContent);
				if (!contentIsInvisible && actualColor !== expectedColor) {
					// console.log('COLOR MISMATCH: ', actualColor, expectedColor);
					// select the same token from the explanation
					let reducedExplanation = actual[i].explanation.filter((e) => e.content === expectedContent);
					if (reducedExplanation.length === 0) {
						reducedExplanation = actual[i].explanation;
					}
					diffs.push({
						oldIndex: j,
						oldToken: expected[j],
						newToken: {
							content: actual[i].content,
							color: actual[i].color,
							explanation: reducedExplanation
						}
					});
				}

				if (actualContent.substr(0, expectedContent.length) !== expectedContent) {
					throw new Error(`at ${actualContent} (${i}-${j}), content mismatch: ${actualContent}, ${expectedContent}`);
				}

				actualContent = actualContent.substr(expectedContent.length);

				j++;
			}

			i++;
		} while (true);

		return diffs;
	}

}
