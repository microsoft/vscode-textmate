/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// Does vscode-oniguruma 1.7.0's result for an invalid pattern depend on earlier searches in the same WASM instance?
// Each sequence runs in a fresh process. Usage: VSCODE_ROOT=<vscode checkout> node garbage-history.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const BAD = '(';
const SHORT = 'abc abc';
const LONG = 'x'.repeat(1200) + 'abc';
const sequences = {
	'fresh: [bad] short@2': [[[BAD], SHORT, 2]],
	'[bad] long@1200, then [bad] short@2': [[[BAD], LONG, 1200], [[BAD], SHORT, 2]],
	'[bad] long@5, then [bad] short@2': [[[BAD], LONG, 5], [[BAD], SHORT, 2]],
	'[bad] long@0, then [bad] short@0': [[[BAD], LONG, 0], [[BAD], SHORT, 0]],
	'[b,bad] long@7, then [bad] short@3': [[['b', BAD], LONG, 7], [[BAD], SHORT, 3]],
	'[bad] long@1200 x3 new strings, then [bad] short@2': [[[BAD], LONG, 1200], [[BAD], LONG, 1200], [[BAD], LONG, 1200], [[BAD], SHORT, 2]],
	'[bad] long@1200, then [b] short@0 (valid only)': [[[BAD], LONG, 1200], [['b'], SHORT, 0]],
	'[bad] long@1200, then [bad,bad] short@2': [[[BAD], LONG, 1200], [[BAD, BAD], SHORT, 2]],
	'fresh: [bad,bad] short@2': [[[BAD, BAD], SHORT, 2]],
	'fresh: [bad,bad,bad] short@3': [[[BAD, BAD, BAD], SHORT, 3]],
	'fresh: [bad,bad] long@0': [[[BAD, BAD], LONG, 0]],
	'fresh: [bad,b,bad] long@0': [[[BAD, 'b', BAD], LONG, 0]],
	'fresh: [bad,"$"] short@0': [[[BAD, '$'], SHORT, 0]],
	'fresh: [bad] 999-byte@0 / 1000-byte@0': [[[BAD], 'y'.repeat(999), 0], [[BAD], 'y'.repeat(1000), 0]],
};
if (process.argv[2] === '--child') {
	const onigDir = path.join(process.env.VSCODE_ROOT, 'node_modules/vscode-oniguruma');
	const onig = require(path.join(onigDir, 'release/main.js'));
	(async () => {
		const wasm = fs.readFileSync(path.join(onigDir, 'release/onig.wasm'));
		await onig.loadWASM({ data: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), print() { } });
		const out = [];
		for (const [patterns, input, start] of sequences[process.argv[3]]) {
			try {
				const sc = new onig.OnigScanner(patterns);
				const s = new onig.OnigString(input);
				const m = sc.findNextMatchSync(s, start);
				out.push(m ? JSON.stringify({ index: m.index, captures: m.captureIndices.map(x => [x.start, x.end]) }) : 'null');
				s.dispose();
				sc.dispose();
			} catch (e) {
				out.push('throws: ' + e.message);
			}
		}
		console.log(out.join('  ->  '));
	})();
} else {
	for (const name of Object.keys(sequences)) {
		let r;
		try {
			r = execFileSync(process.execPath, [__filename, '--child', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
		} catch (e) {
			r = 'process failed: ' + String(e.stderr || e.message).split('\n').find(l => /Error|RuntimeError/.test(l));
		}
		console.log(`${name.padEnd(52)} ${r}`);
	}
}
