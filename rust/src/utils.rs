/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! utils.ts, encodedTokenAttributes.ts, matcher.ts and grammar/basicScopesAttributeProvider.ts.
use crate::onig_lib::{CaptureIndex, OnigString};
use crate::theme::StyleAttributes;
use rustc_hash::FxHashMap;
use std::cell::RefCell;
use std::cmp::Ordering;
use std::rc::Rc;

// ---------------------------------------------------------------- encodedTokenAttributes.ts

pub type EncodedTokenAttributes = u32;

/// StandardTokenType, plus OptionalStandardTokenType.NotSet.
pub mod standard_token_type {
	pub const OTHER: u32 = 0;
	pub const COMMENT: u32 = 1;
	pub const STRING: u32 = 2;
	pub const REG_EX: u32 = 3;
	pub const NOT_SET: u32 = 8;
}

pub fn get_language_id(m: u32) -> u32 {
	m & 0xFF
}
pub fn get_token_type(m: u32) -> u32 {
	(m & 0x300) >> 8
}
pub fn contains_balanced_brackets(m: u32) -> bool {
	m & 0x400 != 0
}
pub fn get_font_style(m: u32) -> u32 {
	(m & 0x7800) >> 11
}
pub fn get_foreground(m: u32) -> u32 {
	(m & 0xFF8000) >> 15
}
pub fn get_background(m: u32) -> u32 {
	m >> 24
}

/// EncodedTokenAttributes.set: every argument left at its "not set" value (0, NotSet, None, -1, 0, 0) keeps the old value.
pub fn set(
	m: u32,
	language_id: u32,
	token_type: u32,
	balanced: Option<bool>,
	font_style: i32,
	foreground: u32,
	background: u32,
) -> u32 {
	let mut l = get_language_id(m);
	let mut t = get_token_type(m);
	let mut b = contains_balanced_brackets(m) as u32;
	let mut fs = get_font_style(m);
	let mut fg = get_foreground(m);
	let mut bg = get_background(m);
	if language_id != 0 {
		l = language_id;
	}
	if token_type != standard_token_type::NOT_SET {
		t = token_type;
	}
	if let Some(x) = balanced {
		b = x as u32;
	}
	if font_style != -1 {
		fs = font_style as u32;
	}
	if foreground != 0 {
		fg = foreground;
	}
	if background != 0 {
		bg = background;
	}
	l | (t << 8) | (b << 10) | (fs << 11) | (fg << 15) | (bg << 24)
}

/// encodedTokenAttributes.ts `FontAttribute`. Not interned: nothing compares font attributes by identity.
#[derive(Clone, Debug, PartialEq)]
pub struct FontAttribute {
	pub font_family: Rc<str>,
	pub font_size: f64,
	pub line_height: f64,
}

impl FontAttribute {
	/// `FontAttribute.with(styleAttributes)`: each of the style's values that is set (JS-truthy) replaces this one's.
	pub fn with(self: &Rc<Self>, style: Option<&StyleAttributes>) -> Rc<FontAttribute> {
		let Some(style) = style else {
			return self.clone();
		};
		let family_set = !style.font_family.is_empty();
		let size_set = js_truthy(style.font_size);
		let height_set = js_truthy(style.line_height);
		if !family_set && !size_set && !height_set {
			return self.clone();
		}
		Rc::new(FontAttribute {
			font_family: if family_set {
				style.font_family.clone()
			} else {
				self.font_family.clone()
			},
			font_size: if size_set {
				style.font_size
			} else {
				self.font_size
			},
			line_height: if height_set {
				style.line_height
			} else {
				self.line_height
			},
		})
	}
}

/// Whether a JS number is truthy: not 0 and not NaN.
pub fn js_truthy(n: f64) -> bool {
	n != 0.0 && !n.is_nan()
}

// ---------------------------------------------------------------- matcher.ts (with grammar.ts nameMatcher)

