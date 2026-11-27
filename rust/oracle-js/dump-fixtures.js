/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// Runs dump.js or fonts.js on VS Code's colorize test fixtures (extensions/vscode-colorize-tests/test/colorize-fixtures)
// instead of the corpora of env.js. Each fixture is tokenized with the grammar of the root scope that VS Code's own
// result for it (colorize-results) starts with; fixtures without a result or a registered grammar are skipped.
// Usage: VSCODE_ROOT=<vscode checkout> node dump-fixtures.js <data dir> dump|fonts (dump first, then fonts)
'use strict';
const fs = require('fs');
const path = require('path');
const env = require('./env');
const { ROOT, CORPORA, readGrammarContributions } = env;

const mode = process.argv[3];
if (mode !== 'dump' && mode !== 'fonts') {
	throw new Error('usage: node dump-fixtures.js <data dir> dump|fonts');
}
const TESTS = path.join(ROOT, 'extensions/vscode-colorize-tests/test');
const { grammars } = readGrammarContributions();
const fixtures = [];
const tags = new Set();
for (const file of fs.readdirSync(path.join(TESTS, 'colorize-fixtures')).sort()) {
	const resultPath = path.join(TESTS, 'colorize-results', file.replace('.', '_') + '.json');
	const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : [];
	const scope = result.length ? result[0].t.split(' ')[0] : undefined;
	if (!scope || !grammars.has(scope)) {
		console.error(`skipped ${file}: root scope ${scope}`);
		continue;
	}
	const name = `fixture ${file}`;
	const tag = name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40);
	if (tags.has(tag)) {
		throw new Error(`two fixtures have the tag ${tag}`);
	}
	tags.add(tag);
	fixtures.push({ name, scope, file: path.join(TESTS, 'colorize-fixtures', file) });
}
console.error(`${fixtures.length} fixtures`);
CORPORA.splice(0, CORPORA.length, ...fixtures);
require(mode === 'dump' ? './dump.js' : './fonts.js');
