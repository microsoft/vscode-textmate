/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import fs = require('fs');
import {IRawGrammar} from './types';
import {parse as parsePLIST} from './plistParser';

export function readGrammar(filePath:string, callback:(error:any, grammar:IRawGrammar)=>void): void {
	let reader = new AsyncGrammarReader(filePath, getGrammarParser(filePath));
	reader.load(callback);
}

export function readGrammarSync(filePath:string): IRawGrammar {
	let reader = new SyncGrammarReader(filePath, getGrammarParser(filePath));
	return reader.load();
}

interface IGrammarParser {
	(contents:string): IRawGrammar;
}

class AsyncGrammarReader {
	private _filePath: string;
	private _parser: IGrammarParser;

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
				r = this._parser(contents.toString());
			} catch (err) {
				callback(err, null);
				return;
			}
			callback(null, r);
		});
	}
}

class SyncGrammarReader {
	private _filePath: string;
	private _parser: IGrammarParser;

	constructor(filePath:string, parser:IGrammarParser) {
		this._filePath = filePath;
		this._parser = parser;
	}

	public load(): IRawGrammar {
		let contents = fs.readFileSync(this._filePath)
		return this._parser(contents.toString());
	}
}

function getGrammarParser(filePath:string): IGrammarParser {
	if (/\.json$/.test(filePath)) {
		return parseJSONGrammar;
	}
	return parsePLISTGrammar;
}

function parseJSONGrammar(contents:string): IRawGrammar {
	return <IRawGrammar>JSON.parse(contents.toString());
}

function parsePLISTGrammar(contents:string): IRawGrammar {
	let tmp:{ value: IRawGrammar, errors: string[]; };

	tmp = parsePLIST<IRawGrammar>(contents);

	if (tmp.errors && tmp.errors.length > 0) {
		throw new Error('Error parsing PLIST: ' + tmp.errors.join(','));
	}

	return tmp.value;
}
