/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';
// declare var require;
var $map = {};
function $load(name, factory) {
    var mod = {
        exports: {}
    };
    factory.call(this, function (mod) {
        if ($map[mod]) {
            return $map[mod].exports;
        }
        return require(mod);
    }, mod, mod.exports);
    $map[name] = mod;
}

$load('./utils', function(require, module, exports) {
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';
function clone(something) {
    return doClone(something);
}
exports.clone = clone;
function doClone(something) {
    if (Array.isArray(something)) {
        return cloneArray(something);
    }
    if (typeof something === 'object') {
        return cloneObj(something);
    }
    return something;
}
function cloneArray(arr) {
    var r = [];
    for (var i = 0, len = arr.length; i < len; i++) {
        r[i] = doClone(arr[i]);
    }
    return r;
}
function cloneObj(obj) {
    var r = {};
    for (var key in obj) {
        r[key] = doClone(obj[key]);
    }
    return r;
}
function mergeObjects(target) {
    var sources = [];
    for (var _i = 1; _i < arguments.length; _i++) {
        sources[_i - 1] = arguments[_i];
    }
    sources.forEach(function (source) {
        for (var key in source) {
            target[key] = source[key];
        }
    });
    return target;
}
exports.mergeObjects = mergeObjects;
var CAPTURING_REGEX_SOURCE = /\$(\d+)|\${(\d+):\/(downcase|upcase)}/;
var RegexSource = (function () {
    function RegexSource() {
    }
    RegexSource.hasCaptures = function (regexSource) {
        return CAPTURING_REGEX_SOURCE.test(regexSource);
    };
    RegexSource.replaceCaptures = function (regexSource, captureSource, captureIndices) {
        return regexSource.replace(CAPTURING_REGEX_SOURCE, function (match, index, commandIndex, command) {
            var capture = captureIndices[parseInt(index || commandIndex, 10)];
            if (capture) {
                var result = captureSource.substring(capture.start, capture.end);
                // Remove leading dots that would make the selector invalid
                while (result[0] === '.') {
                    result = result.substring(1);
                }
                switch (command) {
                    case 'downcase':
                        return result.toLowerCase();
                    case 'upcase':
                        return result.toUpperCase();
                    default:
                        return result;
                }
            }
            else {
                return match;
            }
        });
    };
    return RegexSource;
}());
exports.RegexSource = RegexSource;

});
$load('./matcher', function(require, module, exports) {
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';
function createMatcher(expression, matchesName) {
    var tokenizer = newTokenizer(expression);
    var token = tokenizer.next();
    function parseOperand() {
        if (token === '-') {
            token = tokenizer.next();
            var expressionToNegate = parseOperand();
            return function (matcherInput) { return expressionToNegate && !expressionToNegate(matcherInput); };
        }
        if (token === '(') {
            token = tokenizer.next();
            var expressionInParents = parseExpression('|');
            if (token == ')') {
                token = tokenizer.next();
            }
            return expressionInParents;
        }
        if (isIdentifier(token)) {
            var identifiers = [];
            do {
                identifiers.push(token);
                token = tokenizer.next();
            } while (isIdentifier(token));
            return function (matcherInput) { return matchesName(identifiers, matcherInput); };
        }
        return null;
    }
    function parseConjunction() {
        var matchers = [];
        var matcher = parseOperand();
        while (matcher) {
            matchers.push(matcher);
            matcher = parseOperand();
        }
        return function (matcherInput) { return matchers.every(function (matcher) { return matcher(matcherInput); }); }; // and
    }
    function parseExpression(orOperatorToken) {
        if (orOperatorToken === void 0) { orOperatorToken = ','; }
        var matchers = [];
        var matcher = parseConjunction();
        while (matcher) {
            matchers.push(matcher);
            if (token === orOperatorToken) {
                do {
                    token = tokenizer.next();
                } while (token === orOperatorToken); // ignore subsequent commas
            }
            else {
                break;
            }
            matcher = parseConjunction();
        }
        return function (matcherInput) { return matchers.some(function (matcher) { return matcher(matcherInput); }); }; // or
    }
    return parseExpression() || (function (matcherInput) { return false; });
}
exports.createMatcher = createMatcher;
function isIdentifier(token) {
    return token && token.match(/[\w\.:]+/);
}
function newTokenizer(input) {
    var regex = /([\w\.:]+|[\,\|\-\(\)])/g;
    var match = regex.exec(input);
    return {
        next: function () {
            if (!match) {
                return null;
            }
            var res = match[0];
            match = regex.exec(input);
            return res;
        }
    };
}

});
$load('./plistParser', function(require, module, exports) {
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';
var createParser = (function () {
    var saxModule = null;
    return function parser(strict, opt) {
        if (!saxModule) {
            saxModule = require('sax');
        }
        return saxModule.parser(strict, opt);
    };
})();
function parseSAX(content) {
    var errors = [];
    var currObject = null;
    var result = null;
    var text = null;
    var parser = createParser(false, { lowercase: true });
    parser.onerror = function (e) {
        errors.push(e.message);
    };
    parser.ontext = function (s) {
        text = s;
    };
    parser.onopentag = function (tag) {
        switch (tag.name) {
            case 'dict':
                currObject = { parent: currObject, value: {} };
                break;
            case 'array':
                currObject = { parent: currObject, value: [] };
                break;
            case 'key':
                if (currObject) {
                    currObject.lastKey = null;
                }
                break;
        }
        text = '';
    };
    parser.onclosetag = function (tagName) {
        var value;
        switch (tagName) {
            case 'key':
                if (!currObject || Array.isArray(currObject.value)) {
                    errors.push('key can only be used inside an open dict element');
                    return;
                }
                currObject.lastKey = text;
                return;
            case 'dict':
            case 'array':
                if (!currObject) {
                    errors.push(tagName + ' closing tag found, without opening tag');
                    return;
                }
                value = currObject.value;
                currObject = currObject.parent;
                break;
            case 'string':
            case 'data':
                value = text;
                break;
            case 'date':
                value = new Date(text);
                break;
            case 'integer':
                value = parseInt(text);
                if (isNaN(value)) {
                    errors.push(text + ' is not a integer');
                    return;
                }
                break;
            case 'real':
                value = parseFloat(text);
                if (isNaN(value)) {
                    errors.push(text + ' is not a float');
                    return;
                }
                break;
            case 'true':
                value = true;
                break;
            case 'false':
                value = false;
                break;
            case 'plist':
                return;
            default:
                errors.push('Invalid tag name: ' + tagName);
                return;
        }
        if (!currObject) {
            result = value;
        }
        else if (Array.isArray(currObject.value)) {
            currObject.value.push(value);
        }
        else {
            if (currObject.lastKey) {
                currObject.value[currObject.lastKey] = value;
            }
            else {
                errors.push('Dictionary key missing for value ' + value);
            }
        }
    };
    parser.write(content);
    return { errors: errors, value: result };
}
exports.parseSAX = parseSAX;
/**
 * A very fast plist parser
 */
function _parse(file) {
    var len = file.length;
    var i = 0;
    // Skip UTF8 BOM
    if (len > 0 && file.charCodeAt(0) === 65279) {
        i = 1;
    }
    function skipWhitespace() {
        while (i < len) {
            var chCode = file.charCodeAt(i);
            if (chCode !== 32 /*<space>*/ && chCode !== 9 /*<tab>*/ && chCode !== 13 /*<CarriageReturn>*/ && chCode !== 10 /*<LineFeed>*/) {
                break;
            }
            i++;
        }
    }
    function advanceIfStartsWith(str) {
        if (file.substr(i, str.length) === str) {
            i += str.length;
            return true;
        }
        return false;
    }
    function advanceUntil(str) {
        var nextOccurence = file.indexOf(str, i);
        if (nextOccurence !== -1) {
            i = nextOccurence + str.length;
        }
        else {
            // EOF
            i = len;
        }
    }
    function captureUntil(str) {
        var nextOccurence = file.indexOf(str, i);
        if (nextOccurence !== -1) {
            var r = file.substring(i, nextOccurence);
            i = nextOccurence + str.length;
            return r;
        }
        else {
            // EOF
            var r = file.substr(i);
            i = len;
            return r;
        }
    }
    var ROOT_STATE = 0;
    var DICT_STATE = 1;
    var ARR_STATE = 2;
    var state = ROOT_STATE;
    var cur = {};
    var stateStack = [];
    var objStack = [];
    var curKey = null;
    function pushState(newState, newCur) {
        stateStack.push(state);
        objStack.push(cur);
        state = newState;
        cur = newCur;
    }
    function popState() {
        state = stateStack.pop();
        cur = objStack.pop();
    }
    function fail(msg) {
        throw new Error('Near offset ' + i + ': ' + msg + ' ~~~' + file.substr(i, 50) + '~~~');
    }
    var dictState = {
        enterDict: function () {
            if (curKey === null) {
                fail('missing <key>');
            }
            var newDict = {};
            cur[curKey] = newDict;
            curKey = null;
            pushState(DICT_STATE, newDict);
        },
        enterArray: function () {
            if (curKey === null) {
                fail('missing <key>');
            }
            var newArr = [];
            cur[curKey] = newArr;
            curKey = null;
            pushState(ARR_STATE, newArr);
        }
    };
    var arrState = {
        enterDict: function () {
            var newDict = {};
            cur.push(newDict);
            pushState(DICT_STATE, newDict);
        },
        enterArray: function () {
            var newArr = [];
            cur.push(newArr);
            pushState(ARR_STATE, newArr);
        }
    };
    function enterDict() {
        if (state === DICT_STATE) {
            dictState.enterDict();
        }
        else if (state === ARR_STATE) {
            arrState.enterDict();
        }
        else {
            pushState(DICT_STATE, cur);
        }
    }
    function leaveDict() {
        if (state === DICT_STATE) {
            popState();
        }
        else if (state === ARR_STATE) {
            fail('unexpected </dict>');
        }
        else {
            fail('unexpected </dict>');
        }
    }
    function enterArray() {
        if (state === DICT_STATE) {
            dictState.enterArray();
        }
        else if (state === ARR_STATE) {
            arrState.enterArray();
        }
        else {
            fail('unexpected <array>');
        }
    }
    function leaveArray() {
        if (state === DICT_STATE) {
            fail('unexpected </array>');
        }
        else if (state === ARR_STATE) {
            popState();
        }
        else {
            fail('unexpected </array>');
        }
    }
    function acceptKey(val) {
        if (state === DICT_STATE) {
            if (curKey !== null) {
                fail('too many <key>');
            }
            curKey = val;
        }
        else if (state === ARR_STATE) {
            fail('unexpected <key>');
        }
        else {
            fail('unexpected <key>');
        }
    }
    function acceptString(val) {
        if (state === DICT_STATE) {
            if (curKey === null) {
                fail('missing <key>');
            }
            cur[curKey] = val;
            curKey = null;
        }
        else if (state === ARR_STATE) {
            cur.push(val);
        }
        else {
            fail('unexpected <string>');
        }
    }
    function acceptReal(val) {
        if (state === DICT_STATE) {
            if (curKey === null) {
                fail('missing <key>');
            }
            cur[curKey] = val;
            curKey = null;
        }
        else if (state === ARR_STATE) {
            cur.push(val);
        }
        else {
            fail('unexpected <real>');
        }
    }
    function acceptInteger(val) {
        if (state === DICT_STATE) {
            if (curKey === null) {
                fail('missing <key>');
            }
            cur[curKey] = val;
            curKey = null;
        }
        else if (state === ARR_STATE) {
            cur.push(val);
        }
        else {
            fail('unexpected <integer>');
        }
    }
    function acceptDate(val) {
        if (state === DICT_STATE) {
            if (curKey === null) {
                fail('missing <key>');
            }
            cur[curKey] = val;
            curKey = null;
        }
        else if (state === ARR_STATE) {
            cur.push(val);
        }
        else {
            fail('unexpected <date>');
        }
    }
    function acceptData(val) {
        if (state === DICT_STATE) {
            if (curKey === null) {
                fail('missing <key>');
            }
            cur[curKey] = val;
            curKey = null;
        }
        else if (state === ARR_STATE) {
            cur.push(val);
        }
        else {
            fail('unexpected <data>');
        }
    }
    function acceptBool(val) {
        if (state === DICT_STATE) {
            if (curKey === null) {
                fail('missing <key>');
            }
            cur[curKey] = val;
            curKey = null;
        }
        else if (state === ARR_STATE) {
            cur.push(val);
        }
        else {
            fail('unexpected <true> or <false>');
        }
    }
    function escapeVal(str) {
        return str.replace(/&#([0-9]+);/g, function (_, m0) {
            return String.fromCodePoint(parseInt(m0, 10));
        }).replace(/&#x([0-9a-f]+);/g, function (_, m0) {
            return String.fromCodePoint(parseInt(m0, 16));
        }).replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, function (_) {
            switch (_) {
                case '&amp;': return '&';
                case '&lt;': return '<';
                case '&gt;': return '>';
                case '&quot;': return '"';
                case '&apos;': return '\'';
            }
            return _;
        });
    }
    function parseOpenTag() {
        var r = captureUntil('>');
        var isClosed = false;
        if (r.charCodeAt(r.length - 1) === 47 /*/*/) {
            isClosed = true;
            r = r.substring(0, r.length - 1);
        }
        return {
            name: r.trim(),
            isClosed: isClosed
        };
    }
    function parseTagValue(tag) {
        if (tag.isClosed) {
            return '';
        }
        var val = captureUntil('</');
        advanceUntil('>');
        return escapeVal(val);
    }
    while (i < len) {
        skipWhitespace();
        if (i >= len) {
            break;
        }
        var chCode = file.charCodeAt(i++);
        if (chCode !== 60 /*<*/) {
            fail('expected <');
        }
        if (i >= len) {
            fail('unexpected end of input');
        }
        var peekChCode = file.charCodeAt(i);
        if (peekChCode === 63 /*?*/) {
            i++;
            advanceUntil('?>');
            continue;
        }
        if (peekChCode === 33 /*!*/) {
            i++;
            if (advanceIfStartsWith('--')) {
                advanceUntil('-->');
                continue;
            }
            advanceUntil('>');
            continue;
        }
        if (peekChCode === 47 /*/*/) {
            i++;
            skipWhitespace();
            if (advanceIfStartsWith('plist')) {
                advanceUntil('>');
                continue;
            }
            if (advanceIfStartsWith('dict')) {
                advanceUntil('>');
                leaveDict();
                continue;
            }
            if (advanceIfStartsWith('array')) {
                advanceUntil('>');
                leaveArray();
                continue;
            }
            fail('unexpected closed tag');
        }
        var tag = parseOpenTag();
        switch (tag.name) {
            case 'dict':
                enterDict();
                if (tag.isClosed) {
                    leaveDict();
                }
                continue;
            case 'array':
                enterArray();
                if (tag.isClosed) {
                    leaveArray();
                }
                continue;
            case 'key':
                acceptKey(parseTagValue(tag));
                continue;
            case 'string':
                acceptString(parseTagValue(tag));
                continue;
            case 'real':
                acceptReal(parseFloat(parseTagValue(tag)));
                continue;
            case 'integer':
                acceptInteger(parseInt(parseTagValue(tag), 10));
                continue;
            case 'date':
                acceptDate(new Date(parseTagValue(tag)));
                continue;
            case 'data':
                acceptData(parseTagValue(tag));
                continue;
            case 'true':
                acceptBool(true);
                continue;
            case 'false':
                acceptBool(false);
                continue;
        }
        if (/^plist/.test(tag.name)) {
            continue;
        }
        fail('unexpected opened tag ' + tag.name);
    }
    return cur;
}
function parse(content) {
    try {
        return {
            value: _parse(content),
            errors: []
        };
    }
    catch (err) {
        return {
            value: null,
            errors: [err.message]
        };
    }
}
exports.parse = parse;

});
$load('./grammarReader', function(require, module, exports) {
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';
var fs = require('fs');
var plistParser_1 = require('./plistParser');
var plistParser_2 = require('./plistParser');
function readGrammar(filePath, useExperimentalParser, callback) {
    var reader = new AsyncGrammarReader(filePath, getGrammarParser(filePath, useExperimentalParser));
    reader.load(callback);
}
exports.readGrammar = readGrammar;
function readGrammarSync(filePath, useExperimentalParser) {
    try {
        var reader = new SyncGrammarReader(filePath, getGrammarParser(filePath, useExperimentalParser));
        return reader.load();
    }
    catch (err) {
        throw new Error('Error parsing ' + filePath + ': ' + err.message);
    }
}
exports.readGrammarSync = readGrammarSync;
var AsyncGrammarReader = (function () {
    function AsyncGrammarReader(filePath, parser) {
        this._filePath = filePath;
        this._parser = parser;
    }
    AsyncGrammarReader.prototype.load = function (callback) {
        var _this = this;
        fs.readFile(this._filePath, function (err, contents) {
            if (err) {
                callback(err, null);
                return;
            }
            var r;
            try {
                r = _this._parser(contents.toString());
            }
            catch (err) {
                callback(err, null);
                return;
            }
            callback(null, r);
        });
    };
    return AsyncGrammarReader;
}());
var SyncGrammarReader = (function () {
    function SyncGrammarReader(filePath, parser) {
        this._filePath = filePath;
        this._parser = parser;
    }
    SyncGrammarReader.prototype.load = function () {
        var contents = fs.readFileSync(this._filePath);
        return this._parser(contents.toString());
    };
    return SyncGrammarReader;
}());
function getGrammarParser(filePath, useExperimentalParser) {
    if (/\.json$/.test(filePath)) {
        return parseJSONGrammar;
    }
    if (useExperimentalParser) {
        return parsePLISTGrammar;
    }
    return parseSAXPLISTGrammar;
}
function parseJSONGrammar(contents) {
    return JSON.parse(contents.toString());
}
function parseSAXPLISTGrammar(contents) {
    var tmp;
    tmp = plistParser_1.parseSAX(contents);
    if (tmp.errors && tmp.errors.length > 0) {
        throw new Error('Error parsing PLIST: ' + tmp.errors.join(','));
    }
    return tmp.value;
}
function parsePLISTGrammar(contents) {
    var tmp;
    tmp = plistParser_2.parse(contents);
    if (tmp.errors && tmp.errors.length > 0) {
        throw new Error('Error parsing PLIST: ' + tmp.errors.join(','));
    }
    return tmp.value;
}

});
$load('./rule', function(require, module, exports) {
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var utils_1 = require('./utils');
var HAS_BACK_REFERENCES = /\\(\d+)/;
var BACK_REFERENCING_END = /\\(\d+)/g;
var Rule = (function () {
    function Rule(id, name, contentName) {
        this.id = id;
        this._name = name || null;
        this._nameIsCapturing = utils_1.RegexSource.hasCaptures(this._name);
        this._contentName = contentName || null;
        this._contentNameIsCapturing = utils_1.RegexSource.hasCaptures(this._contentName);
    }
    Rule.prototype.getName = function (lineText, captureIndices) {
        if (!this._nameIsCapturing) {
            return this._name;
        }
        return utils_1.RegexSource.replaceCaptures(this._name, lineText, captureIndices);
    };
    Rule.prototype.getContentName = function (lineText, captureIndices) {
        if (!this._contentNameIsCapturing) {
            return this._contentName;
        }
        return utils_1.RegexSource.replaceCaptures(this._contentName, lineText, captureIndices);
    };
    Rule.prototype.collectPatternsRecursive = function (grammar, out, isFirst) {
        throw new Error('Implement me!');
    };
    Rule.prototype.compile = function (grammar, endRegexSource, allowA, allowG) {
        throw new Error('Implement me!');
    };
    return Rule;
}());
exports.Rule = Rule;
var CaptureRule = (function (_super) {
    __extends(CaptureRule, _super);
    function CaptureRule(id, name, contentName, retokenizeCapturedWithRuleId) {
        _super.call(this, id, name, contentName);
        this.retokenizeCapturedWithRuleId = retokenizeCapturedWithRuleId;
    }
    return CaptureRule;
}(Rule));
exports.CaptureRule = CaptureRule;
var RegExpSource = (function () {
    function RegExpSource(regExpSource, ruleId, handleAnchors) {
        if (handleAnchors === void 0) { handleAnchors = true; }
        if (handleAnchors) {
            this._handleAnchors(regExpSource);
        }
        else {
            this.source = regExpSource;
            this.hasAnchor = false;
        }
        if (this.hasAnchor) {
            this._anchorCache = this._buildAnchorCache();
        }
        this.ruleId = ruleId;
        this.hasBackReferences = HAS_BACK_REFERENCES.test(this.source);
        // console.log('input: ' + regExpSource + ' => ' + this.source + ', ' + this.hasAnchor);
    }
    RegExpSource.prototype.clone = function () {
        return new RegExpSource(this.source, this.ruleId, true);
    };
    RegExpSource.prototype.setSource = function (newSource) {
        if (this.source === newSource) {
            return;
        }
        this.source = newSource;
        if (this.hasAnchor) {
            this._anchorCache = this._buildAnchorCache();
        }
    };
    RegExpSource.prototype._handleAnchors = function (regExpSource) {
        if (regExpSource) {
            var pos = void 0, len = void 0, ch = void 0, nextCh = void 0, lastPushedPos = 0, output = [];
            var hasAnchor = false;
            for (pos = 0, len = regExpSource.length; pos < len; pos++) {
                ch = regExpSource.charAt(pos);
                if (ch === '\\') {
                    if (pos + 1 < len) {
                        nextCh = regExpSource.charAt(pos + 1);
                        if (nextCh === 'z') {
                            output.push(regExpSource.substring(lastPushedPos, pos));
                            output.push('$(?!\\n)(?<!\\n)');
                            lastPushedPos = pos + 2;
                        }
                        else if (nextCh === 'A' || nextCh === 'G') {
                            hasAnchor = true;
                        }
                        pos++;
                    }
                }
            }
            this.hasAnchor = hasAnchor;
            if (lastPushedPos === 0) {
                // No \z hit
                this.source = regExpSource;
            }
            else {
                output.push(regExpSource.substring(lastPushedPos, len));
                this.source = output.join('');
            }
        }
        else {
            this.hasAnchor = false;
            this.source = regExpSource;
        }
    };
    RegExpSource.prototype.resolveBackReferences = function (lineText, captureIndices) {
        var capturedValues = captureIndices.map(function (capture) {
            return lineText.substring(capture.start, capture.end);
        });
        BACK_REFERENCING_END.lastIndex = 0;
        return this.source.replace(BACK_REFERENCING_END, function (match, g1) {
            return escapeRegExpCharacters(capturedValues[parseInt(g1, 10)] || '');
        });
    };
    RegExpSource.prototype._buildAnchorCache = function () {
        var A0_G0_result = [];
        var A0_G1_result = [];
        var A1_G0_result = [];
        var A1_G1_result = [];
        var pos, len, ch, nextCh;
        for (pos = 0, len = this.source.length; pos < len; pos++) {
            ch = this.source.charAt(pos);
            A0_G0_result[pos] = ch;
            A0_G1_result[pos] = ch;
            A1_G0_result[pos] = ch;
            A1_G1_result[pos] = ch;
            if (ch === '\\') {
                if (pos + 1 < len) {
                    nextCh = this.source.charAt(pos + 1);
                    if (nextCh === 'A') {
                        A0_G0_result[pos + 1] = '\uFFFF';
                        A0_G1_result[pos + 1] = '\uFFFF';
                        A1_G0_result[pos + 1] = 'A';
                        A1_G1_result[pos + 1] = 'A';
                    }
                    else if (nextCh === 'G') {
                        A0_G0_result[pos + 1] = '\uFFFF';
                        A0_G1_result[pos + 1] = 'G';
                        A1_G0_result[pos + 1] = '\uFFFF';
                        A1_G1_result[pos + 1] = 'G';
                    }
                    else {
                        A0_G0_result[pos + 1] = nextCh;
                        A0_G1_result[pos + 1] = nextCh;
                        A1_G0_result[pos + 1] = nextCh;
                        A1_G1_result[pos + 1] = nextCh;
                    }
                    pos++;
                }
            }
        }
        return {
            A0_G0: A0_G0_result.join(''),
            A0_G1: A0_G1_result.join(''),
            A1_G0: A1_G0_result.join(''),
            A1_G1: A1_G1_result.join('')
        };
    };
    RegExpSource.prototype.resolveAnchors = function (allowA, allowG) {
        if (!this.hasAnchor) {
            return this.source;
        }
        if (allowA) {
            if (allowG) {
                return this._anchorCache.A1_G1;
            }
            else {
                return this._anchorCache.A1_G0;
            }
        }
        else {
            if (allowG) {
                return this._anchorCache.A0_G1;
            }
            else {
                return this._anchorCache.A0_G0;
            }
        }
    };
    return RegExpSource;
}());
exports.RegExpSource = RegExpSource;
var getOnigModule = (function () {
    var onigurumaModule = null;
    return function () {
        if (!onigurumaModule) {
            onigurumaModule = require('oniguruma');
        }
        return onigurumaModule;
    };
})();
function createOnigScanner(sources) {
    var onigurumaModule = getOnigModule();
    return new onigurumaModule.OnigScanner(sources);
}
function createOnigString(sources) {
    var onigurumaModule = getOnigModule();
    var r = new onigurumaModule.OnigString(sources);
    r.$str = sources;
    return r;
}
exports.createOnigString = createOnigString;
function getString(str) {
    return str.$str;
}
exports.getString = getString;
var RegExpSourceList = (function () {
    function RegExpSourceList() {
        this._items = [];
        this._hasAnchors = false;
        this._cached = null;
        this._cachedSources = null;
        this._anchorCache = {
            A0_G0: null,
            A0_G1: null,
            A1_G0: null,
            A1_G1: null
        };
    }
    RegExpSourceList.prototype.push = function (item) {
        this._items.push(item);
        this._hasAnchors = this._hasAnchors || item.hasAnchor;
    };
    RegExpSourceList.prototype.unshift = function (item) {
        this._items.unshift(item);
        this._hasAnchors = this._hasAnchors || item.hasAnchor;
    };
    RegExpSourceList.prototype.length = function () {
        return this._items.length;
    };
    RegExpSourceList.prototype.setSource = function (index, newSource) {
        if (this._items[index].source !== newSource) {
            // bust the cache
            this._cached = null;
            this._anchorCache.A0_G0 = null;
            this._anchorCache.A0_G1 = null;
            this._anchorCache.A1_G0 = null;
            this._anchorCache.A1_G1 = null;
            this._items[index].setSource(newSource);
        }
    };
    RegExpSourceList.prototype.compile = function (grammar, allowA, allowG) {
        if (!this._hasAnchors) {
            if (!this._cached) {
                this._cached = {
                    scanner: createOnigScanner(this._items.map(function (e) { return e.source; })),
                    rules: this._items.map(function (e) { return e.ruleId; })
                };
            }
            return this._cached;
        }
        else {
            this._anchorCache = {
                A0_G0: this._anchorCache.A0_G0 || (allowA === false && allowG === false ? this._resolveAnchors(allowA, allowG) : null),
                A0_G1: this._anchorCache.A0_G1 || (allowA === false && allowG === true ? this._resolveAnchors(allowA, allowG) : null),
                A1_G0: this._anchorCache.A1_G0 || (allowA === true && allowG === false ? this._resolveAnchors(allowA, allowG) : null),
                A1_G1: this._anchorCache.A1_G1 || (allowA === true && allowG === true ? this._resolveAnchors(allowA, allowG) : null),
            };
            if (allowA) {
                if (allowG) {
                    return this._anchorCache.A1_G1;
                }
                else {
                    return this._anchorCache.A1_G0;
                }
            }
            else {
                if (allowG) {
                    return this._anchorCache.A0_G1;
                }
                else {
                    return this._anchorCache.A0_G0;
                }
            }
        }
    };
    RegExpSourceList.prototype._resolveAnchors = function (allowA, allowG) {
        return {
            scanner: createOnigScanner(this._items.map(function (e) { return e.resolveAnchors(allowA, allowG); })),
            rules: this._items.map(function (e) { return e.ruleId; })
        };
    };
    return RegExpSourceList;
}());
exports.RegExpSourceList = RegExpSourceList;
var MatchRule = (function (_super) {
    __extends(MatchRule, _super);
    function MatchRule(id, name, match, captures) {
        _super.call(this, id, name, null);
        this._match = new RegExpSource(match, this.id);
        this.captures = captures;
        this._cachedCompiledPatterns = null;
    }
    MatchRule.prototype.collectPatternsRecursive = function (grammar, out, isFirst) {
        out.push(this._match);
    };
    MatchRule.prototype.compile = function (grammar, endRegexSource, allowA, allowG) {
        if (!this._cachedCompiledPatterns) {
            this._cachedCompiledPatterns = new RegExpSourceList();
            this.collectPatternsRecursive(grammar, this._cachedCompiledPatterns, true);
        }
        return this._cachedCompiledPatterns.compile(grammar, allowA, allowG);
    };
    return MatchRule;
}(Rule));
exports.MatchRule = MatchRule;
var IncludeOnlyRule = (function (_super) {
    __extends(IncludeOnlyRule, _super);
    function IncludeOnlyRule(id, name, contentName, patterns) {
        _super.call(this, id, name, contentName);
        this.patterns = patterns.patterns;
        this.hasMissingPatterns = patterns.hasMissingPatterns;
        this._cachedCompiledPatterns = null;
    }
    IncludeOnlyRule.prototype.collectPatternsRecursive = function (grammar, out, isFirst) {
        var i, len, rule;
        for (i = 0, len = this.patterns.length; i < len; i++) {
            rule = grammar.getRule(this.patterns[i]);
            rule.collectPatternsRecursive(grammar, out, false);
        }
    };
    IncludeOnlyRule.prototype.compile = function (grammar, endRegexSource, allowA, allowG) {
        if (!this._cachedCompiledPatterns) {
            this._cachedCompiledPatterns = new RegExpSourceList();
            this.collectPatternsRecursive(grammar, this._cachedCompiledPatterns, true);
        }
        return this._cachedCompiledPatterns.compile(grammar, allowA, allowG);
    };
    return IncludeOnlyRule;
}(Rule));
exports.IncludeOnlyRule = IncludeOnlyRule;
function escapeRegExpCharacters(value) {
    return value.replace(/[\-\\\{\}\*\+\?\|\^\$\.\,\[\]\(\)\#\s]/g, '\\$&');
}
var BeginEndRule = (function (_super) {
    __extends(BeginEndRule, _super);
    function BeginEndRule(id, name, contentName, begin, beginCaptures, end, endCaptures, applyEndPatternLast, patterns) {
        _super.call(this, id, name, contentName);
        this._begin = new RegExpSource(begin, this.id);
        this.beginCaptures = beginCaptures;
        this._end = new RegExpSource(end, -1);
        this.endHasBackReferences = this._end.hasBackReferences;
        this.endCaptures = endCaptures;
        this.applyEndPatternLast = applyEndPatternLast || false;
        this.patterns = patterns.patterns;
        this.hasMissingPatterns = patterns.hasMissingPatterns;
        this._cachedCompiledPatterns = null;
    }
    BeginEndRule.prototype.getEndWithResolvedBackReferences = function (lineText, captureIndices) {
        return this._end.resolveBackReferences(lineText, captureIndices);
    };
    BeginEndRule.prototype.collectPatternsRecursive = function (grammar, out, isFirst) {
        if (isFirst) {
            var i = void 0, len = void 0, rule = void 0;
            for (i = 0, len = this.patterns.length; i < len; i++) {
                rule = grammar.getRule(this.patterns[i]);
                rule.collectPatternsRecursive(grammar, out, false);
            }
        }
        else {
            out.push(this._begin);
        }
    };
    BeginEndRule.prototype.compile = function (grammar, endRegexSource, allowA, allowG) {
        var precompiled = this._precompile(grammar);
        if (this._end.hasBackReferences) {
            if (this.applyEndPatternLast) {
                precompiled.setSource(precompiled.length() - 1, endRegexSource);
            }
            else {
                precompiled.setSource(0, endRegexSource);
            }
        }
        return this._cachedCompiledPatterns.compile(grammar, allowA, allowG);
    };
    BeginEndRule.prototype._precompile = function (grammar) {
        if (!this._cachedCompiledPatterns) {
            this._cachedCompiledPatterns = new RegExpSourceList();
            this.collectPatternsRecursive(grammar, this._cachedCompiledPatterns, true);
            if (this.applyEndPatternLast) {
                this._cachedCompiledPatterns.push(this._end.hasBackReferences ? this._end.clone() : this._end);
            }
            else {
                this._cachedCompiledPatterns.unshift(this._end.hasBackReferences ? this._end.clone() : this._end);
            }
        }
        return this._cachedCompiledPatterns;
    };
    return BeginEndRule;
}(Rule));
exports.BeginEndRule = BeginEndRule;
var BeginWhileRule = (function (_super) {
    __extends(BeginWhileRule, _super);
    function BeginWhileRule(id, name, contentName, begin, beginCaptures, _while, patterns) {
        _super.call(this, id, name, contentName);
        this._begin = new RegExpSource(begin, this.id);
        this.beginCaptures = beginCaptures;
        this._while = new RegExpSource(_while, -2);
        this.whileHasBackReferences = this._while.hasBackReferences;
        this.patterns = patterns.patterns;
        this.hasMissingPatterns = patterns.hasMissingPatterns;
        this._cachedCompiledPatterns = null;
        this._cachedCompiledWhilePatterns = null;
    }
    BeginWhileRule.prototype.getWhileWithResolvedBackReferences = function (lineText, captureIndices) {
        return this._while.resolveBackReferences(lineText, captureIndices);
    };
    BeginWhileRule.prototype.collectPatternsRecursive = function (grammar, out, isFirst) {
        if (isFirst) {
            var i = void 0, len = void 0, rule = void 0;
            for (i = 0, len = this.patterns.length; i < len; i++) {
                rule = grammar.getRule(this.patterns[i]);
                rule.collectPatternsRecursive(grammar, out, false);
            }
        }
        else {
            out.push(this._begin);
        }
    };
    BeginWhileRule.prototype.compile = function (grammar, endRegexSource, allowA, allowG) {
        this._precompile(grammar);
        return this._cachedCompiledPatterns.compile(grammar, allowA, allowG);
    };
    BeginWhileRule.prototype._precompile = function (grammar) {
        if (!this._cachedCompiledPatterns) {
            this._cachedCompiledPatterns = new RegExpSourceList();
            this.collectPatternsRecursive(grammar, this._cachedCompiledPatterns, true);
        }
    };
    BeginWhileRule.prototype.compileWhile = function (grammar, endRegexSource, allowA, allowG) {
        this._precompileWhile(grammar);
        if (this._while.hasBackReferences) {
            this._cachedCompiledWhilePatterns.setSource(0, endRegexSource);
        }
        return this._cachedCompiledWhilePatterns.compile(grammar, allowA, allowG);
    };
    BeginWhileRule.prototype._precompileWhile = function (grammar) {
        if (!this._cachedCompiledWhilePatterns) {
            this._cachedCompiledWhilePatterns = new RegExpSourceList();
            this._cachedCompiledWhilePatterns.push(this._while.hasBackReferences ? this._while.clone() : this._while);
        }
    };
    return BeginWhileRule;
}(Rule));
exports.BeginWhileRule = BeginWhileRule;
var RuleFactory = (function () {
    function RuleFactory() {
    }
    RuleFactory.createCaptureRule = function (helper, name, contentName, retokenizeCapturedWithRuleId) {
        return helper.registerRule(function (id) {
            return new CaptureRule(id, name, contentName, retokenizeCapturedWithRuleId);
        });
    };
    RuleFactory.getCompiledRuleId = function (desc, helper, repository) {
        if (!desc.id) {
            helper.registerRule(function (id) {
                desc.id = id;
                if (desc.match) {
                    return new MatchRule(desc.id, desc.name, desc.match, RuleFactory._compileCaptures(desc.captures, helper, repository));
                }
                if (!desc.begin) {
                    if (desc.repository) {
                        repository = utils_1.mergeObjects({}, repository, desc.repository);
                    }
                    return new IncludeOnlyRule(desc.id, desc.name, desc.contentName, RuleFactory._compilePatterns(desc.patterns, helper, repository));
                }
                if (desc.while) {
                    return new BeginWhileRule(desc.id, desc.name, desc.contentName, desc.begin, RuleFactory._compileCaptures(desc.beginCaptures || desc.captures, helper, repository), desc.while, RuleFactory._compilePatterns(desc.patterns, helper, repository));
                }
                return new BeginEndRule(desc.id, desc.name, desc.contentName, desc.begin, RuleFactory._compileCaptures(desc.beginCaptures || desc.captures, helper, repository), desc.end, RuleFactory._compileCaptures(desc.endCaptures || desc.captures, helper, repository), desc.applyEndPatternLast, RuleFactory._compilePatterns(desc.patterns, helper, repository));
            });
        }
        return desc.id;
    };
    RuleFactory._compileCaptures = function (captures, helper, repository) {
        var r = [], numericCaptureId, maximumCaptureId, i, captureId;
        if (captures) {
            // Find the maximum capture id
            maximumCaptureId = 0;
            for (captureId in captures) {
                numericCaptureId = parseInt(captureId, 10);
                if (numericCaptureId > maximumCaptureId) {
                    maximumCaptureId = numericCaptureId;
                }
            }
            // Initialize result
            for (i = 0; i <= maximumCaptureId; i++) {
                r[i] = null;
            }
            // Fill out result
            for (captureId in captures) {
                numericCaptureId = parseInt(captureId, 10);
                var retokenizeCapturedWithRuleId = 0;
                if (captures[captureId].patterns) {
                    retokenizeCapturedWithRuleId = RuleFactory.getCompiledRuleId(captures[captureId], helper, repository);
                }
                r[numericCaptureId] = RuleFactory.createCaptureRule(helper, captures[captureId].name, captures[captureId].contentName, retokenizeCapturedWithRuleId);
            }
        }
        return r;
    };
    RuleFactory._compilePatterns = function (patterns, helper, repository) {
        var r = [], pattern, i, len, patternId, externalGrammar, rule, skipRule;
        if (patterns) {
            for (i = 0, len = patterns.length; i < len; i++) {
                pattern = patterns[i];
                patternId = -1;
                if (pattern.include) {
                    if (pattern.include.charAt(0) === '#') {
                        // Local include found in `repository`
                        var localIncludedRule = repository[pattern.include.substr(1)];
                        if (localIncludedRule) {
                            patternId = RuleFactory.getCompiledRuleId(localIncludedRule, helper, repository);
                        }
                        else {
                        }
                    }
                    else if (pattern.include === '$base' || pattern.include === '$self') {
                        // Special include also found in `repository`
                        patternId = RuleFactory.getCompiledRuleId(repository[pattern.include], helper, repository);
                    }
                    else {
                        var externalGrammarName = null, externalGrammarInclude = null, sharpIndex = pattern.include.indexOf('#');
                        if (sharpIndex >= 0) {
                            externalGrammarName = pattern.include.substring(0, sharpIndex);
                            externalGrammarInclude = pattern.include.substring(sharpIndex + 1);
                        }
                        else {
                            externalGrammarName = pattern.include;
                        }
                        // External include
                        externalGrammar = helper.getExternalGrammar(externalGrammarName, repository);
                        if (externalGrammar) {
                            if (externalGrammarInclude) {
                                var externalIncludedRule = externalGrammar.repository[externalGrammarInclude];
                                if (externalIncludedRule) {
                                    patternId = RuleFactory.getCompiledRuleId(externalIncludedRule, helper, externalGrammar.repository);
                                }
                                else {
                                }
                            }
                            else {
                                patternId = RuleFactory.getCompiledRuleId(externalGrammar.repository.$self, helper, externalGrammar.repository);
                            }
                        }
                        else {
                        }
                    }
                }
                else {
                    patternId = RuleFactory.getCompiledRuleId(pattern, helper, repository);
                }
                if (patternId !== -1) {
                    rule = helper.getRule(patternId);
                    skipRule = false;
                    if (rule instanceof IncludeOnlyRule || rule instanceof BeginEndRule || rule instanceof BeginWhileRule) {
                        if (rule.hasMissingPatterns && rule.patterns.length === 0) {
                            skipRule = true;
                        }
                    }
                    if (skipRule) {
                        // console.log('REMOVING RULE ENTIRELY DUE TO EMPTY PATTERNS THAT ARE MISSING');
                        continue;
                    }
                    r.push(patternId);
                }
            }
        }
        return {
            patterns: r,
            hasMissingPatterns: ((patterns ? patterns.length : 0) !== r.length)
        };
    };
    return RuleFactory;
}());
exports.RuleFactory = RuleFactory;

});
$load('./grammar', function(require, module, exports) {
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';
var utils_1 = require('./utils');
var rule_1 = require('./rule');
var matcher_1 = require('./matcher');
function createGrammar(grammar, grammarRepository) {
    return new Grammar(grammar, grammarRepository);
}
exports.createGrammar = createGrammar;
/**
 * Fill in `result` all external included scopes in `patterns`
 */
function _extractIncludedScopesInPatterns(result, patterns) {
    for (var i = 0, len = patterns.length; i < len; i++) {
        if (Array.isArray(patterns[i].patterns)) {
            _extractIncludedScopesInPatterns(result, patterns[i].patterns);
        }
        var include = patterns[i].include;
        if (!include) {
            continue;
        }
        if (include === '$base' || include === '$self') {
            // Special includes that can be resolved locally in this grammar
            continue;
        }
        if (include.charAt(0) === '#') {
            // Local include from this grammar
            continue;
        }
        var sharpIndex = include.indexOf('#');
        if (sharpIndex >= 0) {
            result[include.substring(0, sharpIndex)] = true;
        }
        else {
            result[include] = true;
        }
    }
}
/**
 * Fill in `result` all external included scopes in `repository`
 */
function _extractIncludedScopesInRepository(result, repository) {
    for (var name_1 in repository) {
        var rule = repository[name_1];
        if (rule.patterns && Array.isArray(rule.patterns)) {
            _extractIncludedScopesInPatterns(result, rule.patterns);
        }
        if (rule.repository) {
            _extractIncludedScopesInRepository(result, rule.repository);
        }
    }
}
/**
 * Collects the list of all external included scopes in `grammar`.
 */
function collectIncludedScopes(result, grammar) {
    if (grammar.patterns && Array.isArray(grammar.patterns)) {
        _extractIncludedScopesInPatterns(result, grammar.patterns);
    }
    if (grammar.repository) {
        _extractIncludedScopesInRepository(result, grammar.repository);
    }
    // remove references to own scope (avoid recursion)
    delete result[grammar.scopeName];
}
exports.collectIncludedScopes = collectIncludedScopes;
function collectInjections(result, selector, rule, ruleFactoryHelper, grammar) {
    function scopesAreMatching(thisScopeName, scopeName) {
        if (!thisScopeName) {
            return false;
        }
        if (thisScopeName === scopeName) {
            return true;
        }
        var len = scopeName.length;
        return thisScopeName.length > len && thisScopeName.substr(0, len) === scopeName && thisScopeName[len] === '.';
    }
    function nameMatcher(identifers, stackElements) {
        var scopes = stackElements.generateScopes();
        var lastIndex = 0;
        return identifers.every(function (identifier) {
            for (var i = lastIndex; i < scopes.length; i++) {
                if (scopesAreMatching(scopes[i], identifier)) {
                    lastIndex = i;
                    return true;
                }
            }
            return false;
        });
    }
    ;
    var subExpressions = selector.split(',');
    subExpressions.forEach(function (subExpression) {
        var expressionString = subExpression.replace(/L:/g, '');
        result.push({
            matcher: matcher_1.createMatcher(expressionString, nameMatcher),
            ruleId: rule_1.RuleFactory.getCompiledRuleId(rule, ruleFactoryHelper, grammar.repository),
            grammar: grammar,
            priorityMatch: expressionString.length < subExpression.length
        });
    });
}
var Grammar = (function () {
    function Grammar(grammar, grammarRepository) {
        this._rootId = -1;
        this._lastRuleId = 0;
        this._ruleId2desc = [];
        this._includedGrammars = {};
        this._grammarRepository = grammarRepository;
        this._grammar = initGrammar(grammar, null);
    }
    Grammar.prototype.getInjections = function (states) {
        var _this = this;
        if (!this._injections) {
            this._injections = [];
            // add injections from the current grammar
            var rawInjections = this._grammar.injections;
            if (rawInjections) {
                for (var expression in rawInjections) {
                    collectInjections(this._injections, expression, rawInjections[expression], this, this._grammar);
                }
            }
            // add injection grammars contributed for the current scope
            if (this._grammarRepository) {
                var injectionScopeNames = this._grammarRepository.injections(this._grammar.scopeName);
                if (injectionScopeNames) {
                    injectionScopeNames.forEach(function (injectionScopeName) {
                        var injectionGrammar = _this.getExternalGrammar(injectionScopeName);
                        if (injectionGrammar) {
                            var selector = injectionGrammar.injectionSelector;
                            if (selector) {
                                collectInjections(_this._injections, selector, injectionGrammar, _this, injectionGrammar);
                            }
                        }
                    });
                }
            }
        }
        if (this._injections.length === 0) {
            return this._injections;
        }
        return this._injections.filter(function (injection) { return injection.matcher(states); });
    };
    Grammar.prototype.registerRule = function (factory) {
        var id = (++this._lastRuleId);
        var result = factory(id);
        this._ruleId2desc[id] = result;
        return result;
    };
    Grammar.prototype.getRule = function (patternId) {
        return this._ruleId2desc[patternId];
    };
    Grammar.prototype.getExternalGrammar = function (scopeName, repository) {
        var actualGrammar = null;
        if (this._includedGrammars[scopeName]) {
            return this._includedGrammars[scopeName];
        }
        else if (this._grammarRepository) {
            var rawIncludedGrammar = this._grammarRepository.lookup(scopeName);
            if (rawIncludedGrammar) {
                // console.log('LOADED GRAMMAR ' + pattern.include);
                this._includedGrammars[scopeName] = initGrammar(rawIncludedGrammar, repository && repository.$base);
                return this._includedGrammars[scopeName];
            }
        }
    };
    Grammar.prototype.tokenizeLine = function (lineText, prevState) {
        if (this._rootId === -1) {
            this._rootId = rule_1.RuleFactory.getCompiledRuleId(this._grammar.repository.$self, this, this._grammar.repository);
        }
        var isFirstLine;
        if (!prevState) {
            isFirstLine = true;
            prevState = new StackElement(null, this._rootId, -1, null, this.getRule(this._rootId).getName(null, null), null);
        }
        else {
            isFirstLine = false;
            prevState.reset();
        }
        lineText = lineText + '\n';
        var onigLineText = rule_1.createOnigString(lineText);
        var lineLength = rule_1.getString(onigLineText).length;
        var lineTokens = new LineTokens();
        var nextState = _tokenizeString(this, onigLineText, isFirstLine, 0, prevState, lineTokens);
        var _produced = lineTokens.getResult(nextState, lineLength);
        return {
            tokens: _produced,
            ruleStack: nextState
        };
    };
    return Grammar;
}());
function initGrammar(grammar, base) {
    grammar = utils_1.clone(grammar);
    grammar.repository = grammar.repository || {};
    grammar.repository.$self = {
        patterns: grammar.patterns,
        name: grammar.scopeName
    };
    grammar.repository.$base = base || grammar.repository.$self;
    return grammar;
}
function handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, captures, captureIndices) {
    if (captures.length === 0) {
        return;
    }
    var len = Math.min(captures.length, captureIndices.length), localStack = [], maxEnd = captureIndices[0].end, i, captureRule, captureIndex;
    for (i = 0; i < len; i++) {
        captureRule = captures[i];
        if (captureRule === null) {
            // Not interested
            continue;
        }
        captureIndex = captureIndices[i];
        if (captureIndex.length === 0) {
            // Nothing really captured
            continue;
        }
        if (captureIndex.start > maxEnd) {
            // Capture going beyond consumed string
            break;
        }
        // pop captures while needed
        while (localStack.length > 0 && localStack[localStack.length - 1].endPos <= captureIndex.start) {
            // pop!
            lineTokens.produce(stack, localStack[localStack.length - 1].endPos, localStack);
            localStack.pop();
        }
        lineTokens.produce(stack, captureIndex.start, localStack);
        if (captureRule.retokenizeCapturedWithRuleId) {
            // the capture requires additional matching
            var stackClone = stack.push(captureRule.retokenizeCapturedWithRuleId, captureIndex.start, null, captureRule.getName(rule_1.getString(lineText), captureIndices), captureRule.getContentName(rule_1.getString(lineText), captureIndices));
            _tokenizeString(grammar, rule_1.createOnigString(rule_1.getString(lineText).substring(0, captureIndex.end)), (isFirstLine && captureIndex.start === 0), captureIndex.start, stackClone, lineTokens);
            continue;
        }
        // push
        localStack.push(new LocalStackElement(captureRule.getName(rule_1.getString(lineText), captureIndices), captureIndex.end));
    }
    while (localStack.length > 0) {
        // pop!
        lineTokens.produce(stack, localStack[localStack.length - 1].endPos, localStack);
        localStack.pop();
    }
}
function matchInjections(injections, grammar, lineText, isFirstLine, linePos, stack, anchorPosition) {
    // The lower the better
    var bestMatchRating = Number.MAX_VALUE;
    var bestMatchCaptureIndices = null;
    var bestMatchRuleId;
    var bestMatchResultPriority = false;
    for (var i = 0, len = injections.length; i < len; i++) {
        var injection = injections[i];
        var ruleScanner = grammar.getRule(injection.ruleId).compile(grammar, null, isFirstLine, linePos === anchorPosition);
        var matchResult = ruleScanner.scanner._findNextMatchSync(lineText, linePos);
        if (!matchResult) {
            continue;
        }
        var matchRating = matchResult.captureIndices[0].start;
        if (matchRating >= bestMatchRating) {
            continue;
        }
        bestMatchRating = matchRating;
        bestMatchCaptureIndices = matchResult.captureIndices;
        bestMatchRuleId = ruleScanner.rules[matchResult.index];
        bestMatchResultPriority = injection.priorityMatch;
        if (bestMatchRating === linePos && bestMatchResultPriority) {
            // No more need to look at the rest of the injections
            break;
        }
    }
    if (bestMatchCaptureIndices) {
        return {
            priorityMatch: bestMatchResultPriority,
            captureIndices: bestMatchCaptureIndices,
            matchedRuleId: bestMatchRuleId
        };
    }
    return null;
}
function matchRule(grammar, lineText, isFirstLine, linePos, stack, anchorPosition) {
    var rule = stack.getRule(grammar);
    if (rule instanceof rule_1.BeginWhileRule && stack.getEnterPos() === -1) {
        var ruleScanner_1 = rule.compileWhile(grammar, stack.getEndRule(), isFirstLine, linePos === anchorPosition);
        var r_1 = ruleScanner_1.scanner._findNextMatchSync(lineText, linePos);
        var doNotContinue = {
            captureIndices: null,
            matchedRuleId: -3
        };
        if (r_1) {
            var matchedRuleId = ruleScanner_1.rules[r_1.index];
            if (matchedRuleId != -2) {
                // we shouldn't end up here
                return doNotContinue;
            }
        }
        else {
            return doNotContinue;
        }
    }
    var ruleScanner = rule.compile(grammar, stack.getEndRule(), isFirstLine, linePos === anchorPosition);
    var r = ruleScanner.scanner._findNextMatchSync(lineText, linePos);
    if (r) {
        return {
            captureIndices: r.captureIndices,
            matchedRuleId: ruleScanner.rules[r.index]
        };
    }
    return null;
}
function matchRuleOrInjections(grammar, lineText, isFirstLine, linePos, stack, anchorPosition) {
    // Look for normal grammar rule
    var matchResult = matchRule(grammar, lineText, isFirstLine, linePos, stack, anchorPosition);
    // Look for injected rules
    var injections = grammar.getInjections(stack);
    if (injections.length === 0) {
        // No injections whatsoever => early return
        return matchResult;
    }
    var injectionResult = matchInjections(injections, grammar, lineText, isFirstLine, linePos, stack, anchorPosition);
    if (!injectionResult) {
        // No injections matched => early return
        return matchResult;
    }
    if (!matchResult) {
        // Only injections matched => early return
        return injectionResult;
    }
    // Decide if `matchResult` or `injectionResult` should win
    var matchResultScore = matchResult.captureIndices[0].start;
    var injectionResultScore = injectionResult.captureIndices[0].start;
    if (injectionResultScore < matchResultScore || (injectionResult.priorityMatch && injectionResultScore === matchResultScore)) {
        // injection won!
        return injectionResult;
    }
    return matchResult;
}
function _tokenizeString(grammar, lineText, isFirstLine, linePos, stack, lineTokens) {
    var lineLength = rule_1.getString(lineText).length;
    var anchorPosition = -1;
    while (linePos < lineLength) {
        scanNext(); // potentially modifies linePos && anchorPosition
    }
    function scanNext() {
        var r = matchRuleOrInjections(grammar, lineText, isFirstLine, linePos, stack, anchorPosition);
        if (!r) {
            // No match
            lineTokens.produce(stack, lineLength);
            linePos = lineLength;
            return true;
        }
        var captureIndices = r.captureIndices;
        var matchedRuleId = r.matchedRuleId;
        var hasAdvanced = (captureIndices && captureIndices.length > 0) ? (captureIndices[0].end > linePos) : false;
        if (matchedRuleId === -1) {
            // We matched the `end` for this rule => pop it
            var poppedRule = stack.getRule(grammar);
            lineTokens.produce(stack, captureIndices[0].start);
            stack = stack.withContentName(null);
            handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, poppedRule.endCaptures, captureIndices);
            lineTokens.produce(stack, captureIndices[0].end);
            // pop
            var popped = stack;
            stack = stack.pop();
            if (!hasAdvanced && popped.getEnterPos() === linePos) {
                // Grammar pushed & popped a rule without advancing
                console.error('[1] - Grammar is in an endless loop - Grammar pushed & popped a rule without advancing');
                // See https://github.com/Microsoft/vscode-textmate/issues/12
                // Let's assume this was a mistake by the grammar author and the intent was to continue in this state
                stack = stack.pushElement(popped);
                lineTokens.produce(stack, lineLength);
                linePos = lineLength;
                return false;
            }
        }
        else if (matchedRuleId === -3) {
            // A while clause failed
            stack = stack.pop();
            return true;
        }
        else {
            // We matched a rule!
            var _rule = grammar.getRule(matchedRuleId);
            lineTokens.produce(stack, captureIndices[0].start);
            var beforePush = stack;
            // push it on the stack rule
            stack = stack.push(matchedRuleId, linePos, null, _rule.getName(rule_1.getString(lineText), captureIndices), null);
            if (_rule instanceof rule_1.BeginEndRule) {
                var pushedRule = _rule;
                handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, captureIndices);
                lineTokens.produce(stack, captureIndices[0].end);
                anchorPosition = captureIndices[0].end;
                stack = stack.withContentName(pushedRule.getContentName(rule_1.getString(lineText), captureIndices));
                if (pushedRule.endHasBackReferences) {
                    stack = stack.withEndRule(pushedRule.getEndWithResolvedBackReferences(rule_1.getString(lineText), captureIndices));
                }
                if (!hasAdvanced && beforePush.hasSameRuleAs(stack)) {
                    // Grammar pushed the same rule without advancing
                    console.error('[2] - Grammar is in an endless loop - Grammar pushed the same rule without advancing');
                    stack = stack.pop();
                    lineTokens.produce(stack, lineLength);
                    linePos = lineLength;
                    return false;
                }
            }
            else if (_rule instanceof rule_1.BeginWhileRule) {
                var pushedRule = _rule;
                handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, captureIndices);
                lineTokens.produce(stack, captureIndices[0].end);
                anchorPosition = captureIndices[0].end;
                stack = stack.withContentName(pushedRule.getContentName(rule_1.getString(lineText), captureIndices));
                if (pushedRule.whileHasBackReferences) {
                    stack = stack.withEndRule(pushedRule.getWhileWithResolvedBackReferences(rule_1.getString(lineText), captureIndices));
                }
                if (!hasAdvanced && beforePush.hasSameRuleAs(stack)) {
                    // Grammar pushed the same rule without advancing
                    console.error('[3] - Grammar is in an endless loop - Grammar pushed the same rule without advancing');
                    stack = stack.pop();
                    lineTokens.produce(stack, lineLength);
                    linePos = lineLength;
                    return false;
                }
            }
            else {
                var matchingRule = _rule;
                handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, matchingRule.captures, captureIndices);
                lineTokens.produce(stack, captureIndices[0].end);
                // pop rule immediately since it is a MatchRule
                stack = stack.pop();
                if (!hasAdvanced) {
                    // Grammar is not advancing, nor is it pushing/popping
                    console.error('[4] - Grammar is in an endless loop - Grammar is not advancing, nor is it pushing/popping');
                    stack = stack.safePop();
                    lineTokens.produce(stack, lineLength);
                    linePos = lineLength;
                    return false;
                }
            }
        }
        if (captureIndices[0].end > linePos) {
            // Advance stream
            linePos = captureIndices[0].end;
            isFirstLine = false;
        }
        return true;
    }
    return stack;
}
/**
 * **IMPORTANT** - Immutable!
 */
