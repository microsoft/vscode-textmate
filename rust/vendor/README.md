# Vendored onig_sys

`onig_sys/` is the `onig_sys` crate 69.8.1 from crates.io (rust-onig commit d2bf79faaff42d9c4e83878f3c7608f7db6d8574), which bundles Oniguruma 6.9.8, with the patches in `patches/` applied. `rust/Cargo.toml` depends on that folder by path. A `[patch.crates-io]` entry would not do: Cargo applies `[patch]` only in the manifest it builds from, so a crate that depends on this one by path or Git would get the unpatched crate from crates.io, which lacks `onig_regset_search_keyed`, and fail to link. For the same reason, publishing this crate to crates.io would first need the patched crate published under a name of its own; until then, `cargo publish` refuses, as the dependency has no version.

`onig_sys/` is generated: never edit it by hand. `update-onig-sys.sh` takes the crate from Cargo's cache, or downloads it, checks its SHA-256, keeps the files below, and applies the patches in `patches/` in order. `update-onig-sys.sh --check` does the same in a temporary folder and fails if `onig_sys/` differs, for example after an edit that has no patch.

## What is kept

Only what the build uses: the crate's `Cargo.toml`, `build.rs`, `LICENSE.md` and `src/` (`lib.rs`, `ffi.rs`, `bindgened.rs`), Oniguruma's `COPYING`, and the 64 files of `oniguruma/src` that `build.rs` compiles or includes. The tests, documentation, autotools, CMake and Windows files of the crate are left out.

## Patches

### `0001-build-rerun-if-changed.patch`: `build.rs` rebuilds when the sources change

Two `cargo:rerun-if-changed` lines (`oniguruma/src`, `build.rs`) before `cc.compile`, so that an edit to the C sources rebuilds the library.

### `0002-allow-fn-pointer-comparisons.patch`: `src/lib.rs` allows a lint in the bindings

`#[allow(unpredictable_function_pointer_comparisons)]` on `mod ffi`. The generated bindings derive `PartialEq` on structs with function pointers, which this lint warns about. Cargo caps lints for crates from crates.io but not for path dependencies, so the vendored crate showed 16 warnings.

### `0003-regset-reuse-search-memory.patch`: the regset search in `oniguruma/src/regexec.c` reuses its memory

`onig_regset_search` allocated and freed three arrays on every call: the parameters of each regex, the match arguments of each regex, and the search ranges. In `ONIG_REGSET_POSITION_LEAD` mode, it then ran `match_at` for each regex at each position it tried, and each `match_at` allocated a match stack and copied it to the heap or freed it. It also cleared the region of every regex before searching. The port runs one regset search per token, so this work showed in profiles.

With the patch:

- The set keeps the three arrays between searches (`tm_mps`, `tm_msas`, `tm_sr`), and grows them when it has more regexes than they hold. `onig_regset_free` frees them.
- `regset_match_at` gives `match_at` the set's match stack (`tm_stk`) instead of a new one, and takes it back afterward, grown or not. It frees the stack when it grows past 1 MB, so a pathological search does not keep its memory. It falls back to plain `match_at` when a limit on the match stack (`match_stack_limit`) is set.
- `onig_regset_search_with_param` clears a region only when it has the wrong number of groups, or when the regex needs a cleared region: capture history, `ONIG_OPTION_FIND_NOT_EMPTY` or `ONIG_OPTION_FIND_LONGEST`.

What each search finds is unchanged: `match_at` starts from the same state, since it initializes the stack it is given, and it sets every group of the region of the regex that matches. The difference is that the region of a regex that did not match keeps the values of an earlier search instead of being cleared. The port reads only the region of the regex the search returns (`onig_regset_get_region`), so its results are the same. The set was already not safe to search from two threads at once, since its regions belong to the set; the port's scanner holds it as a raw pointer behind a `RefCell`, so Rust lets it neither move to nor be shared with another thread.