pub enum Matcher {
	Name(Vec<String>),
	And(Vec<Matcher>),
	Or(Vec<Matcher>),
	Not(Option<Box<Matcher>>),
}

pub struct MatcherWithPriority {
	pub matcher: Matcher,
	pub priority: i32,
}

impl Matcher {
	pub fn matches<S: AsRef<str>>(&self, scopes: &[S]) -> bool {
		match self {
			Matcher::Name(ids) => name_matcher(ids, scopes),
			Matcher::And(v) => v.iter().all(|m| m.matches(scopes)),
			Matcher::Or(v) => v.iter().any(|m| m.matches(scopes)),
			Matcher::Not(e) => e.as_ref().is_some_and(|e| !e.matches(scopes)),
		}
	}
}

/// grammar.ts `nameMatcher`.
fn name_matcher<S: AsRef<str>>(identifiers: &[String], scopes: &[S]) -> bool {
	if scopes.len() < identifiers.len() {
		return false;
	}
	let mut last_index = 0;
	identifiers.iter().all(|identifier| {
		match scopes[last_index..]
			.iter()
			.position(|scope| scopes_are_matching(scope.as_ref(), identifier))
		{
			Some(offset) => {
				last_index += offset + 1;
				true
			}
			None => false,
		}
	})
}

fn scopes_are_matching(this_scope_name: &str, scope_name: &str) -> bool {
	if this_scope_name.is_empty() {
		return false;
	}
	if this_scope_name == scope_name {
		return true;
	}
	let len = scope_name.len();
	this_scope_name.len() > len
		&& this_scope_name.starts_with(scope_name)
		&& this_scope_name.as_bytes()[len] == b'.'
}

fn is_ident_char(c: u8) -> bool {
	c.is_ascii_alphanumeric() || c == b'_' || c == b'.' || c == b':'
}

/// `/([LR]:|[\w\.:][\w\.:\-]*|[\,\|\-\(\)])/g`.
struct Tokenizer<'a> {
	s: &'a str,
	pos: usize,
}

impl<'a> Tokenizer<'a> {
	fn next(&mut self) -> Option<&'a str> {
		let b = self.s.as_bytes();
		while self.pos < b.len() {
			let i = self.pos;
			let c = b[i];
			if (c == b'L' || c == b'R') && i + 1 < b.len() && b[i + 1] == b':' {
				self.pos = i + 2;
				return Some(&self.s[i..i + 2]);
			}
			if is_ident_char(c) {
				let mut j = i + 1;
				while j < b.len() && (is_ident_char(b[j]) || b[j] == b'-') {
					j += 1;
				}
				self.pos = j;
				return Some(&self.s[i..j]);
			}
			if matches!(c, b',' | b'|' | b'-' | b'(' | b')') {
				self.pos = i + 1;
				return Some(&self.s[i..i + 1]);
			}
			self.pos += 1;
		}
		None
	}
}

fn is_identifier(token: Option<&str>) -> bool {
	token.is_some_and(|t| t.bytes().any(is_ident_char))
}

struct Parser<'a> {
	tokenizer: Tokenizer<'a>,
	token: Option<&'a str>,
}

