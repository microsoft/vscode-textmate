/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import {IRawGrammar} from './types';
import * as plist from 'fast-plist';
import {CAPTURE_METADATA} from './debug';
import {parse as manualParseJSON} from './json';

export function readGrammar(filePath:string, callback:(error:any, grammar:IRawGrammar)=>void): void {
	let reader = new AsyncGrammarReader(filePath, getGrammarParser(filePath));
	reader.load(callback);
}

export function readGrammarSync(filePath:string): IRawGrammar {
	try {
		let reader = new SyncGrammarReader(filePath, getGrammarParser(filePath));
		return reader.load();
	} catch(err) {
		throw new Error('Error parsing ' + filePath + ': ' + err.message);
	}
}

interface IGrammarParser {
	(contents:string, filename:string): IRawGrammar;
}

class AsyncGrammarReader {
	private readonly _filePath: string;
	private readonly _parser: IGrammarParser;

	constructor(filePath:string, parser:IGrammarParser) {
		this._filePath = filePath;
		this._parser = parser;
	}

	public load(callback:(error:any, grammar:IRawGrammar)=>void): void {
		fs.readFile(this._filePath, (err, contents) => {
			if (err) {
				callback(err, null);
				return;
			}
			let r:IRawGrammar;
			try {
				r = this._parser(contents.toString(), this._filePath);
			} catch (err) {
				callback(err, null);
				return;
			}
			callback(null, r);
		});
	}
}

class SyncGrammarReader {
	private readonly _filePath: string;
	private readonly _parser: IGrammarParser;

	constructor(filePath:string, parser:IGrammarParser) {
		this._filePath = filePath;
		this._parser = parser;
	}

	public load(): IRawGrammar {
		let contents = fs.readFileSync(this._filePath);
		return this._parser(contents.toString(), this._filePath);
	}
}

function getGrammarParser(filePath:string): IGrammarParser {
	if (/\.json$/.test(filePath)) {
		return parseJSONGrammar;
	}
	return parsePLISTGrammar;
}

function parseJSONGrammar(contents:string, filename:string): IRawGrammar {
	if (CAPTURE_METADATA) {
		return <IRawGrammar>manualParseJSON(contents, filename, true);
	}
	return <IRawGrammar>JSON.parse(contents);
}

function parsePLISTGrammar(contents:string, filename:string): IRawGrammar {
	if (CAPTURE_METADATA) {
		return <IRawGrammar>plist.parseWithLocation(contents, filename, '$vscodeTextmateLocation');
	}
	return <IRawGrammar>plist.parse(contents);
}
