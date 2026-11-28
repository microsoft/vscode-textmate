/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// Shared setup of the JS oracle: loads vscode-textmate and vscode-oniguruma from a VS Code checkout (set
// VSCODE_ROOT to it, after `pnpm install`) and registers its built-in grammars and its 2026 Dark theme the way
// VS Code does. Set VSCODE_TEXTMATE_JS to the main.js of another vscode-textmate build, such as this repository's
// own (`npm run compile` emits it at out/src/main.js), to compare the port with it instead of the package VS Code
// installed.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.VSCODE_ROOT;
if (!ROOT || !fs.existsSync(path.join(ROOT, 'node_modules', 'vscode-textmate'))) {
	throw new Error('Set VSCODE_ROOT to a VS Code checkout with its dependencies installed (pnpm install).');
}
const VSCODE_TEXTMATE_JS = process.env.VSCODE_TEXTMATE_JS ? path.resolve(process.env.VSCODE_TEXTMATE_JS) : undefined;
const vsctm = require(VSCODE_TEXTMATE_JS || ROOT + '/node_modules/vscode-textmate/release/main.js');
const onig = require(ROOT + '/node_modules/vscode-oniguruma/release/main.js');
console.error(`vscode-textmate: ${VSCODE_TEXTMATE_JS || `${require(ROOT + '/node_modules/vscode-textmate/package.json').version} from VSCODE_ROOT`}`);
const onigVersion = require(ROOT + '/node_modules/vscode-oniguruma/package.json').version;
if (onigVersion !== '1.7.0') {
	console.warn(`vscode-oniguruma is ${onigVersion}; the port links the Oniguruma of 1.7.0 (6.9.8), so differences may come from the engine.`);
}
// jsonc-parser is not a direct dependency of VS Code: take the 3.x copy pnpm installed for others.
const jsoncDir = fs.readdirSync(ROOT + '/node_modules/.pnpm').filter(d => d.startsWith('jsonc-parser@3.')).sort().pop();
const jsonc = require(ROOT + `/node_modules/.pnpm/${jsoncDir}/node_modules/jsonc-parser/lib/umd/main.js`);

let wasmLoaded = null;
function loadOnig() {
	if (!wasmLoaded) {
		const data = fs.readFileSync(ROOT + '/node_modules/vscode-oniguruma/release/onig.wasm').buffer;
		wasmLoaded = onig.loadWASM({ data, print: () => { } });
	}
	return wasmLoaded;
}

const realOnigLib = {
	createOnigScanner: patterns => onig.createOnigScanner(patterns),
	createOnigString: s => onig.createOnigString(s),
};

