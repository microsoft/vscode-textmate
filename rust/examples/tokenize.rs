/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Tokenizes two lines with a small grammar and theme, as the README shows: `tokenize_line` gives each token's scopes,
//! `tokenize_line2` the encoded token attributes, and each line starts from the state the previous line ended in.
use std::rc::Rc;
use vscode_textmate::grammar::{Registry, RegistryOptions, StateStack};
use vscode_textmate::json::parse_json;
use vscode_textmate::onig_lib::NativeOnigLib;
use vscode_textmate::raw::parse_raw_grammar;
use vscode_textmate::utils::{get_font_style, get_foreground};

const GRAMMAR: &str = r#"{
	"scopeName": "source.demo",
	"patterns": [
		{ "match": "\\b(let|const)\\b", "name": "keyword.control.demo" },
		{ "match": "\"[^\"]*\"", "name": "string.quoted.double.demo" },
		{ "begin": "/\\*", "end": "\\*/", "name": "comment.block.demo" }
	]
}"#;

const THEME: &str = r##"{
	"settings": [
		{ "settings": { "foreground": "#000000", "background": "#ffffff" } },
		{ "scope": "keyword", "settings": { "foreground": "#0000ff" } },
		{ "scope": "string", "settings": { "foreground": "#a31515" } },
		{ "scope": "comment", "settings": { "foreground": "#008000", "fontStyle": "italic" } }
	]
}"##;

fn main() {
	let registry = Registry::new(RegistryOptions {
		onig_lib: Rc::new(NativeOnigLib),
		theme: Some(parse_json(THEME).expect("theme")),
		color_map: None,
		// Called with each scope name the registry needs; a real loader reads the grammar file of that scope.
		// `parse_raw_grammar` reads JSON when the path ends in ".json", and a plist otherwise.
		load_grammar: Box::new(|scope_name| match scope_name {
			"source.demo" => parse_raw_grammar(GRAMMAR, Some("demo.tmLanguage.json")).ok(),
			_ => None,
		}),
		get_injections: None,
	});
	let grammar = registry
		.load_grammar("source.demo")
		.expect("load")
		.expect("grammar");
	let lines = ["let a = \"x\"; /* a comment", "that ends here */ const b"];

	// `None` is INITIAL. As in vscode-textmate, indices count UTF-16 code units (these lines are ASCII, so they are
	// byte offsets too), and the last token ends one past the line, at the "\n" the tokenizer appends.
	let mut state: Option<Rc<StateStack>> = None;
	for line in lines {
		let result = grammar.tokenize_line(line, state.as_ref());
		println!("{line}");
		for token in &result.tokens {
			let text = &line[token.start_index..token.end_index.min(line.len())];
			println!(
				"  {:>2}..{:<2} {:<16} {}",
				token.start_index,
				token.end_index,
				format!("{text:?}"),
				token.scopes.join(" ")
			);
		}
		state = Some(result.rule_stack);
	}

	let color_map = registry.get_color_map();
	let mut state: Option<Rc<StateStack>> = None;
	for line in lines {
		let result = grammar.tokenize_line2(line, state.as_ref());
		let starts_and_colors: Vec<String> = result
			.tokens
			.chunks(2)
			.map(|pair| {
				format!(
					"{} {}{}",
					pair[0],
					color_map[get_foreground(pair[1]) as usize],
					if get_font_style(pair[1]) & 1 != 0 {
						" italic"
					} else {
						""
					}
				)
			})
			.collect();
		println!("{}", starts_and_colors.join(", "));
		state = Some(result.rule_stack);
	}
}
