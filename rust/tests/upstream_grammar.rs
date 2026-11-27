/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! The cases of vscode-textmate's `src/tests/grammar.test.ts` (the same in v9.3.2 and on main), transcribed.

use std::rc::Rc;
use vscode_textmate::grammar::{FontInfo, Grammar, Registry, RegistryOptions, Token};
use vscode_textmate::json::parse_json;
use vscode_textmate::onig_lib::NativeOnigLib;
use vscode_textmate::raw::RawRule;
use vscode_textmate::utils::{self, standard_token_type::*};

// theme.ts FontStyle.
const FONT_STYLE_NOT_SET: i32 = -1;
const FONT_STYLE_NONE: i32 = 0;
const ITALIC: i32 = 1;
const BOLD: i32 = 2;
const UNDERLINE: i32 = 4;
const STRIKETHROUGH: i32 = 8;

fn assert_equals(
	metadata: u32,
	language_id: u32,
	token_type: u32,
	balanced: bool,
	font_style: i32,
	foreground: u32,
	background: u32,
) {
	let actual = (
		utils::get_language_id(metadata),
		utils::get_token_type(metadata),
		utils::contains_balanced_brackets(metadata),
		utils::get_font_style(metadata) as i32,
		utils::get_foreground(metadata),
		utils::get_background(metadata),
	);
	assert_eq!(
		actual,
		(
			language_id,
			token_type,
			balanced,
			font_style,
			foreground,
			background
		),
		"equals for {metadata:032b}"
	);
}

fn initial(font_style: i32) -> u32 {
	let value = utils::set(0, 1, REG_EX, Some(false), font_style, 101, 102);
	assert_equals(value, 1, REG_EX, false, font_style, 101, 102);
	value
}

#[test]
fn stack_element_metadata_works() {
	initial(UNDERLINE | BOLD);
}

#[test]
fn stack_element_metadata_can_overwrite_language_id() {
	let value = utils::set(
		initial(UNDERLINE | BOLD),
		2,
		NOT_SET,
		Some(false),
		FONT_STYLE_NOT_SET,
		0,
		0,
	);
	assert_equals(value, 2, REG_EX, false, UNDERLINE | BOLD, 101, 102);
}

#[test]
fn stack_element_metadata_can_overwrite_token_type() {
	let value = utils::set(
		initial(UNDERLINE | BOLD),
		0,
		COMMENT,
		Some(false),
		FONT_STYLE_NOT_SET,
		0,
		0,
	);
	assert_equals(value, 1, COMMENT, false, UNDERLINE | BOLD, 101, 102);
}

#[test]
fn stack_element_metadata_can_overwrite_font_style() {
	let value = utils::set(
		initial(UNDERLINE | BOLD),
		0,
		NOT_SET,
		Some(false),
		FONT_STYLE_NONE,
		0,
		0,
	);
	assert_equals(value, 1, REG_EX, false, FONT_STYLE_NONE, 101, 102);
}

#[test]
fn stack_element_metadata_can_overwrite_font_style_with_strikethrough() {
	let value = utils::set(
		initial(STRIKETHROUGH),
		0,
		NOT_SET,
		Some(false),
		FONT_STYLE_NONE,
		0,
		0,
	);
	assert_equals(value, 1, REG_EX, false, FONT_STYLE_NONE, 101, 102);
}

#[test]
fn stack_element_metadata_can_overwrite_foreground() {
	let value = utils::set(
		initial(UNDERLINE | BOLD),
		0,
		NOT_SET,
		Some(false),
		FONT_STYLE_NOT_SET,
		5,
		0,
	);
	assert_equals(value, 1, REG_EX, false, UNDERLINE | BOLD, 5, 102);
}

#[test]
fn stack_element_metadata_can_overwrite_background() {
	let value = utils::set(
		initial(UNDERLINE | BOLD),
		0,
		NOT_SET,
		Some(false),
		FONT_STYLE_NOT_SET,
		0,
		7,
	);
	assert_equals(value, 1, REG_EX, false, UNDERLINE | BOLD, 101, 7);
}

