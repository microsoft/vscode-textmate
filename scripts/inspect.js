if (process.argv.length !== 4) {
    console.log('usage: node index.js <grammarPath> <filePath>');
    process.exit(0);
}

var GRAMMAR_PATH = process.argv[2];
var FILE_PATH = process.argv[3];

var Registry = require('../out/main').Registry;
var registry = new Registry();
var grammar = registry.loadGrammarFromPathSync(GRAMMAR_PATH);

var fileContents = require('fs').readFileSync(FILE_PATH).toString();
var lines = fileContents.split(/\r\n|\r|\n/);
var ruleStack = null;
var lastElementId = 0;
for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    console.log('');
    console.log('');
    console.log('===========================================');
    console.log('TOKENIZING LINE ' + (i + 1) + '');
    console.log(line);

    var r = grammar.tokenizeLine(line, ruleStack);

    console.log('');
    console.log('  LINE CONTAINS ' + r.tokens.length + ' TOKENS:');
    for (var j = 0; j < r.tokens.length; j++) {
        var token = r.tokens[j];
        console.log('    => TOKEN (' + token.startIndex + '-' + token.endIndex + '): ');
        console.log('      ' + line.substring(token.startIndex, token.endIndex) + '');
        for (var k = 0; k < token.scopes.length; k++) {
            console.log('      * ' + token.scopes[k]);
        }
    }

    var stackElement = r.ruleStack;
    var cnt = 0;
    while (stackElement) {
        cnt++;
        stackElement = stackElement._parent;
    }

    console.log('');
    console.log('  LINE END RULE STACK CONTAINS ' + cnt + ' RULES:');
    stackElement = r.ruleStack
    while (stackElement) {
        if (!stackElement._instanceId) {
            stackElement._instanceId = (++lastElementId);
        }
        var ruleDesc = grammar._ruleId2desc[stackElement._ruleId]
        console.log('      * [' + stackElement._ruleId + ',' + stackElement._instanceId + '] ' + ruleDesc.constructor.name + ' "' + stackElement._scopeName + '", entered @' + stackElement._enterPos);
        stackElement = stackElement._parent;
    }

    ruleStack = r.ruleStack;
}
