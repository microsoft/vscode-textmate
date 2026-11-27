# vscode-textmate in Rust

A direct, file-by-file port of [vscode-textmate](https://github.com/microsoft/vscode-textmate) to Rust, written from its TypeScript sources and 9.3.2's npm bundle, with no code or design taken from other Rust TextMate implementations. It follows this repository's main branch: the 9.3.2 release plus #252 (a missing or empty `end`, and a back-referencing `while` whose source is empty, become the empty pattern instead of U+FFFF, so they match at once), #261 (the TokenHandler refactor) and #276 (fewer characters escaped in `escapeRegExpCharacters`). It loads the same TextMate grammars and themes as vscode-textmate and gives the same tokens, scopes, states, encoded token attributes and fonts. MIT licensed, like vscode-textmate (see ../LICENSE.md).

## Status

The port is complete: every part of vscode-textmate that loads grammars and themes and tokenizes is ported (the table under Internals maps the modules), it links the same Oniguruma sources as the vscode-oniguruma 1.7.0 that VS Code ships, and its output is identical to vscode-textmate's, built from main and as the 9.3.2 release, on everything it was compared with.

- **Against vscode-textmate built from main, with vscode-oniguruma 1.7.0**, using VS Code's built-in grammars (84 scopes, with their injections and embedded languages) and its 2026 Dark theme, on 9 files in 7 languages (98,998 lines, 481,930 tokens): 0 differences in the binary tokens of `tokenize_line2`, 0 in the scopes of `tokenize_line`, 0 in the states rebuilt with `diff_state_stacks_ref_eq` and `apply_state_stack_diff`, and 0 when tokenizing on from those rebuilt states. The same comparison against the 9.3.2 release, on an earlier VS Code checkout whose files and theme differ slightly (99,002 lines, 482,681 tokens), also gives 0 differences. Token counts are those of `tokenize_line2`, which merges neighbouring tokens with equal attributes, so they move with the theme and the files.
- **VS Code's colorize test fixtures** (extensions/vscode-colorize-tests, 109 fixtures with a grammar, 3,424 lines; 14,597 tokens under the theme of the main comparison and 14,636 under that of the 9.3.2 one), each tokenized with the grammar of its root scope: 0 differences in the same four comparisons and in the fonts, against main and against 9.3.2.
- **Fonts**: 0 differences in the `fonts` of every line under two themes with font rules (414,532 and 165,901 font ranges on the 9 files), from chained states and from states rebuilt from diffs; the binary tokens under those themes hash the same as in JS.
- **Time limit**: with a 1 ms limit on a long line (the first 200 lines of each file joined into one), tokenizing stops early on 8 of the 9 lines; on the other one (C++, whose file starts with a `//` comment, so the joined line is a single comment) the port finishes the whole line in 1.08 ms, where 9.3.2 needed 1.9 ms and stopped. As in vscode-textmate, the limit is checked between scans, so one slow scan can run past it: on the Markdown line 9.3.2 stopped after 889 ms and the port stops after 575 ms. Whether a line stops early depends on the machine's speed, so this is the one result that is not compared automatically (`oracle` prints the port's side; the JS times are from one run of the same test with 9.3.2).
- **vscode-textmate's own test cases** (../test-cases), run by `upstream_tests` the way src/tests/tokenization.test.ts runs them: all 95 pass.

| Suite | Passed | Failed | Skipped |
|---|---|---|---|
| test-cases/first-mate/tests.json | 64 | 0 | 0 |
| test-cases/suite1/tests.json | 22 | 0 | 0 |
| test-cases/suite1/whileTests.json | 9 | 0 | 0 |