impl<'a> Parser<'a> {
	fn advance(&mut self) {
		self.token = self.tokenizer.next();
	}
	fn parse_operand(&mut self) -> Option<Matcher> {
		if self.token == Some("-") {
			self.advance();
			let expression_to_negate = self.parse_operand();
			return Some(Matcher::Not(expression_to_negate.map(Box::new)));
		}
		if self.token == Some("(") {
			self.advance();
			let expression_in_parents = self.parse_inner_expression();
			if self.token == Some(")") {
				self.advance();
			}
			return Some(expression_in_parents);
		}
		if is_identifier(self.token) {
			let mut identifiers = Vec::new();
			loop {
				identifiers.push(self.token.unwrap().to_string());
				self.advance();
				if !is_identifier(self.token) {
					break;
				}
			}
			return Some(Matcher::Name(identifiers));
		}
		None
	}
	fn parse_conjunction(&mut self) -> Matcher {
		let mut matchers = Vec::new();
		while let Some(m) = self.parse_operand() {
			matchers.push(m);
		}
		Matcher::And(matchers)
	}
	fn parse_inner_expression(&mut self) -> Matcher {
		let mut matchers = Vec::new();
		let mut matcher = self.parse_conjunction();
		loop {
			matchers.push(matcher);
			if self.token == Some("|") || self.token == Some(",") {
				loop {
					self.advance();
					if !(self.token == Some("|") || self.token == Some(",")) {
						break;
					}
				}
			} else {
				break;
			}
			matcher = self.parse_conjunction();
		}
		Matcher::Or(matchers)
	}
}

/// matcher.ts `createMatchers`.
pub fn create_matchers(selector: &str) -> Vec<MatcherWithPriority> {
	let mut results = Vec::new();
	let mut p = Parser {
		tokenizer: Tokenizer {
			s: selector,
			pos: 0,
		},
		token: None,
	};
	p.advance();
	while let Some(token) = p.token {
		let mut priority = 0;
		if token.len() == 2 && token.as_bytes()[1] == b':' {
			priority = match token.as_bytes()[0] {
				b'R' => 1,
				b'L' => -1,
				_ => 0,
			};
			p.advance();
		}
		let matcher = p.parse_conjunction();
		results.push(MatcherWithPriority { matcher, priority });
		if p.token != Some(",") {
			break;
		}
		p.advance();
	}
	results
}

// ---------------------------------------------------------------- grammar/basicScopesAttributeProvider.ts

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BasicScopeAttributes {
	pub language_id: u32,
	pub token_type: u32,
}

pub struct BasicScopeAttributesProvider {
	default_attributes: BasicScopeAttributes,
	embedded_languages: Vec<(String, u32)>,
	cache: RefCell<FxHashMap<String, BasicScopeAttributes>>,
}

impl BasicScopeAttributesProvider {
	pub fn new(initial_language_id: u32, embedded_languages: &[(String, u32)]) -> Self {
		BasicScopeAttributesProvider {
			default_attributes: BasicScopeAttributes {
				language_id: initial_language_id,
				token_type: standard_token_type::NOT_SET,
			},
			embedded_languages: embedded_languages.to_vec(),
			cache: RefCell::new(FxHashMap::default()),
		}
	}
	pub fn get_default_attributes(&self) -> BasicScopeAttributes {
		self.default_attributes
	}
	pub fn get_basic_scope_attributes(&self, scope_name: Option<&str>) -> BasicScopeAttributes {
		let Some(scope_name) = scope_name else {
			return BasicScopeAttributes {
				language_id: 0,
				token_type: 0,
			};
		};
		if let Some(a) = self.cache.borrow().get(scope_name) {
			return *a;
		}
		let a = BasicScopeAttributes {
			language_id: self.scope_to_language(scope_name),
			token_type: to_standard_token_type(scope_name),
		};
		self.cache.borrow_mut().insert(scope_name.to_string(), a);
		a
	}
	/// ScopeMatcher: the TS regex `^((k1)|(k2)...)($|\.)` over the keys sorted and reversed tries the longest matching key first.
	fn scope_to_language(&self, scope: &str) -> u32 {
		let mut best: Option<(usize, u32)> = None;
		for (k, v) in &self.embedded_languages {
			let hit = scope == k
				|| (scope.len() > k.len()
					&& scope.starts_with(k.as_str())
					&& scope.as_bytes()[k.len()] == b'.');
			if hit && best.is_none_or(|(l, _)| k.len() > l) {
				best = Some((k.len(), *v));
			}
		}
		best.map_or(0, |b| b.1)
	}
}