function readGrammarContributions() {
	const grammars = new Map(); // scopeName -> contribution
	const injections = {}; // injectTo scope -> [scopeName]
	const languageIds = new Map();
	let nextLanguageId = 1;
	const langId = l => {
		if (!languageIds.has(l)) {
			languageIds.set(l, nextLanguageId++);
		}
		return languageIds.get(l);
	};
	for (const ext of fs.readdirSync(ROOT + '/extensions')) {
		const pj = path.join(ROOT, 'extensions', ext, 'package.json');
		if (!fs.existsSync(pj)) {
			continue;
		}
		let pkg;
		try { pkg = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { continue; }
		const contributed = pkg.contributes && pkg.contributes.grammars;
		if (!Array.isArray(contributed)) {
			continue;
		}
		for (const g of contributed) {
			if (!g.scopeName || !g.path) {
				continue;
			}
			const absPath = path.join(ROOT, 'extensions', ext, g.path);
			if (!fs.existsSync(absPath)) {
				continue;
			}
			grammars.set(g.scopeName, { ...g, absPath, ext });
			if (Array.isArray(g.injectTo)) {
				for (const target of g.injectTo) {
					(injections[target] = injections[target] || []).push(g.scopeName);
				}
			}
		}
	}
	for (const g of grammars.values()) {
		if (g.language) {
			langId(g.language);
		}
		for (const l of Object.values(g.embeddedLanguages || {})) {
			langId(l);
		}
	}
	return { grammars, injections, languageIds };
}

function loadThemeFile(file) {
	const json = jsonc.parse(fs.readFileSync(file, 'utf8'));
	let tokenColors = [];
	let colors = {};
	if (json.include) {
		const inc = loadThemeFile(path.join(path.dirname(file), json.include));
		tokenColors = inc.tokenColors;
		colors = inc.colors;
	}
	if (Array.isArray(json.tokenColors)) {
		tokenColors = tokenColors.concat(json.tokenColors);
	}
	colors = { ...colors, ...(json.colors || {}) };
	return { tokenColors, colors };
}

function loadDefaultTheme() {
	const t = loadThemeFile(ROOT + '/extensions/theme-defaults/themes/2026-dark.json');
	// Mirrors ColorThemeData.tokenColors: the default rule comes first.
	const settings = [{ settings: { foreground: t.colors['editor.foreground'] || '#D4D4D4', background: t.colors['editor.background'] || '#1E1E1E' } }];
	for (const r of t.tokenColors) {
		if (r && r.scope) {
			settings.push(r);
		}
	}
	return { name: '2026-dark', settings };
}

const TOKEN_TYPES = { string: 2, other: 0, comment: 1, regex: 3 };

async function createRegistry(onigLib) {
	await loadOnig();
	const { grammars, injections, languageIds } = readGrammarContributions();
	const registry = new vsctm.Registry({
		onigLib: Promise.resolve(onigLib || realOnigLib),
		loadGrammar: async scopeName => {
			const g = grammars.get(scopeName);
			if (!g) {
				return null;
			}
			return vsctm.parseRawGrammar(fs.readFileSync(g.absPath, 'utf8'), g.absPath);
		},
		getInjections: scopeName => {
			const parts = scopeName.split('.');
			let result = [];
			for (let i = 1; i <= parts.length; i++) {
				const sub = parts.slice(0, i).join('.');
				result = result.concat(injections[sub] || []);
			}
			return result;
		},
	});
	registry.setTheme(loadDefaultTheme());
	async function loadGrammar(scopeName) {
		const g = grammars.get(scopeName);
		const embeddedLanguages = {};
		for (const [scope, lang] of Object.entries(g.embeddedLanguages || {})) {
			embeddedLanguages[scope] = languageIds.get(lang);
		}
		const tokenTypes = {};
		for (const [scope, type] of Object.entries(g.tokenTypes || {})) {
			tokenTypes[scope] = TOKEN_TYPES[type] ?? 0;
		}
		return registry.loadGrammarWithConfiguration(scopeName, languageIds.get(g.language) || 0, {
			embeddedLanguages,
			tokenTypes,
			balancedBracketSelectors: g.balancedBracketScopes || ['*'],
			unbalancedBracketSelectors: g.unbalancedBracketScopes || [],
		});
	}
	return { registry, loadGrammar, grammars, injections };
}

function cssCorpus() {
	const out = [];
	let size = 0;
	const walk = dir => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (size > 1_000_000) {
				return;
			}
			const p = path.join(dir, e.name);
			if (e.isDirectory()) {
				walk(p);
			} else if (e.name.endsWith('.css')) {
				const t = fs.readFileSync(p, 'utf8');
				out.push(t);
				size += t.length;
			}
		}
	};
	walk(ROOT + '/src/vs');
	return out.join('\n');
}

// The files are those of VS Code main in November 2026; other checkouts may have other package versions in .pnpm.
const P = ROOT + '/node_modules/.pnpm/';
const CORPORA = [
	{ name: 'TypeScript (textModel.ts)', scope: 'source.ts', file: ROOT + '/src/vs/editor/common/model/textModel.ts' },
	{ name: 'TypeScript (agentService.ts, large)', scope: 'source.ts', file: ROOT + '/src/vs/platform/agentHost/node/agentService.ts' },
	{ name: 'JavaScript (react-dom.development.js)', scope: 'source.js', file: P + 'react-dom@17.0.2_react@17.0.2/node_modules/react-dom/cjs/react-dom.development.js' },
	{ name: 'C++ (koffi base.cc)', scope: 'source.cpp', file: P + 'koffi@3.2.1/node_modules/koffi/lib/native/base/base.cc' },
	{ name: 'C++ header (napi-inl.h)', scope: 'source.cpp', file: P + 'node-addon-api@8.9.2/node_modules/node-addon-api/napi-inl.h' },
	{ name: 'CSS (src/vs/**/*.css, ~1 MB)', scope: 'source.css', text: cssCorpus },
	{ name: 'Markdown (axios CHANGELOG.md)', scope: 'text.html.markdown', file: P + 'axios@1.20.0_debug@4.4.3/node_modules/axios/CHANGELOG.md' },
	{ name: 'HTML (bignumber.js API.html)', scope: 'text.html.basic', file: P + 'bignumber.js@9.3.1/node_modules/bignumber.js/doc/API.html' },
	{ name: 'Python (example.py)', scope: 'source.python', file: ROOT + '/extensions/copilot/src/extension/completions-core/vscode-node/prompt/src/test/testdata/example.py' },
];

function corpusText(c) {
	return typeof c.text === 'function' ? c.text() : fs.readFileSync(c.file, 'utf8');
}

function tokenizeAll(grammar, lines) {
	let state = vsctm.INITIAL;
	let tokens = 0;
	for (let i = 0; i < lines.length; i++) {
		const r = grammar.tokenizeLine2(lines[i], state, 0);
		state = r.ruleStack;
		tokens += r.tokens.length >> 1;
	}
	return { tokens, state };
}

module.exports = { ROOT, vsctm, onig, loadOnig, realOnigLib, createRegistry, CORPORA, corpusText, tokenizeAll, readGrammarContributions, loadDefaultTheme };
