/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import * as path from 'path';

export interface IOnigEngine {
	createOnigScanner(sources: string[]): OnigScanner;
	createOnigString(sources: string): OnigString;
}

export interface IOnigCaptureIndex {
	start: number;
	end: number;
	length: number;
}

export interface IOnigMatch {
    index: number;
    captureIndices: IOnigCaptureIndex[];
    scanner: OnigScanner;
}

export interface OnigScanner {
	findNextMatchSync(string: string | OnigString, startPosition: number): IOnigMatch;
}

export interface OnigString {
}

let onigasmEngine: Promise<IOnigEngine> = null;
let onigurumaEngine: Promise<IOnigEngine> = null;

export function getOnigasmEngine(): Promise<IOnigEngine> {
	if (!onigasmEngine) {
		let onigasmModule = require('onigasm');
		const wasmBin = fs.readFileSync(path.join(__dirname, '../node_modules/onigasm/lib/onigasm.wasm')).buffer;
		onigasmEngine = onigasmModule.loadWASM(wasmBin).then((_: any) => {
			return {
				createOnigScanner(patterns: string[]) { return new onigasmModule.OnigScanner(patterns); },
				createOnigString(s: string) { return new onigasmModule.OnigString(s); }
			};
		});
	}
	return onigasmEngine;
}

export function getOnigurumaEngine(): Promise<IOnigEngine> {
	if (!onigurumaEngine) {
		let getOnigModule : any = (function () {
			var onigurumaModule: any = null;
			return function () {
				if (!onigurumaModule) {
					onigurumaModule = require('oniguruma');
				}
				return onigurumaModule;
			};
		})();
		onigurumaEngine = Promise.resolve({
			createOnigScanner(patterns: string[]) {
				let onigurumaModule = getOnigModule();
				return new onigurumaModule.OnigScanner(patterns);
			},
			createOnigString(s: string) {
				let onigurumaModule = getOnigModule();
				return new onigurumaModule.OnigString(s);
			}
		});
	}
	return onigurumaEngine;
}