On the port's benchmark (9 files from VS Code and other projects, tokenized warm, best of 3 runs on an arm64 Mac), the patch takes the total from 4,720 to 4,059 ms (−14%), with the same tokens on every line (`oracle`: 0 differences against vscode-textmate). Peak memory is about the same.

An alternative that needs no change to Oniguruma was rejected: searching each regex on its own for every line, as the port already does for lines of 1,000 bytes or more, instead of using the regset for shorter lines. It gives the same tokens but makes the benchmark 1.8× slower (4,717 to 8,491 ms), because each regex then scans the rest of the line, while the regset stops at the first position where any regex matches.

### `0004-utf8-inline-enclen.patch`: the length of a UTF-8 character is looked up inline (`oniguruma/src/regenc.h`, `oniguruma/src/utf8.c`)

Oniguruma's matcher and search loops step through the subject with `enclen(enc, p)`, the length in bytes of the character at `p`, which called the encoding's `mbc_enc_len` through a function pointer. For UTF-8, that function only reads a 256-entry table indexed by the first byte. With the patch, `enclen` reads the table directly when the encoding is UTF-8, the only encoding the port uses, and calls through the pointer for the others. `utf8.c` exports the table, renamed `OnigEncLenUTF8`, for this.

The macro reads the same table that `mbc_enc_len` read, so every length, and so every match, is unchanged. It evaluates `enc` twice; no call passes an argument with side effects.

On the same benchmark, run twice with and twice without the patch, alternately, the patch takes the warm total from 4,063 to 3,932 ms (−3.2%), and the cold total from 5,576 to 5,428 ms, with the same tokens on every line (`oracle`: 0 differences against vscode-textmate).

### `0005-regset-forward-search-cache.patch`: the regset search reuses the results of `forward_search` (`oniguruma/src/regexec.c`, `oniguruma/src/oniguruma.h`)

In `ONIG_REGSET_POSITION_LEAD` mode, `onig_regset_search` calls `forward_search` for each regex, which uses the regex's optimization (an exact string, a character map) to find the next position where it can match. The port searches the same line once per token, each time from where the previous token ended, so each search scanned again what the previous one had scanned.

With the patch, `onig_regset_search_keyed` is `onig_regset_search` with one more argument, a non-zero key that identifies the string. The caller promises that the string is valid UTF-8 and doesn't change while its key is in use. For a keyed search of a UTF-8 set, the set keeps, for each regex, where its last `forward_search` started and the candidate it found, or that it found none (`tm_fc`, 24 bytes per regex). A later search with the same key, `str` and `end` that starts at or after that position, and not after the candidate, reuses it instead of scanning. A different key, `str` or `end` starts the cache over, and so do `onig_regset_add` and `onig_regset_replace`. `onig_regset_search` itself is unchanged and never uses the cache.

