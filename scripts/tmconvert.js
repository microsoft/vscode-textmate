const fs = require('fs');


if (process.argv.length < 3) {
	console.log('usage: node index.js <mainGrammarPath>');
	process.exit(0);
}

const GRAMMAR_PATH = process.argv[process.argv.length - 1];
let contents = JSON.parse(fs.readFileSync(GRAMMAR_PATH).toString());
delete contents['information_for_contributors'];
delete contents['version'];
delete contents['name'];
delete contents['scopeName'];
let strContents = JSON.stringify(contents, null, '  ');

strContents = strContents.replace(/"([\w-]+)": /g, '$1 = ')
strContents = strContents.replace(/ = "(.*)",/g, ' = "$1";')
strContents = strContents.replace(/"(\s*)\}/mg, '";$1}')
strContents = strContents.replace(/\[\n/mg, '(\n')
strContents = strContents.replace(/\],\n/mg, ');\n')
strContents = strContents.replace(/\]\n/mg, ');\n')
strContents = strContents.replace(/\},\n(\s*)([^{ ])/mg, '};\n$1$2')
strContents = strContents.replace(/\}\n(\s*)([^) ])/mg, '};\n$1$2')
strContents = strContents.replace(/\}\n(\s*)([^) ])/mg, '};\n$1$2')

console.log(strContents);

