# Vendored onig_sys

This is the `onig_sys` crate 69.8.1 from crates.io (rust-onig commit d2bf79faaff42d9c4e83878f3c7608f7db6d8574), which bundles Oniguruma 6.9.8. `rust/Cargo.toml` keeps the `=69.8.1` requirement and replaces the crate with this folder through `[patch.crates-io]`.

## What is kept

Only what the build uses: the crate's `Cargo.toml`, `build.rs`, `LICENSE.md` and `src/` (`lib.rs`, `ffi.rs`, `bindgened.rs`), Oniguruma's `COPYING`, and the 64 files of `oniguruma/src` that `build.rs` compiles or includes. The tests, documentation, autotools, CMake and Windows files of the crate are left out. The kept files are unchanged except for the three below.

## Changes

### `oniguruma/src/regexec.c`: the regset search reuses its memory

`onig_regset_search` allocated and freed three arrays on every call: the parameters of each regex, the match arguments of each regex, and the search ranges. In `ONIG_REGSET_POSITION_LEAD` mode, it then ran `match_at` for each regex at each position it tried, and each `match_at` allocated a match stack and copied it to the heap or freed it. It also cleared the region of every regex before searching. The port runs one regset search per token, so this work showed in profiles.

With the patch:

- The set keeps the three arrays between searches (`tm_mps`, `tm_msas`, `tm_sr`), and grows them when it has more regexes than they hold. `onig_regset_free` frees them.
- `regset_match_at` gives `match_at` the set's match stack (`tm_stk`) instead of a new one, and takes it back afterward, grown or not. It frees the stack when it grows past 1 MB, so a pathological search does not keep its memory. It falls back to plain `match_at` when a limit on the match stack (`match_stack_limit`) is set.
- `onig_regset_search_with_param` clears a region only when it has the wrong number of groups, or when the regex needs a cleared region: capture history, `ONIG_OPTION_FIND_NOT_EMPTY` or `ONIG_OPTION_FIND_LONGEST`.

What each search finds is unchanged: `match_at` starts from the same state, since it initializes the stack it is given, and it sets every group of the region of the regex that matches. The difference is that the region of a regex that did not match keeps the values of an earlier search instead of being cleared. The port reads only the region of the regex the search returns (`onig_regset_get_region`), so its results are the same. The set was already not safe to search from two threads at once, since its regions belong to the set; the port's scanner holds it as a raw pointer behind a `RefCell`, so Rust lets it neither move to nor be shared with another thread.

On the port's benchmark (9 files from VS Code and other projects, tokenized warm, best of 3 runs on an arm64 Mac), the patch takes the total from 4,720 to 4,059 ms (−14%), with the same tokens on every line (`oracle`: 0 differences against vscode-textmate). Peak memory is about the same.

An alternative that needs no change to Oniguruma was rejected: searching each regex on its own for every line, as the port already does for lines of 1,000 bytes or more, instead of using the regset for shorter lines. It gives the same tokens but makes the benchmark 1.8× slower (4,717 to 8,491 ms), because each regex then scans the rest of the line, while the regset stops at the first position where any regex matches.

### `build.rs`: rebuild when the sources change

Two `cargo:rerun-if-changed` lines (`oniguruma/src`, `build.rs`) before `cc.compile`, so that an edit to the C sources rebuilds the library.

### `src/lib.rs`: allow a lint in the bindings

`#[allow(unpredictable_function_pointer_comparisons)]` on `mod ffi`. The generated bindings derive `PartialEq` on structs with function pointers, which this lint warns about. Cargo caps lints for crates from crates.io but not for path dependencies, so the vendored crate showed 16 warnings.

## Diff against onig_sys 69.8.1

