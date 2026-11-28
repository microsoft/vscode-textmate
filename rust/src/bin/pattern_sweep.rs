/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Compiles every regular expression of every grammar in grammars.json with the native Oniguruma, the way
//! vscode-textmate would compile it: the rule's `match`, or its `begin` with its `while` or `end` (RuleFactory's
//! choice), the `\z` rewrite, the four `\A`/`\G` variants of a pattern with anchors, and the `\N` of `end`/`while`
//! resolved with empty captures. Capture entries count only when they have `patterns`, as in `_compileCaptures`.
//! Reports the patterns Oniguruma rejects. It compiles with the strict `try_create_onig_scanner`, because
//! `create_onig_scanner` never fails: like vscode-oniguruma 1.7.0, it gives a scanner whose results for such patterns
//! are vscode-oniguruma's.
//! Usage: pattern_sweep <data dir with grammars.json>
use std::collections::BTreeMap;
use std::fs;
use vscode_textmate::json::{Json, parse_json};
use vscode_textmate::onig_lib::{NativeOnigLib, OnigString};
use vscode_textmate::raw::{RawRule, parse_raw_grammar};
use vscode_textmate::rule::RegExpSource;

struct Sweep {
	/// Compiled source -> where it comes from (scope, path), first occurrence.
	sources: BTreeMap<String, (String, String)>,
	occurrences: usize,
}

impl Sweep {
	fn add(&mut self, scope: &str, path: &str, source: &str, resolve_back_references: bool) {
		let mut rs = RegExpSource::new(source, 0);
		if resolve_back_references && rs.has_back_references {
			let resolved = rs.resolve_back_references(&OnigString::new(String::new()), &[]);
			rs = RegExpSource::new(&resolved, 0);
		}
		let variants: Vec<String> = if rs.has_anchor {
			[(false, false), (false, true), (true, false), (true, true)]
				.iter()
				.map(|&(a, g)| rs.resolve_anchors(a, g).to_string())
				.collect()
		} else {
			vec![rs.source.clone()]
		};
		for v in variants {
			self.occurrences += 1;
			self.sources
				.entry(v)
				.or_insert_with(|| (scope.to_string(), path.to_string()));
		}
	}

	fn walk(&mut self, scope: &str, path: &str, rule: &RawRule) {
		if let Some(m) = &rule.match_ {
			self.add(scope, &format!("{path}.match"), m, false);
		} else if let Some(b) = &rule.begin {
			self.add(scope, &format!("{path}.begin"), b, false);
			if let Some(w) = &rule.while_ {
				self.add(scope, &format!("{path}.while"), w, true);
			} else {
				let end = rule.end.as_deref().unwrap_or("");
				self.add(scope, &format!("{path}.end"), end, true);
			}
		}
		for (name, captures) in [
			("captures", &rule.captures),
			("beginCaptures", &rule.begin_captures),
			("endCaptures", &rule.end_captures),
			("whileCaptures", &rule.while_captures),
		] {
			if let Some(captures) = captures {
				for (k, c) in captures.iter() {
					if c.patterns.is_some() {
						self.walk(scope, &format!("{path}.{name}.{k}"), c);
					}
				}
			}
		}
		if let Some(patterns) = &rule.patterns {
			for (i, p) in patterns.iter().enumerate() {
				self.walk(scope, &format!("{path}.patterns[{i}]"), p);
			}
		}
		if let Some(repository) = &rule.repository {
			let mut keys: Vec<_> = repository.keys().collect();
			keys.sort();
			for k in keys {
				self.walk(scope, &format!("{path}.repository.{k}"), &repository[k]);
			}
		}
		if let Some(injections) = &rule.injections {
			for (selector, r) in injections.iter() {
				self.walk(scope, &format!("{path}.injections[{selector:?}]"), r);
			}
		}
	}
}

fn main() {
	let data = std::env::args().nth(1).expect("data dir");
	let grammars =
		parse_json(&fs::read_to_string(format!("{data}/grammars.json")).unwrap()).unwrap();
	let mut sweep = Sweep {
		sources: BTreeMap::new(),
		occurrences: 0,
	};
	let mut count = 0;
	for g in grammars.as_array().unwrap() {
		let path = g.get("path").and_then(Json::as_str).unwrap();
		let raw = parse_raw_grammar(&fs::read_to_string(path).unwrap(), Some(path)).unwrap();
		let scope = raw.scope_name.as_deref().unwrap_or("?").to_string();
		sweep.walk(&scope, "$", &raw);
		count += 1;
	}
	let lib = NativeOnigLib;
	let version = unsafe { std::ffi::CStr::from_ptr(onig_sys::onig_version()) }
		.to_string_lossy()
		.into_owned();
	let mut failures = Vec::new();
	for (source, (scope, path)) in &sweep.sources {
		if let Err(e) = lib.try_create_onig_scanner(std::slice::from_ref(source)) {
			failures.push(format!(
				"{scope} {path}\n    pattern {source:?}\n    error   {e}"
			));
		}
	}
	println!(
		"native Oniguruma {version}: {count} grammars, {} patterns to compile, {} unique",
		sweep.occurrences,
		sweep.sources.len()
	);
	println!("{} unique patterns don't compile", failures.len());
	for f in &failures {
		println!("  {f}");
	}
}
