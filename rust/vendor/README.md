# Vendored onig_sys

`onig_sys/` is the `onig_sys` crate 69.8.1 from crates.io (rust-onig commit d2bf79faaff42d9c4e83878f3c7608f7db6d8574), which bundles Oniguruma 6.9.8, with the patches in `patches/` applied. `rust/Cargo.toml` keeps the `=69.8.1` requirement and replaces the crate with that folder through `[patch.crates-io]`.

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

## Updating

1. Set `VERSION` and `SHA256` in `update-onig-sys.sh` to the new crate (crates.io shows the checksum), and update the list of excluded files in it if `oniguruma/src` gained or lost files that `build.rs` doesn't use.
2. Run `bash update-onig-sys.sh`. If a patch no longer applies, the script stops and names it. Fix the change by hand in a fresh extraction of the crate, and write the patch again with `git diff --no-index` against an untouched extraction, from the root of the crate so that its paths are relative to it (`a/oniguruma/src/regexec.c`). Keep the text at the top of the patch.
3. Run `bash update-onig-sys.sh --check`, then the tests: `cargo test --release`, `upstream_tests` and `oracle` (see rust/README.md). The tokens must not change unless the new Oniguruma is meant to change them.
4. Update the version, the commit and the numbers in this file and in rust/README.md.

vscode-textmate matches through vscode-oniguruma, which bundles Oniguruma 6.9.8. Keep the port on 6.9.8 while it does: a newer Oniguruma (onig_sys 69.9.x bundles 6.9.10, with Unicode 16.0) can match differently, and the port would then tokenize differently from vscode-textmate. Upstream Oniguruma (kkos/oniguruma) is archived, so new versions should be rare.
