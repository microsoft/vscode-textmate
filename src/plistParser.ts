/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import sax = require('sax');

interface PListObject {
	parent: PListObject;
	value: any;
	lastKey?: string;
}

let createParser = (function() {
	let saxModule: any = null;
	return function parser(strict:boolean, opt: sax.SAXOptions) {
		if (!saxModule) {
			saxModule = require('sax');
		}
		return saxModule.parser(strict, opt);
	}
})();

export function parseSAX<T>(content: string) : { value: T; errors: string[]; } {

	let errors : string[] = [];
	let currObject : PListObject = null;
	let result : any = null;

	let text: string = null;

	let parser = createParser(false, { lowercase: true });
	parser.onerror = (e:any) => {
		errors.push(e.message);
	};
	parser.ontext = (s: string) => {
		text = s;
	};
	parser.onopentag = (tag: sax.Tag) => {
		switch (tag.name) {
			case 'dict':
				currObject = { parent: currObject, value: {} };
				break;
			case 'array':
				currObject = { parent: currObject, value: [] };
				break;
			case 'key':
				if (currObject) {
					currObject.lastKey = null;
				}
				break;
		}
		text = '';
	}

	parser.onclosetag = (tagName:  string) => {
		let value: any;
		switch (tagName) {
			case 'key':
				if (!currObject || Array.isArray(currObject.value)) {
					errors.push('key can only be used inside an open dict element');
					return;
				}
				currObject.lastKey = text;
				return;
			case 'dict':
			case 'array':
				if (!currObject) {
					errors.push(tagName + ' closing tag found, without opening tag');
					return;
				}
				value = currObject.value;
				currObject = currObject.parent;
				break;
			case 'string':
			case 'data':
				value = text;
				break;
			case 'date':
				value = new Date(text);
				break;
			case 'integer':
				value = parseInt(text);
				if (isNaN(value)) {
					errors.push(text + ' is not a integer');
					return;
				}
				break;
			case 'real':
				value = parseFloat(text);
				if (isNaN(value)) {
					errors.push(text + ' is not a float');
					return;
				}
				break;
			case 'true':
				value = true;
				break;
			case 'false':
				value = false;
				break;
			case 'plist':
				return;
			default:
				errors.push('Invalid tag name: ' + tagName);
				return;

		}
		if (!currObject) {
			result = value;
		} else if (Array.isArray(currObject.value)) {
			currObject.value.push(value);
		} else {
			if (currObject.lastKey) {
				currObject.value[currObject.lastKey] = value;
			} else {
				errors.push('Dictionary key missing for value ' + value);
			}
		}
	};
	parser.write(content);
	return { errors: errors, value: result };
}

/**
 * A very fast plist parser
 */
