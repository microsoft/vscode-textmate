/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! rule.ts: RegExpSource, RegExpSourceList, CompiledRule, the Rule kinds and RuleFactory.
use crate::onig_lib::{CaptureIndex, OnigLib, OnigMatch, OnigScanner, OnigString};
use crate::raw::{
	IncludeReference, RawCaptures, RawRepository, RawRule, merge_objects, parse_include,
};
use crate::utils::{escape_regexp_characters, has_captures, parse_int, replace_captures};
use std::cell::RefCell;
use std::rc::Rc;

/// The special rule id that says the end regexp matched.
pub const END_RULE_ID: i32 = -1;
/// The special rule id that says the while regexp matched.
pub const WHILE_RULE_ID: i32 = -2;

/// `HAS_BACK_REFERENCES = /\\(\d+)/`.
fn has_back_references(source: &str) -> bool {
	let b = source.as_bytes();
	(0..b.len().saturating_sub(1)).any(|i| b[i] == b'\\' && b[i + 1].is_ascii_digit())
}

struct AnchorCache {
	a0_g0: String,
	a0_g1: String,
	a1_g0: String,
	a1_g1: String,
}

/// rule.ts `RegExpSource`.
pub struct RegExpSource {
	pub source: String,
	pub rule_id: i32,
	pub has_anchor: bool,
	pub has_back_references: bool,
	anchor_cache: Option<AnchorCache>,
}

impl RegExpSource {
	pub fn new(reg_exp_source: &str, rule_id: i32) -> RegExpSource {
		let mut has_anchor = false;
		let mut source = reg_exp_source.to_string();
		if !reg_exp_source.is_empty() {
			let chars: Vec<char> = reg_exp_source.chars().collect();
			let mut output = String::with_capacity(reg_exp_source.len());
			let mut replaced = false;
			let mut pos = 0;
			while pos < chars.len() {
				let ch = chars[pos];
				if ch == '\\' && pos + 1 < chars.len() {
					let next = chars[pos + 1];
					if next == 'z' {
						output.push_str(r"$(?!\n)(?<!\n)");
						replaced = true;
					} else {
						if next == 'A' || next == 'G' {
							has_anchor = true;
						}
						output.push(ch);
						output.push(next);
					}
					pos += 2;
					continue;
				}
				output.push(ch);
				pos += 1;
			}
			if replaced {
				source = output;
			}
		}
		let mut r = RegExpSource {
			has_back_references: has_back_references(&source),
			source,
			rule_id,
			has_anchor,
			anchor_cache: None,
		};
		if r.has_anchor {
			r.anchor_cache = Some(r.build_anchor_cache());
		}
		r
	}

	pub fn clone_source(&self) -> RegExpSource {
		RegExpSource::new(&self.source, self.rule_id)
	}

	/// Like the TS: rebuilds the anchor variants, keeps `has_back_references`.
	pub fn set_source(&mut self, new_source: &str) {
		if self.source == new_source {
			return;
		}
		self.source = new_source.to_string();
		if self.has_anchor {
			self.anchor_cache = Some(self.build_anchor_cache());
		}
	}

	/// Replaces each `\N` with the escaped text of capture N of `line_text` (positions are UTF-16).
	pub fn resolve_back_references(
		&self,
		line_text: &OnigString,
		capture_indices: &[CaptureIndex],
	) -> String {
		let captured: Vec<&str> = capture_indices
			.iter()
			.map(|c| line_text.slice16(c.start, c.end))
			.collect();
		let b = self.source.as_bytes();
		let mut out = String::with_capacity(self.source.len());
		let (mut last, mut i) = (0, 0);
		while i < b.len() {
			if b[i] == b'\\' && i + 1 < b.len() && b[i + 1].is_ascii_digit() {
				let mut j = i + 1;
				while j < b.len() && b[j].is_ascii_digit() {
					j += 1;
				}
				out.push_str(&self.source[last..i]);
				let value = self.source[i + 1..j]
					.parse::<usize>()
					.ok()
					.and_then(|n| captured.get(n).copied())
					.unwrap_or("");
				out.push_str(&escape_regexp_characters(value));
				last = j;
				i = j;
			} else {
				i += 1;
			}
		}
		out.push_str(&self.source[last..]);
		out
	}