#[test]
fn stack_element_metadata_can_overwrite_balanced_bracket_bit() {
	let value = utils::set(
		initial(UNDERLINE | BOLD),
		0,
		NOT_SET,
		Some(true),
		FONT_STYLE_NOT_SET,
		0,
		0,
	);
	assert_equals(value, 1, REG_EX, true, UNDERLINE | BOLD, 101, 102);

	let value = utils::set(value, 0, NOT_SET, Some(false), FONT_STYLE_NOT_SET, 0, 0);
	assert_equals(value, 1, REG_EX, false, UNDERLINE | BOLD, 101, 102);
}

#[test]
fn stack_element_metadata_can_work_at_max_values() {
	let max_lang_id = 255;
	let max_token_type = COMMENT | OTHER | REG_EX | STRING;
	let max_font_style = BOLD | ITALIC | UNDERLINE;
	let max_foreground = 511;
	let max_background = 254;

	let value = utils::set(
		0,
		max_lang_id,
		max_token_type,
		Some(true),
		max_font_style,
		max_foreground,
		max_background,
	);
	assert_equals(
		value,
		max_lang_id,
		max_token_type,
		true,
		max_font_style,
		max_foreground,
		max_background,
	);
}

fn new_registry() -> Registry {
	Registry::new(RegistryOptions {
		onig_lib: Rc::new(NativeOnigLib),
		theme: None,
		color_map: None,
		load_grammar: Box::new(|_| None),
		get_injections: None,
	})
}

fn add_grammar(registry: &Registry, raw_grammar: &str) -> Rc<Grammar> {
	registry
		.add_grammar(
			RawRule::from_json(&parse_json(raw_grammar).unwrap()),
			None,
			0,
			&[],
		)
		.unwrap()
}

/// Upstream skips this test, and expects `outer` with "TODO this should be inner!". vscode-textmate (9.3.2 and
/// main) gives `inner` (checked by running this grammar through both), so the port is checked against that.
#[test]
fn shadowed_rules_are_resolved_correctly() {
	let registry = new_registry();
	let grammar = add_grammar(
		&registry,
		r##"{
			"scopeName": "source.test",
			"repository": {
				"foo": { "include": "#bar" },
				"bar": { "match": "bar1", "name": "outer" }
			},
			"patterns": [
				{
					"patterns": [{ "include": "#foo" }],
					"repository": {
						"bar": { "match": "bar1", "name": "inner" }
					}
				},
				{
					"begin": "begin",
					"patterns": [{ "include": "#foo" }],
					"end": "end"
				}
			]
		}"##,
	);
	let result = grammar.tokenize_line("bar1", None);
	assert_eq!(
		result.tokens,
		vec![Token {
			start_index: 0,
			end_index: 4,
			scopes: vec!["source.test".into(), "inner".into()]
		}]
	);
}

#[test]
fn fonts_are_correctly_set() {
	let registry = new_registry();
	registry.set_theme(&parse_json(r#"{"settings": [{"scope": "bar.test", "settings": {"fontFamily": "monospace", "fontSize": 1.2, "lineHeight": 3}}]}"#).unwrap(), None);
	let grammar = add_grammar(
		&registry,
		r#"{"scopeName": "source.test", "patterns": [{"match": "\\bbar\\b", "name": "bar.test"}]}"#,
	);
	let result = grammar.tokenize_line2("bar hello", None);
	assert_eq!(
		result.fonts,
		vec![FontInfo {
			start_index: 0,
			end_index: 3,
			font_family: "monospace".into(),
			font_size_multiplier: 1.2,
			line_height_multiplier: 3.0
		}]
	);
}

#[test]
fn fonts_are_correctly_set_2() {
	let registry = new_registry();
	registry.set_theme(&parse_json(r#"{"settings": [{"scope": "entity.name.function.ts", "settings": {"fontFamily": "Times New Roman", "fontSize": 1.3, "lineHeight": 3}}]}"#).unwrap(), None);
	let grammar = add_grammar(
		&registry,
		r#"{"scopeName": "source.ts", "patterns": [{"match": "g", "name": "entity.name.function.ts"}]}"#,
	);
	let result = grammar.tokenize_line2("function g() {}", None);
	assert_eq!(
		result.fonts,
		vec![FontInfo {
			start_index: 9,
			end_index: 10,
			font_family: "Times New Roman".into(),
			font_size_multiplier: 1.3,
			line_height_multiplier: 3.0
		}]
	);
}
