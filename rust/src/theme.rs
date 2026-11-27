/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! theme.ts: parseTheme, the color map, the theme trie and Theme.match.
use crate::json::Json;
use crate::utils::{is_valid_hex_color, str_arr_cmp, strcmp};
use rustc_hash::FxHashMap;
use std::cell::RefCell;
use std::rc::Rc;

/// theme.ts `ScopeStack`: a scope path, innermost last.
pub struct ScopeStack {
	pub parent: Option<Rc<ScopeStack>>,
	pub scope_name: Rc<str>,
}

impl ScopeStack {
	pub fn push(self: &Rc<Self>, scope_name: Rc<str>) -> Rc<ScopeStack> {
		Rc::new(ScopeStack {
			parent: Some(self.clone()),
			scope_name,
		})
	}
	pub fn get_segments(&self) -> Vec<Rc<str>> {
		let mut result = vec![self.scope_name.clone()];
		let mut item = self.parent.as_deref();
		while let Some(i) = item {
			result.push(i.scope_name.clone());
			item = i.parent.as_deref();
		}
		result.reverse();
		result
	}

	/// `ScopeStack.push(path, scopeNames)`: pushes each scope name in turn.
	pub fn push_all(
		mut path: Option<Rc<ScopeStack>>,
		scope_names: &[Rc<str>],
	) -> Option<Rc<ScopeStack>> {
		for scope_name in scope_names {
			path = Some(Rc::new(ScopeStack {
				parent: path,
				scope_name: scope_name.clone(),
			}));
		}
		path
	}

	/// `ScopeStack.getExtensionIfDefined(base)`: the scope names after `base` up to this one, outermost first, or
	/// `None` when `base` isn't on this path.
	pub fn get_extension_if_defined(&self, base: Option<&ScopeStack>) -> Option<Vec<Rc<str>>> {
		let mut result = Vec::new();
		let mut item = Some(self);
		while let Some(i) = item {
			if base.is_some_and(|base| std::ptr::eq(i, base)) {
				break;
			}
			result.push(i.scope_name.clone());
			item = i.parent.as_deref();
		}
		let reached_base = match (item, base) {
			(None, None) => true,
			(Some(item), Some(base)) => std::ptr::eq(item, base),
			_ => false,
		};
		reached_base.then(|| {
			result.reverse();
			result
		})
	}
}

/// theme.ts `StyleAttributes`.
#[derive(Clone, Debug, PartialEq)]
pub struct StyleAttributes {
	pub font_style: i32,
	pub foreground_id: u32,
	pub background_id: u32,
	pub font_family: Rc<str>,
	pub font_size: f64,
	pub line_height: f64,
}

#[derive(Clone, Debug)]
pub struct ParsedThemeRule {
	pub scope: String,
	pub parent_scopes: Option<Vec<String>>,
	pub index: usize,
	pub font_style: i32,
	pub foreground: Option<String>,
	pub background: Option<String>,
	pub font_family: Rc<str>,
	pub font_size: f64,
	pub line_height: f64,
}

pub(crate) fn is_js_whitespace(c: char) -> bool {
	matches!(
		c,
		'\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
			..='\u{200A}'
				| '\u{2028}'
				| '\u{2029}'
				| '\u{202F}'
				| '\u{205F}'
				| '\u{3000}'
				| '\u{FEFF}'
	)
}

/// theme.ts `parseTheme`.
pub fn parse_theme(source: Option<&Json>) -> Vec<ParsedThemeRule> {
	let Some(source) = source.filter(|s| s.is_truthy()) else {
		return Vec::new();
	};
	let Some(settings) = source.get("settings").and_then(Json::as_array) else {
		return Vec::new();
	};
	let mut result = Vec::new();
	for (i, entry) in settings.iter().enumerate() {
		let Some(entry_settings) = entry.get("settings").filter(|s| s.is_truthy()) else {
			continue;
		};
		let scopes: Vec<String> = match entry.get("scope") {
			Some(Json::String(s)) => s
				.trim_start_matches(',')
				.trim_end_matches(',')
				.split(',')
				.map(str::to_string)
				.collect(),
			Some(Json::Array(a)) => a
				.iter()
				.map(|x| x.as_str().unwrap_or_default().to_string())
				.collect(),
			_ => vec![String::new()],
		};
		let mut font_style = -1;
		if let Some(fs) = entry_settings.get("fontStyle").and_then(Json::as_str) {
			font_style = 0;
			for segment in fs.split(' ') {
				match segment {
					"italic" => font_style |= 1,
					"bold" => font_style |= 2,
					"underline" => font_style |= 4,
					"strikethrough" => font_style |= 8,
					_ => {}
				}
			}
		}
		let color = |k: &str| {
			entry_settings
				.get(k)
				.and_then(Json::as_str)
				.filter(|c| is_valid_hex_color(c))
				.map(str::to_string)
		};
		let foreground = color("foreground");
		let background = color("background");
		let font_family: Rc<str> = entry_settings
			.get("fontFamily")
			.and_then(Json::as_str)
			.unwrap_or("")
			.into();
		let font_size = entry_settings
			.get("fontSize")
			.and_then(Json::as_f64)
			.unwrap_or(0.0);
		let line_height = entry_settings
			.get("lineHeight")
			.and_then(Json::as_f64)
			.unwrap_or(0.0);
		for scope in &scopes {
			let segments: Vec<&str> = scope.trim_matches(is_js_whitespace).split(' ').collect();
			let parent_scopes = (segments.len() > 1).then(|| {
				segments[..segments.len() - 1]
					.iter()
					.rev()
					.map(|s| s.to_string())
					.collect()
			});
			result.push(ParsedThemeRule {
				scope: segments[segments.len() - 1].to_string(),
				parent_scopes,
				index: i,
				font_style,
				foreground: foreground.clone(),
				background: background.clone(),
				font_family: font_family.clone(),
				font_size,
				line_height,
			});
		}
	}
	result
}

