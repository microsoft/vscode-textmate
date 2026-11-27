/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// Dumps the grammars, theme and corpora that env.js uses, with vscode-textmate's tokens for every line
// (tokenizeLine2 binary and tokenizeLine scopes), and times vscode-textmate + vscode-oniguruma (WASM) on the
// same lines. The output is the data directory of `cargo run --release --bin oracle -- <data dir>`.
// Usage: VSCODE_ROOT=<vscode checkout> node dump.js <data dir>
'use strict';
const fs = require('fs');
const path = require('path');
const { vsctm, createRegistry, CORPORA, corpusText, readGrammarContributions, loadDefaultTheme } = require('./env');
const OUT = path.resolve(process.argv[2] || 'data');
fs.mkdirSync(OUT, { recursive: true });
const TT = { string: 2, other: 0, comment: 1, regex: 3 };

(async () => {
	const { grammars, injections, languageIds } = readGrammarContributions();
	const prefixInjections = scope => {
		const parts = scope.split('.');
		let r = [];
		for (let i = 1; i <= parts.length; i++) { r = r.concat(injections[parts.slice(0, i).join('.')] || []); }
		return r;
	};
	const glist = [...grammars.values()].map(g => ({ scopeName: g.scopeName, path: g.absPath, injections: prefixInjections(g.scopeName) }));
	fs.writeFileSync(path.join(OUT, 'grammars.json'), JSON.stringify(glist));
	fs.writeFileSync(path.join(OUT, 'theme.json'), JSON.stringify(loadDefaultTheme()));
	const summary = [];
	for (const c of CORPORA) {
		const { registry, loadGrammar } = await createRegistry();
		const g = grammars.get(c.scope);
		const lines = corpusText(c).split(/\r\n|\r|\n/);
		let t0 = performance.now();
		const grammar = await loadGrammar(c.scope);
		const loadMs = performance.now() - t0;
		const bin = [], scopes = [];
		t0 = performance.now();
		let state = vsctm.INITIAL;
		for (const l of lines) { const r = grammar.tokenizeLine2(l, state, 0); state = r.ruleStack; bin.push(Array.from(r.tokens)); }
		const coldMs = performance.now() - t0;
		let warmMs = Infinity;
		for (let rep = 0; rep < 3; rep++) {
			t0 = performance.now();
			state = vsctm.INITIAL;
			for (const l of lines) { state = grammar.tokenizeLine2(l, state, 0).ruleStack; }
			warmMs = Math.min(warmMs, performance.now() - t0);
		}
		state = vsctm.INITIAL;
		for (const l of lines) { const r = grammar.tokenizeLine(l, state, 0); state = r.ruleStack; scopes.push(r.tokens.map(t => [t.startIndex, t.endIndex, t.scopes.join(' ')])); }
		const embeddedLanguages = {};
		for (const [s, lang] of Object.entries(g.embeddedLanguages || {})) { embeddedLanguages[s] = languageIds.get(lang); }
		const tokenTypes = Object.entries(g.tokenTypes || {}).map(([s, t]) => [s, TT[t] ?? 0]);
		const tag = c.name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40);
		fs.writeFileSync(path.join(OUT, `corpus-${tag}.json`), JSON.stringify({
			name: c.name, scope: c.scope, languageId: languageIds.get(g.language) || 0, embeddedLanguages, tokenTypes,
			balanced: g.balancedBracketScopes || ['*'], unbalanced: g.unbalancedBracketScopes || [], lines, bin, scopes,
		}));
		const s = { name: c.name, tag, lines: lines.length, tokens: bin.reduce((a, b) => a + b.length / 2, 0), jsGrammarLoadMs: +loadMs.toFixed(1), jsColdMs: +coldMs.toFixed(1), jsWarmMs: +warmMs.toFixed(1) };
		summary.push(s);
		console.log(JSON.stringify(s));
	}
	fs.writeFileSync(path.join(OUT, 'js-summary.json'), JSON.stringify(summary, null, 1));
})();
