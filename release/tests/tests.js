/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';
var fs = require('fs');
var path = require('path');
var main_1 = require('../main');
require('colors');
var errCnt = 0;
function runDescriptiveTests(testLocation) {
    var tests = JSON.parse(fs.readFileSync(testLocation).toString());
    errCnt = 0;
    tests.forEach(function (test, index) {
        var desc = test.desc;
        if (test.feature === 'injection') {
            console.log(index + ' - SKIPPING TEST ' + desc + ': injection');
            return;
        }
        var noAsserts = (test.feature === 'endless-loop');
        console.log(index + ' - RUNNING ' + desc);
        var registry = new main_1.Registry();
        var grammar = null;
        test.grammars.forEach(function (grammarPath) {
            var tmpGrammar = registry.loadGrammarFromPathSync(path.join(path.dirname(testLocation), grammarPath));
            if (test.grammarPath === grammarPath) {
                grammar = tmpGrammar;
            }
        });
        if (test.grammarScopeName) {
            grammar = registry.grammarForScopeName(test.grammarScopeName);
        }
        var prevState = null;
        if (!grammar) {
            console.error('I HAVE NO GRAMMAR FOR TEST ' + desc);
            return;
        }
        for (var i = 0; i < test.lines.length; i++) {
            prevState = assertTokenization(noAsserts, grammar, test.lines[i], prevState, desc);
        }
    });
    if (errCnt === 0) {
        var msg = 'Test suite at ' + testLocation + ' finished ok';
        console.log(msg.green);
    }
    else {
        var msg = 'Test suite at ' + testLocation + ' finished with ' + errCnt + ' errors.';
        console.log(msg.red);
    }
}
exports.runDescriptiveTests = runDescriptiveTests;
function assertTokenization(noAsserts, grammar, testCase, prevState, desc) {
    var r = grammar.tokenizeLine(testCase.line, prevState);
    if (!noAsserts) {
        assertTokens(r.tokens, testCase.line, testCase.tokens, desc);
    }
    return r.ruleStack;
}
function fail(message, actual, expected) {
    errCnt++;
    console.error(message.red);
    console.log(JSON.stringify(actual, null, '\t'));
    console.log(JSON.stringify(expected, null, '\t'));
}
function assertTokens(actual, line, expected, desc) {
    var actualTokens = actual.map(function (token) {
        return {
            value: line.substring(token.startIndex, token.endIndex),
            scopes: token.scopes
        };
    });
    if (line.length > 0) {
        // Remove empty tokens...
        expected = expected.filter(function (token) {
            return (token.value.length > 0);
        });
    }
    if (actualTokens.length !== expected.length) {
        fail('test: GOT DIFFERENT LENGTHS FOR ' + desc, actualTokens, expected);
        return;
    }
    for (var i = 0, len = actualTokens.length; i < len; i++) {
        assertToken(actualTokens[i], expected[i], desc);
    }
}
function assertToken(actual, expected, desc) {
    if (actual.value !== expected.value) {
        fail('test: GOT DIFFERENT VALUES FOR ' + desc, actual.value, expected.value);
        return;
    }
    if (actual.scopes.length !== expected.scopes.length) {
        fail('test: GOT DIFFERENT scope lengths FOR ' + desc, actual.scopes, expected.scopes);
        return;
    }
    for (var i = 0, len = actual.scopes.length; i < len; i++) {
        if (actual.scopes[i] !== expected.scopes[i]) {
            fail('test: GOT DIFFERENT scopes FOR ' + desc, actual.scopes, expected.scopes);
            return;
        }
    }
}
