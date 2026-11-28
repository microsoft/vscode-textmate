/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Tokenizes the oracle corpora like the JS dump did (one registry per corpus, the theme set, grammar loaded with
//! its configuration, a cold `tokenizeLine2` pass, the best of 3 warm passes, then a `tokenizeLine` pass), and
//! compares every line's tokens with what vscode-textmate produced.
//! It also checks that each line's end state survives `diffStateStacksRefEq` and `applyStateStackDiff`, and that
//! tokenizing every line from the state rebuilt from those diffs, with a time limit, gives the same tokens.
//! With the themes and dumps of `fonts.js`, it compares every line's `fonts` and a hash of every line's tokens
//! under two themes with font settings, and every line's `fonts` when tokenized from the state rebuilt from diffs.
//! Usage: oracle <data dir> [corpus tags...]
use std::collections::HashMap;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::rc::Rc;
use std::time::Instant;
use vscode_textmate::diff_state_stacks::{apply_state_stack_diff, diff_state_stacks_ref_eq};
use vscode_textmate::grammar::{
	FontInfo, Grammar, GrammarConfiguration, Registry, RegistryOptions, StateStack,
};
use vscode_textmate::json::{Json, parse_json};
use vscode_textmate::onig_lib::NativeOnigLib;
use vscode_textmate::raw::parse_raw_grammar;

struct GrammarSource {
	path: String,
	injections: Option<Vec<String>>,
}

fn strings(j: Option<&Json>) -> Vec<String> {
	j.and_then(Json::as_array)
		.map(|a| {
			a.iter()
				.filter_map(|s| s.as_str().map(str::to_string))
				.collect()
		})
		.unwrap_or_default()
}

fn pairs(j: Option<&Json>) -> Vec<(String, u32)> {
	match j {
		Some(Json::Object(o)) => o
			.iter()
			.map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0) as u32))
			.collect(),
		Some(Json::Array(a)) => a
			.iter()
			.filter_map(|p| {
				let p = p.as_array()?;
				Some((p.first()?.as_str()?.to_string(), p.get(1)?.as_f64()? as u32))
			})
			.collect(),
		_ => Vec::new(),
	}
}

const LIMIT_LINES: usize = 200;

fn create_registry(sources: &Rc<HashMap<String, GrammarSource>>, theme: &Json) -> Registry {
	let loader_sources = sources.clone();
	let injection_sources = sources.clone();
	let registry = Registry::new(RegistryOptions {
		onig_lib: Rc::new(NativeOnigLib),
		theme: None,
		color_map: None,
		load_grammar: Box::new(move |scope_name| {
			let source = loader_sources.get(scope_name)?;
			let text = fs::read_to_string(&source.path).ok()?;
			parse_raw_grammar(&text, Some(&source.path)).ok()
		}),
		get_injections: Some(Box::new(move |scope_name| {
			injection_sources
				.get(scope_name)
				.and_then(|s| s.injections.clone())
		})),
	});
	registry.set_theme(theme, None);
	registry
}

/// Loads the corpus' grammar with its configuration, like the JS dump.
fn load_grammar(registry: &Registry, corpus: &Json) -> Rc<Grammar> {
	let scope = corpus.get("scope").and_then(Json::as_str).unwrap();
	let language_id = corpus
		.get("languageId")
		.and_then(Json::as_f64)
		.unwrap_or(0.0) as u32;
	let configuration = GrammarConfiguration {
		embedded_languages: pairs(corpus.get("embeddedLanguages")),
		token_types: pairs(corpus.get("tokenTypes")),
		balanced_bracket_selectors: strings(corpus.get("balanced")),
		unbalanced_bracket_selectors: strings(corpus.get("unbalanced")),
	};
	registry
		.load_grammar_with_configuration(scope, language_id, &configuration)
		.unwrap()
		.expect("grammar")
}

fn corpus_lines(corpus: &Json) -> Vec<&str> {
	corpus
		.get("lines")
		.and_then(Json::as_array)
		.unwrap()
		.iter()
		.map(|l| l.as_str().unwrap())
		.collect()
}

