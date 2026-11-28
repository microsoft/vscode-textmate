/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! rawGrammar.ts, with the fields RuleFactory and the dependency collector read, as `clone` (utils.ts) leaves them,
//! plus utils.ts `mergeObjects` and grammar.ts `initGrammar`.
//!
//! Each field keeps the test the TS applies to it: `match`, `while`, `include`, `name`, `contentName` and
//! `injectionSelector` count only as non-empty strings (the TS tests their truthiness), `begin` counts when it is
//! present, `end` falls back to `""` (which matches at once) when it is empty, and `patterns` and the captures count when present,
//! even when empty. `clone` turns `null` into `{}`, so a `null` rule is an empty rule.
use crate::json::{Json, parse_json, parse_plist};
use rustc_hash::FxHashMap;
use std::cell::Cell;
use std::rc::Rc;

pub type RawRepository = FxHashMap<Rc<str>, Rc<RawRule>>;
/// Captures, or a grammar's injections, in `for..in` order.
pub type RawCaptures = Vec<(Rc<str>, Rc<RawRule>)>;

#[derive(Default)]
pub struct RawRule {
	/// The id RuleFactory gives the rule (0: none yet; ids start at 1).
	pub id: Cell<i32>,
	pub include: Option<Rc<str>>,
	pub name: Option<Rc<str>>,
	pub content_name: Option<Rc<str>>,
	pub match_: Option<Rc<str>>,
	pub begin: Option<Rc<str>>,
	pub end: Option<Rc<str>>,
	pub while_: Option<Rc<str>>,
	pub captures: Option<Rc<RawCaptures>>,
	pub begin_captures: Option<Rc<RawCaptures>>,
	pub end_captures: Option<Rc<RawCaptures>>,
	pub while_captures: Option<Rc<RawCaptures>>,
	pub patterns: Option<Rc<Vec<Rc<RawRule>>>>,
	pub repository: Option<Rc<RawRepository>>,
	pub apply_end_pattern_last: bool,
	// The grammar's own fields.
	pub scope_name: Option<Rc<str>>,
	pub injections: Option<Rc<RawCaptures>>,
	pub injection_selector: Option<Rc<str>>,
}

fn non_empty_string(v: &Json) -> Option<Rc<str>> {
	match v {
		Json::String(s) if !s.is_empty() => Some(Rc::from(s.as_str())),
		_ => None,
	}
}

fn captures_from_json(v: &Json) -> Option<Rc<RawCaptures>> {
	match v {
		Json::Object(fields) => Some(Rc::new(
			fields
				.iter()
				.map(|(k, v)| (Rc::from(k.as_str()), RawRule::from_json(v)))
				.collect(),
		)),
		Json::Array(items) => Some(Rc::new(
			items
				.iter()
				.enumerate()
				.map(|(i, v)| (Rc::from(i.to_string().as_str()), RawRule::from_json(v)))
				.collect(),
		)),
		Json::Null => Some(Rc::new(Vec::new())),
		_ => None,
	}
}

impl RawRule {
	pub fn from_json(v: &Json) -> Rc<RawRule> {
		let mut r = RawRule::default();
		if let Some(fields) = v.as_object() {
			for (k, v) in fields {
				match k.as_str() {
					"include" => r.include = non_empty_string(v),
					"name" => r.name = non_empty_string(v),
					"contentName" => r.content_name = non_empty_string(v),
					"match" => r.match_ = non_empty_string(v),
					"begin" => r.begin = Some(Rc::from(v.as_str().unwrap_or(""))),
					"end" => r.end = non_empty_string(v),
					"while" => r.while_ = non_empty_string(v),
					"captures" => r.captures = captures_from_json(v),
					"beginCaptures" => r.begin_captures = captures_from_json(v),
					"endCaptures" => r.end_captures = captures_from_json(v),
					"whileCaptures" => r.while_captures = captures_from_json(v),
					"patterns" => {
						r.patterns = v
							.as_array()
							.map(|a| Rc::new(a.iter().map(RawRule::from_json).collect()))
					}
					"repository" => {
						r.repository = v.as_object().map(|o| {
							Rc::new(
								o.iter()
									.map(|(k, v)| (Rc::from(k.as_str()), RawRule::from_json(v)))
									.collect(),
							)
						})
					}
					"applyEndPatternLast" => r.apply_end_pattern_last = v.is_truthy(),
					"scopeName" => r.scope_name = v.as_str().map(Rc::from),
					"injections" => {
						r.injections = v.as_object().map(|o| {
							Rc::new(
								o.iter()
									.map(|(k, v)| (Rc::from(k.as_str()), RawRule::from_json(v)))
									.collect(),
							)
						})
					}
					"injectionSelector" => r.injection_selector = non_empty_string(v),
					_ => {}
				}
			}
		}
		Rc::new(r)
	}