The results are the same because `forward_search`, when the search range ends at `end` (as in all of the port's searches), returns the first candidate at or after the character where it starts. A candidate found from an earlier position is therefore also the first one from any later position up to it, and "none" stays none. The cache is bypassed when that argument doesn't hold: a range that ends before `end`, a start in the middle of a character, and a regex whose exact string starts with a UTF-8 continuation byte, which `forward_search` can find in the middle of a character. Built with `-DONIG_REGSET_FS_VERIFY`, every reuse is checked against a real `forward_search` and aborts on a difference; that build gives the same tokens on all 236 corpora of `oracle` without aborting.

`onig_find` in rust/src/onig_lib.rs declares `onig_regset_search_keyed` itself, since the bindings of `onig_sys` don't have it, and passes the string's id as the key: each `OnigString` gets a new id, from 1, and its text never changes.

On the same benchmark, run three times with and three times without the patch, alternately, the patch takes the warm total from 3,930 to 3,517 ms (−10.5%), and the cold total from 5,423 to 5,013 ms (−7.6%), with the same tokens on every line (`oracle`: 0 differences against vscode-textmate).

### `0006-regset-lazy-setup.patch`: the regset search sets up a regex only when it tries it (`oniguruma/src/regexec.c`)

Before it searched, `onig_regset_search` in `ONIG_REGSET_POSITION_LEAD` mode set up every regex of the set: it adjusted the match parameters, resized the region and initialized the match arguments (`MATCH_ARG_INIT`), and at the end it freed them all again. A grammar's rule often has dozens of regexes, and a search usually stops after it has tried a few of them at the first positions, so most of that work was done for nothing.

With the patch, a search in that mode with `start < end` sets up a regex the first time it tries a match with it (`regset_lazy_setup`), and at the end frees and clears only the regexes it set up. The set keeps, for each regex, the search that last set it up (`tm_igen`, 8 bytes per regex), and the list of the regexes the current search set up (`tm_used`, 4 bytes per regex). Each search starts a new number, so nothing carries over from one search to the next. The setup itself is the same code as before, run later; a search of the empty string and `ONIG_REGSET_REGEX_LEAD` still set up every regex first. The only difference a caller can see is that the region of a regex that the search didn't try keeps what it had; the port reads only the region of the regex that matched.

On the same benchmark, run three times with and three times without the patch, alternately, the patch takes the warm total from 3,460 to 3,184 ms (−8.0%), and the cold total from 3,640 to 3,364 ms (−7.6%), with the same tokens on every line (`oracle`: 0 differences against vscode-textmate).

### `0007-regset-first-byte.patch`: the regset search tests the first byte before it tries a regex (`oniguruma/src/regexec.c`)

For a short subject (up to 500 bytes, and a longer one too unless every regex of the set has a bounded search range), `onig_regset_search` in `ONIG_REGSET_POSITION_LEAD` mode walks the subject one character at a time and, at each position, tries the regexes that could match there, in order. To know whether a regex could match at a position, it ran `forward_search` from there to find the regex's next candidate, once when it started and again each time it reached that candidate. Many of a grammar's regexes start with a fixed set of first bytes or a fixed string, which Oniguruma's optimizer records (`OPTIMIZE_MAP`, `OPTIMIZE_STR` and the `OPTIMIZE_STR_FAST` variants). When that start is at distance 0, `forward_search` reports the position itself exactly when the map has the byte there, or the string starts there.

With the patch, the search tests that directly for those regexes that have no anchor (patch 0008 adds the anchored ones): `map[*s]`, or the first byte and a `memcmp` of the string, and no longer runs `forward_search` for them. `match_at` still decides every match, the regexes are tried in the same order at the same positions, and the path for long subjects is unchanged. A caller sees no difference.

On the same benchmark, run three times with and three times without the patch, alternately, the patch takes the warm total from 3,090 to 2,752 ms (−11.0%), and the cold total from 3,264 to 2,926 ms (−10.4%), with the same tokens on every line (`oracle`: 0 differences against vscode-textmate). On checker.ts and sqlite3.c, it takes the warm total from 9,360 to 7,473 ms (−20.2%).

### `0008-regset-first-byte-anchored.patch`: the first-byte test also covers anchored regexes (`oniguruma/src/regexec.c`)

Patch 0007 tested the first byte only for regexes without an anchor. That condition is not needed: `forward_search` doesn't read the anchor of a regex, only its distance, its `sub_anchor` and its optimize data, so for an anchored regex it reports the same candidates, in the same order, as the direct test. Whether the anchor holds is decided where it was before: `match_at` checks `\G`, `\A` and look-behind, and the `ANCR_ANYCHAR_INF` check before each try still runs. Grammars use `\G` and look-behind a lot (TypeScript's keywords start with `(?<![_$[:alnum:]])`), so the patch covers many more regexes. A caller sees no difference.

On the same benchmark, run three times with and three times without the patch, alternately, the patch takes the warm total from 2,768 to 2,521 ms (−8.9%), and the cold total from 2,946 to 2,699 ms (−8.4%), with the same tokens on every line (`oracle`: 0 differences against vscode-textmate). On checker.ts and sqlite3.c, it takes the warm total from 7,450 to 6,492 ms (−12.9%).