struct FontsOutcome {
	lines_with_fonts: usize,
	ranges: usize,
	/// Lines whose `fonts` differ from what vscode-textmate produced.
	diffs: usize,
	/// Lines with `fonts` when each line is tokenized from the state rebuilt with `apply_state_stack_diff`.
	replay_lines_with_fonts: usize,
	/// Lines whose `fonts` differ from vscode-textmate's when tokenized from the rebuilt state.
	replay_diffs: usize,
	/// Whether the hash of every line's binary tokens under this theme is the one vscode-textmate produced.
	tokens_match: bool,
}

/// Hashes the binary tokens of a line into `hash` like `fonts.js` does.
fn hash_tokens(hash: u32, tokens: &[u32]) -> u32 {
	let mut hash = (hash ^ tokens.len() as u32).wrapping_mul(16777619);
	for &n in tokens {
		hash = (hash ^ n).wrapping_mul(16777619);
	}
	hash
}

/// A font range as the JS dump writes it: start index, end index, font family, font size and line height multipliers.
type FontTuple = (usize, usize, String, f64, f64);

fn font_tuple(f: &FontInfo) -> FontTuple {
	(
		f.start_index,
		f.end_index,
		f.font_family.to_string(),
		f.font_size_multiplier,
		f.line_height_multiplier,
	)
}

/// Tokenizes the corpus under the theme `theme-fonts-<variant>.json` and compares each line's fonts with `fonts-<variant>-<tag>.json`.
fn run_fonts(
	data: &str,
	tag: &str,
	sources: &Rc<HashMap<String, GrammarSource>>,
	corpus: &Json,
	variant: &str,
) -> Option<FontsOutcome> {
	let theme = parse_json(&fs::read_to_string(format!("{data}/theme-fonts-{variant}.json")).ok()?)
		.unwrap();
	let expected =
		parse_json(&fs::read_to_string(format!("{data}/fonts-{variant}-{tag}.json")).ok()?)
			.unwrap();
	let expected_hash = expected.get("hash").and_then(Json::as_f64).unwrap() as u32;
	let read_fonts = |key: &str| -> Vec<Vec<FontTuple>> {
		expected
			.get(key)
			.and_then(Json::as_array)
			.unwrap()
			.iter()
			.map(|l| {
				l.as_array()
					.unwrap()
					.iter()
					.map(|f| {
						let f = f.as_array().unwrap();
						(
							f[0].as_f64().unwrap() as usize,
							f[1].as_f64().unwrap() as usize,
							f[2].as_str().unwrap().to_string(),
							f[3].as_f64().unwrap(),
							f[4].as_f64().unwrap(),
						)
					})
					.collect()
			})
			.collect()
	};
	let expected_fonts = read_fonts("lines");
	let expected_replay = read_fonts("replay");
	let registry = create_registry(sources, &theme);
	let grammar = load_grammar(&registry, corpus);
	let lines = corpus_lines(corpus);
	let mut outcome = FontsOutcome {
		lines_with_fonts: 0,
		ranges: 0,
		diffs: 0,
		replay_lines_with_fonts: 0,
		replay_diffs: 0,
		tokens_match: false,
	};
	let mut hash = 2166136261u32;
	let mut shown = 0;
	let mut state = None;
	for (i, line) in lines.iter().enumerate() {
		let r = grammar.tokenize_line2(line, state.as_ref());
		state = Some(r.rule_stack);
		hash = hash_tokens(hash, &r.tokens);
		let actual: Vec<_> = r.fonts.iter().map(font_tuple).collect();
		if !actual.is_empty() {
			outcome.lines_with_fonts += 1;
			outcome.ranges += actual.len();
		}
		if expected_fonts.get(i) != Some(&actual) {
			outcome.diffs += 1;
			if shown < 3 {
				shown += 1;
				let line: String = line.chars().take(140).collect();
				println!(
					"  fonts-{variant} line {i}: {line:?}\n    expected {:?}\n    actual   {:?}",
					expected_fonts.get(i),
					actual
				);
			}
		}
	}
	outcome.diffs += expected_fonts.len().abs_diff(lines.len());
	outcome.tokens_match = hash == expected_hash;
	let mut rebuilt: Option<Rc<StateStack>> = None;
	for (i, line) in lines.iter().enumerate() {
		let r = grammar.tokenize_line2(line, rebuilt.as_ref());
		let diff = diff_state_stacks_ref_eq(rebuilt.as_ref(), Some(&r.rule_stack));
		rebuilt = apply_state_stack_diff(rebuilt.as_ref(), &diff);
		let actual: Vec<_> = r.fonts.iter().map(font_tuple).collect();
		outcome.replay_lines_with_fonts += usize::from(!actual.is_empty());
		if expected_replay.get(i) != Some(&actual) {
			outcome.replay_diffs += 1;
			if shown < 6 {
				shown += 1;
				println!(
					"  fonts-{variant} replay line {i}:\n    expected {:?}\n    actual   {:?}",
					expected_replay.get(i),
					actual
				);
			}
		}
	}
	outcome.replay_diffs += expected_replay.len().abs_diff(lines.len());
	Some(outcome)
}