```diff
--- a/build.rs
+++ b/build.rs
@@ -193,6 +193,8 @@
     }
 
     cc.warnings(false); // not actionable by the end user
+    println!("cargo:rerun-if-changed=oniguruma/src");
+    println!("cargo:rerun-if-changed=build.rs");
     cc.compile("onig");
 }
 
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -9,6 +9,7 @@
 #[allow(non_camel_case_types)]
 #[allow(non_snake_case)]
 #[allow(clippy::all)]
+#[allow(unpredictable_function_pointer_comparisons)]
 mod ffi;
 
 #[cfg(not(feature = "generate"))]
--- a/oniguruma/src/regexec.c
+++ b/oniguruma/src/regexec.c
@@ -4453,6 +4453,15 @@
   OnigLen      anc_dmax;    /* (SEMI_)END_BUF anchor distance */
   int          all_low_high;
   int          anychar_inf;
+  /* scratch kept between searches (see regset_match_at) */
+  void*        tm_sr;
+  int          tm_sr_cap;
+  void*        tm_msas;
+  int          tm_msas_cap;
+  void*        tm_mps;
+  int          tm_mps_cap;
+  char*        tm_stk;
+  size_t       tm_stk_bytes;
 };
 
 enum SearchRangeStatus {
@@ -4467,9 +4476,50 @@
   UChar* high;
   UChar* sch_range;
 } SearchRange;
+
+#define REGSET_STACK_KEEP_MAX_BYTES  (1024 * 1024)
+
+/* match_at on the match stack of the set, which the set keeps between
+   calls, instead of a stack allocated, copied and freed for each regex. */
+static int
+regset_match_at(OnigRegSet* set, regex_t* reg, const UChar* str,
+                const UChar* end, const UChar* in_right_range,
+                const UChar* sstart, MatchArg* msa)
+{
+  int r;
+  size_t ptr_bytes;
+  size_t need;
 
+  if (msa->match_stack_limit != 0 || IS_NOT_NULL(msa->stack_p))
+    return match_at(reg, str, end, in_right_range, sstart, msa);
+
+  ptr_bytes = sizeof(StkPtrType) * msa->ptr_num;
+  need = ptr_bytes + sizeof(StackType) * INIT_MATCH_STACK_SIZE;
+  if (set->tm_stk_bytes < need) {
+    char* p = (char* )xrealloc(set->tm_stk, need);
+    if (IS_NULL(p)) return ONIGERR_MEMORY;
+    set->tm_stk = p;
+    set->tm_stk_bytes = need;
+  }
+
+  msa->stack_p = set->tm_stk;
+  msa->stack_n = (int )((set->tm_stk_bytes - ptr_bytes) / sizeof(StackType));
+  r = match_at(reg, str, end, in_right_range, sstart, msa);
+
+  /* match_at leaves the stack in msa, grown or not */
+  set->tm_stk = (char* )msa->stack_p;
+  set->tm_stk_bytes = ptr_bytes + sizeof(StackType) * (size_t )msa->stack_n;
+  msa->stack_p = (void* )0;
+  if (set->tm_stk_bytes > REGSET_STACK_KEEP_MAX_BYTES) {
+    xfree(set->tm_stk);
+    set->tm_stk = (char* )0;
+    set->tm_stk_bytes = 0;
+  }
+  return r;
+}
+
 #define REGSET_MATCH_AND_RETURN_CHECK(upper_range) \
-  r = match_at(reg, str, end, (upper_range), s, msas + i); \
+  r = regset_match_at(set, reg, str, end, (upper_range), s, msas + i); \
   if (r != ONIG_MISMATCH) {\
     if (r >= 0) {\
       goto match;\
@@ -4496,8 +4546,13 @@
   enc = set->enc;
   s = (UChar* )start;
 
-  sr = (SearchRange* )xmalloc(sizeof(*sr) * n);
-  CHECK_NULL_RETURN_MEMERR(sr);
+  if (set->tm_sr_cap < n) {
+    sr = (SearchRange* )xrealloc(set->tm_sr, sizeof(*sr) * n);
+    CHECK_NULL_RETURN_MEMERR(sr);
+    set->tm_sr = (void* )sr;
+    set->tm_sr_cap = n;
+  }
+  sr = (SearchRange* )set->tm_sr;
 
   for (i = 0; i < n; i++) {
     reg = set->rs[i].reg;
@@ -4614,15 +4669,12 @@
     } while (1);
   }
 
-  xfree(sr);
   return ONIG_MISMATCH;
 
  finish:
-  xfree(sr);
   return r;
 
  match:
-  xfree(sr);
   *rmatch_pos = (int )(s - str);
   return i;
 }
@@ -4701,8 +4753,16 @@
     region = set->rs[i].region;
     ADJUST_MATCH_PARAM(reg, mps[i]);
     if (IS_NOT_NULL(region)) {
-      r = onig_region_resize_clear(region, reg->num_mem + 1);
-      if (r != 0) goto finish_no_msa;
+      /* match_at sets every group of the region of a regex that matches;
+         the region of a regex that doesn't match keeps its old values */
+      if (region->num_regs != reg->num_mem + 1
+          || IS_NOT_NULL(region->history_root)
+          || reg->capture_history != 0
+          || OPTON_FIND_NOT_EMPTY(reg->options | option)
+          || OPTON_FIND_LONGEST(reg->options | option)) {
+        r = onig_region_resize_clear(region, reg->num_mem + 1);
+        if (r != 0) goto finish_no_msa;
+      }
     }
   }
 
@@ -4809,8 +4869,13 @@
   }
 
   if (lead == ONIG_REGSET_POSITION_LEAD) {
-    msas = (MatchArg* )xmalloc(sizeof(*msas) * set->n);
-    CHECK_NULL_RETURN_MEMERR(msas);
+    if (set->tm_msas_cap < set->n) {
+      msas = (MatchArg* )xrealloc(set->tm_msas, sizeof(*msas) * set->n);
+      CHECK_NULL_RETURN_MEMERR(msas);
+      set->tm_msas = (void* )msas;
+      set->tm_msas_cap = set->n;
+    }
+    msas = (MatchArg* )set->tm_msas;
 
     for (i = 0; i < set->n; i++) {
       MATCH_ARG_INIT(msas[i], set->rs[i].reg, option, set->rs[i].region,
@@ -4838,7 +4903,7 @@
       onig_region_clear(set->rs[i].region);
     }
   }
-  if (IS_NOT_NULL(msas)) xfree(msas);
+  if (IS_NOT_NULL(msas) && msas != (MatchArg* )set->tm_msas) xfree(msas);
   return r;
 
  mismatch_no_msa:
@@ -4857,7 +4922,7 @@
       onig_region_clear(set->rs[i].region);
     }
   }
-  if (IS_NOT_NULL(msas)) xfree(msas);
+  if (IS_NOT_NULL(msas) && msas != (MatchArg* )set->tm_msas) xfree(msas);
   return r; /* regex index */
 }
 
@@ -4871,8 +4936,14 @@
   OnigMatchParam* mp;
   OnigMatchParam** mps;
 
-  mps = (OnigMatchParam** )xmalloc((sizeof(OnigMatchParam*) + sizeof(OnigMatchParam)) * set->n);
-  CHECK_NULL_RETURN_MEMERR(mps);
+  if (set->tm_mps_cap < set->n) {
+    mps = (OnigMatchParam** )xrealloc(set->tm_mps,
+            (sizeof(OnigMatchParam*) + sizeof(OnigMatchParam)) * set->n);
+    CHECK_NULL_RETURN_MEMERR(mps);
+    set->tm_mps = (void* )mps;
+    set->tm_mps_cap = set->n;
+  }
+  mps = (OnigMatchParam** )set->tm_mps;
 
   mp = (OnigMatchParam* )(mps + set->n);
 
@@ -4885,8 +4956,6 @@
                                     rmatch_pos);
   for (i = 0; i < set->n; i++)
     onig_free_match_param_content(mp + i);
-
-  xfree(mps);
 
   return r;
 }
@@ -5894,6 +5963,7 @@
 
   set = (OnigRegSet* )xmalloc(sizeof(*set));
   CHECK_NULL_RETURN_MEMERR(set);
+  xmemset(set, 0, sizeof(*set));
 
   alloc = n > REGSET_INITIAL_ALLOC_SIZE ? n : REGSET_INITIAL_ALLOC_SIZE;
   rs = (RR* )xmalloc(sizeof(set->rs[0]) * alloc);
@@ -6050,6 +6120,10 @@
       onig_region_free(region, 1);
   }
 
+  if (IS_NOT_NULL(set->tm_sr))   xfree(set->tm_sr);
+  if (IS_NOT_NULL(set->tm_msas)) xfree(set->tm_msas);
+  if (IS_NOT_NULL(set->tm_mps))  xfree(set->tm_mps);
+  if (IS_NOT_NULL(set->tm_stk))  xfree(set->tm_stk);
   xfree(set->rs);
   xfree(set);
 }
```
