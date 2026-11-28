/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// What vscode-oniguruma 1.7.0 (the WASM build VS Code ships) does with a pattern Oniguruma rejects.
// Usage: VSCODE_ROOT=<vscode checkout with node_modules> node garbage.js
'use strict';
const fs = require('fs');
const path = require('path');
const onigDir = path.join(process.env.VSCODE_ROOT, 'node_modules/vscode-oniguruma');
const onig = require(path.join(onigDir, 'release/main.js'));
(async () => {
	const wasm = fs.readFileSync(path.join(onigDir, 'release/onig.wasm'));
	await onig.loadWASM({ data: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), print() { } });
	const fmt = m => m ? JSON.stringify({ index: m.index, captures: m.captureIndices.map(x => [x.start, x.end]) }) : 'null';
	const run = (label, patterns, input, start, { onigString = true, repeat = 1 } = {}) => {
		let out;
		try {
			const sc = new onig.OnigScanner(patterns);
			const str = onigString ? new onig.OnigString(input) : input;
			const res = [];
			for (let k = 0; k < repeat; k++) {
				res.push(fmt(sc.findNextMatchSync(str, start)));
			}
			if (onigString) { str.dispose(); }
			sc.dispose();
			out = [...new Set(res)].join(' | ');
		} catch (e) {
			out = 'throws: ' + e.message;
		}
		console.log(`${label.padEnd(58)} ${out}`);
	};
	const long = 'x'.repeat(1200) + 'abc';
	const nonAscii = 'ééé abc ééé';
	for (const bad of ['(', '[a', '\\p{Foo}', '^*', '(?<a>x)\\k<b>']) {
		console.log(`--- invalid pattern ${JSON.stringify(bad)}`);
		run('alone, short, start 0', [bad], 'abc abc', 0);
		run('alone, short, start 3', [bad], 'abc abc', 3);
		run('alone, short, start 7 (end)', [bad], 'abc abc', 7);
		run('alone, empty string', [bad], '', 0);
		run('alone, short, plain JS string, start 2', [bad], 'abc abc', 2, { onigString: false });
		run('alone, non-ASCII, start 4', [bad], nonAscii, 4);
		run('alone, 1203-byte string, start 0', [bad], long, 0);
		run('alone, 1203-byte string, start 1200', [bad], long, 1200);
		run('alone, short, same scanner x5, start 2', [bad], 'abc abc', 2, { repeat: 5 });
		run('[valid "b", bad], short, start 0', ['b', bad], 'abc abc', 0);
		run('[bad, valid "b"], short, start 0', [bad, 'b'], 'abc abc', 0);
		run('[valid "c", bad, valid "a"], short, start 3', ['c', bad, 'a'], 'abc abc', 3);
		run('[valid "b", bad], 1203-byte string, start 0', ['b', bad], long, 0);
		run('[bad, valid "b"], 1203-byte string, start 0', [bad, 'b'], long, 0);
		run('[valid "zzz" (no match), bad], short, start 1', ['zzz', bad], 'abc abc', 1);
		run('afterwards: valid ["b"] still works, start 0', ['b'], 'abc abc', 0);
		run('afterwards: valid ["b"] on 1203-byte string', ['b'], long, 0);
	}
	console.log('--- empty pattern list');
	run('[], short, start 0', [], 'abc abc', 0);
	run('[], 1203-byte string, start 0', [], long, 0);
	console.log('--- 1000-byte boundary (vscode-textmate searches line + "\\n")');
	run('alone "(", 999-byte string, start 0', ['('], 'x'.repeat(999), 0);
	run('alone "(", 1000-byte string, start 0', ['('], 'x'.repeat(1000), 0);
	run('[valid "x", "("], 999-byte string, start 5', ['x', '('], 'x'.repeat(999), 5);
	run('[valid "x", "("], 1000-byte string, start 5', ['x', '('], 'x'.repeat(1000), 5);
	console.log('--- valid patterns that onig_regset_new rejects (find-longest option)');
	run('alone "(?L)a", short, start 0', ['(?L)a'], 'xaa', 0);
	run('[valid "x", "(?L)a"], short, start 0', ['x', '(?L)a'], 'xaa', 0);
	run('alone "(?L)a", 1203-byte string, start 0', ['(?L)a'], long, 0);
	run('[valid "x", "(?L)a"], 1203-byte string, start 1200', ['x', '(?L)a'], long, 1200);
})();
