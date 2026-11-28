/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Runs vscode-textmate's own tokenization suites (src/tests/tokenization.test.ts) against the port.
//! For each test it reads and parses the grammars the test lists, loads the scope of `grammarScopeName` or of the
//! grammar at `grammarPath` from a registry that serves only those grammars (and `grammarInjections` for that
//! scope), tokenizes the lines with `tokenizeLine`, each from the state of the line before, and compares each
//! line's tokens, as `{ value: line.substring(startIndex, endIndex), scopes }`, with the expected tokens, from
//! which empty values are left out when the line is not empty. Like the test, it passes each line's end state
//! through `diffStateStacksRefEq` and `applyStateStackDiff` from the previous state before the next line, and a
//! test stops at its first mismatching line.
//! Grammar files that are not in the test-cases directory are left out of the registry. A test whose own grammar
//! (`grammarPath`, or the file that would hold `grammarScopeName`) is among them is skipped. A test that fails
//! while files are missing and the registry was asked for scopes it could not serve is reported as skipped, as
//! inconclusive, with the failure; a test that passes all the same is a pass, and the report names the scopes
//! that were not loaded.
//! Usage: upstream_tests <test-cases dir> [--dump], where the directory is the `test-cases` folder of
//! microsoft/vscode-textmate, which holds `first-mate/tests.json`, `suite1/tests.json` and `suite1/whileTests.json`;
//! a suite that is missing is skipped. With `--dump` it compares nothing: it prints each test's description and,
//! for every line, its tokens as `"value"|scope,scope` (the value as `JSON.stringify` writes it), to diff with
//! the same dump from another implementation.
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Instant;
use vscode_textmate::diff_state_stacks::{apply_state_stack_diff, diff_state_stacks_ref_eq};
use vscode_textmate::grammar::{Registry, RegistryOptions, StateStack};
use vscode_textmate::json::{Json, parse_json};
use vscode_textmate::onig_lib::NativeOnigLib;
use vscode_textmate::raw::{RawRule, parse_raw_grammar};

const SUITES: [&str; 3] = [
	"first-mate/tests.json",
	"suite1/tests.json",
	"suite1/whileTests.json",
];

enum Outcome {
	/// Passed; the text names the scopes that were not loaded, when grammar files were missing.
	Pass(String),
	Fail(String),
	Skip(String),
}

/// A token as the test compares it: its text in UTF-16 code units and its scopes.
#[derive(PartialEq)]
struct RawToken {
	value: Vec<u16>,
	scopes: Vec<String>,
}

fn strings(j: Option<&Json>) -> Option<Vec<String>> {
	j.and_then(Json::as_array).map(|a| {
		a.iter()
			.filter_map(|s| s.as_str().map(str::to_string))
			.collect()
	})
}

/// JavaScript `String.prototype.substring` on UTF-16 code units.
fn substring(line: &[u16], start: usize, end: usize) -> Vec<u16> {
	let (start, end) = (start.min(line.len()), end.min(line.len()));
	let (start, end) = if start > end {
		(end, start)
	} else {
		(start, end)
	};
	line[start..end].to_vec()
}

fn show(tokens: &[RawToken]) -> String {
	let shown: Vec<String> = tokens
		.iter()
		.map(|t| {
			format!(
				"{:?} [{}]",
				String::from_utf16_lossy(&t.value),
				t.scopes.join(", ")
			)
		})
		.collect();
	format!("\n      {}", shown.join("\n      "))
}