	fn build_anchor_cache(&self) -> AnchorCache {
		let mut c = AnchorCache {
			a0_g0: String::new(),
			a0_g1: String::new(),
			a1_g0: String::new(),
			a1_g1: String::new(),
		};
		let chars: Vec<char> = self.source.chars().collect();
		let mut pos = 0;
		while pos < chars.len() {
			let ch = chars[pos];
			for s in [&mut c.a0_g0, &mut c.a0_g1, &mut c.a1_g0, &mut c.a1_g1] {
				s.push(ch);
			}
			if ch == '\\' && pos + 1 < chars.len() {
				let next = chars[pos + 1];
				let [x00, x01, x10, x11] = match next {
					'A' => ['\u{FFFF}', '\u{FFFF}', 'A', 'A'],
					'G' => ['\u{FFFF}', 'G', '\u{FFFF}', 'G'],
					n => [n, n, n, n],
				};
				c.a0_g0.push(x00);
				c.a0_g1.push(x01);
				c.a1_g0.push(x10);
				c.a1_g1.push(x11);
				pos += 1;
			}
			pos += 1;
		}
		c
	}

	pub fn resolve_anchors(&self, allow_a: bool, allow_g: bool) -> &str {
		match (&self.anchor_cache, self.has_anchor) {
			(Some(c), true) => match (allow_a, allow_g) {
				(true, true) => &c.a1_g1,
				(true, false) => &c.a1_g0,
				(false, true) => &c.a0_g1,
				(false, false) => &c.a0_g0,
			},
			_ => &self.source,
		}
	}
}

/// rule.ts `RegExpSourceList`. Items are shared like the TS shares RegExpSource objects between lists,
/// except the ones it clones (end/while patterns with back-references), which the owner holds by value.
#[derive(Default)]
pub struct RegExpSourceList {
	items: Vec<ListItem>,
	has_anchors: bool,
	cached: Option<Rc<CompiledRule>>,
	anchor_cache: [Option<Rc<CompiledRule>>; 4],
}

pub enum ListItem {
	Shared(Rc<RegExpSource>),
	Owned(RegExpSource),
}

impl ListItem {
	fn get(&self) -> &RegExpSource {
		match self {
			ListItem::Shared(r) => r,
			ListItem::Owned(r) => r,
		}
	}
}

impl RegExpSourceList {
	pub fn push(&mut self, item: ListItem) {
		self.has_anchors = self.has_anchors || item.get().has_anchor;
		self.items.push(item);
	}

	pub fn unshift(&mut self, item: ListItem) {
		self.has_anchors = self.has_anchors || item.get().has_anchor;
		self.items.insert(0, item);
	}

	pub fn length(&self) -> usize {
		self.items.len()
	}

	pub fn set_source(&mut self, index: usize, new_source: &str) {
		if self.items[index].get().source != new_source {
			self.cached = None;
			self.anchor_cache = [None, None, None, None];
			match &mut self.items[index] {
				ListItem::Owned(r) => r.set_source(new_source),
				ListItem::Shared(r) => {
					let mut owned = r.clone_source();
					owned.set_source(new_source);
					self.items[index] = ListItem::Owned(owned);
				}
			}
		}
	}

	pub fn compile(&mut self, onig_lib: &dyn OnigLib) -> Rc<CompiledRule> {
		if self.cached.is_none() {
			let reg_exps: Vec<String> = self.items.iter().map(|e| e.get().source.clone()).collect();
			self.cached = Some(Rc::new(CompiledRule::new(
				onig_lib,
				reg_exps,
				self.rule_ids(),
			)));
		}
		self.cached.clone().unwrap()
	}

	pub fn compile_ag(
		&mut self,
		onig_lib: &dyn OnigLib,
		allow_a: bool,
		allow_g: bool,
	) -> Rc<CompiledRule> {
		if !self.has_anchors {
			return self.compile(onig_lib);
		}
		let slot = (allow_a as usize) * 2 + allow_g as usize;
		if self.anchor_cache[slot].is_none() {
			let reg_exps: Vec<String> = self
				.items
				.iter()
				.map(|e| e.get().resolve_anchors(allow_a, allow_g).to_string())
				.collect();
			self.anchor_cache[slot] = Some(Rc::new(CompiledRule::new(
				onig_lib,
				reg_exps,
				self.rule_ids(),
			)));
		}
		self.anchor_cache[slot].clone().unwrap()
	}

	fn rule_ids(&self) -> Vec<i32> {
		self.items.iter().map(|e| e.get().rule_id).collect()
	}
}

/// rule.ts `CompiledRule`.
pub struct CompiledRule {
	pub reg_exps: Vec<String>,
	pub rules: Vec<i32>,
	scanner: Box<dyn OnigScanner>,
}