/// `/\b(comment|string|regex|meta\.embedded)\b/`.
fn to_standard_token_type(scope_name: &str) -> u32 {
	let b = scope_name.as_bytes();
	let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
	for i in 0..b.len() {
		let before = i > 0 && is_word(b[i - 1]);
		if before == is_word(b[i]) {
			continue;
		}
		for (w, t) in [
			("comment", 1),
			("string", 2),
			("regex", 3),
			("meta.embedded", 0),
		] {
			if b[i..].starts_with(w.as_bytes()) {
				let j = i + w.len();
				if !(j < b.len() && is_word(b[j])) {
					return t;
				}
			}
		}
	}
	standard_token_type::NOT_SET
}

// ---------------------------------------------------------------- utils.ts

/// Matches `\$(\d+)|\${(\d+):\/(downcase|upcase)}` at byte `i`: (end, capture index (None when it overflows), command 0/1 down/2 up).
fn match_capture_reference(b: &[u8], i: usize) -> Option<(usize, Option<usize>, u8)> {
	if b.get(i) != Some(&b'$') {
		return None;
	}
	let digits = |from: usize| {
		let mut j = from;
		while j < b.len() && b[j].is_ascii_digit() {
			j += 1;
		}
		j
	};
	let parse = |from: usize, to: usize| {
		std::str::from_utf8(&b[from..to])
			.ok()
			.and_then(|s| s.parse::<usize>().ok())
	};
	let j = digits(i + 1);
	if j > i + 1 {
		return Some((j, parse(i + 1, j), 0));
	}
	if b.get(i + 1) == Some(&b'{') {
		let j = digits(i + 2);
		if j > i + 2 && b[j..].starts_with(b":/") {
			for (w, cmd) in [("downcase", 1u8), ("upcase", 2u8)] {
				let k = j + 2;
				if b[k..].starts_with(w.as_bytes()) && b.get(k + w.len()) == Some(&b'}') {
					return Some((k + w.len() + 1, parse(i + 2, j), cmd));
				}
			}
		}
	}
	None
}

/// RegexSource.hasCaptures.
pub fn has_captures(regex_source: Option<&str>) -> bool {
	let Some(s) = regex_source else { return false };
	let b = s.as_bytes();
	(0..b.len()).any(|i| match_capture_reference(b, i).is_some())
}

/// RegexSource.replaceCaptures.
pub fn replace_captures(
	regex_source: &str,
	capture_source: &OnigString,
	capture_indices: &[CaptureIndex],
) -> String {
	let b = regex_source.as_bytes();
	let mut out = String::with_capacity(regex_source.len());
	let (mut last, mut i) = (0, 0);
	while i < b.len() {
		if let Some((end, index, command)) = match_capture_reference(b, i) {
			out.push_str(&regex_source[last..i]);
			match index.and_then(|k| capture_indices.get(k)) {
				Some(capture) => {
					let result = capture_source
						.slice16(capture.start, capture.end)
						.trim_start_matches('.');
					match command {
						1 => out.push_str(&result.to_lowercase()),
						2 => out.push_str(&result.to_uppercase()),
						_ => out.push_str(result),
					}
				}
				None => out.push_str(&regex_source[i..end]),
			}
			last = end;
			i = end;
			continue;
		}
		i += 1;
	}
	out.push_str(&regex_source[last..]);
	out
}

/// JavaScript string comparison (UTF-16 code units).
pub fn strcmp(a: &str, b: &str) -> Ordering {
	if a.is_ascii() && b.is_ascii() {
		return a.cmp(b);
	}
	a.encode_utf16().cmp(b.encode_utf16())
}

pub fn str_arr_cmp(a: Option<&[String]>, b: Option<&[String]>) -> i64 {
	match (a, b) {
		(None, None) => 0,
		(None, _) => -1,
		(_, None) => 1,
		(Some(a), Some(b)) => {
			if a.len() == b.len() {
				for (x, y) in a.iter().zip(b) {
					match strcmp(x, y) {
						Ordering::Less => return -1,
						Ordering::Greater => return 1,
						Ordering::Equal => {}
					}
				}
				0
			} else {
				a.len() as i64 - b.len() as i64
			}
		}
	}
}

