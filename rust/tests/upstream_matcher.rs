/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! The cases of vscode-textmate's `src/tests/matcher.test.ts` (the same in v9.3.2 and on main), transcribed.
//!
//! Upstream passes its own `nameMatcher` (exact scope equality); `create_matchers` uses grammar.ts `nameMatcher`
//! (scope prefix at a dot), which gives the same result on every case here.

use vscode_textmate::utils::create_matchers;

const TESTS: &[(&str, &[&str], bool)] = &[
	("foo", &["foo"], true),
	("foo", &["bar"], false),
	("- foo", &["foo"], false),
	("- foo", &["bar"], true),
	("- - foo", &["bar"], false),
	("bar foo", &["foo"], false),
	("bar foo", &["bar"], false),
	("bar foo", &["bar", "foo"], true),
	("bar - foo", &["bar"], true),
	("bar - foo", &["foo", "bar"], false),
	("bar - foo", &["foo"], false),
	("bar, foo", &["foo"], true),
	("bar, foo", &["bar"], true),
	("bar, foo", &["bar", "foo"], true),
	("bar, -foo", &["bar", "foo"], true),
	("bar, -foo", &["yo"], true),
	("bar, -foo", &["foo"], false),
	("(foo)", &["foo"], true),
	("(foo - bar)", &["foo"], true),
	("(foo - bar)", &["foo", "bar"], false),
	("foo bar - (yo man)", &["foo", "bar"], true),
	("foo bar - (yo man)", &["foo", "bar", "yo"], true),
	("foo bar - (yo man)", &["foo", "bar", "yo", "man"], false),
	("foo bar - (yo | man)", &["foo", "bar", "yo", "man"], false),
	("foo bar - (yo | man)", &["foo", "bar", "yo"], false),
	(
		"R:text.html - (comment.block, text.html source)",
		&["text.html", "bar", "source"],
		false,
	),
	(
		"text.html.php - (meta.embedded | meta.tag), L:text.html.php meta.tag, L:source.js.embedded.html",
		&["text.html.php", "bar", "source.js"],
		true,
	),
];

#[test]
fn matcher_tests() {
	let failures: Vec<String> = TESTS
		.iter()
		.enumerate()
		.filter_map(|(index, &(expression, input, expected))| {
			let result = create_matchers(expression)
				.iter()
				.any(|m| m.matcher.matches(input));
			(result != expected).then(|| {
				format!("Matcher Test #{index}: {expression:?} on {input:?} gave {result}")
			})
		})
		.collect();
	assert_eq!(TESTS.len(), 27);
	assert!(failures.is_empty(), "{failures:#?}");
}
