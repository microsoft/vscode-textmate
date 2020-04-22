/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as tape from 'tape';
import * as fs from 'fs';
import * as path from 'path';
import * as durations from 'durations';

import { IGrammarRegistration, Resolver, ILanguageRegistration } from './resolver';
import { getOnigasm, getOniguruma, getVSCodeOniguruma } from './onigLibs';
import { Registry, StackElement } from '../main';

declare module 'durations';

tape.skip('Compare OnigLibs outputs', (t: tape.Test) => {
	let registrations = getVSCodeRegistrations();
	if (!registrations) {
		console.log('vscode repo ot found, skipping OnigLibs tests');
		return;
	}
	let onigurumaResolver = new Resolver(registrations.grammarRegistrations, registrations.languageRegistrations, getOniguruma(), 'oniguruma');
	let onigasmResolver = new Resolver(registrations.grammarRegistrations, registrations.languageRegistrations, getOnigasm(), 'onigasm');
	let vscodeOnigurumaResolver = new Resolver(registrations.grammarRegistrations, registrations.languageRegistrations, getVSCodeOniguruma(), 'vscode-oniguruma');

	const fixturesDir = path.join(__dirname, '../../test-cases/onigtests/fixtures');
	const fixturesFiles = fs.readdirSync(fixturesDir);
	for (let fixturesFile of fixturesFiles) {
		let testFilePath = path.join(fixturesDir, fixturesFile);
		let scopeName = onigurumaResolver.findScopeByFilename(fixturesFile);
		if (!scopeName) {
			throw new Error(`Cannot find scopeName for fixture ${fixturesFile}`);
		}
		addTest(scopeName, testFilePath, new Registry(onigurumaResolver), new Registry(onigasmResolver), new Registry(vscodeOnigurumaResolver));
	}
	t.end();
});

async function addTest(scopeName: string, filePath: string, onigurumaRegistry: Registry, onigasmRegistry: Registry, vscodeOnigurumaRegistry: Registry) {
	tape(scopeName + '/' + path.basename(filePath), { timeout: 1000000 }, async (t: tape.Test) => {
		const fileContent = fs.readFileSync(filePath).toString();
		let lines = fileContent.split(/\r\n|\r|\n/g);
		let prevState1: StackElement | null = null;
		let prevState2: StackElement | null = null;
		let prevState3: StackElement | null = null;

		let grammar1 = await onigurumaRegistry.loadGrammar(scopeName);
		let grammar2 = await onigasmRegistry.loadGrammar(scopeName);
		let grammar3 = await vscodeOnigurumaRegistry.loadGrammar(scopeName);

		if (!grammar1 || !grammar2 || !grammar3) {
			throw new Error(`Cannot load grammar for scope ${scopeName}`);
		}

		let stopWatch1 = durations.stopwatch();
		let stopWatch2 = durations.stopwatch();
		let stopWatch3 = durations.stopwatch();

		for (let i = 0; i < lines.length; i++) {
			stopWatch1.start();
			let t1 = grammar1.tokenizeLine(lines[i], prevState1);
			stopWatch1.stop();
			stopWatch2.start();
			let t2 = grammar2.tokenizeLine(lines[i], prevState2);
			stopWatch2.stop();
			t.deepEqual(t2.tokens, t1.tokens, `Difference in onigasm at line ${i}: ${lines[i]}`);
			stopWatch3.start();
			let t3 = grammar2.tokenizeLine(lines[i], prevState3);
			stopWatch3.stop();
			t.deepEqual(t3.tokens, t1.tokens, `Difference in vscode-oniguruma at line ${i}: ${lines[i]}`);
			prevState1 = t1.ruleStack;
			prevState2 = t2.ruleStack;
			prevState3 = t3.ruleStack;
		}
		console.log(`Oniguruma: ${stopWatch1.format()}, Onigasm: ${stopWatch2.format()} (${comparison(stopWatch2, stopWatch1)}), VSCodeOniguruma: ${stopWatch3.format()} (${comparison(stopWatch3, stopWatch1)})`);
		t.end();
	});
}

function comparison(actualSW: any, expectedSW: any): string {
	return _comparison(actualSW.duration().micros(), expectedSW.duration().micros());
}

function _comparison(actualTime: number, expectedTime: number): string {
	if (actualTime < expectedTime) {
		return `${(expectedTime / actualTime).toFixed(1)}x faster`;
	}
	return `${(actualTime / expectedTime).toFixed(1)}x slower`;
}

function getVSCodeRegistrations(): { grammarRegistrations: IGrammarRegistration[], languageRegistrations: ILanguageRegistration[] } | null {
	const grammarRegistrations: IGrammarRegistration[] = [];
	const languageRegistrations: ILanguageRegistration[] = [];

	const extensionsPath = path.join(__dirname, '../../../vscode/extensions');
	if (!fs.existsSync(extensionsPath)) {
		return null;
	}

	const extDirs = fs.readdirSync(extensionsPath);
	for (let ext of extDirs) {
		try {
			let packageJSONPath = path.join(extensionsPath, ext, 'package.json');
			if (!fs.existsSync(packageJSONPath)) {
				continue;
			}
			let packageJSON = JSON.parse(fs.readFileSync(packageJSONPath).toString());
			let contributes = packageJSON['contributes'];
			if (contributes) {
				let grammars = contributes['grammars'];
				if (Array.isArray(grammars)) {
					for (let grammar of grammars) {
						let registration: IGrammarRegistration = {
							scopeName: grammar.scopeName,
							path: path.join(extensionsPath, ext, grammar.path),
							language: grammar.language,
							embeddedLanguages: grammar.embeddedLanguages
						};
						grammarRegistrations.push(registration);
					}
				}
				let languages = contributes['languages'];
				if (Array.isArray(languages)) {
					for (let language of languages) {
						let registration: ILanguageRegistration = {
							id: language.id,
							filenames: language.filenames,
							extensions: language.extensions
						};
						languageRegistrations.push(registration);
					}
				}
			}
		} catch (e) {
			// i
		}
	}
	return { grammarRegistrations, languageRegistrations };
}