/// theme.ts `ColorMap`.
pub struct ColorMap {
	is_frozen: bool,
	last_color_id: u32,
	id2color: Vec<String>,
	color2id: FxHashMap<String, u32>,
}

impl ColorMap {
	pub fn new(color_map: Option<&[String]>) -> ColorMap {
		let mut m = ColorMap {
			is_frozen: false,
			last_color_id: 0,
			id2color: vec![String::new()],
			color2id: FxHashMap::default(),
		};
		if let Some(colors) = color_map {
			m.is_frozen = true;
			m.id2color = colors.to_vec();
			for (i, c) in colors.iter().enumerate() {
				m.color2id.insert(c.clone(), i as u32);
			}
		}
		m
	}
	pub fn get_id(&mut self, color: Option<&str>) -> u32 {
		let Some(color) = color else { return 0 };
		let color = color.to_uppercase();
		if let Some(&v) = self.color2id.get(&color) {
			if v != 0 {
				return v;
			}
		}
		if self.is_frozen {
			panic!("Missing color in color map - {color}");
		}
		self.last_color_id += 1;
		let v = self.last_color_id;
		self.color2id.insert(color.clone(), v);
		if self.id2color.len() <= v as usize {
			self.id2color.resize(v as usize + 1, String::new());
		}
		self.id2color[v as usize] = color;
		v
	}
	pub fn get_color_map(&self) -> Vec<String> {
		self.id2color.clone()
	}
}

/// theme.ts `ThemeTrieElementRule`.
#[derive(Clone, Debug)]
pub struct ThemeTrieElementRule {
	pub scope_depth: i32,
	pub parent_scopes: Vec<String>,
	pub font_style: i32,
	pub foreground: u32,
	pub background: u32,
	pub font_family: Rc<str>,
	pub font_size: f64,
	pub line_height: f64,
}

impl ThemeTrieElementRule {
	#[allow(clippy::too_many_arguments)]
	fn accept_overwrite(
		&mut self,
		scope_depth: i32,
		font_style: i32,
		foreground: u32,
		background: u32,
		font_family: &Rc<str>,
		font_size: f64,
		line_height: f64,
	) {
		if self.scope_depth <= scope_depth {
			self.scope_depth = scope_depth;
		}
		if font_style != -1 {
			self.font_style = font_style;
		}
		if foreground != 0 {
			self.foreground = foreground;
		}
		if background != 0 {
			self.background = background;
		}
		if !font_family.is_empty() {
			self.font_family = font_family.clone();
		}
		if font_size != 0.0 {
			self.font_size = font_size;
		}
		if line_height != 0.0 {
			self.line_height = line_height;
		}
	}
}

fn len16(s: &str) -> i64 {
	if s.is_ascii() {
		s.len() as i64
	} else {
		s.encode_utf16().count() as i64
	}
}

fn split_head(scope: &str) -> (&str, &str) {
	match scope.find('.') {
		None => (scope, ""),
		Some(i) => (&scope[..i], &scope[i + 1..]),
	}
}

/// theme.ts `ThemeTrieElement`.
pub struct ThemeTrieElement {
	main_rule: ThemeTrieElementRule,
	rules_with_parent_scopes: Vec<ThemeTrieElementRule>,
	children: FxHashMap<String, ThemeTrieElement>,
}

