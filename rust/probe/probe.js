/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// Runs cases.json through vscode-oniguruma 1.7.0 (the WASM build VS Code ships), one JSON line per case.
// Usage: VSCODE_ROOT=<vscode checkout with node_modules> node probe.js [cases.json]
'use strict';
const fs = require('fs');
const path = require('path');
const root = process.env.VSCODE_ROOT;
const onigDir = path.join(root, 'node_modules/vscode-oniguruma');
const onig = require(path.join(onigDir, 'release/main.js'));
const version = JSON.parse(fs.readFileSync(path.join(onigDir, 'package.json'), 'utf8')).version;
(async () => {
	const wasm = fs.readFileSync(path.join(onigDir, 'release/onig.wasm'));
	await onig.loadWASM({ data: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), print() { } });
	const cases = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, 'cases.json'), 'utf8'));
	console.log(JSON.stringify({ engine: 'vscode-oniguruma ' + version }));
	cases.forEach((c, i) => {
		let r;
		try {
			const sc = new onig.OnigScanner(c.patterns);
			const m = sc.findNextMatchSync(c.input, c.start);
			r = m ? { index: m.index, captures: m.captureIndices.map(x => [x.start, x.end]) } : null;
			sc.dispose();
		} catch (e) {
			r = { error: String(e.message) };
		}
		console.log(JSON.stringify({ i, r }));
	});
})();