### `0009-alt-branch-head-byte.patch`: alternatives that must start with a known byte skip a failed push (`oniguruma/src/regcomp.c`)

An alternation compiles each branch but the last to `OP_PUSH`, which saves a backtrack point before the branch runs. When a branch can only match starting with one byte (its first string, possibly inside a capture group, an option group, an atomic group or a quantifier with a lower bound of at least 1, and not ignore-case), the patch starts it with `OP_PUSH_OR_JUMP_EXACT1` instead, the opcode Oniguruma already emits for a quantifier with a known head byte. It pushes the same backtrack point when the byte at the current position is that byte, and otherwise jumps straight to the next branch. Without the patch, the branch would push, fail on its first byte compare and pop. What a skipped branch would have done before that compare only pushes entries that the failure pops (captures inside an alternation are always saved on the stack), so the matches and the captures are the same. Grammars' keyword alternations, such as `(?:if|else|for|while)`, take this path. A caller sees no difference.

On the same benchmark, run three times with and three times without the patch, alternately, the patch takes the warm total from 2,524 to 2,332 ms (−7.6%), and the cold total from 2,697 to 2,512 ms (−6.9%), with the same tokens on every line (`oracle`: 0 differences against vscode-textmate). On checker.ts and sqlite3.c, it takes the warm total from 6,490 to 6,304 ms (−2.9%).

### `0010-utf8-map-search.patch`: the first-byte map scan steps one byte at a time in UTF-8 (`oniguruma/src/regexec.c`)

When a regex can start with any of a set of bytes (for example an identifier, a number or a choice of keywords), Oniguruma looks for its next possible start with `map_search`, which walks the text one character at a time: it tests the byte at each character head against the regex's map, and looks up the length of the character to find the next head. In UTF-8 the character heads are exactly the bytes that are not continuation bytes (`0x80` to `0xBF`), so in UTF-8 the patch walks one byte at a time with no length lookup, and skips a hit on a continuation byte. `map_search` is called only from `forward_search`, always from a character head, and the port passes it valid UTF-8 only, so the patch tests the same character heads in the same order and returns the same position. Other encodings, the backward map search and the inline map test of patch 0007 are unchanged.

On the same benchmark, run three times with and three times without the patch, alternately, the patch takes the warm total from 2,330 to 2,197 ms (−5.7%), and the cold total from 2,503 to 2,377 ms (−5.0%), with the same tokens on every line (`oracle`: 0 differences against vscode-textmate). On checker.ts and sqlite3.c, it takes the warm total from 6,278 to 5,844 ms (−6.9%).

## Updating

1. Set `VERSION` and `SHA256` in `update-onig-sys.sh` to the new crate (crates.io shows the checksum), and update the list of excluded files in it if `oniguruma/src` gained or lost files that `build.rs` doesn't use.
2. Run `bash update-onig-sys.sh`. If a patch no longer applies, the script stops and names it. Fix the change by hand in a fresh extraction of the crate, and write the patch again with `git diff --no-index` against an untouched extraction, from the root of the crate so that its paths are relative to it (`a/oniguruma/src/regexec.c`). Keep the text at the top of the patch.
3. Run `bash update-onig-sys.sh --check`, then the tests: `cargo test --release`, `upstream_tests` and `oracle` (see rust/README.md). The tokens must not change unless the new Oniguruma is meant to change them.
4. Update the version, the commit and the numbers in this file and in rust/README.md.

vscode-textmate matches through vscode-oniguruma, which bundles Oniguruma 6.9.8. Keep the port on 6.9.8 while it does: a newer Oniguruma (onig_sys 69.9.x bundles 6.9.10, with Unicode 16.0) can match differently, and the port would then tokenize differently from vscode-textmate. Upstream Oniguruma (kkos/oniguruma) is archived, so new versions should be rare.
