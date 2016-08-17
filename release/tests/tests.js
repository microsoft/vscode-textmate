/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';
var fs = require('fs');
var path = require('path');
var main_1 = require('../main');
require('colors');
var TestResult;
(function (TestResult) {
    TestResult[TestResult["Pending"] = 0] = "Pending";
    TestResult[TestResult["Success"] = 1] = "Success";
    TestResult[TestResult["Failed"] = 2] = "Failed";
})(TestResult || (TestResult = {}));
var Test = (function () {
    function Test(testName, runner) {
        this.testName = testName;
        this._runner = runner;
        this.result = TestResult.Pending;
        this.failReason = null;
    }
    Test.prototype.run = function () {
        var ctx = new TestContext(this);
        try {
            this.result = TestResult.Success;
            this._runner(ctx);
        }
        catch (err) {
            this.result = TestResult.Failed;
            this.failReason = err;
        }
    };
    Test.prototype.fail = function (message, actual, expected) {
        this.result = TestResult.Failed;
        var reason = [
            message
        ];
        if (actual) {
            'ACTUAL: ' + reason.push(JSON.stringify(actual, null, '\t'));
        }
        if (expected) {
            'EXPECTED: ' + reason.push(JSON.stringify(expected, null, '\t'));
        }
        this.failReason = reason.join('\n');
    };
    return Test;
}());
var TestContext = (function () {
    function TestContext(test) {
        this._test = test;
    }
    TestContext.prototype.fail = function (message, actual, expected) {
        this._test.fail(message, actual, expected);
    };
    return TestContext;
}());
var TestManager = (function () {
    function TestManager() {
        this._tests = [];
    }
    TestManager.prototype.registerTest = function (testName, runner) {
        this._tests.push(new Test(testName, runner));
    };
    TestManager.prototype.runTests = function () {
        var len = this._tests.length;
        for (var i = 0; i < len; i++) {
            var test = this._tests[i];
            var progress = (i + 1) + '/' + len;
            console.log(progress.yellow, ': ' + test.testName);
            test.run();
            if (test.result === TestResult.Failed) {
                console.log('FAILED'.red);
                console.log(test.failReason);
            }
        }
        var passed = this._tests.filter(function (t) { return t.result === TestResult.Success; });
        if (passed.length === len) {
            console.log((passed.length + '/' + len + ' PASSED.').green);
        }
        else {
            console.log((passed.length + '/' + len + ' PASSED.').red);
        }
    };
    return TestManager;
}());
function runTests(tokenizationTestPaths, matcherTestPaths) {
    var manager = new TestManager();
    matcherTestPaths.forEach(function (path) {
        generateMatcherTests(manager, path);
    });
    tokenizationTestPaths.forEach(function (path) {
        generateTokenizationTests(manager, path);
    });
    manager.runTests();
}
exports.runTests = runTests;
function generateTokenizationTests(manager, testLocation) {
    var tests = JSON.parse(fs.readFileSync(testLocation).toString());
    var suiteName = path.join(path.basename(path.dirname(testLocation)), path.basename(testLocation));
    tests.forEach(function (test, index) {
        manager.registerTest(suiteName + ' > ' + test.desc, function (ctx) {
            var locator = {
                getFilePath: function (scopeName) { return null; },
                getInjections: function (scopeName) {
                    if (scopeName === test.grammarScopeName) {
                        return test.grammarInjections;
                    }
                    return void 0;
                }
            };
            var registry = new main_1.Registry(locator);
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
                ctx.fail('I HAVE NO GRAMMAR FOR TEST');
                return;
            }
            for (var i = 0; i < test.lines.length; i++) {
                prevState = assertTokenization(ctx, grammar, test.lines[i], prevState);
            }
        });
    });
}
function assertTokenization(ctx, grammar, testCase, prevState) {
    var r = grammar.tokenizeLine(testCase.line, prevState);
    assertTokens(ctx, r.tokens, testCase.line, testCase.tokens);
    return r.ruleStack;
}
function assertTokens(ctx, actual, line, expected) {
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
        ctx.fail('GOT DIFFERENT LENGTHS FOR ', actualTokens, expected);
        return;
    }
    for (var i = 0, len = actualTokens.length; i < len; i++) {
        assertToken(ctx, actualTokens[i], expected[i]);
    }
}
function assertToken(ctx, actual, expected) {
    if (actual.value !== expected.value) {
        ctx.fail('test: GOT DIFFERENT VALUES FOR ', actual.value, expected.value);
        return;
    }
    if (actual.scopes.length !== expected.scopes.length) {
        ctx.fail('test: GOT DIFFERENT scope lengths FOR ', actual.scopes, expected.scopes);
        return;
    }
    for (var i = 0, len = actual.scopes.length; i < len; i++) {
        if (actual.scopes[i] !== expected.scopes[i]) {
            ctx.fail('test: GOT DIFFERENT scopes FOR ', actual.scopes, expected.scopes);
            return;
        }
    }
}
function generateMatcherTests(manager, testLocation) {
    var tests = JSON.parse(fs.readFileSync(testLocation).toString());
    var suiteName = path.join(path.basename(path.dirname(testLocation)), path.basename(testLocation));
    var nameMatcher = function (identifers, stackElements) {
        var lastIndex = 0;
        return identifers.every(function (identifier) {
            for (var i = lastIndex; i < stackElements.length; i++) {
                if (stackElements[i] === identifier) {
                    lastIndex = i + 1;
                    return true;
                }
            }
            return false;
        });
    };
    tests.forEach(function (test, index) {
        manager.registerTest(suiteName + ' > ' + index, function (ctx) {
            var matcher = main_1.createMatcher(test.expression, nameMatcher);
            var result = matcher(test.input);
            if (result !== test.result) {
                ctx.fail('matcher expected', result, test.result);
            }
        });
    });
}