`upstream_tests` would skip a test whose grammar files are missing; none are. Three of these tests (Issue #66, #239 and #251) cover the changes on main since 9.3.2, and a port of 9.3.2 alone fails them.

- **The regex engine and invalid patterns**: see Engine parity below. All 6,500 distinct regexes that the 84 grammars can produce compile in the port's Oniguruma, and for regexes that don't compile the port gives vscode-oniguruma's results.
- **Unit tests**: `cargo test` runs 28 tests: 20 ports of vscode-textmate's matcher, JSON and grammar tests (stack element metadata, fonts, shadowed rules) and 8 of the port's own, one of which tokenizes on 8 threads at once (see Internals). `parse_json` accepts and rejects what `JSON.parse` does, which vscode-textmate uses for JSON grammars.
- **One finding**: vscode-textmate's grammar test "Shadowed rules are resolved correctly" is skipped upstream and expects `outer`, with "TODO this should be inner". vscode-textmate (9.3.2 and main) actually returns `inner`, and the ported test asserts what it does.

## Performance

Same machine (an arm64 Mac), same grammars, theme and files; JS is vscode-textmate 9.3.2 with vscode-oniguruma 1.7.0 on Node 24. Times are in ms, Rust / JS. Load is the time to load the grammar; cold is the first pass of `tokenize_line2` over the file, from INITIAL with each line's state passed to the next; warm is the best of three more passes with the same grammar.

| File | Lines | Tokens | Load | Cold | Warm | Warm speedup |
|---|---|---|---|---|---|---|
| TypeScript (VS Code textModel.ts) | 2,748 | 18,084 | 3.8 / 3.2 | 260.7 / 461.2 | 116.1 / 196.9 | 1.70× |
| TypeScript (VS Code agentService.ts) | 17,189 | 117,537 | 1.1 / 1.4 | 1,094.0 / 1,891.8 | 919.6 / 1,585.7 | 1.72× |
| JavaScript (react-dom.development.js) | 26,263 | 95,304 | 3.3 / 2.8 | 940.8 / 1,584.5 | 821.5 / 1,380.1 | 1.68× |
| C++ (koffi base.cc) | 11,199 | 52,762 | 6.4 / 5.1 | 1,192.7 / 1,990.5 | 722.8 / 1,214.1 | 1.68× |
| C++ (node-addon-api napi-inl.h) | 7,251 | 32,848 | 4.0 / 3.7 | 796.0 / 1,348.5 | 436.5 / 733.9 | 1.68× |
| CSS (VS Code's src/vs/**/*.css, ~1 MB) | 29,666 | 135,730 | 1.9 / 1.2 | 1,052.7 / 1,580.5 | 901.0 / 1,336.9 | 1.48× |
| Markdown (axios CHANGELOG.md) | 1,935 | 11,679 | 39.5 / 31.1 | 130.6 / 262.6 | 97.3 / 170.2 | 1.75× |
| HTML (bignumber.js API.html) | 2,250 | 16,136 | 2.3 / 2.5 | 56.6 / 108.1 | 23.3 / 53.4 | 2.29× |
| Python (example.py) | 501 | 2,601 | 0.5 / 0.8 | 28.9 / 48.7 | 18.2 / 29.4 | 1.62× |
| **Total** | **99,002** | **482,681** | 62.8 / 51.8 | 5,553.0 / 9,276.4 | 4,056.3 / 6,700.6 | **1.65×** |

The port is 1.67× faster cold and 1.65× faster warm. Against vscode-textmate built from main, on the files of the main comparison above, the warm speedup per file is 1.48× to 2.28×, and varies by a few hundredths between runs. Load times are a few ms and noisy. The release profile uses LTO and one codegen unit. Most of the time is spent in Oniguruma, and its regset search allocated and freed its scratch memory, and a match stack for each regex it tried, on every search; the vendored Oniguruma keeps them in the regset instead (vendor/onig_sys/PATCHES.md), which takes 14% off the warm total and gives the same results. `bench <data dir> [--reps N] [corpus tags...]` times the same passes as `oracle` without comparing anything, for quick runs while tuning.

## Usage

```rust
use std::rc::Rc;
use vscode_textmate::grammar::{Registry, RegistryOptions, StateStack};
use vscode_textmate::json::parse_json;
use vscode_textmate::onig_lib::NativeOnigLib;
use vscode_textmate::raw::parse_raw_grammar;

let registry = Registry::new(RegistryOptions {
	onig_lib: Rc::new(NativeOnigLib),
	theme: Some(parse_json(THEME).expect("theme")),
	color_map: None,
	// Called with each scope name the registry needs; `parse_raw_grammar` reads JSON for a ".json" path, a plist otherwise.
	load_grammar: Box::new(|scope_name| match scope_name {
		"source.demo" => parse_raw_grammar(GRAMMAR, Some("demo.tmLanguage.json")).ok(),
		_ => None,
	}),
	get_injections: None,
});
let grammar = registry.load_grammar("source.demo").expect("load").expect("grammar");
let mut state: Option<Rc<StateStack>> = None; // INITIAL
for line in ["let a = \"x\"; /* a comment", "that ends here */ const b"] {
	let result = grammar.tokenize_line(line, state.as_ref());
	for token in &result.tokens {
		println!("{}..{} {}", token.start_index, token.end_index, token.scopes.join(" "));
	}
	state = Some(result.rule_stack);
}
```

`cargo run --release --example tokenize` runs the whole example (examples/tokenize.rs, with its grammar and theme), which prints each line's tokens from `tokenize_line`, then each token's start, color and font style from `tokenize_line2`, the same as vscode-textmate:

```
let a = "x"; /* a comment
   0..3  "let"            source.demo keyword.control.demo
   3..8  " a = "          source.demo
   8..11 "\"x\""          source.demo string.quoted.double.demo
  11..13 "; "             source.demo
  13..15 "/*"             source.demo comment.block.demo
  15..26 " a comment"     source.demo comment.block.demo
that ends here */ const b
   0..15 "that ends here " source.demo comment.block.demo
  15..17 "*/"             source.demo comment.block.demo
  17..18 " "              source.demo
  18..23 "const"          source.demo keyword.control.demo
  23..26 " b"             source.demo
0 #0000FF, 3 #000000, 8 #A31515, 11 #000000, 13 #008000 italic
0 #008000 italic, 17 #000000, 18 #0000FF, 23 #000000
```

The API is vscode-textmate's, with names in snake_case: `Registry` (`load_grammar`, `load_grammar_with_embedded_languages`, `load_grammar_with_configuration`, `add_grammar`, `set_theme`, `get_color_map`); `Grammar` (`tokenize_line` and `tokenize_line2`, and `_with_time_limit` variants of both, where 0 means no limit); `StateStack`; `diff_state_stacks_ref_eq` and `apply_state_stack_diff`; and in `utils` the encoded token attribute getters (`get_language_id`, `get_token_type`, `get_font_style`, `get_foreground`, `get_background`, `contains_balanced_brackets`). Where it differs: loading is synchronous, so the `load_grammar` callback returns the raw grammar (or `None`) and `Registry::load_grammar` returns `Result<Option<Rc<Grammar>>, String>` instead of a promise; INITIAL is `None`; and there is no `dispose`, as dropping does it.

## Internals

vscode-textmate leaves the regex engine to its caller through `IOnigLib`; VS Code passes vscode-oniguruma, which compiles Oniguruma to WebAssembly. The port has the same seam, the `OnigLib` and `OnigScanner` traits, and `NativeOnigLib` implements them on C Oniguruma 6.9.8, the same sources that vscode-oniguruma 1.7.0 compiles to WebAssembly, which the `onig_sys` crate (69.8.1, vendored in vendor/onig_sys with one patch to the regset, see Engine parity) builds. It searches the way vscode-oniguruma's onig.cc does: all the scanner's regexes at once with a regset for UTF-8 strings shorter than 1,000 bytes, and each regex on its own, caching its last result, for longer ones. Each line is converted to UTF-8 once, and positions are mapped between the UTF-16 offsets of the API and the UTF-8 offsets Oniguruma searches. Like vscode-oniguruma's `createOnigScanner`, `create_onig_scanner` never fails: a scanner with patterns that don't compile gives vscode-oniguruma's results (see Engine parity), and `NativeOnigLib::try_create_onig_scanner` returns Oniguruma's error instead, for tools.

Threads: a `Registry` and its grammars use `Rc` and are not `Send`, so each thread that tokenizes needs its own. Oniguruma initializes its global tables lazily and without a lock on the first `onig_new`, which corrupted the heap when registries on two threads compiled their first regexes at once (WebAssembly vscode-oniguruma never meets this, as it runs on one thread); `NativeOnigLib` therefore initializes Oniguruma once, under `std::sync::Once`, before its first compile. tests/threads.rs tokenizes on 8 threads at once: without that, 3 of 100 runs crashed; with it, none of 300 did.

| Rust module | vscode-textmate sources |
|---|---|
| `onig_lib` | onigLib.ts, and a native `OnigLib` |
| `utils` | utils.ts, encodedTokenAttributes.ts, the font attributes, matcher.ts, basicScopesAttributeProvider.ts |
| `json` | json.ts, plist.ts (objects keep their keys in JS order) |
| `raw` | rawGrammar.ts, parseRawGrammar.ts, and `initGrammar` (grammar/grammar.ts), `mergeObjects` (utils.ts), `parseInclude` (grammar/grammarDependencies.ts) |
| `theme` | theme.ts |
| `rule` | rule.ts |
| `grammar` | grammar/grammar.ts, grammar/tokenizeString.ts, grammar/grammarDependencies.ts, registry.ts, main.ts |
| `diff_state_stacks` | diffStateStacks.ts |

The port keeps the TypeScript structure (the same types, functions and order, so the two read side by side), with `Rc`, `RefCell` and `Cell` where the TypeScript shares and mutates objects. Rules are created and compiled lazily and cached as in the TypeScript. Object keys keep JS order (array-index keys first, then the rest as written), because vscode-textmate iterates captures and injections in that order, which decides rule ids and which injection is tried first; `json` is a small ordered JSON and plist parser, so the only dependencies are `onig_sys` 69.8.1 (vendored, see Engine parity) and `rustc-hash` 2.1.3. PORT-SPEC.md records the details, part by part.

## Engine parity

Tokens depend on the regex engine as much as on vscode-textmate, so the port must run the Oniguruma that VS Code runs, and do what it does when a pattern doesn't compile.

- **Same sources.** vscode-oniguruma 1.7.0 compiles Oniguruma 6.9.8 (commit 08d36110), whose Unicode data is version 14.0. `onig_sys` 69.8.1 bundles 6.9.8, and the 83 files of its oniguruma/src are byte-identical to those of that commit; the newer `onig_sys` 69.9.x bundles 6.9.10, with Unicode 16.0. Cargo.toml pins `=69.8.1` and patches it with vendor/onig_sys, a copy of the crate that keeps the 64 files of oniguruma/src its build uses, all unchanged except regexec.c, whose regset search reuses its memory between searches without changing what it finds (PATCHES.md there gives the diff and why the results are the same).
- **Why it matters.** probe/cases.json holds 82 regex cases (POSIX classes, case folding, Unicode properties and letters added in Unicode 15, 15.1 and 16, anchors, look-behind, back-references, long lines, invalid patterns). probe/probe.js runs them on vscode-oniguruma 1.7.0 and `engine_probe` on the port's Oniguruma. With 6.9.10, 16 cases gave different results: `[[:punct:]]`, `(?I)` with character classes, letters, emoji and case pairs of Unicode 15 and 16, and 4 patterns that 6.9.10 compiles and 6.9.8 rejects (`\p{PosixPunct}` and three scripts of Unicode 15 and 16). With 6.9.8, the 69 cases whose patterns compile are identical, and for each of the other 13, which 6.9.8 rejects (the 4 above and 9 patterns that are invalid in both versions), 1.7.0 gives its invalid-pattern result (probe/report-6910.txt, report-698.txt).
- **Invalid patterns.** vscode-oniguruma never reports a pattern that doesn't compile: `createOnigScanner` succeeds, and the scanner's results follow from how onig.cc uses the failed regex. They are deterministic, and `create_onig_scanner` reproduces them: on lines shorter than 1,000 UTF-8 bytes, a scanner whose patterns all fail matches the empty string at the start position as pattern 0, and a scanner with both kinds (or one `onig_regset_new` refuses) never matches; on longer lines, the failing patterns never match and the others work. With `--lenient`, `engine_probe` builds scanners that way and all 82 cases are identical (report-698-lenient.txt). probe/garbage.js and `garbage_probe` compare 103 such searches (5 kinds of invalid pattern, short, long and non-ASCII lines, mixed scanners), with identical output, and probe/garbage-history.js shows that 1.7.0's results don't depend on earlier searches. probe/invalid-grammar.js and `invalid_grammar` tokenize a grammar with invalid patterns in `match`, `begin`, `end` and `while` rules, as 9.3.2 on 1.7.0 and as the port: 9 cases, 118 lines of tokens, identical, including the two cases where 9.3.2's endless-loop guard stops the line.
- **Every built-in pattern compiles.** `pattern_sweep` compiles each regex the 84 grammars can produce (23,171, of which 6,500 are distinct, with the `\A`/`\G` variants and back-reference resolution that vscode-textmate applies), and none fails, so VS Code's own grammars never reach the invalid-pattern path.

## Behaviors to know

All of these are as in vscode-textmate, except the last.

- Token indices count UTF-16 code units, and the last token can end at the line's length + 1 (the "\n" the tokenizer appends).
- Captures with their own patterns are retokenized without a time limit.
- `FontAttribute::with` replaces only fields that are truthy in JS, so a font size of 0 or an empty font family keeps the parent's.
- States rebuilt from a diff carry no fonts, and adjacent font ranges with equal options merge into one.
- A pattern that doesn't compile doesn't raise an error; the scanner gives vscode-oniguruma 1.7.0's results for it (see Engine parity).
- INITIAL is `None` rather than a frame of its own, so a diff from INITIAL has one pop fewer than in JS; applying it rebuilds an equal state.

## Building and testing

Rust 1.85 or later, with edition 2024 (`rust-version` in Cargo.toml; `cargo test` passes with 1.85.0 and 1.100.0), and a C compiler (`onig_sys`, vendored in vendor/onig_sys, builds Oniguruma from source; with `default-features = false` it uses its bundled bindings, so neither libclang nor bindgen is needed). Built and tested on an arm64 Mac only.

```sh
cargo build --release
cargo test --release
cargo run --release --example tokenize

# vscode-textmate's test cases (all 95 pass); --dump prints every test's tokens, to diff with another implementation
cargo run --release --bin upstream_tests -- ../test-cases [--dump]
```

`cargo fmt --check` and `cargo clippy --release --all-targets` report nothing. rustfmt.toml sets hard tabs, which VS Code's Rust code and this repository's TypeScript also use.

The comparison with vscode-textmate runs in two steps: oracle-js dumps what vscode-textmate does, and `oracle` compares the port with it. By default oracle-js uses the vscode-textmate that the VS Code checkout installed (9.3.2); to compare with this repository's build instead, run `npm install && npm run compile` at its root and set `VSCODE_TEXTMATE_JS=<this repository>/out/src/main.js`.

```sh
VSCODE_ROOT=<vscode checkout> node oracle-js/dump.js <data dir>
VSCODE_ROOT=<vscode checkout> node oracle-js/fonts.js <data dir>
cargo run --release --bin oracle -- <data dir>

# the same on VS Code's colorize test fixtures, in a data dir of their own
VSCODE_ROOT=<vscode checkout> node oracle-js/dump-fixtures.js <fixtures dir> dump
VSCODE_ROOT=<vscode checkout> node oracle-js/dump-fixtures.js <fixtures dir> fonts
cargo run --release --bin oracle -- <fixtures dir>

# timings only, without comparing: grammar load, a cold pass and the best of N warm passes per file
cargo run --release --bin bench -- <data dir> [--reps N]
```

dump.js loads vscode-textmate (or the build that `VSCODE_TEXTMATE_JS` names) and vscode-oniguruma from a VS Code checkout (after `pnpm install`, with Node 24), registers its built-in grammars and its 2026 Dark theme the way VS Code does, tokenizes the 9 files, and writes the grammar list, the theme, and each file's lines, binary tokens, scopes and JS timings. fonts.js adds each line's fonts under two themes with font rules. `oracle` runs the port on the same data and prints the tables above, with the time-limit lines; `parse_check <data dir>` checks that every grammar there parses and that the theme loads. The data dir is about 130 MB and holds absolute paths into the checkout, so make it on the machine that runs the port. The files are those of VS Code main in November 2026, and some come from node_modules, so they move with VS Code's lockfile: change `CORPORA` in oracle-js/env.js when they are gone.

The engine checks of Engine parity, from the crate's root (`pattern_sweep` takes the data dir of dump.js):

```sh
VSCODE_ROOT=<vscode checkout> node probe/probe.js > js.txt
cargo run --release --bin engine_probe -- --lenient > rust.txt
node probe/compare.js js.txt rust.txt

VSCODE_ROOT=<vscode checkout> node probe/garbage.js > garbage-js.txt
cargo run --release --bin garbage_probe > garbage-rust.txt
diff garbage-js.txt garbage-rust.txt

VSCODE_ROOT=<vscode checkout> node probe/invalid-grammar.js > grammar-js.txt
cargo run --release --bin invalid_grammar -- probe/invalid-grammar.json > grammar-rust.txt
diff grammar-js.txt grammar-rust.txt

cargo run --release --bin pattern_sweep -- <data dir>
```

## Not ported

`dispose` (dropping does it), debug logging, `parseJSON`'s debug locations (used only to debug grammars), the theme tests (themes.test.ts, which needs vscode-textmate's theme fixtures) and the `UseOnigurumaFindOptions` path (off in vscode-textmate). There is no WebAssembly build and no Node binding yet; for VS Code to use the port, one of them is the next step, followed by measuring it in VS Code's tokenization worker.
