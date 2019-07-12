# VSCode TextMate [![Build Status](https://dev.azure.com/ms/vscode-textmate/_apis/build/status/microsoft.vscode-textmate?branchName=master)](https://dev.azure.com/ms/vscode-textmate/_build/latest?definitionId=172&branchName=master)

An interpreter for grammar files as defined by TextMate. Supports loading grammar files from JSON or PLIST format. Cross - grammar injections are currently not supported.

## Installing

```sh
npm install vscode-textmate
```

## Using

```javascript
const fs = require('fs');
const vsctm = require('vscode-textmate');

/**
 * Utility to read a file as a promise
 */
function readFile(path) {
    return new Promise((resolve, reject) => {
        fs.readFile(path, (error, data) => error ? reject(error) : resolve(data));
    })
}

// Create a registry that can create a grammar from a scope name.
const registry = new vsctm.Registry({
    loadGrammar: (scopeName) => {
        if (scopeName === 'source.js') {
            // https://github.com/textmate/javascript.tmbundle/blob/master/Syntaxes/JavaScript.plist
            return readFile('./JavaScript.plist').then(data => vsctm.parseRawGrammar(data.toString()))
        }
        console.log(`Unknown scope name: ${scopeName}`);
        return null;
    }
});

// Load the JavaScript grammar and any other grammars included by it async.
registry.loadGrammar('source.js').then(grammar => {
    const text = [
        `function sayHello(name) {`,
        `\treturn "Hello, " + name;`,
        `}`
    ];
    let ruleStack = vsctm.INITIAL;
    for (let i = 0; i < text.length; i++) {
        const line = text[i];
        const lineTokens = grammar.tokenizeLine(line, ruleStack);
        console.log(`\nTokenizing line: ${line}`);
        for (let j = 0; j < lineTokens.tokens.length; j++) {
            const token = lineTokens.tokens[j];
            console.log(` - token from ${token.startIndex} to ${token.endIndex} (${line.substring(token.startIndex, token.endIndex)}) with scopes ${token.scopes.join(', ')}`);
        }
        ruleStack = lineTokens.ruleStack;
    }
});



```

## API doc

See [the main.ts file](./src/main.ts)

## Developing

* Clone the repository
* Run `npm install`
* Compile in the background with `npm run watch`
* Run tests with `npm test`
* Run benchmark with `npm run benchmark`
* Troubleshoot a grammar with `npm run inspect -- PATH_TO_GRAMMAR PATH_TO_FILE`

## Code of Conduct

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.


## License
[MIT](https://github.com/Microsoft/vscode-textmate/blob/master/LICENSE.md)

