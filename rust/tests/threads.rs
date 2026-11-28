/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! The port's own: registries on different threads compile their first regexes at the same time. Oniguruma
//! initializes its global tables lazily and without a lock on the first `onig_new` (see `onig_lib.rs`), which
//! corrupted the heap here before the native backend initialized it once, up front. This file holds one test, so
//! that each run of its binary starts with Oniguruma not yet initialized. The race only shows in some runs: without
//! the up-front initialization, 3 of 100 runs of this binary crashed; with it, none of 300 did.

use std::rc::Rc;
use std::sync::{Arc, Barrier};
use vscode_textmate::grammar::{Registry, RegistryOptions};
use vscode_textmate::onig_lib::NativeOnigLib;
use vscode_textmate::raw::parse_raw_grammar;

const GRAMMAR: &str = r#"{
	"scopeName": "source.demo",
	"patterns": [
		{ "match": "\\b(let|const)\\b", "name": "keyword.control.demo" },
		{ "begin": "/\\*", "end": "\\*/", "name": "comment.block.demo" }
	]
}"#;

fn tokenize(barrier: Option<&Barrier>) -> Vec<String> {
	let registry = Registry::new(RegistryOptions {
		onig_lib: Rc::new(NativeOnigLib),
		theme: None,
		color_map: None,
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
	if let Some(barrier) = barrier {
		barrier.wait();
	}
	// The first line compiles the grammar's regexes.
	let result = grammar.tokenize_line("let a /* b */ const", None);
	result
		.tokens
		.iter()
		.map(|t| format!("{}..{} {}", t.start_index, t.end_index, t.scopes.join(" ")))
		.collect()
}

#[test]
fn registries_on_different_threads_compile_at_the_same_time() {
	const THREADS: usize = 8;
	let barrier = Arc::new(Barrier::new(THREADS));
	let handles: Vec<_> = (0..THREADS)
		.map(|_| {
			let barrier = barrier.clone();
			std::thread::spawn(move || tokenize(Some(&barrier)))
		})
		.collect();
	let results: Vec<Vec<String>> = handles
		.into_iter()
		.map(|h| h.join().expect("thread"))
		.collect();
	assert_eq!(results, vec![tokenize(None); THREADS]);
}