struct Outcome {
	lines: usize,
	tokens: usize,
	bin_diffs: usize,
	text_diffs: usize,
	/// Lines whose end state differs once rebuilt from its diff.
	roundtrip_diffs: usize,
	/// Lines whose tokens differ, or that stopped early, when tokenized from the rebuilt state with a time limit.
	replay_diffs: usize,
	/// Lines with `fonts` under the oracle's theme, which has no font settings.
	lines_with_fonts: usize,
	/// Whether a 1 ms time limit stopped the tokenization of the first `LIMIT_LINES` lines joined into one line, and after how long.
	limit_stopped: bool,
	limit_ms: f64,
	load_ms: f64,
	cold_ms: f64,
	warm_ms: f64,
}

fn run_corpus(
	corpus: &Json,
	sources: &Rc<HashMap<String, GrammarSource>>,
	theme: &Json,
) -> Outcome {
	let lines = corpus_lines(corpus);
	let expected_bin: Vec<Vec<u32>> = corpus
		.get("bin")
		.and_then(Json::as_array)
		.unwrap()
		.iter()
		.map(|l| {
			l.as_array()
				.unwrap()
				.iter()
				.map(|n| n.as_f64().unwrap() as u32)
				.collect()
		})
		.collect();
	let expected_scopes: Vec<Vec<(usize, usize, String)>> = corpus
		.get("scopes")
		.and_then(Json::as_array)
		.unwrap()
		.iter()
		.map(|l| {
			l.as_array()
				.unwrap()
				.iter()
				.map(|t| {
					let t = t.as_array().unwrap();
					(
						t[0].as_f64().unwrap() as usize,
						t[1].as_f64().unwrap() as usize,
						t[2].as_str().unwrap().to_string(),
					)
				})
				.collect()
		})
		.collect();

	let registry = create_registry(sources, theme);
	let t0 = Instant::now();
	let grammar = load_grammar(&registry, corpus);
	let load_ms = t0.elapsed().as_secs_f64() * 1000.0;

	let mut shown = 0;
	let mut bin_diffs = 0;
	let mut tokens = 0;
	let t0 = Instant::now();
	let mut state = None;
	let mut actual_bin = Vec::with_capacity(lines.len());
	let mut lines_with_fonts = 0;
	for line in &lines {
		let r = grammar.tokenize_line2(line, state.as_ref());
		state = Some(r.rule_stack);
		actual_bin.push(r.tokens);
		lines_with_fonts += usize::from(!r.fonts.is_empty());
	}
	let cold_ms = t0.elapsed().as_secs_f64() * 1000.0;
	for (i, (actual, expected)) in actual_bin.iter().zip(&expected_bin).enumerate() {
		tokens += actual.len() / 2;
		if actual != expected {
			bin_diffs += 1;
			if shown < 5 {
				shown += 1;
				let line: String = lines[i].chars().take(140).collect();
				println!(
					"  bin line {i}: {line:?}\n    expected {:?}\n    actual   {:?}",
					&expected[..expected.len().min(24)],
					&actual[..actual.len().min(24)]
				);
			}
		}
	}

	let mut warm_ms = f64::INFINITY;
	for _ in 0..3 {
		let t0 = Instant::now();
		let mut state = None;
		for line in &lines {
			state = Some(grammar.tokenize_line2(line, state.as_ref()).rule_stack);
		}
		warm_ms = warm_ms.min(t0.elapsed().as_secs_f64() * 1000.0);
	}

	let mut text_diffs = 0;
	let mut roundtrip_diffs = 0;
	let mut shown = 0;
	let mut state: Option<Rc<StateStack>> = None;
	let mut rebuilt: Option<Rc<StateStack>> = None;
	for (i, line) in lines.iter().enumerate() {
		let r = grammar.tokenize_line(line, state.as_ref());
		let diff = diff_state_stacks_ref_eq(state.as_ref(), Some(&r.rule_stack));
		rebuilt = apply_state_stack_diff(rebuilt.as_ref(), &diff);
		if !rebuilt.as_ref().is_some_and(|s| s.equals(&r.rule_stack)) {
			roundtrip_diffs += 1;
		}
		state = Some(r.rule_stack);
		lines_with_fonts += usize::from(!r.fonts.is_empty());
		let actual: Vec<(usize, usize, String)> = r
			.tokens
			.iter()
			.map(|t| {
				(
					t.start_index,
					t.end_index,
					t.scopes.iter().map(|s| &**s).collect::<Vec<_>>().join(" "),
				)
			})
			.collect();
		if actual != expected_scopes[i] {
			text_diffs += 1;
			if shown < 5 {
				shown += 1;
				let line: String = lines[i].chars().take(140).collect();
				let k = actual
					.iter()
					.zip(&expected_scopes[i])
					.position(|(a, e)| a != e)
					.unwrap_or(actual.len().min(expected_scopes[i].len()));
				println!(
					"  text line {i}: {line:?} ({} tokens, expected {})\n    expected[{k}] {:?}\n    actual[{k}]   {:?}",
					actual.len(),
					expected_scopes[i].len(),
					expected_scopes[i].get(k),
					actual.get(k)
				);
			}
		}
	}

	let mut replay_diffs = 0;
	let mut state: Option<Rc<StateStack>> = None;
	for (line, expected) in lines.iter().zip(&actual_bin) {
		let r = grammar.tokenize_line2_with_time_limit(line, state.as_ref(), 60_000);
		if r.stopped_early || r.tokens != *expected {
			replay_diffs += 1;
		}
		let diff = diff_state_stacks_ref_eq(state.as_ref(), Some(&r.rule_stack));
		state = apply_state_stack_diff(state.as_ref(), &diff);
	}

	// Capped: upstream checks the limit only between scan iterations, and one iteration on a huge Markdown line runs for minutes in JS too.
	let long_line = lines[..lines.len().min(LIMIT_LINES)].join(" ");
	let t0 = Instant::now();
	let limit_stopped = grammar
		.tokenize_line2_with_time_limit(&long_line, None, 1)
		.stopped_early;
	let limit_ms = t0.elapsed().as_secs_f64() * 1000.0;
	Outcome {
		lines: lines.len(),
		tokens,
		bin_diffs,
		text_diffs,
		roundtrip_diffs,
		replay_diffs,
		lines_with_fonts,
		limit_stopped,
		limit_ms,
		load_ms,
		cold_ms,
		warm_ms,
	}
}

