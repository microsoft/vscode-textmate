/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// Tokenizes invalid-grammar.json, a grammar with patterns Oniguruma rejects, with vscode-textmate 9.3.2 on
// vscode-oniguruma 1.7.0 (what VS Code ships), and prints the tokens in the format of src/bin/invalid_grammar.rs.
// Usage: VSCODE_ROOT=<vscode checkout with node_modules> node invalid-grammar.js
'use strict';
const fs = require('fs');
const path = require('path');
const onigDir = path.join(process.env.VSCODE_ROOT, 'node_modules/vscode-oniguruma');
const onig = require(path.join(onigDir, 'release/main.js'));
const vsctm = require(path.join(process.env.VSCODE_ROOT, 'node_modules/vscode-textmate/release/main.js'));
(async () => {
	const wasm = fs.readFileSync(path.join(onigDir, 'release/onig.wasm'));
	await onig.loadWASM({ data: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), print() { } });
	const content = fs.readFileSync(path.join(__dirname, 'invalid-grammar.json'), 'utf8');
	const registry = new vsctm.Registry({
		onigLib: Promise.resolve({ createOnigScanner: p => new onig.OnigScanner(p), createOnigString: s => new onig.OnigString(s) }),
		loadGrammar: async scopeName => scopeName === 'source.invalid' ? vsctm.parseRawGrammar(content, 'invalid-grammar.json') : null,
	});
	const grammar = await registry.loadGrammar('source.invalid');
	const fill = (n, s) => '-'.repeat(n) + s;
	// Lines of 999 bytes or more (with the "\n" the tokenizer appends, 1000) take vscode-oniguruma's long-string path.
	const cases = [
		['foo [x(x] foo', 'x] foo', fill(1100, 'x] foo'), 'foo'],
		['[', fill(997, ']'), fill(998, ']')],
		['{ a } b', fill(1100, '} foo'), 'foo'],
		['( a ) b', fill(1100, ') foo'), 'foo'],
		['>start', 'still', fill(1100, ''), 'after foo'],
		['abc<mid>abc( tail', '<<after', 'bar', 'x bar foo'],
		['<<after', 'bar', 'x bar foo', fill(1100, '<<x a foo'), 'foo bar'],
		// An all-invalid scanner's empty match runs into the endless-loop guards: [4] with a match rule first, [1] when
		// the begin was an empty match too.
		['a ! b foo', 'foo', fill(1100, '! x foo'), 'foo bar'],
		['a %b foo', 'foo', fill(1100, '%b foo'), 'foo'],
	];
	cases.forEach((lines, i) => {
		console.log(`=== case ${i + 1}`);
		let state = vsctm.INITIAL;
		for (const line of lines) {
			const r = grammar.tokenizeLine(line, state);
			console.log(JSON.stringify(line));
			for (const t of r.tokens) {
				console.log(`  ${t.startIndex}-${t.endIndex} ${t.scopes.join(' ')}`);
			}
			state = r.ruleStack;
		}
	});
})();
