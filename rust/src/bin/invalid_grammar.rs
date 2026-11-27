/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Tokenizes probe/invalid-grammar.json, a grammar with patterns Oniguruma rejects, and prints the tokens in the format
//! of probe/invalid-grammar.js (vscode-textmate 9.3.2 on vscode-oniguruma 1.7.0), so that the two outputs can be
//! compared with diff.
//! Usage: invalid_grammar <path to invalid-grammar.json>
use std::rc::Rc;
use vscode_textmate::grammar::{Registry, RegistryOptions, StateStack};
use vscode_textmate::onig_lib::NativeOnigLib;
use vscode_textmate::raw::parse_raw_grammar;

fn json_string(s: &str) -> String {
	let mut out = String::from("\"");
	for c in s.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
			c => out.push(c),
		}
	}
	out.push('"');
	out
}

fn main() {
	let path = std::env::args()
		.nth(1)
		.expect("usage: invalid_grammar <path to invalid-grammar.json>");
	let content = std::fs::read_to_string(&path).expect("read the grammar");
	let registry = Registry::new(RegistryOptions {
		onig_lib: Rc::new(NativeOnigLib),
		theme: None,
		color_map: None,
		load_grammar: Box::new(move |scope_name| match scope_name {
			"source.invalid" => parse_raw_grammar(&content, Some("invalid-grammar.json")).ok(),
			_ => None,
		}),
		get_injections: None,
	});
	let grammar = registry
		.load_grammar("source.invalid")
		.expect("load")
		.expect("grammar");
	let fill = |n: usize, s: &str| format!("{}{}", "-".repeat(n), s);
	// Lines of 999 bytes or more (with the "\n" the tokenizer appends, 1000) take vscode-oniguruma's long-string path.
	let cases: Vec<Vec<String>> = vec![
		vec![
			"foo [x(x] foo".into(),
			"x] foo".into(),
			fill(1100, "x] foo"),
			"foo".into(),
		],
		vec!["[".into(), fill(997, "]"), fill(998, "]")],
		vec!["{ a } b".into(), fill(1100, "} foo"), "foo".into()],
		vec!["( a ) b".into(), fill(1100, ") foo"), "foo".into()],
		vec![
			">start".into(),
			"still".into(),
			fill(1100, ""),
			"after foo".into(),
		],
		vec![
			"abc<mid>abc( tail".into(),
			"<<after".into(),
			"bar".into(),
			"x bar foo".into(),
		],
		vec![
			"<<after".into(),
			"bar".into(),
			"x bar foo".into(),
			fill(1100, "<<x a foo"),
			"foo bar".into(),
		],
		// An all-invalid scanner's empty match runs into the endless-loop guards: [4] with a match rule first, [1] when
		// the begin was an empty match too.
		vec![
			"a ! b foo".into(),
			"foo".into(),
			fill(1100, "! x foo"),
			"foo bar".into(),
		],
		vec![
			"a %b foo".into(),
			"foo".into(),
			fill(1100, "%b foo"),
			"foo".into(),
		],
	];
	for (i, lines) in cases.iter().enumerate() {
		println!("=== case {}", i + 1);
		let mut state: Option<Rc<StateStack>> = None;
		for line in lines {
			let r = grammar.tokenize_line(line, state.as_ref());
			println!("{}", json_string(line));
			for t in &r.tokens {
				println!("  {}-{} {}", t.start_index, t.end_index, t.scopes.join(" "));
			}
			state = Some(r.rule_stack);
		}
	}
}