var StackElement = (function () {
    function StackElement(parent, ruleId, enterPos, endRule, scopeName, contentName) {
        this._parent = parent;
        this._ruleId = ruleId;
        this._enterPos = enterPos;
        this._endRule = endRule;
        this._scopeName = scopeName;
        this._contentName = contentName;
    }
    StackElement.prototype.equals = function (other) {
        if (!this._shallowEquals(other)) {
            return false;
        }
        if (!this._parent && !other._parent) {
            return true;
        }
        if (!this._parent || !other._parent) {
            return false;
        }
        return this._parent.equals(other._parent);
    };
    StackElement.prototype._shallowEquals = function (other) {
        return (this._ruleId === other._ruleId
            && this._endRule === other._endRule
            && this._scopeName === other._scopeName
            && this._contentName === other._contentName);
    };
    StackElement.prototype.reset = function () {
        this._enterPos = -1;
        if (this._parent) {
            this._parent.reset();
        }
    };
    StackElement.prototype.pop = function () {
        return this._parent;
    };
    StackElement.prototype.safePop = function () {
        if (this._parent) {
            return this._parent;
        }
        return this;
    };
    StackElement.prototype.pushElement = function (what) {
        return this.push(what._ruleId, what._enterPos, what._endRule, what._scopeName, what._contentName);
    };
    StackElement.prototype.push = function (ruleId, enterPos, endRule, scopeName, contentName) {
        return new StackElement(this, ruleId, enterPos, endRule, scopeName, contentName);
    };
    StackElement.prototype.getEnterPos = function () {
        return this._enterPos;
    };
    StackElement.prototype.getRule = function (grammar) {
        return grammar.getRule(this._ruleId);
    };
    StackElement.prototype.getEndRule = function () {
        return this._endRule;
    };
    StackElement.prototype._writeString = function (res, outIndex) {
        if (this._parent) {
            outIndex = this._parent._writeString(res, outIndex);
        }
        res[outIndex++] = "(" + this._ruleId + ", " + this._scopeName + ", " + this._contentName + ")";
        return outIndex;
    };
    StackElement.prototype.toString = function () {
        var r = [];
        this._writeString(r, 0);
        return '[' + r.join(',') + ']';
    };
    StackElement.prototype.withContentName = function (contentName) {
        if (this._contentName === contentName) {
            return this;
        }
        return new StackElement(this._parent, this._ruleId, this._enterPos, this._endRule, this._scopeName, contentName);
    };
    StackElement.prototype.withEndRule = function (endRule) {
        if (this._endRule === endRule) {
            return this;
        }
        return new StackElement(this._parent, this._ruleId, this._enterPos, endRule, this._scopeName, this._contentName);
    };
    StackElement.prototype._writeScopes = function (scopes, outIndex) {
        if (this._parent) {
            outIndex = this._parent._writeScopes(scopes, outIndex);
        }
        if (this._scopeName) {
            scopes[outIndex++] = this._scopeName;
        }
        if (this._contentName) {
            scopes[outIndex++] = this._contentName;
        }
        return outIndex;
    };
    /**
     * Token scopes
     */
    StackElement.prototype.generateScopes = function () {
        var result = [];
        this._writeScopes(result, 0);
        return result;
    };
    StackElement.prototype.hasSameRuleAs = function (other) {
        return this._ruleId === other._ruleId;
    };
    return StackElement;
}());
exports.StackElement = StackElement;
var LocalStackElement = (function () {
    function LocalStackElement(scopeName, endPos) {
        this.scopeName = scopeName;
        this.endPos = endPos;
    }
    return LocalStackElement;
}());
var LineTokens = (function () {
    function LineTokens() {
        this._tokens = [];
        this._lastTokenEndIndex = 0;
    }
    LineTokens.prototype.produce = function (stack, endIndex, extraScopes) {
        // console.log('PRODUCE TOKEN: lastTokenEndIndex: ' + lastTokenEndIndex + ', endIndex: ' + endIndex);
        if (this._lastTokenEndIndex >= endIndex) {
            return;
        }
        var scopes = stack.generateScopes();
        var outIndex = scopes.length;
        if (extraScopes) {
            for (var i = 0; i < extraScopes.length; i++) {
                scopes[outIndex++] = extraScopes[i].scopeName;
            }
        }
        this._tokens.push({
            startIndex: this._lastTokenEndIndex,
            endIndex: endIndex,
            // value: lineText.substring(lastTokenEndIndex, endIndex),
            scopes: scopes
        });
        this._lastTokenEndIndex = endIndex;
    };
    LineTokens.prototype.getResult = function (stack, lineLength) {
        if (this._tokens.length > 0 && this._tokens[this._tokens.length - 1].startIndex === lineLength - 1) {
            // pop produced token for newline
            this._tokens.pop();
        }
        if (this._tokens.length === 0) {
            this._lastTokenEndIndex = -1;
            this.produce(stack, lineLength, null);
            this._tokens[this._tokens.length - 1].startIndex = 0;
        }
        return this._tokens;
    };
    return LineTokens;
}());

});
$load('./registry', function(require, module, exports) {
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';
var grammar_1 = require('./grammar');
var SyncRegistry = (function () {
    function SyncRegistry() {
        this._grammars = {};
        this._rawGrammars = {};
        this._injectionGrammars = {};
    }
    /**
     * Add `grammar` to registry and return a list of referenced scope names
     */
    SyncRegistry.prototype.addGrammar = function (grammar, injectionScopeNames) {
        this._rawGrammars[grammar.scopeName] = grammar;
        var includedScopes = {};
        grammar_1.collectIncludedScopes(includedScopes, grammar);
        if (injectionScopeNames) {
            this._injectionGrammars[grammar.scopeName] = injectionScopeNames;
            injectionScopeNames.forEach(function (scopeName) {
                includedScopes[scopeName] = true;
            });
        }
        return Object.keys(includedScopes);
    };
    /**
     * Lookup a raw grammar.
     */
    SyncRegistry.prototype.lookup = function (scopeName) {
        return this._rawGrammars[scopeName];
    };
    /**
     * Returns the injections for the given grammar
     */
    SyncRegistry.prototype.injections = function (targetScope) {
        return this._injectionGrammars[targetScope];
    };
    /**
     * Lookup a grammar.
     */
    SyncRegistry.prototype.grammarForScopeName = function (scopeName) {
        if (!this._grammars[scopeName]) {
            var rawGrammar = this._rawGrammars[scopeName];
            if (!rawGrammar) {
                return null;
            }
            this._grammars[scopeName] = grammar_1.createGrammar(rawGrammar, this);
        }
        return this._grammars[scopeName];
    };
    return SyncRegistry;
}());
exports.SyncRegistry = SyncRegistry;

});
$load('./main', function(require, module, exports) {
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';
var registry_1 = require('./registry');
var grammarReader_1 = require('./grammarReader');
var expressionMatcher = require('./matcher');
exports.createMatcher = expressionMatcher.createMatcher;
var DEFAULT_LOCATOR = {
    getFilePath: function (scopeName) { return null; },
    getInjections: function (scopeName) { return null; }
};
var Registry = (function () {
    function Registry(locator, useExperimentalParser) {
        if (locator === void 0) { locator = DEFAULT_LOCATOR; }
        if (useExperimentalParser === void 0) { useExperimentalParser = false; }
        this._locator = locator;
        this._useExperimentalParser = useExperimentalParser;
        this._syncRegistry = new registry_1.SyncRegistry();
    }
    Registry.prototype.loadGrammar = function (initialScopeName, callback) {
        var remainingScopeNames = [initialScopeName];
        var seenScopeNames = {};
        seenScopeNames[initialScopeName] = true;
        while (remainingScopeNames.length > 0) {
            var scopeName = remainingScopeNames.shift();
            if (this._syncRegistry.lookup(scopeName)) {
                continue;
            }
            var filePath = this._locator.getFilePath(scopeName);
            if (!filePath) {
                if (scopeName === initialScopeName) {
                    callback(new Error('Unknown location for grammar <' + initialScopeName + '>'), null);
                    return;
                }
                continue;
            }
            try {
                var grammar = grammarReader_1.readGrammarSync(filePath, this._useExperimentalParser);
                var injections = (typeof this._locator.getInjections === 'function') && this._locator.getInjections(scopeName);
                var deps = this._syncRegistry.addGrammar(grammar, injections);
                deps.forEach(function (dep) {
                    if (!seenScopeNames[dep]) {
                        seenScopeNames[dep] = true;
                        remainingScopeNames.push(dep);
                    }
                });
            }
            catch (err) {
                if (scopeName === initialScopeName) {
                    callback(new Error('Unknown location for grammar <' + initialScopeName + '>'), null);
                    return;
                }
            }
        }
        callback(null, this.grammarForScopeName(initialScopeName));
    };
    Registry.prototype.loadGrammarFromPathSync = function (path) {
        var rawGrammar = grammarReader_1.readGrammarSync(path, this._useExperimentalParser);
        var injections = this._locator.getInjections(rawGrammar.scopeName);
        this._syncRegistry.addGrammar(rawGrammar, injections);
        return this.grammarForScopeName(rawGrammar.scopeName);
    };
    Registry.prototype.grammarForScopeName = function (scopeName) {
        return this._syncRegistry.grammarForScopeName(scopeName);
    };
    return Registry;
}());
exports.Registry = Registry;

});
module.exports = $map['./main'].exports;
