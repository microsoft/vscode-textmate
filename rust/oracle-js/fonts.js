/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// Dumps vscode-textmate's `fonts` for every line of the oracle corpora under two themes with font settings:
// a: the default theme plus font rules and a default ("") rule with a font, b: the same without the default rule.
// Also writes a hash of each corpus' binary tokens under that theme. It reads the lines dump.js wrote, so run
// dump.js first. Usage: VSCODE_ROOT=<vscode checkout> node fonts.js <data dir>
'use strict';
const fs = require('fs');
const path = require('path');
const { vsctm, createRegistry, CORPORA, loadDefaultTheme } = require('./env');
const OUT = path.resolve(process.argv[2] || 'data');

const FONT_RULES = [
	{ scope: 'comment', settings: { fontSize: 1.2 } },
	{ scope: 'comment.line', settings: { fontFamily: 'Line' } },
	{ scope: 'string', settings: { lineHeight: 1.5 } },
	{ scope: ['keyword', 'storage.type'], settings: { fontFamily: 'Kw' } },
	{ scope: 'markup.heading', settings: { fontFamily: 'Head', fontSize: 1.6, lineHeight: 2 } },
	{ scope: 'source.ts string', settings: { fontSize: 2 } },
	{ scope: 'entity.name.function', settings: { fontFamily: '', fontSize: 0 } },
	{ scope: 'variable', settings: { fontSize: '1.4' } },
	{ scope: 'punctuation.definition.string', settings: { fontFamily: 12, lineHeight: 1.25 } },
	{ scope: 'constant.numeric', settings: { fontSize: -1 } },
	{ scope: 'support, entity.name.type', settings: { fontFamily: 'Types' } },
	{ scope: 'meta.embedded', settings: { fontSize: 0.9 } },
];

function themeVariant(withDefault) {
	const t = loadDefaultTheme();
	const settings = [...t.settings, ...FONT_RULES];
	if (withDefault) {
		settings.push({ settings: { fontFamily: 'Default Mono', lineHeight: 1.1 } });
	}
	return { name: t.name + (withDefault ? '-fonts-a' : '-fonts-b'), settings };
}

(async () => {
	for (const [v, withDefault] of [['a', true], ['b', false]]) {
		const theme = themeVariant(withDefault);
		fs.writeFileSync(path.join(OUT, `theme-fonts-${v}.json`), JSON.stringify(theme));
		for (const c of CORPORA) {
			const { registry, loadGrammar } = await createRegistry();
			registry.setTheme(theme);
			const grammar = await loadGrammar(c.scope);
			const tag = c.name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40);
			// The lines of the token oracle, so that both oracles tokenize the same text.
			const lines = JSON.parse(fs.readFileSync(path.join(OUT, `corpus-${tag}.json`), 'utf8')).lines;
			let hash = 2166136261;
			let fonted = 0, ranges = 0;
			const out = [];
			let state = vsctm.INITIAL;
			for (const l of lines) {
				const r = grammar.tokenizeLine2(l, state, 0);
				state = r.ruleStack;
				hash = Math.imul(hash ^ r.tokens.length, 16777619) >>> 0;
				for (const n of r.tokens) {
					hash = Math.imul(hash ^ n, 16777619) >>> 0;
				}
				out.push(r.fonts.map(f => [f.startIndex, f.endIndex, f.fontFamily, f.fontSizeMultiplier, f.lineHeightMultiplier]));
				if (r.fonts.length) {
					fonted++;
					ranges += r.fonts.length;
				}
			}
			// Each line tokenized from the state rebuilt with diffStateStacksRefEq and applyStateStackDiff.
			const replay = [];
			let rebuilt = vsctm.INITIAL;
			for (const l of lines) {
				const r = grammar.tokenizeLine2(l, rebuilt, 0);
				rebuilt = vsctm.applyStateStackDiff(rebuilt, vsctm.diffStateStacksRefEq(rebuilt, r.ruleStack));
				replay.push(r.fonts.map(f => [f.startIndex, f.endIndex, f.fontFamily, f.fontSizeMultiplier, f.lineHeightMultiplier]));
			}
			fs.writeFileSync(path.join(OUT, `fonts-${v}-${tag}.json`), JSON.stringify({ hash, lines: out, replay }));
			console.log(JSON.stringify({ v, tag, lines: lines.length, linesWithFonts: fonted, ranges, hash, replayLinesWithFonts: replay.filter(f => f.length).length }));
		}
	}
})();