impl ThemeTrieElement {
	fn cmp_by_specificity(a: &ThemeTrieElementRule, b: &ThemeTrieElementRule) -> i64 {
		if a.scope_depth != b.scope_depth {
			return (b.scope_depth - a.scope_depth) as i64;
		}
		let (mut i, mut j) = (0, 0);
		loop {
			if a.parent_scopes.get(i).is_some_and(|s| s == ">") {
				i += 1;
			}
			if b.parent_scopes.get(j).is_some_and(|s| s == ">") {
				j += 1;
			}
			if i >= a.parent_scopes.len() || j >= b.parent_scopes.len() {
				break;
			}
			let r = len16(&b.parent_scopes[j]) - len16(&a.parent_scopes[i]);
			if r != 0 {
				return r;
			}
			i += 1;
			j += 1;
		}
		b.parent_scopes.len() as i64 - a.parent_scopes.len() as i64
	}

	pub fn match_scope(&self, scope: &str) -> Vec<ThemeTrieElementRule> {
		if !scope.is_empty() {
			let (head, tail) = split_head(scope);
			if let Some(child) = self.children.get(head) {
				return child.match_scope(tail);
			}
		}
		let mut rules = self.rules_with_parent_scopes.clone();
		rules.push(self.main_rule.clone());
		rules.sort_by(|a, b| Self::cmp_by_specificity(a, b).cmp(&0));
		rules
	}

	#[allow(clippy::too_many_arguments)]
	fn insert(
		&mut self,
		scope_depth: i32,
		scope: &str,
		parent_scopes: Option<&[String]>,
		font_style: i32,
		foreground: u32,
		background: u32,
		font_family: Rc<str>,
		font_size: f64,
		line_height: f64,
	) {
		if scope.is_empty() {
			self.do_insert_here(
				scope_depth,
				parent_scopes,
				font_style,
				foreground,
				background,
				font_family,
				font_size,
				line_height,
			);
			return;
		}
		let (head, tail) = split_head(scope);
		if !self.children.contains_key(head) {
			let child = ThemeTrieElement {
				main_rule: self.main_rule.clone(),
				rules_with_parent_scopes: self.rules_with_parent_scopes.clone(),
				children: FxHashMap::default(),
			};
			self.children.insert(head.to_string(), child);
		}
		self.children.get_mut(head).unwrap().insert(
			scope_depth + 1,
			tail,
			parent_scopes,
			font_style,
			foreground,
			background,
			font_family,
			font_size,
			line_height,
		);
	}

	#[allow(clippy::too_many_arguments)]
	fn do_insert_here(
		&mut self,
		scope_depth: i32,
		parent_scopes: Option<&[String]>,
		mut font_style: i32,
		mut foreground: u32,
		mut background: u32,
		mut font_family: Rc<str>,
		mut font_size: f64,
		mut line_height: f64,
	) {
		let Some(parent_scopes) = parent_scopes else {
			self.main_rule.accept_overwrite(
				scope_depth,
				font_style,
				foreground,
				background,
				&font_family,
				font_size,
				line_height,
			);
			return;
		};
		for rule in &mut self.rules_with_parent_scopes {
			if str_arr_cmp(Some(&rule.parent_scopes), Some(parent_scopes)) == 0 {
				rule.accept_overwrite(
					scope_depth,
					font_style,
					foreground,
					background,
					&font_family,
					font_size,
					line_height,
				);
				return;
			}
		}
		if font_style == -1 {
			font_style = self.main_rule.font_style;
		}
		if foreground == 0 {
			foreground = self.main_rule.foreground;
		}
		if background == 0 {
			background = self.main_rule.background;
		}
		if font_family.is_empty() {
			font_family = self.main_rule.font_family.clone();
		}
		if font_size == 0.0 {
			font_size = self.main_rule.font_size;
		}
		if line_height == 0.0 {
			line_height = self.main_rule.line_height;
		}
		self.rules_with_parent_scopes.push(ThemeTrieElementRule {
			scope_depth,
			parent_scopes: parent_scopes.to_vec(),
			font_style,
			foreground,
			background,
			font_family,
			font_size,
			line_height,
		});
	}
}

/// theme.ts `Theme`.
pub struct Theme {
	color_map: ColorMap,
	defaults: StyleAttributes,
	root: ThemeTrieElement,
	cached_match_root: RefCell<FxHashMap<Rc<str>, Rc<[ThemeTrieElementRule]>>>,
}

impl Theme {
	pub fn create_from_raw_theme(source: Option<&Json>, color_map: Option<&[String]>) -> Theme {
		Self::create_from_parsed_theme(parse_theme(source), color_map)
	}