fn main() {
	let mut args = std::env::args().skip(1);
	let data = args
		.next()
		.expect("usage: oracle <data dir> [corpus tags...]");
	let mut tags: Vec<String> = args.collect();
	let summary =
		parse_json(&fs::read_to_string(format!("{data}/js-summary.json")).unwrap()).unwrap();
	let summary = summary.as_array().unwrap();
	if tags.is_empty() {
		tags = summary
			.iter()
			.map(|s| s.get("tag").and_then(Json::as_str).unwrap().to_string())
			.collect();
	}
	let grammars =
		parse_json(&fs::read_to_string(format!("{data}/grammars.json")).unwrap()).unwrap();
	let mut sources = HashMap::new();
	for g in grammars.as_array().unwrap() {
		let scope = g
			.get("scopeName")
			.and_then(Json::as_str)
			.unwrap()
			.to_string();
		let injections = match g.get("injections") {
			Some(Json::Array(_)) => Some(strings(g.get("injections"))),
			_ => None,
		};
		sources.insert(
			scope,
			GrammarSource {
				path: g.get("path").and_then(Json::as_str).unwrap().to_string(),
				injections,
			},
		);
	}
	let sources = Rc::new(sources);
	let theme = parse_json(&fs::read_to_string(format!("{data}/theme.json")).unwrap()).unwrap();

	let mut rows = Vec::new();
	let mut font_rows = Vec::new();
	for tag in &tags {
		println!("== {tag}");
		let js = summary
			.iter()
			.find(|s| s.get("tag").and_then(Json::as_str) == Some(tag.as_str()));
		let js_ms = |key: &str| {
			js.and_then(|s| s.get(key))
				.and_then(Json::as_f64)
				.unwrap_or(f64::NAN)
		};
		let corpus =
			parse_json(&fs::read_to_string(format!("{data}/corpus-{tag}.json")).unwrap()).unwrap();
		match catch_unwind(AssertUnwindSafe(|| run_corpus(&corpus, &sources, &theme))) {
			Ok(o) => {
				println!(
					"  lines {} tokens {} (js {}) bin diffs {} text diffs {} state round-trip diffs {} replay diffs {} lines with fonts {}\n  first {LIMIT_LINES} lines as one line with a 1 ms time limit: stopped early {} after {:.2} ms",
					o.lines,
					o.tokens,
					js_ms("tokens"),
					o.bin_diffs,
					o.text_diffs,
					o.roundtrip_diffs,
					o.replay_diffs,
					o.lines_with_fonts,
					o.limit_stopped,
					o.limit_ms
				);
				rows.push(format!("| {tag} | {} | {} | {} | {} | {} | {} | {:.1} / {:.1} | {:.1} / {:.1} | {:.1} / {:.1} | {:.2}x |", o.lines, o.tokens, o.bin_diffs, o.text_diffs, o.roundtrip_diffs, o.replay_diffs, o.load_ms, js_ms("jsGrammarLoadMs"), o.cold_ms, js_ms("jsColdMs"), o.warm_ms, js_ms("jsWarmMs"), js_ms("jsWarmMs") / o.warm_ms));
			}
			Err(_) => rows.push(format!("| {tag} | panicked |")),
		}
		let mut font_row = format!("| {tag} |");
		for variant in ["a", "b"] {
			match catch_unwind(AssertUnwindSafe(|| {
				run_fonts(&data, tag, &sources, &corpus, variant)
			})) {
				Ok(Some(f)) => {
					println!(
						"  fonts-{variant}: lines with fonts {} ranges {} diffs {} tokens match {}; from rebuilt states: lines with fonts {} diffs {}",
						f.lines_with_fonts,
						f.ranges,
						f.diffs,
						f.tokens_match,
						f.replay_lines_with_fonts,
						f.replay_diffs
					);
					font_row.push_str(&format!(
						" {} | {} | {} | {} | {} |",
						f.lines_with_fonts, f.ranges, f.diffs, f.replay_diffs, f.tokens_match
					));
				}
				Ok(None) => font_row.push_str(" - | - | - | - | - |"),
				Err(_) => font_row.push_str(" panicked | | | | |"),
			}
		}
		font_rows.push(font_row);
	}
	println!(
		"\n| corpus | lines | tokens | bin diffs | text diffs | state round-trip diffs | replay diffs | load ms rs / js | cold ms rs / js | warm ms rs / js | warm speedup |\n|---|---|---|---|---|---|---|---|---|---|---|"
	);
	for row in rows {
		println!("{row}");
	}
	println!(
		"\n| corpus | theme a: lines with fonts | ranges | font diffs | replay font diffs | tokens match | theme b: lines with fonts | ranges | font diffs | replay font diffs | tokens match |\n|---|---|---|---|---|---|---|---|---|---|---|"
	);
	for row in font_rows {
		println!("{row}");
	}
}