pub struct FindNextMatchResult {
	pub rule_id: i32,
	pub capture_indices: Vec<CaptureIndex>,
}

impl CompiledRule {
	pub fn new(onig_lib: &dyn OnigLib, reg_exps: Vec<String>, rules: Vec<i32>) -> CompiledRule {
		let scanner = onig_lib.create_onig_scanner(&reg_exps);
		CompiledRule {
			reg_exps,
			rules,
			scanner,
		}
	}

	pub fn find_next_match_sync(
		&self,
		string: &OnigString,
		start_position: usize,
	) -> Option<FindNextMatchResult> {
		let OnigMatch {
			index,
			capture_indices,
		} = self.scanner.find_next_match_sync(string, start_position)?;
		Some(FindNextMatchResult {
			rule_id: self.rules[index],
			capture_indices,
		})
	}
}

/// The capture rules of a rule, indexed by capture group (`null` in the TS for the groups that have none).
pub type CaptureRules = Vec<Option<Rc<Rule>>>;

/// rule.ts `IRuleRegistry`, `IGrammarRegistry` and `IRuleFactoryHelper` in one: what rules need from their grammar.
pub trait RuleFactoryHelper {
	/// The first half of `registerRule`: `++this._lastRuleId`. The rule is unknown to `get_rule` until `set_rule`.
	fn alloc_rule_id(&self) -> i32;
	/// The second half of `registerRule`.
	fn set_rule(&self, id: i32, rule: Rc<Rule>);
	fn get_rule(&self, id: i32) -> Option<Rc<Rule>>;
	fn get_external_grammar(
		&self,
		scope_name: &str,
		repository: Option<&Rc<RawRepository>>,
	) -> Option<Rc<RawRule>>;
	fn onig_lib(&self) -> &dyn OnigLib;
}

/// rule.ts `Rule` and its subclasses, one `RuleKind` per subclass.
pub struct Rule {
	pub id: i32,
	name: Option<Rc<str>>,
	name_is_capturing: bool,
	content_name: Option<Rc<str>>,
	content_name_is_capturing: bool,
	pub kind: RuleKind,
}

pub enum RuleKind {
	Capture {
		retokenize_captured_with_rule_id: i32,
	},
	Match {
		match_: Rc<RegExpSource>,
		captures: CaptureRules,
		cache: RefCell<Option<RegExpSourceList>>,
	},
	IncludeOnly {
		patterns: Vec<i32>,
		has_missing_patterns: bool,
		cache: RefCell<Option<RegExpSourceList>>,
	},
	BeginEnd {
		begin: Rc<RegExpSource>,
		begin_captures: CaptureRules,
		end: Rc<RegExpSource>,
		end_has_back_references: bool,
		end_captures: CaptureRules,
		apply_end_pattern_last: bool,
		patterns: Vec<i32>,
		has_missing_patterns: bool,
		cache: RefCell<Option<RegExpSourceList>>,
	},
	BeginWhile {
		begin: Rc<RegExpSource>,
		begin_captures: CaptureRules,
		while_: Rc<RegExpSource>,
		while_has_back_references: bool,
		while_captures: CaptureRules,
		patterns: Vec<i32>,
		has_missing_patterns: bool,
		cache: RefCell<Option<RegExpSourceList>>,
		while_cache: RefCell<Option<RegExpSourceList>>,
	},
}

impl Rule {
	fn new(id: i32, name: Option<Rc<str>>, content_name: Option<Rc<str>>, kind: RuleKind) -> Rule {
		Rule {
			id,
			name_is_capturing: has_captures(name.as_deref()),
			name,
			content_name_is_capturing: has_captures(content_name.as_deref()),
			content_name,
			kind,
		}
	}

	pub fn get_name(
		&self,
		line_text: Option<&OnigString>,
		capture_indices: Option<&[CaptureIndex]>,
	) -> Option<Rc<str>> {
		match (&self.name, line_text, capture_indices) {
			(Some(name), Some(line_text), Some(capture_indices)) if self.name_is_capturing => {
				Some(Rc::from(replace_captures(name, line_text, capture_indices)))
			}
			_ => self.name.clone(),
		}
	}

	pub fn get_content_name(
		&self,
		line_text: &OnigString,
		capture_indices: &[CaptureIndex],
	) -> Option<Rc<str>> {
		match &self.content_name {
			Some(name) if self.content_name_is_capturing => {
				Some(Rc::from(replace_captures(name, line_text, capture_indices)))
			}
			_ => self.content_name.clone(),
		}
	}