	/// theme.ts `resolveParsedThemeRules`.
	pub fn create_from_parsed_theme(
		mut rules: Vec<ParsedThemeRule>,
		color_map: Option<&[String]>,
	) -> Theme {
		rules.sort_by(|a, b| {
			strcmp(&a.scope, &b.scope)
				.then_with(|| {
					str_arr_cmp(a.parent_scopes.as_deref(), b.parent_scopes.as_deref()).cmp(&0)
				})
				.then_with(|| a.index.cmp(&b.index))
		});
		let (mut default_font_style, mut default_foreground, mut default_background) =
			(0, "#000000".to_string(), "#ffffff".to_string());
		let (mut default_font_family, mut default_font_size, mut default_line_height): (
			Rc<str>,
			f64,
			f64,
		) = ("".into(), 0.0, 0.0);
		let mut start = 0;
		while start < rules.len() && rules[start].scope.is_empty() {
			let incoming = &rules[start];
			if incoming.font_style != -1 {
				default_font_style = incoming.font_style;
			}
			if let Some(f) = &incoming.foreground {
				default_foreground = f.clone();
			}
			if let Some(b) = &incoming.background {
				default_background = b.clone();
			}
			// The TS checks these against `null`, which a parsed rule never holds: the last default rule always wins.
			default_font_family = incoming.font_family.clone();
			default_font_size = incoming.font_size;
			default_line_height = incoming.line_height;
			start += 1;
		}
		let mut color_map = ColorMap::new(color_map);
		let defaults = StyleAttributes {
			font_style: default_font_style,
			foreground_id: color_map.get_id(Some(&default_foreground)),
			background_id: color_map.get_id(Some(&default_background)),
			font_family: default_font_family.clone(),
			font_size: default_font_size,
			line_height: default_line_height,
		};
		let mut root = ThemeTrieElement {
			main_rule: ThemeTrieElementRule {
				scope_depth: 0,
				parent_scopes: Vec::new(),
				font_style: -1,
				foreground: 0,
				background: 0,
				font_family: default_font_family,
				font_size: default_font_size,
				line_height: default_line_height,
			},
			rules_with_parent_scopes: Vec::new(),
			children: FxHashMap::default(),
		};
		for rule in &rules[start..] {
			let fg = color_map.get_id(rule.foreground.as_deref());
			let bg = color_map.get_id(rule.background.as_deref());
			root.insert(
				0,
				&rule.scope,
				rule.parent_scopes.as_deref(),
				rule.font_style,
				fg,
				bg,
				rule.font_family.clone(),
				rule.font_size,
				rule.line_height,
			);
		}
		Theme {
			color_map,
			defaults,
			root,
			cached_match_root: RefCell::new(FxHashMap::default()),
		}
	}

	pub fn get_color_map(&self) -> Vec<String> {
		self.color_map.get_color_map()
	}

	pub fn get_defaults(&self) -> &StyleAttributes {
		&self.defaults
	}

	pub fn match_path(&self, scope_path: Option<&ScopeStack>) -> Option<StyleAttributes> {
		let Some(scope_path) = scope_path else {
			return Some(self.defaults.clone());
		};
		let rules = {
			let cached = self
				.cached_match_root
				.borrow()
				.get(&*scope_path.scope_name)
				.cloned();
			match cached {
				Some(r) => r,
				None => {
					let r: Rc<[ThemeTrieElementRule]> =
						self.root.match_scope(&scope_path.scope_name).into();
					self.cached_match_root
						.borrow_mut()
						.insert(scope_path.scope_name.clone(), r.clone());
					r
				}
			}
		};
		let effective = rules.iter().find(|v| {
			scope_path_matches_parent_scopes(scope_path.parent.as_deref(), &v.parent_scopes)
		})?;
		Some(StyleAttributes {
			font_style: effective.font_style,
			foreground_id: effective.foreground,
			background_id: effective.background,
			font_family: effective.font_family.clone(),
			font_size: effective.font_size,
			line_height: effective.line_height,
		})
	}
}

fn scope_path_matches_parent_scopes(
	mut scope_path: Option<&ScopeStack>,
	parent_scopes: &[String],
) -> bool {
	if parent_scopes.is_empty() {
		return true;
	}
	let mut index = 0;
	while index < parent_scopes.len() {
		let mut scope_pattern = parent_scopes[index].as_str();
		let mut scope_must_match = false;
		if scope_pattern == ">" {
			if index == parent_scopes.len() - 1 {
				return false;
			}
			index += 1;
			scope_pattern = &parent_scopes[index];
			scope_must_match = true;
		}
		while let Some(p) = scope_path {
			if matches_scope(&p.scope_name, scope_pattern) {
				break;
			}
			if scope_must_match {
				return false;
			}
			scope_path = p.parent.as_deref();
		}
		let Some(p) = scope_path else { return false };
		scope_path = p.parent.as_deref();
		index += 1;
	}
	true
}

fn matches_scope(scope_name: &str, scope_pattern: &str) -> bool {
	scope_pattern == scope_name
		|| (scope_name.starts_with(scope_pattern)
			&& scope_name.as_bytes().get(scope_pattern.len()) == Some(&b'.'))
}