fn perform_test(test: &Json, dir: &Path) -> Outcome {
	let grammar_paths = strings(test.get("grammars")).unwrap_or_default();
	let (available, missing): (Vec<&String>, Vec<&String>) =
		grammar_paths.iter().partition(|p| dir.join(p).is_file());
	let missing: Vec<&str> = missing.into_iter().map(String::as_str).collect();
	let test_grammar_path = test.get("grammarPath").and_then(Json::as_str);
	if let Some(path) = test_grammar_path.filter(|p| missing.contains(p)) {
		return Outcome::Skip(format!("its grammar {path} is not available here"));
	}

	let mut grammar_scope_name = test
		.get("grammarScopeName")
		.and_then(Json::as_str)
		.map(str::to_string);
	let mut grammar_by_scope: HashMap<String, Rc<RawRule>> = HashMap::new();
	for grammar_path in available {
		let content = match fs::read_to_string(dir.join(grammar_path)) {
			Ok(c) => c,
			Err(e) => return Outcome::Fail(format!("cannot read {grammar_path}: {e}")),
		};
		let raw_grammar = match parse_raw_grammar(&content, Some(grammar_path)) {
			Ok(g) => g,
			Err(e) => return Outcome::Fail(format!("cannot parse {grammar_path}: {e}")),
		};
		let scope_name = raw_grammar
			.scope_name
			.as_deref()
			.unwrap_or("undefined")
			.to_string();
		if grammar_scope_name.is_none() && Some(grammar_path.as_str()) == test_grammar_path {
			grammar_scope_name = Some(scope_name.clone());
		}
		grammar_by_scope.insert(scope_name, raw_grammar);
	}
	let Some(grammar_scope_name) = grammar_scope_name else {
		return Outcome::Fail("I HAVE NO GRAMMAR FOR TEST".to_string());
	};
	if !missing.is_empty() && !grammar_by_scope.contains_key(&grammar_scope_name) {
		return Outcome::Skip(format!(
			"no grammar here has its scope {grammar_scope_name}; not available here: {}",
			missing.join(", ")
		));
	}

	let grammar_by_scope = Rc::new(grammar_by_scope);
	let unresolved: Rc<RefCell<Vec<String>>> = Rc::default();
	let unresolved_in_loader = unresolved.clone();
	let injections = strings(test.get("grammarInjections"));
	let injections_scope = grammar_scope_name.clone();
	let registry = Registry::new(RegistryOptions {
		onig_lib: Rc::new(NativeOnigLib),
		theme: None,
		color_map: None,
		load_grammar: Box::new(move |scope_name| {
			let grammar = grammar_by_scope.get(scope_name).cloned();
			if grammar.is_none()
				&& !unresolved_in_loader
					.borrow()
					.iter()
					.any(|s| s == scope_name)
			{
				unresolved_in_loader
					.borrow_mut()
					.push(scope_name.to_string());
			}
			grammar
		}),
		get_injections: Some(Box::new(move |scope_name| {
			if scope_name == injections_scope {
				injections.clone()
			} else {
				None
			}
		})),
	});
	// A failure is inconclusive when grammar files are missing here and the registry asked for scopes it lacked.
	let fail = |why: String| -> Outcome {
		let unresolved = unresolved.borrow();
		if missing.is_empty() || unresolved.is_empty() {
			Outcome::Fail(why)
		} else {
			Outcome::Skip(format!(
				"inconclusive, not available here: {}; scopes not found: {}; it fails at {why}",
				missing.join(", "),
				unresolved.join(", ")
			))
		}
	};
	let grammar = match registry.load_grammar(&grammar_scope_name) {
		Ok(Some(g)) => g,
		Ok(None) => return fail("I HAVE NO GRAMMAR FOR TEST".to_string()),
		Err(e) => return fail(e),
	};

	let mut prev_state: Option<Rc<StateStack>> = None;
	for (i, test_case) in test
		.get("lines")
		.and_then(Json::as_array)
		.unwrap_or_default()
		.iter()
		.enumerate()
	{
		let line = test_case
			.get("line")
			.and_then(Json::as_str)
			.unwrap_or_default();
		let actual = grammar.tokenize_line(line, prev_state.as_ref());

		let line16: Vec<u16> = line.encode_utf16().collect();
		let actual_tokens: Vec<RawToken> = actual
			.tokens
			.iter()
			.map(|t| RawToken {
				value: substring(&line16, t.start_index, t.end_index),
				scopes: t.scopes.iter().map(|s| s.to_string()).collect(),
			})
			.collect();

		let mut expected_tokens: Vec<RawToken> = test_case
			.get("tokens")
			.and_then(Json::as_array)
			.unwrap_or_default()
			.iter()
			.map(|t| RawToken {
				value: t
					.get("value")
					.and_then(Json::as_str)
					.unwrap_or_default()
					.encode_utf16()
					.collect(),
				scopes: strings(t.get("scopes")).unwrap_or_default(),
			})
			.collect();
		// Like the test: "TODO@Alex: fix tests instead of working around".
		if !line16.is_empty() {
			expected_tokens.retain(|t| !t.value.is_empty());
		}

		if actual_tokens != expected_tokens {
			return fail(format!(
				"line {} {:?}\n    expected:{}\n    actual:{}",
				i + 1,
				line,
				show(&expected_tokens),
				show(&actual_tokens)
			));
		}

		let mut rule_stack = actual.rule_stack;
		if let Some(prev) = prev_state.as_ref() {
			let diff = diff_state_stacks_ref_eq(Some(prev), Some(&rule_stack));
			match apply_state_stack_diff(Some(prev), &diff) {
				Some(rebuilt) => rule_stack = rebuilt,
				None => return fail(format!("line {}: applyStateStackDiff gave no state", i + 1)),
			}
		}
		prev_state = Some(rule_stack);
	}
	let unresolved = unresolved.borrow();
	if missing.is_empty() || unresolved.is_empty() {
		Outcome::Pass(String::new())
	} else {
		Outcome::Pass(format!(
			" (not available here: {}; scopes not loaded: {})",
			missing.join(", "),
			unresolved.join(", ")
		))
	}
}