	/// The patterns of an IncludeOnly, BeginEnd or BeginWhile rule, with `hasMissingPatterns`.
	fn patterns(&self) -> Option<(&[i32], bool)> {
		match &self.kind {
			RuleKind::IncludeOnly {
				patterns,
				has_missing_patterns,
				..
			}
			| RuleKind::BeginEnd {
				patterns,
				has_missing_patterns,
				..
			}
			| RuleKind::BeginWhile {
				patterns,
				has_missing_patterns,
				..
			} => Some((patterns, *has_missing_patterns)),
			_ => None,
		}
	}

	pub fn collect_patterns(&self, helper: &dyn RuleFactoryHelper, out: &mut RegExpSourceList) {
		match &self.kind {
			RuleKind::Capture { .. } => panic!("Not supported!"),
			RuleKind::Match { match_, .. } => out.push(ListItem::Shared(match_.clone())),
			RuleKind::IncludeOnly { patterns, .. } => {
				for &p in patterns {
					helper.get_rule(p).unwrap().collect_patterns(helper, out);
				}
			}
			RuleKind::BeginEnd { begin, .. } | RuleKind::BeginWhile { begin, .. } => {
				out.push(ListItem::Shared(begin.clone()))
			}
		}
	}

	pub fn compile_ag(
		&self,
		helper: &dyn RuleFactoryHelper,
		end_regex_source: Option<&str>,
		allow_a: bool,
		allow_g: bool,
	) -> Rc<CompiledRule> {
		match &self.kind {
			RuleKind::Capture { .. } => panic!("Not supported!"),
			RuleKind::Match { cache, .. } | RuleKind::IncludeOnly { cache, .. } => {
				let mut cache = cache.borrow_mut();
				let list = cache.get_or_insert_with(|| {
					let mut list = RegExpSourceList::default();
					self.collect_patterns(helper, &mut list);
					list
				});
				list.compile_ag(helper.onig_lib(), allow_a, allow_g)
			}
			RuleKind::BeginEnd {
				end,
				apply_end_pattern_last,
				patterns,
				cache,
				..
			} => {
				let mut cache = cache.borrow_mut();
				let list = cache.get_or_insert_with(|| {
					let mut list = RegExpSourceList::default();
					for &p in patterns {
						helper
							.get_rule(p)
							.unwrap()
							.collect_patterns(helper, &mut list);
					}
					let item = if end.has_back_references {
						ListItem::Owned(end.clone_source())
					} else {
						ListItem::Shared(end.clone())
					};
					if *apply_end_pattern_last {
						list.push(item);
					} else {
						list.unshift(item);
					}
					list
				});
				if end.has_back_references {
					// The TS would set a `null` source here, which no grammar of ours reaches.
					if let Some(source) = end_regex_source {
						let index = if *apply_end_pattern_last {
							list.length() - 1
						} else {
							0
						};
						list.set_source(index, source);
					}
				}
				list.compile_ag(helper.onig_lib(), allow_a, allow_g)
			}
			RuleKind::BeginWhile {
				patterns, cache, ..
			} => {
				let mut cache = cache.borrow_mut();
				let list = cache.get_or_insert_with(|| {
					let mut list = RegExpSourceList::default();
					for &p in patterns {
						helper
							.get_rule(p)
							.unwrap()
							.collect_patterns(helper, &mut list);
					}
					list
				});
				list.compile_ag(helper.onig_lib(), allow_a, allow_g)
			}
		}
	}

	pub fn compile_while_ag(
		&self,
		helper: &dyn RuleFactoryHelper,
		end_regex_source: Option<&str>,
		allow_a: bool,
		allow_g: bool,
	) -> Rc<CompiledRule> {
		let RuleKind::BeginWhile {
			while_,
			while_cache,
			..
		} = &self.kind
		else {
			panic!("compile_while_ag on a rule without while")
		};
		let mut cache = while_cache.borrow_mut();
		let list = cache.get_or_insert_with(|| {
			let mut list = RegExpSourceList::default();
			list.push(if while_.has_back_references {
				ListItem::Owned(while_.clone_source())
			} else {
				ListItem::Shared(while_.clone())
			});
			list
		});
		if while_.has_back_references {
			list.set_source(0, end_regex_source.unwrap_or(""));
		}
		list.compile_ag(helper.onig_lib(), allow_a, allow_g)
	}

