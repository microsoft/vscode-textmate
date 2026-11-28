/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Checks json.rs/plist and theme.rs on the oracle data: every grammar parses and has a scopeName, and the theme loads.
//! Usage: parse_check <data dir with grammars.json and theme.json>
use std::fs;
use vscode_textmate::json::{Json, parse_json};
use vscode_textmate::raw::parse_raw_grammar;
use vscode_textmate::theme::Theme;

fn main() {
	let data = std::env::args().nth(1).expect("data dir");
	let grammars =
		parse_json(&fs::read_to_string(format!("{data}/grammars.json")).unwrap()).unwrap();
	let (mut ok, mut failed) = (0, 0);
	for g in grammars.as_array().unwrap() {
		let scope = g.get("scopeName").and_then(Json::as_str).unwrap_or("?");
		let path = g.get("path").and_then(Json::as_str).unwrap();
		let source = fs::read_to_string(path).unwrap();
		match parse_raw_grammar(&source, Some(path)) {
			Ok(raw) if raw.scope_name.as_deref() == Some(scope) => ok += 1,
			Ok(_) => {
				failed += 1;
				eprintln!("{scope}: scopeName differs");
			}
			Err(e) => {
				failed += 1;
				eprintln!("{scope}: {e}");
			}
		}
	}
	println!("grammars: {ok} parsed, {failed} failed");
	let theme = parse_json(&fs::read_to_string(format!("{data}/theme.json")).unwrap()).unwrap();
	let t = Theme::create_from_raw_theme(Some(&theme), None);
	let colors = t.get_color_map();
	println!(
		"theme: {} colors, defaults {:?}, ids 1-2 {:?}",
		colors.len() - 1,
		t.get_defaults(),
		&colors[1..3.min(colors.len())]
	);
}
