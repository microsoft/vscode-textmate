var path = require('path');
var fs = require('fs');
var Registry = require('../release/main').Registry;

var registry = new Registry();
var jsGrammar = registry.loadGrammarFromPathSync(path.resolve(__dirname, '..', 'test-cases', 'first-mate', 'fixtures', 'javascript.json'))
var cssGrammar = registry.loadGrammarFromPathSync(path.resolve(__dirname, '..', 'test-cases', 'first-mate', 'fixtures', 'css.json'))

function tokenize(grammar, content) {
	console.log('TOKENIZING ' + content.length + ' lines using grammar ' + grammar._grammar.scopeName);
	var start = Date.now();
	var ruleStack = null;
	for (var i = 0; i < content.length; i++) {
		var r = grammar.tokenizeLine(content[i], ruleStack);
		ruleStack = r.ruleStack;
	}
	var duration = Date.now() - start
	console.log('TOOK ' + duration + ' ms.');
}

function tokenizeFile(filePath, grammar, message) {
	console.log();
	console.log(message);
	var content = fs.readFileSync(filePath, 'utf8')
	tokenize(grammar, content.split(/\r\n|\r|\n/));
}

tokenizeFile(path.join(__dirname, 'main.08642f99.css.txt'), cssGrammar, 'Tokenizing Bootstrap with multi-byte')

tokenizeFile(path.join(__dirname, 'large.js.txt'), jsGrammar, 'Tokenizing jQuery v2.0.3')
tokenizeFile(path.join(__dirname, 'large.min.js.txt'), jsGrammar, 'Tokenizing jQuery v2.0.3 minified')
tokenizeFile(path.join(__dirname, 'bootstrap.css.txt'), cssGrammar, 'Tokenizing Bootstrap CSS v3.1.1')
tokenizeFile(path.join(__dirname, 'bootstrap.min.css.txt'), cssGrammar, 'Tokenizing Bootstrap CSS v3.1.1 minified')