	pub fn get_end_with_resolved_back_references(
		&self,
		line_text: &OnigString,
		capture_indices: &[CaptureIndex],
	) -> String {
		match &self.kind {
			RuleKind::BeginEnd { end, .. } => {
				end.resolve_back_references(line_text, capture_indices)
			}
			_ => panic!("not a BeginEnd rule"),
		}
	}

	pub fn get_while_with_resolved_back_references(
		&self,
		line_text: &OnigString,
		capture_indices: &[CaptureIndex],
	) -> String {
		match &self.kind {
			RuleKind::BeginWhile { while_, .. } => {
				while_.resolve_back_references(line_text, capture_indices)
			}
			_ => panic!("not a BeginWhile rule"),
		}
	}
}

/// rule.ts `RuleFactory.getCompiledRuleId`.
pub fn get_compiled_rule_id(
	desc: &Rc<RawRule>,
	helper: &dyn RuleFactoryHelper,
	repository: &Rc<RawRepository>,
) -> i32 {
	if desc.id.get() != 0 {
		return desc.id.get();
	}
	let id = helper.alloc_rule_id();
	desc.id.set(id);
	let rule = if let Some(match_) = &desc.match_ {
		let captures = compile_captures(desc.captures.as_deref(), helper, repository);
		Rule::new(
			id,
			desc.name.clone(),
			None,
			RuleKind::Match {
				match_: Rc::new(RegExpSource::new(match_, id)),
				captures,
				cache: RefCell::new(None),
			},
		)
	} else if desc.begin.is_none() {
		let merged;
		let repository = match &desc.repository {
			Some(own) => {
				merged = merge_objects(Some(repository), own);
				&merged
			}
			None => repository,
		};
		let included;
		let patterns: Option<&[Rc<RawRule>]> = match (&desc.patterns, &desc.include) {
			(Some(patterns), _) => Some(patterns),
			(None, Some(include)) => {
				included = [Rc::new(RawRule {
					include: Some(include.clone()),
					..RawRule::default()
				})];
				Some(&included)
			}
			(None, None) => None,
		};
		let (patterns, has_missing_patterns) = compile_patterns(patterns, helper, repository);
		Rule::new(
			id,
			desc.name.clone(),
			desc.content_name.clone(),
			RuleKind::IncludeOnly {
				patterns,
				has_missing_patterns,
				cache: RefCell::new(None),
			},
		)
	} else if let Some(while_) = &desc.while_ {
		let begin_captures = compile_captures(
			desc.begin_captures.as_deref().or(desc.captures.as_deref()),
			helper,
			repository,
		);
		let while_captures = compile_captures(
			desc.while_captures.as_deref().or(desc.captures.as_deref()),
			helper,
			repository,
		);
		let (patterns, has_missing_patterns) = compile_patterns(
			desc.patterns.as_deref().map(|p| p.as_slice()),
			helper,
			repository,
		);
		let while_ = Rc::new(RegExpSource::new(while_, WHILE_RULE_ID));
		Rule::new(
			id,
			desc.name.clone(),
			desc.content_name.clone(),
			RuleKind::BeginWhile {
				begin: Rc::new(RegExpSource::new(desc.begin.as_deref().unwrap(), id)),
				begin_captures,
				while_has_back_references: while_.has_back_references,
				while_,
				while_captures,
				patterns,
				has_missing_patterns,
				cache: RefCell::new(None),
				while_cache: RefCell::new(None),
			},
		)
	} else {
		let begin_captures = compile_captures(
			desc.begin_captures.as_deref().or(desc.captures.as_deref()),
			helper,
			repository,
		);
		let end_captures = compile_captures(
			desc.end_captures.as_deref().or(desc.captures.as_deref()),
			helper,
			repository,
		);
		let (patterns, has_missing_patterns) = compile_patterns(
			desc.patterns.as_deref().map(|p| p.as_slice()),
			helper,
			repository,
		);
		let end = Rc::new(RegExpSource::new(
			desc.end.as_deref().unwrap_or(""),
			END_RULE_ID,
		));
		Rule::new(
			id,
			desc.name.clone(),
			desc.content_name.clone(),
			RuleKind::BeginEnd {
				begin: Rc::new(RegExpSource::new(desc.begin.as_deref().unwrap(), id)),
				begin_captures,
				end_has_back_references: end.has_back_references,
				end,
				end_captures,
				apply_end_pattern_last: desc.apply_end_pattern_last,
				patterns,
				has_missing_patterns,
				cache: RefCell::new(None),
			},
		)
	};
	helper.set_rule(id, Rc::new(rule));
	id
}