pub fn is_valid_hex_color(hex: &str) -> bool {
	let b = hex.as_bytes();
	matches!(b.len(), 4 | 5 | 7 | 9) && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// `value.replace(/[\\|([{}\]).?*+^$]/g, '\\$&')`.
pub fn escape_regexp_characters(value: &str) -> String {
	let mut out = String::with_capacity(value.len() + 8);
	for c in value.chars() {
		if matches!(
			c,
			'\\' | '|' | '(' | '[' | '{' | '}' | ']' | ')' | '.' | '?' | '*' | '+' | '^' | '$'
		) {
			out.push('\\');
		}
		out.push(c);
	}
	out
}

/// vscode's strings.containsRTL, as copied into vscode-textmate.
pub fn contains_rtl(s: &str) -> bool {
	if s.is_ascii() {
		return false;
	}
	const RANGES: &[(u32, u32)] = &[
		(0x05BE, 0x05BE),
		(0x05C0, 0x05C0),
		(0x05C3, 0x05C3),
		(0x05C6, 0x05C6),
		(0x05D0, 0x05F4),
		(0x0608, 0x0608),
		(0x060B, 0x060B),
		(0x060D, 0x060D),
		(0x061B, 0x064A),
		(0x066D, 0x066F),
		(0x0671, 0x06D5),
		(0x06E5, 0x06E6),
		(0x06EE, 0x06EF),
		(0x06FA, 0x0710),
		(0x0712, 0x072F),
		(0x074D, 0x07A5),
		(0x07B1, 0x07EA),
		(0x07F4, 0x07F5),
		(0x07FA, 0x07FA),
		(0x07FE, 0x0815),
		(0x081A, 0x081A),
		(0x0824, 0x0824),
		(0x0828, 0x0828),
		(0x0830, 0x0858),
		(0x085E, 0x088E),
		(0x08A0, 0x08C9),
		(0x200F, 0x200F),
		(0xFB1D, 0xFB1D),
		(0xFB1F, 0xFB28),
		(0xFB2A, 0xFD3D),
		(0xFD50, 0xFDC7),
		(0xFDF0, 0xFDFC),
		(0xFE70, 0xFEFC),
		(0x10800, 0x1091B),
		(0x10920, 0x10A00),
		(0x10A10, 0x10A35),
		(0x10A40, 0x10AE4),
		(0x10AEB, 0x10B35),
		(0x10B40, 0x10BFF),
		(0x10C00, 0x10D23),
		(0x10E80, 0x10EA9),
		(0x10EAD, 0x10F45),
		(0x10F51, 0x10F81),
		(0x10F86, 0x10FF6),
		(0x1E800, 0x1E8CF),
		(0x1E900, 0x1E943),
		(0x1E94B, 0x1EBFF),
		(0x1EC00, 0x1EEBB),
	];
	s.chars().any(|c| {
		let c = c as u32;
		RANGES.iter().any(|&(lo, hi)| lo <= c && c <= hi)
	})
}

/// `parseInt(s, 10)`: leading digits (after optional whitespace and sign), else NaN (None).
pub fn parse_int(s: &str) -> Option<i64> {
	let t = s.trim_start();
	let (neg, t) = match t.as_bytes().first() {
		Some(b'-') => (true, &t[1..]),
		Some(b'+') => (false, &t[1..]),
		_ => (false, t),
	};
	let n = t.bytes().take_while(|c| c.is_ascii_digit()).count();
	if n == 0 {
		return None;
	}
	let v: i64 = t[..n].parse().unwrap_or(i64::MAX);
	Some(if neg { -v } else { v })
}