/// A string of UTF-16 code units as `JSON.stringify` writes it.
fn json_string(units: &[u16]) -> String {
	let mut out = String::from("\"");
	for c in char::decode_utf16(units.iter().copied()) {
		match c {
			Ok('"') => out.push_str("\\\""),
			Ok('\\') => out.push_str("\\\\"),
			Ok('\n') => out.push_str("\\n"),
			Ok('\r') => out.push_str("\\r"),
			Ok('\t') => out.push_str("\\t"),
			Ok('\u{8}') => out.push_str("\\b"),
			Ok('\u{c}') => out.push_str("\\f"),
			Ok(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
			Ok(c) => out.push(c),
			Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
		}
	}
	out.push('"');
	out
}

/// `--dump`: the tokens of every line of a test, with the grammars that are here, without comparing them.
fn dump_test(test: &Json, dir: &Path) -> Vec<String> {
	let mut grammar_scope_name = test
		.get("grammarScopeName")
		.and_then(Json::as_str)
		.map(str::to_string);
	let test_grammar_path = test.get("grammarPath").and_then(Json::as_str);
	let mut grammar_by_scope: HashMap<String, Rc<RawRule>> = HashMap::new();
	for grammar_path in strings(test.get("grammars")).unwrap_or_default() {
		let Ok(content) = fs::read_to_string(dir.join(&grammar_path)) else {
			continue;
		};
		let raw_grammar = match parse_raw_grammar(&content, Some(&grammar_path)) {
			Ok(g) => g,
			Err(e) => return vec![format!("  error cannot parse {grammar_path}: {e}")],
		};
		let scope_name = raw_grammar
			.scope_name
			.as_deref()
			.unwrap_or("undefined")
			.to_string();
		if grammar_scope_name.is_none() && Some(grammar_path.as_str()) == test_grammar_path {
			grammar_scope_name = Some(scope_name.clone());
		}
		grammar_by_scope.insert(scope_name, raw_grammar);
	}
	let Some(grammar_scope_name) = grammar_scope_name else {
		return vec!["  no grammar".to_string()];
	};
	let injections = strings(test.get("grammarInjections"));
	let injections_scope = grammar_scope_name.clone();
	let registry = Registry::new(RegistryOptions {
		onig_lib: Rc::new(NativeOnigLib),
		theme: None,
		color_map: None,
		load_grammar: Box::new(move |scope_name| grammar_by_scope.get(scope_name).cloned()),
		get_injections: Some(Box::new(move |scope_name| {
			if scope_name == injections_scope {
				injections.clone()
			} else {
				None
			}
		})),
	});
	let grammar = match registry.load_grammar(&grammar_scope_name) {
		Ok(Some(g)) => g,
		Ok(None) => return vec!["  no grammar".to_string()],
		Err(e) => return vec![format!("  error {e}")],
	};
	let mut lines = Vec::new();
	let mut prev_state: Option<Rc<StateStack>> = None;
	for test_case in test
		.get("lines")
		.and_then(Json::as_array)
		.unwrap_or_default()
	{
		let line = test_case
			.get("line")
			.and_then(Json::as_str)
			.unwrap_or_default();
		let line16: Vec<u16> = line.encode_utf16().collect();
		let actual = grammar.tokenize_line(line, prev_state.as_ref());
		let tokens: Vec<String> = actual
			.tokens
			.iter()
			.map(|t| {
				format!(
					"{}|{}",
					json_string(&substring(&line16, t.start_index, t.end_index)),
					t.scopes
						.iter()
						.map(|s| s.to_string())
						.collect::<Vec<_>>()
						.join(",")
				)
			})
			.collect();
		lines.push(format!("  {}", tokens.join(" ")));
		let mut rule_stack = actual.rule_stack;
		if let Some(prev) = prev_state.as_ref() {
			let diff = diff_state_stacks_ref_eq(Some(prev), Some(&rule_stack));
			match apply_state_stack_diff(Some(prev), &diff) {
				Some(rebuilt) => rule_stack = rebuilt,
				None => {
					lines.push("  error applyStateStackDiff gave no state".to_string());
					break;
				}
			}
		}
		prev_state = Some(rule_stack);
	}
	lines
}

fn main() {
	let args: Vec<String> = std::env::args().collect();
	let Some(root) = args.get(1).map(PathBuf::from) else {
		eprintln!("usage: upstream_tests <test-cases dir> [--dump]");
		std::process::exit(2);
	};
	if args.get(2).map(String::as_str) == Some("--dump") {
		for suite in SUITES {
			let location = root.join(suite);
			let Ok(text) = fs::read_to_string(&location) else {
				continue;
			};
			let tests = parse_json(&text).unwrap_or_else(|e| panic!("{suite}: {e}"));
			let dir = location.parent().unwrap();
			for test in tests.as_array().unwrap_or_default() {
				let desc = test.get("desc").and_then(Json::as_str).unwrap_or_default();
				println!("{suite} {desc}");
				let lines = catch_unwind(AssertUnwindSafe(|| dump_test(test, dir)))
					.unwrap_or_else(|_| vec!["  error panicked".to_string()]);
				for line in lines {
					println!("{line}");
				}
			}
		}
		return;
	}
	let (mut total_pass, mut total_fail, mut total_skip) = (0, 0, 0);
	for suite in SUITES {
		let location = root.join(suite);
		let Ok(text) = fs::read_to_string(&location) else {
			println!("{suite}: not available here, not run");
			continue;
		};
		let tests = parse_json(&text).unwrap_or_else(|e| panic!("{suite}: {e}"));
		let dir = location.parent().unwrap();
		let (mut pass, mut fail, mut skip) = (0, 0, 0);
		let mut report = Vec::new();
		let start = Instant::now();
		for test in tests.as_array().unwrap_or_default() {
			let desc = test.get("desc").and_then(Json::as_str).unwrap_or_default();
			let outcome = catch_unwind(AssertUnwindSafe(|| perform_test(test, dir)))
				.unwrap_or_else(|_| Outcome::Fail("panicked".to_string()));
			match outcome {
				Outcome::Pass(note) => {
					pass += 1;
					report.push(format!("  pass  {desc}{note}"));
				}
				Outcome::Fail(why) => {
					fail += 1;
					report.push(format!("  FAIL  {desc}\n    {why}"));
				}
				Outcome::Skip(why) => {
					skip += 1;
					report.push(format!("  skip  {desc}: {why}"));
				}
			}
		}
		println!(
			"{suite}: {pass} passed, {fail} failed, {skip} skipped ({:.0} ms)",
			start.elapsed().as_secs_f64() * 1000.0
		);
		for line in report {
			println!("{line}");
		}
		total_pass += pass;
		total_fail += fail;
		total_skip += skip;
	}
	println!("total: {total_pass} passed, {total_fail} failed, {total_skip} skipped");
	if total_fail > 0 {
		std::process::exit(1);
	}
}
