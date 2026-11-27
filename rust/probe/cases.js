/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// Generates cases.json: regex cases that compare vscode-oniguruma 1.7.0 (WASM) with the native engine.
// Each case is { patterns, input, start }; both probes print one JSON line per case.
'use strict';
const fs = require('fs');
const cases = [];
const add = (patterns, input, start = 0) => cases.push({ patterns: Array.isArray(patterns) ? patterns : [patterns], input, start });

// Ordinary controls: both engines must agree on these on any version.
add('\\w+', 'hello world');
add('\\w+', 'hello world', 5);
add('(a)|(b)', 'xxb');
add(['\\G(foo)', 'bar', '(?<=o)b'], 'foobar', 3);
add('\\Gx', 'ax', 0);
add('\\Gx', 'ax', 1);
add('(x)', '😀😀x😀', 0);
add('😀+', 'a😀😀b', 0);
add('(?<=\\s)foo', 'a foo', 0);
add('(a)\\1', 'baab');
add('\\h+', 'zz09afAFg');
add('[[:alpha:]]+', 'éa1');
add('(?i)straße', 'STRASSE');
add('(?i)ß', 'SS');
add('\\p{Greek}+', 'abc αβγ');
add('\\X', 'e\u0301x');
add('\\R', 'a\r\nb');
add('\\bfoo\\b', 'a foo b');
add('(?<name>a)(?<n2>b)?', 'ac');
add('^\\s*(#)\\s*(include)\\b', '  #  include <x>');
add('[\\p{L}\\p{N}_]+', 'Größe_42 x');
add('(?x) a b # comment', 'ab');
add('a++b', 'aaab');
add('(?>a+)b', 'aaab');
add('(?~abc)', 'xxabc');
add('\\A', 'abc', 1);
add('\\z', 'abc', 1);
add('$', 'ab\ncd', 0);
add('[^\\x{0}-\\x{7f}]', 'abc€', 0);
add('\\x{1F600}', 'a😀', 0);
add('[\\u00e9]', 'aé', 0);
add('(?i)[a-z]+', 'ABC', 0);
add(['a', 'b', 'c'], 'zzzcba', 0);
add(['(b)', '(a)'], 'ab', 0);
add('(', 'x');
add('[a', 'x');
add('a{2,1}', 'aa');
add('\\p{Foo}', 'x');
add('(?<a>x)\\k<b>', 'x');
const longLine = 'x'.repeat(1200) + 'é foo(bar) 😀 baz';
add('foo\\((\\w+)\\)', longLine, 0);
add('\\bbaz\\b', longLine, 1100);
add(['\\G\\s*', '(?<=😀)\\s'], longLine, 1205);

// Behaviors that changed in Oniguruma 6.9.9 and 6.9.10 (from its HISTORY).
add('[[:punct:]]', 'a$b!c');                 // #268: [[:punct:]] = \p{P} + \p{S} since 6.9.9
add('[[:punct:]]+', '$+<=>^`|~');
add('[[:^punct:]]+', '$+<=>^`|~a');
add('\\p{PosixPunct}+', '$+!');
add('[[:^alpha:]]+', '12ab');                // negative POSIX bracket fix
add('[^[:^alpha:]]+', '12ab');
add('[[:^alpha:][:digit:]]+', 'ab12-');
add('(?i)\\p{Word}+', 'K\u212Aſ');          // \p{Word} ignorecase like \w
add('(?i)\\w+', 'K\u212Aſ');
add('(?iI)[a-z]+', 'K\u212Aſk');             // #264: (?I) with character classes
add('(?iI)k', '\u212A');
add('(?iI)[k]', '\u212A');
add('(?iI)[^k]', '\u212A');
add('.{0,99}', 'ab');                        // #284
add('.{0,99}b', 'ab');
add('x.{0,99}y', 'x\ny xy');
add('.{0,99}?$', 'abc');
add('^.{0,3}$', 'ab');
add('a\\{2}', 'a{2} aa');                    // #293: literal escaped braces
add('a\\{2\\}', 'a{2} aa');
add('x{,2}y', 'xxy');
add('^*', 'a');                              // #292
add('a|^*', 'b');
add('\\A|\\z', 'ab', 1);                     // #295: empty match with anchors
add('(?=b)|$', 'ab', 0);
add('\\b|$', '  ', 0);
add('(?:^|\\G)', 'ab', 1);
add('[\\w-a]+', 'a-b');                      // #298
add('[\\d-z]+', '1-z');
add('[a-\\w]', 'b');
add('\\p{Kawi}', 'x');                       // Unicode 15 script
add('\\p{Nag_Mundari}', 'x');
add('\\p{Garay}', 'x');                      // Unicode 16 script
add('\\w+', 'a\u{11F04}b');                  // Kawi letter (Unicode 15)
add('\\p{L}+', 'a\u{10D50}b');               // Garay letter (Unicode 16)
add('\\p{Alpha}+', 'a\u{2EBF0}b');           // CJK Ext. I (Unicode 15.1)
add('[[:alpha:]]+', 'a\u{1E4D0}b');          // Nag Mundari (Unicode 15)
add('\\X', '\u{1FAE8}\u{1F3FB}');            // Unicode 15 emoji
add('\\p{Emoji}', '\u{1FAE8}');
add('(?i)\u{10D70}', '\u{10D50}');           // Garay case pair (Unicode 16)
fs.writeFileSync(__dirname + '/cases.json', JSON.stringify(cases, null, 0).replace(/\},\{/g, '},\n{'));
console.log(cases.length + ' cases');