function _parse(file: string): any {
	const len = file.length;

	let i = 0;

	// Skip UTF8 BOM
	if (len > 0 && file.charCodeAt(0) === 65279) {
		i = 1;
	}

	function skipWhitespace(): void {
		while (i < len) {
			let chCode = file.charCodeAt(i);
			if (chCode !== 32 /*<space>*/ && chCode !== 9 /*<tab>*/ && chCode !== 13 /*<CarriageReturn>*/ && chCode !== 10/*<LineFeed>*/) {
				break;
			}
			i++;
		}
	}

	function advanceIfStartsWith(str:string): boolean {
		if (file.substr(i, str.length) === str) {
			i += str.length;
			return true;
		}
		return false;
	}

	function advanceUntil(str:string): void {
		let nextOccurence = file.indexOf(str, i);
		if (nextOccurence !== -1) {
			i = nextOccurence + str.length;
		} else {
			// EOF
			i = len;
		}
	}

	function captureUntil(str:string): string {
		let nextOccurence = file.indexOf(str, i);
		if (nextOccurence !== -1) {
			let r = file.substring(i, nextOccurence);
			i = nextOccurence + str.length;
			return r;
		} else {
			// EOF
			let r = file.substr(i);
			i = len;
			return r;
		}
	}

	const ROOT_STATE = 0;
	const DICT_STATE = 1;
	const ARR_STATE = 2;

	let state = ROOT_STATE;

	let cur:any = {};
	let stateStack:number[] = [];
	let objStack:any[] = [];
	let curKey:string = null;

	function pushState(newState:number, newCur:any): void {
		stateStack.push(state);
		objStack.push(cur);
		state = newState;
		cur = newCur;
	}

	function popState(): void {
		state = stateStack.pop();
		cur = objStack.pop();
	}

	function fail(msg:string): void {
		throw new Error('Near offset ' + i + ': ' + msg + ' ~~~' + file.substr(i, 50) + '~~~');
	}

	const dictState = {
		enterDict: function() {
			if (curKey === null) {
				fail('missing <key>');
			}
			let newDict = {};
			cur[curKey] = newDict;
			curKey = null;
			pushState(DICT_STATE, newDict);
		},
		enterArray: function() {
			if (curKey === null) {
				fail('missing <key>');
			}
			let newArr:any[] = [];
			cur[curKey] = newArr;
			curKey = null;
			pushState(ARR_STATE, newArr);
		}
	};

	const arrState = {
		enterDict: function() {
			let newDict = {};
			cur.push(newDict);
			pushState(DICT_STATE, newDict);
		},
		enterArray: function() {
			let newArr:any[] = [];
			cur.push(newArr);
			pushState(ARR_STATE, newArr);
		}
	};


	function enterDict() {
		if (state === DICT_STATE) {
			dictState.enterDict();
		} else if (state === ARR_STATE) {
			arrState.enterDict();
		} else { // ROOT_STATE
			pushState(DICT_STATE, cur);
		}
	}
	function leaveDict() {
		if (state === DICT_STATE) {
			popState();
		} else if (state === ARR_STATE) {
			fail('unexpected </dict>');
		} else { // ROOT_STATE
			fail('unexpected </dict>');
		}
	}
	function enterArray() {
		if (state === DICT_STATE) {
			dictState.enterArray();
		} else if (state === ARR_STATE) {
			arrState.enterArray();
		} else { // ROOT_STATE
			fail('unexpected <array>');
		}
	}
	function leaveArray() {
		if (state === DICT_STATE) {
			fail('unexpected </array>');
		} else if (state === ARR_STATE) {
			popState();
		} else { // ROOT_STATE
			fail('unexpected </array>');
		}
	}
	function acceptKey(val:string) {
		if (state === DICT_STATE) {
			if (curKey !== null) {
				fail('too many <key>');
			}
			curKey = val;
		} else if (state === ARR_STATE) {
			fail('unexpected <key>');
		} else { // ROOT_STATE
			fail('unexpected <key>');
		}
	}
	function acceptString(val:string) {
		if (state === DICT_STATE) {
			if (curKey === null) {
				fail('missing <key>');
			}
			cur[curKey] = val;
			curKey = null;
		} else if (state === ARR_STATE) {
			cur.push(val);
		} else { // ROOT_STATE
			fail('unexpected <string>');
		}
	}
	function acceptReal(val:number) {
		if (state === DICT_STATE) {
			if (curKey === null) {
				fail('missing <key>');
			}
			cur[curKey] = val;
			curKey = null;
		} else if (state === ARR_STATE) {
			cur.push(val);
		} else { // ROOT_STATE
			fail('unexpected <real>');
		}
	}
	function acceptInteger(val:number) {
		if (state === DICT_STATE) {
			if (curKey === null) {
				fail('missing <key>');
			}
			cur[curKey] = val;
			curKey = null;
		} else if (state === ARR_STATE) {
			cur.push(val);
		} else { // ROOT_STATE
			fail('unexpected <integer>');
		}
	}
	function acceptDate(val:Date) {
		if (state === DICT_STATE) {
			if (curKey === null) {
				fail('missing <key>');
			}
			cur[curKey] = val;
			curKey = null;
		} else if (state === ARR_STATE) {
			cur.push(val);
		} else { // ROOT_STATE
			fail('unexpected <date>');
		}
	}
	function acceptData(val:string) {
		if (state === DICT_STATE) {
			if (curKey === null) {
				fail('missing <key>');
			}
			cur[curKey] = val;
			curKey = null;
		} else if (state === ARR_STATE) {
			cur.push(val);
		} else { // ROOT_STATE
			fail('unexpected <data>');
		}
	}
	function acceptBool(val:boolean) {
		if (state === DICT_STATE) {
			if (curKey === null) {
				fail('missing <key>');
			}
			cur[curKey] = val;
			curKey = null;
		} else if (state === ARR_STATE) {
			cur.push(val);
		} else { // ROOT_STATE
			fail('unexpected <true> or <false>');
		}
	}

	function escapeVal(str:string): string {
		return str.replace(/&#([0-9]+);/g, function(_:string, m0:string) {
			return (<any>String).fromCodePoint(parseInt(m0, 10));
		}).replace(/&#x([0-9a-f]+);/g, function(_:string, m0:string) {
			return (<any>String).fromCodePoint(parseInt(m0, 16));
		}).replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, function(_:string) {
			switch (_) {
				case '&amp;': return '&';
				case '&lt;': return '<';
				case '&gt;': return '>';
				case '&quot;': return '"';
				case '&apos;': return '\'';
			}
			return _;
		})
	}

	interface IParsedTag {
		name: string;
		isClosed: boolean;
	}

	function parseOpenTag(): IParsedTag {
		let r = captureUntil('>');
		let isClosed = false;
		if (r.charCodeAt(r.length - 1) === 47 /*/*/) {
			isClosed = true;
			r = r.substring(0, r.length - 1);
		}

		return {
			name: r.trim(),
			isClosed: isClosed
		};
	}

	function parseTagValue(tag:IParsedTag): string {
		if (tag.isClosed) {
			return '';
		}
		let val = captureUntil('</');
		advanceUntil('>');
		return escapeVal(val);
	}

	while (i < len) {
		skipWhitespace();
		if (i >= len) {
			break;
		}

		const chCode = file.charCodeAt(i++);
		if (chCode !== 60 /*<*/) {
			fail('expected <');
		}

		if (i >= len) {
			fail('unexpected end of input');
		}

		const peekChCode = file.charCodeAt(i);

		if (peekChCode === 63 /*?*/) {
			i++;
			advanceUntil('?>');
			continue;
		}

		if (peekChCode === 33 /*!*/) {
			i++;

			if (advanceIfStartsWith('--')) {
				advanceUntil('-->');
				continue;
			}

			advanceUntil('>');
			continue;
		}

		if (peekChCode === 47 /*/*/) {
			i++;
			skipWhitespace();

			if (advanceIfStartsWith('plist')) {
				advanceUntil('>');
				continue;
			}

			if (advanceIfStartsWith('dict')) {
				advanceUntil('>');
				leaveDict();
				continue;
			}

			if (advanceIfStartsWith('array')) {
				advanceUntil('>');
				leaveArray();
				continue;
			}

			fail('unexpected closed tag');
		}

		let tag = parseOpenTag();

		switch (tag.name) {
			case 'dict':
				enterDict();
				if (tag.isClosed) {
					leaveDict();
				}
				continue;

			case 'array':
				enterArray();
				if (tag.isClosed) {
					leaveArray();
				}
				continue;

			case 'key':
				acceptKey(parseTagValue(tag));
				continue;

			case 'string':
				acceptString(parseTagValue(tag));
				continue;

			case 'real':
				acceptReal(parseFloat(parseTagValue(tag)));
				continue;

			case 'integer':
				acceptInteger(parseInt(parseTagValue(tag), 10));
				continue;

			case 'date':
				acceptDate(new Date(parseTagValue(tag)));
				continue;

			case 'data':
				acceptData(parseTagValue(tag));
				continue;

			case 'true':
				acceptBool(true);
				continue;

			case 'false':
				acceptBool(false);
				continue;
		}

		if (/^plist/.test(tag.name)) {
			continue;
		}

		fail('unexpected opened tag ' + tag.name);
	}

	return cur;
}

export function parse<T>(content: string) : { value: T; errors: string[]; } {
	try {
		return {
			value: _parse(content),
			errors: []
		};
	} catch(err) {
		return {
			value: null,
			errors:[err.message]
		}
	}
}
