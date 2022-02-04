const path = require('path');
const fs = require('fs');
const main = require('../release/main');
const onigLibs = require('../out/tests/onigLibs');

const Registry = main.Registry;

const onigurumaRegistry = new Registry({ loadGrammar, onigLib: onigLibs.getOniguruma()});

function tokenize(grammar, content) {
	const start = Date.now();
	let ruleStack = null;
	for (let i = 0; i < content.length; i++) {
		const r = grammar.tokenizeLine(content[i], ruleStack);
		ruleStack = r.ruleStack;
	}
	return Date.now() - start;
}

async function tokenizeFile(filePath, scope, message) {
	const content = fs.readFileSync(filePath, 'utf8')
	const lines = content.split(/\r\n|\r|\n/);

	let onigurumaGrammar  = await onigurumaRegistry.loadGrammar(scope);
	let onigurumaTime = tokenize(onigurumaGrammar, lines);

	console.log();
	console.log(message);
	console.log('TOKENIZING ' + content.length + ' lines using grammar ' + scope);
	console.log(`Oniguruma: ${onigurumaTime} ms.`);
}

function loadGrammar(scopeName) {
	let grammarPath = null;
	if (scopeName === 'source.js') {
		grammarPath = path.resolve(__dirname, 'JavaScript.tmLanguage.json');
	} else if (scopeName === 'source.ts') {
		grammarPath = path.resolve(__dirname, '..', 'test-cases/themes/syntaxes/TypeScript.tmLanguage.json');
	} else if (scopeName === 'source.css') {
		grammarPath = path.resolve(__dirname, '..', 'test-cases/first-mate/fixtures/css.json');
	} else if (scopeName === 'source.json') {
		grammarPath = path.resolve(__dirname, '..', 'test-cases/themes/syntaxes/JSON.json');
	} else {
		return null;
	}
	return Promise.resolve(main.parseRawGrammar(fs.readFileSync(grammarPath).toString(), grammarPath));
}

async function test() {
	await tokenizeFile(path.join(__dirname, 'large.js.txt'), 'source.js', 'jQuery v2.0.3');
	await tokenizeFile(path.join(__dirname, 'bootstrap.css.txt'), 'source.css', 'Bootstrap CSS v3.1.1'),
	await tokenizeFile(path.join(__dirname, 'vscode.d.ts.txt'), 'source.ts', 'vscode.d.ts');
	await tokenizeFile(path.join(__dirname, 'JavaScript.tmLanguage.json.txt'), 'source.ts', 'JSON');
	await tokenizeFile(path.join(__dirname, 'bootstrap.min.css.txt'), 'source.css', 'Bootstrap CSS v3.1.1 minified')
	await tokenizeFile(path.join(__dirname, 'large.min.js.txt'), 'source.js', 'jQuery v2.0.3 minified');
	await tokenizeFile(path.join(__dirname, 'main.08642f99.css.txt'), 'source.css', 'Bootstrap with multi-byte minified')
	await tokenizeFile(path.join(__dirname, 'minified.js.txt'), 'source.js', 'Simple minified file');
};
test();