	/// utils.ts `clone`: fresh rule objects all the way down, sharing the strings.
	pub fn deep_clone(&self) -> RawRule {
		fn clone_captures(c: &Option<Rc<RawCaptures>>) -> Option<Rc<RawCaptures>> {
			c.as_ref().map(|c| {
				Rc::new(
					c.iter()
						.map(|(k, v)| (k.clone(), Rc::new(v.deep_clone())))
						.collect(),
				)
			})
		}
		RawRule {
			id: Cell::new(self.id.get()),
			include: self.include.clone(),
			name: self.name.clone(),
			content_name: self.content_name.clone(),
			match_: self.match_.clone(),
			begin: self.begin.clone(),
			end: self.end.clone(),
			while_: self.while_.clone(),
			captures: clone_captures(&self.captures),
			begin_captures: clone_captures(&self.begin_captures),
			end_captures: clone_captures(&self.end_captures),
			while_captures: clone_captures(&self.while_captures),
			patterns: self
				.patterns
				.as_ref()
				.map(|p| Rc::new(p.iter().map(|r| Rc::new(r.deep_clone())).collect())),
			repository: self.repository.as_ref().map(|r| {
				Rc::new(
					r.iter()
						.map(|(k, v)| (k.clone(), Rc::new(v.deep_clone())))
						.collect(),
				)
			}),
			apply_end_pattern_last: self.apply_end_pattern_last,
			scope_name: self.scope_name.clone(),
			injections: clone_captures(&self.injections),
			injection_selector: self.injection_selector.clone(),
		}
	}
}

/// main.ts `parseRawGrammar` (parseRawGrammar.ts): JSON when the path ends in `.json`, plist otherwise, including
/// when there is no path.
pub fn parse_raw_grammar(content: &str, file_path: Option<&str>) -> Result<Rc<RawRule>, String> {
	let json = match file_path {
		Some(path) if path.ends_with(".json") => parse_json(content)?,
		_ => parse_plist(content)?,
	};
	Ok(RawRule::from_json(&json))
}

/// grammar.ts `initGrammar`: a clone whose repository has `$self` (the grammar's patterns, named after its scope)
/// and `$base` (the given base, or `$self`).
pub fn init_grammar(grammar: &RawRule, base: Option<Rc<RawRule>>) -> Rc<RawRule> {
	let mut g = grammar.deep_clone();
	let mut repository: RawRepository = match g.repository.take() {
		Some(r) => Rc::try_unwrap(r).unwrap_or_else(|r| (*r).clone()),
		None => RawRepository::default(),
	};
	let self_rule = Rc::new(RawRule {
		patterns: g.patterns.clone(),
		name: g.scope_name.clone(),
		..RawRule::default()
	});
	repository.insert(Rc::from("$self"), self_rule.clone());
	repository.insert(Rc::from("$base"), base.unwrap_or(self_rule));
	g.repository = Some(Rc::new(repository));
	Rc::new(g)
}

/// `mergeObjects({}, a, b)` over repositories.
pub fn merge_objects(a: Option<&RawRepository>, b: &RawRepository) -> Rc<RawRepository> {
	let mut m = a.cloned().unwrap_or_default();
	for (k, v) in b {
		m.insert(k.clone(), v.clone());
	}
	Rc::new(m)
}

/// grammarDependencies.ts `parseInclude`.
#[derive(Debug, PartialEq, Eq)]
pub enum IncludeReference<'a> {
	Base,
	SelfRef,
	Relative(&'a str),
	TopLevel(&'a str),
	TopLevelRepository(&'a str, &'a str),
}

pub fn parse_include(include: &str) -> IncludeReference<'_> {
	if include == "$base" {
		return IncludeReference::Base;
	}
	if include == "$self" {
		return IncludeReference::SelfRef;
	}
	match include.find('#') {
		None => IncludeReference::TopLevel(include),
		Some(0) => IncludeReference::Relative(&include[1..]),
		Some(i) => IncludeReference::TopLevelRepository(&include[..i], &include[i + 1..]),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parse_raw_grammar_reads_json_only_for_a_json_path() {
		let json = r#"{"scopeName":"source.a"}"#;
		let plist = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>scopeName</key><string>source.b</string></dict></plist>";
		let scope = |r: Result<Rc<RawRule>, String>| {
			r.map(|g| g.scope_name.as_deref().unwrap_or("").to_string())
				.map_err(|_| ())
		};
		assert_eq!(
			[
				scope(parse_raw_grammar(json, Some("a.json"))),
				scope(parse_raw_grammar(plist, Some("b.tmLanguage"))),
				scope(parse_raw_grammar(plist, None)),
				scope(parse_raw_grammar(json, Some("a.JSON")))
			],
			[
				Ok("source.a".to_string()),
				Ok("source.b".to_string()),
				Ok("source.b".to_string()),
				Err(())
			]
		);
	}

	#[test]
	fn init_grammar_shares_the_patterns_of_self() {
		let raw = RawRule::from_json(&parse_json(r#"{"scopeName":"s","patterns":[{"match":"a","name":""}],"repository":{"r":null},"captures":[{"name":"x"}]}"#).unwrap());
		let g = init_grammar(&raw, None);
		let repo = g.repository.as_ref().unwrap();
		let self_rule = repo.get("$self").unwrap();
		assert!(Rc::ptr_eq(
			self_rule.patterns.as_ref().unwrap(),
			g.patterns.as_ref().unwrap()
		));
		assert!(Rc::ptr_eq(self_rule, repo.get("$base").unwrap()));
		assert_eq!(
			(
				self_rule.name.as_deref(),
				g.patterns.as_ref().unwrap()[0].name.is_none(),
				repo.get("r").unwrap().match_.is_none(),
				&*g.captures.as_ref().unwrap()[0].0
			),
			(Some("s"), true, true, "0")
		);
		assert_eq!(
			[
				parse_include("$base"),
				parse_include("#a"),
				parse_include("x.y"),
				parse_include("x#a#b")
			],
			[
				IncludeReference::Base,
				IncludeReference::Relative("a"),
				IncludeReference::TopLevel("x.y"),
				IncludeReference::TopLevelRepository("x", "a#b")
			]
		);
	}
}
