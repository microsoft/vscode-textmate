/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// Compares two probe outputs (probe.js and engine_probe) case by case.
// Usage: node compare.js <js.txt> <rust.txt> [cases.json]
'use strict';
const fs = require('fs');
const path = require('path');

function readLines(file) {
	const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim().length > 0).map(l => JSON.parse(l));
	return { engine: lines[0].engine, results: new Map(lines.slice(1).map(l => [l.i, l.r])) };
}

const [aFile, bFile, casesFile] = process.argv.slice(2);
const a = readLines(aFile);
const b = readLines(bFile);
const cases = JSON.parse(fs.readFileSync(casesFile || path.join(__dirname, 'cases.json'), 'utf8'));

const show = s => JSON.stringify(s.length > 60 ? s.slice(0, 57) + '...' : s);
let same = 0;
const differs = [];
const compileErrors = [];
cases.forEach((c, i) => {
	const ra = a.results.get(i);
	const rb = b.results.get(i);
	if (rb && rb.error !== undefined) {
		compileErrors.push({ i, c, ra, rb });
	} else if (JSON.stringify(ra) === JSON.stringify(rb)) {
		same++;
	} else {
		differs.push({ i, c, ra, rb });
	}
});

console.log(`A: ${a.engine}`);
console.log(`B: ${b.engine}`);
console.log(`${cases.length} cases: ${same} identical, ${differs.length} differ, ${compileErrors.length} do not compile in B`);
if (differs.length) {
	console.log('\nDiffering cases:');
	for (const { i, c, ra, rb } of differs) {
		console.log(`  #${i} patterns=${JSON.stringify(c.patterns)} input=${show(c.input)} start=${c.start}`);
		console.log(`      A: ${JSON.stringify(ra)}`);
		console.log(`      B: ${JSON.stringify(rb)}`);
	}
}
if (compileErrors.length) {
	console.log('\nCases B rejects as invalid patterns (B printed the compile error; vscode-oniguruma 1.7.0 does not throw for an invalid pattern, and its result for one is not an engine match: run engine_probe --lenient to compare what the tokenizer gets):');
	for (const { i, c, ra, rb } of compileErrors) {
		console.log(`  #${i} patterns=${JSON.stringify(c.patterns)}: B: ${rb.error} | A: ${JSON.stringify(ra)}`);
	}
}
process.exitCode = differs.length ? 1 : 0;
