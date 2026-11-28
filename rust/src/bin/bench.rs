/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Times tokenization of the oracle corpora: grammar load, a cold `tokenizeLine2` pass, and the best of N warm
//! passes per corpus, without comparing anything. It is the quick loop for performance work; the oracle checks
//! that the tokens stay the same.
//! Usage: bench <data dir> [--reps N] [--seconds S] [corpus tags...]
//! With --seconds, it tokenizes each corpus again and again for about S seconds, for a profiler to sample.
use std::collections::HashMap;
use std::fs;
use std::rc::Rc;
use std::time::Instant;
use vscode_textmate::grammar::{Grammar, GrammarConfiguration, Registry, RegistryOptions};
use vscode_textmate::json::{Json, parse_json};
use vscode_textmate::onig_lib::NativeOnigLib;
use vscode_textmate::raw::parse_raw_grammar;

/// Grammar scope name to its file path and injected scope names.
type GrammarSources = Rc<HashMap<String, (String, Option<Vec<String>>)>>;

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

fn create_registry(sources: &GrammarSources, theme: &Json) -> Registry {
	let loader_sources = sources.clone();
	let injection_sources = sources.clone();
	let registry = Registry::new(RegistryOptions {
		onig_lib: Rc::new(NativeOnigLib),
		theme: None,
		color_map: None,
		load_grammar: Box::new(move |scope_name| {
			let (path, _) = loader_sources.get(scope_name)?;
			let text = fs::read_to_string(path).ok()?;
			parse_raw_grammar(&text, Some(path)).ok()
		}),
		get_injections: Some(Box::new(move |scope_name| {
			injection_sources.get(scope_name).and_then(|s| s.1.clone())
		})),
	});
	registry.set_theme(theme, None);
	registry
}

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

fn pass(grammar: &Grammar, lines: &[&str]) -> (f64, usize) {
	let t0 = Instant::now();
	let mut state = None;
	let mut tokens = 0;
	for line in lines {
		let r = grammar.tokenize_line2(line, state.as_ref());
		tokens += r.tokens.len() / 2;
		state = Some(r.rule_stack);
	}
	(t0.elapsed().as_secs_f64() * 1000.0, tokens)
}

fn main() {
	let mut args = std::env::args().skip(1);
	let data = args
		.next()
		.expect("usage: bench <data dir> [--reps N] [--seconds S] [corpus tags...]");
	let mut reps = 5;
	let mut seconds = 0.0;
	let mut tags = Vec::new();
	while let Some(a) = args.next() {
		match a.as_str() {
			"--reps" => reps = args.next().and_then(|n| n.parse().ok()).expect("--reps N"),
			"--seconds" => {
				seconds = args
					.next()
					.and_then(|n| n.parse().ok())
					.expect("--seconds S")
			}
			_ => tags.push(a),
		}
	}
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
		let injections = match g.get("injections") {
			Some(Json::Array(_)) => Some(strings(g.get("injections"))),
			_ => None,
		};
		sources.insert(
			g.get("scopeName")
				.and_then(Json::as_str)
				.unwrap()
				.to_string(),
			(
				g.get("path").and_then(Json::as_str).unwrap().to_string(),
				injections,
			),
		);
	}
	let sources = Rc::new(sources);
	let theme = parse_json(&fs::read_to_string(format!("{data}/theme.json")).unwrap()).unwrap();

	println!(
		"| corpus | lines | tokens | load ms | cold ms | warm ms (best of {reps}) | js warm ms | speedup |\n|---|---|---|---|---|---|---|---|"
	);
	let (mut total_cold, mut total_warm, mut total_js) = (0.0, 0.0, 0.0);
	for tag in &tags {
		let js_warm = summary
			.iter()
			.find(|s| s.get("tag").and_then(Json::as_str) == Some(tag.as_str()))
			.and_then(|s| s.get("jsWarmMs"))
			.and_then(Json::as_f64)
			.unwrap_or(f64::NAN);
		let corpus =
			parse_json(&fs::read_to_string(format!("{data}/corpus-{tag}.json")).unwrap()).unwrap();
		let lines: Vec<&str> = corpus
			.get("lines")
			.and_then(Json::as_array)
			.unwrap()
			.iter()
			.map(|l| l.as_str().unwrap())
			.collect();
		let registry = create_registry(&sources, &theme);
		let t0 = Instant::now();
		let grammar = load_grammar(&registry, &corpus);
		let load_ms = t0.elapsed().as_secs_f64() * 1000.0;
		let (cold_ms, tokens) = pass(&grammar, &lines);
		let mut warm_ms = f64::INFINITY;
		if seconds > 0.0 {
			let t0 = Instant::now();
			while t0.elapsed().as_secs_f64() < seconds {
				warm_ms = warm_ms.min(pass(&grammar, &lines).0);
			}
		} else {
			for _ in 0..reps {
				warm_ms = warm_ms.min(pass(&grammar, &lines).0);
			}
		}
		total_cold += cold_ms;
		total_warm += warm_ms;
		total_js += js_warm;
		println!(
			"| {tag} | {} | {tokens} | {load_ms:.1} | {cold_ms:.1} | {warm_ms:.1} | {js_warm:.1} | {:.2}x |",
			lines.len(),
			js_warm / warm_ms
		);
	}
	println!(
		"| total | | | | {total_cold:.1} | {total_warm:.1} | {total_js:.1} | {:.2}x |",
		total_js / total_warm
	);
}