/// rule.ts `RuleFactory._compileCaptures`.
fn compile_captures(
	captures: Option<&RawCaptures>,
	helper: &dyn RuleFactoryHelper,
	repository: &Rc<RawRepository>,
) -> CaptureRules {
	let Some(captures) = captures else {
		return Vec::new();
	};
	let max = captures
		.iter()
		.filter_map(|(key, _)| parse_int(key))
		.fold(0, i64::max);
	let mut r: CaptureRules = vec![None; max as usize + 1];
	for (key, capture) in captures {
		let retokenize_captured_with_rule_id = if capture.patterns.is_some() {
			get_compiled_rule_id(capture, helper, repository)
		} else {
			0
		};
		let id = helper.alloc_rule_id();
		let rule = Rc::new(Rule::new(
			id,
			capture.name.clone(),
			capture.content_name.clone(),
			RuleKind::Capture {
				retokenize_captured_with_rule_id,
			},
		));
		helper.set_rule(id, rule.clone());
		if let Some(index) = parse_int(key).filter(|&i| i >= 0) {
			r[index as usize] = Some(rule);
		}
	}
	r
}

/// rule.ts `RuleFactory._compilePatterns`.
fn compile_patterns(
	patterns: Option<&[Rc<RawRule>]>,
	helper: &dyn RuleFactoryHelper,
	repository: &Rc<RawRepository>,
) -> (Vec<i32>, bool) {
	let mut r = Vec::new();
	for pattern in patterns.unwrap_or(&[]) {
		let mut rule_id = -1;
		if let Some(include) = &pattern.include {
			match parse_include(include) {
				IncludeReference::Base | IncludeReference::SelfRef => {
					if let Some(local) = repository.get(&**include) {
						rule_id = get_compiled_rule_id(local, helper, repository);
					}
				}
				IncludeReference::Relative(rule_name) => {
					if let Some(local) = repository.get(rule_name) {
						rule_id = get_compiled_rule_id(local, helper, repository);
					}
				}
				IncludeReference::TopLevel(scope_name)
				| IncludeReference::TopLevelRepository(scope_name, _) => {
					let rule_name = match parse_include(include) {
						IncludeReference::TopLevelRepository(_, rule_name)
							if !rule_name.is_empty() =>
						{
							Some(rule_name)
						}
						_ => None,
					};
					if let Some(external) =
						helper.get_external_grammar(scope_name, Some(repository))
					{
						let external_repository = external.repository.as_ref().unwrap();
						match rule_name {
							Some(rule_name) => {
								if let Some(external_rule) = external_repository.get(rule_name) {
									rule_id = get_compiled_rule_id(
										external_rule,
										helper,
										external_repository,
									);
								}
							}
							None => {
								rule_id = get_compiled_rule_id(
									external_repository.get("$self").unwrap(),
									helper,
									external_repository,
								)
							}
						}
					}
				}
			}
		} else {
			rule_id = get_compiled_rule_id(pattern, helper, repository);
		}
		if rule_id != -1 {
			let skip = match helper.get_rule(rule_id) {
				Some(rule) => {
					matches!(rule.patterns(), Some((patterns, true)) if patterns.is_empty())
				}
				None => false,
			};
			if skip {
				continue;
			}
			r.push(rule_id);
		}
	}
	let has_missing_patterns = patterns.map_or(0, |p| p.len()) != r.len();
	(r, has_missing_patterns)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reg_exp_source_matches_the_ts() {
		let r = RegExpSource::new(r"a\zb\Gc\Ad", 7);
		assert_eq!(
			(
				r.source.as_str(),
				r.has_anchor,
				r.resolve_anchors(false, false),
				r.resolve_anchors(true, false),
				r.resolve_anchors(false, true)
			),
			(
				r"a$(?!\n)(?<!\n)b\Gc\Ad",
				true,
				"a$(?!\\n)(?<!\\n)b\\\u{FFFF}c\\\u{FFFF}d",
				"a$(?!\\n)(?<!\\n)b\\\u{FFFF}c\\Ad",
				"a$(?!\\n)(?<!\\n)b\\Gc\\\u{FFFF}d"
			)
		);
		let e = RegExpSource::new(r"\1(\\2)\x", -1);
		let line = OnigString::new("ab.c".to_string());
		assert_eq!(
			(
				e.has_back_references,
				e.resolve_back_references(
					&line,
					&[
						CaptureIndex { start: 0, end: 4 },
						CaptureIndex { start: 2, end: 3 }
					]
				)
			),
			(true, r"\.(\)\x".to_string())
		);
	}
}
