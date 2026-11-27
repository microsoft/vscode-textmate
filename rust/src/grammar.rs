/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! A direct port of vscode-textmate's grammar/grammar.ts (`Grammar`, `AttributedScopeStack`,
//! `StateStackImpl`, `BalancedBracketSelectors`, `LineTokens`), grammar/tokenizeString.ts,
//! grammar/grammarDependencies.ts, registry.ts (`SyncRegistry`) and main.ts (`Registry`).
//!
//! The loading in main.ts is asynchronous; here the grammar loader is a synchronous callback, called in the same
//! order. Not ported: `dispose` (`Drop` covers it) and the debug logging.
use crate::json::Json;
use crate::onig_lib::{CaptureIndex, OnigLib, OnigString};
use crate::raw::{
	IncludeReference, RawRepository, RawRule, init_grammar, merge_objects, parse_include,
};
use crate::rule::{
	END_RULE_ID, Rule, RuleFactoryHelper, RuleKind, WHILE_RULE_ID, get_compiled_rule_id,
};
use crate::theme::{ScopeStack, StyleAttributes, Theme};
use crate::utils::{
	BasicScopeAttributes, BasicScopeAttributesProvider, FontAttribute, Matcher, contains_rtl,
	create_matchers, js_truthy, set,
};
use rustc_hash::{FxHashMap, FxHashSet};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Instant;

// ---------------------------------------------------------------- grammar.ts: AttributedScopeStack

/// grammar.ts `AttributedScopeStack`, without `styleAttributes`, which nothing reads.
pub struct AttributedScopeStack {
	pub parent: Option<Rc<AttributedScopeStack>>,
	pub scope_path: Rc<ScopeStack>,
	pub token_attributes: u32,
	/// `None` on elements rebuilt by `from_extension`, as upstream.
	pub font_attributes: Option<Rc<FontAttribute>>,
}

impl AttributedScopeStack {
	fn create_root(
		scope_name: Rc<str>,
		token_attributes: u32,
		font_attributes: Rc<FontAttribute>,
	) -> Rc<AttributedScopeStack> {
		Rc::new(AttributedScopeStack {
			parent: None,
			scope_path: Rc::new(ScopeStack {
				parent: None,
				scope_name,
			}),
			token_attributes,
			font_attributes: Some(font_attributes),
		})
	}

	fn create_root_and_look_up_scope_name(
		scope_name: Rc<str>,
		token_attributes: u32,
		font_attributes: Rc<FontAttribute>,
		basic: &BasicScopeAttributesProvider,
		theme: &Theme,
	) -> Rc<AttributedScopeStack> {
		let raw_root_metadata = basic.get_basic_scope_attributes(Some(&*scope_name));
		let scope_path = Rc::new(ScopeStack {
			parent: None,
			scope_name,
		});
		let root_style = theme.match_path(Some(&*scope_path));
		let resolved_token_attributes =
			merge_attributes(token_attributes, raw_root_metadata, root_style.as_ref());
		let resolved_font_attributes = font_attributes.with(root_style.as_ref());
		Rc::new(AttributedScopeStack {
			parent: None,
			scope_path,
			token_attributes: resolved_token_attributes,
			font_attributes: Some(resolved_font_attributes),
		})
	}

	pub fn scope_name(&self) -> &str {
		&self.scope_path.scope_name
	}

	pub fn get_scope_names(&self) -> Vec<Rc<str>> {
		self.scope_path.get_segments()
	}

	pub fn equals(
		mut a: Option<&AttributedScopeStack>,
		mut b: Option<&AttributedScopeStack>,
	) -> bool {
		loop {
			match (a, b) {
				(None, None) => return true,
				(Some(x), Some(y)) => {
					if std::ptr::eq(x, y) {
						return true;
					}
					if x.scope_name() != y.scope_name() || x.token_attributes != y.token_attributes
					{
						return false;
					}
					a = x.parent.as_deref();
					b = y.parent.as_deref();
				}
				_ => return false,
			}
		}
	}

	pub fn push_attributed(
		self: &Rc<Self>,
		scope_path: Option<Rc<str>>,
		basic: &BasicScopeAttributesProvider,
		theme: &Theme,
	) -> Rc<AttributedScopeStack> {
		let Some(scope_path) = scope_path else {
			return self.clone();
		};
		if !scope_path.contains(' ') {
			// This is the common case and much faster
			return Self::push_one(self, scope_path, basic, theme);
		}
		let mut result = self.clone();
		for scope in scope_path.split(' ') {
			result = Self::push_one(&result, Rc::from(scope), basic, theme);
		}
		result
	}

	fn push_one(
		target: &Rc<AttributedScopeStack>,
		scope_name: Rc<str>,
		basic: &BasicScopeAttributesProvider,
		theme: &Theme,
	) -> Rc<AttributedScopeStack> {
		let raw_metadata = basic.get_basic_scope_attributes(Some(&*scope_name));
		let new_path = target.scope_path.push(scope_name);
		let scope_theme_match_result = theme.match_path(Some(&*new_path));
		let metadata = merge_attributes(
			target.token_attributes,
			raw_metadata,
			scope_theme_match_result.as_ref(),
		);
		let font_attributes = target
			.font_attributes
			.as_ref()
			.map(|f| f.with(scope_theme_match_result.as_ref()));
		Rc::new(AttributedScopeStack {
			parent: Some(target.clone()),
			scope_path: new_path,
			token_attributes: metadata,
			font_attributes,
		})
	}

	/// `AttributedScopeStack.fromExtension(namesScopeList, contentNameScopesList)`: `base` with the frames pushed.
	pub fn from_extension(
		base: Option<Rc<AttributedScopeStack>>,
		frames: &[AttributedScopeStackFrame],
	) -> Option<Rc<AttributedScopeStack>> {
		let mut current = base;
		let mut scope_path = current.as_ref().map(|c| c.scope_path.clone());
		for frame in frames {
			scope_path = ScopeStack::push_all(scope_path, &frame.scope_names);
			let scope_path = scope_path
				.clone()
				.expect("the first frame on an empty stack has a scope name");
			current = Some(Rc::new(AttributedScopeStack {
				parent: current,
				scope_path,
				token_attributes: frame.encoded_token_attributes,
				font_attributes: None,
			}));
		}
		current
	}

	/// `AttributedScopeStack.getExtensionIfDefined(base)`: the frames after `base` up to this element, outermost first,
	/// or `None` when `base` isn't on this stack.
	pub fn get_extension_if_defined(
		&self,
		base: Option<&AttributedScopeStack>,
	) -> Option<Vec<AttributedScopeStackFrame>> {
		let mut result = Vec::new();
		let mut item = Some(self);
		while let Some(i) = item {
			if base.is_some_and(|base| std::ptr::eq(i, base)) {
				break;
			}
			let parent_scope_path = i.parent.as_ref().map(|p| &*p.scope_path);
			result.push(AttributedScopeStackFrame {
				encoded_token_attributes: i.token_attributes,
				scope_names: i
					.scope_path
					.get_extension_if_defined(parent_scope_path)
					.expect("the parent's scope path is on this scope path"),
			});
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

/// grammar.ts `AttributedScopeStackFrame`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttributedScopeStackFrame {
	pub encoded_token_attributes: u32,
	pub scope_names: Vec<Rc<str>>,
}

/// `AttributedScopeStack.mergeAttributes`.
fn merge_attributes(
	existing_token_attributes: u32,
	basic_scope_attributes: BasicScopeAttributes,
	style_attributes: Option<&StyleAttributes>,
) -> u32 {
	let (font_style, foreground, background) = match style_attributes {
		Some(style) => (style.font_style, style.foreground_id, style.background_id),
		None => (-1, 0, 0),
	};
	set(
		existing_token_attributes,
		basic_scope_attributes.language_id,
		basic_scope_attributes.token_type,
		None,
		font_style,
		foreground,
		background,
	)
}

// ---------------------------------------------------------------- grammar.ts: StateStackImpl

/// grammar.ts `StateStackImpl`. `None` stands for `INITIAL`.
pub struct StateStack {
	pub parent: Option<Rc<StateStack>>,
	/// The rule of this stack element.
	pub rule_id: i32,
	/// The position on the current line where this state was pushed; -1 once the line is done.
	enter_pos: Cell<i64>,
	/// The anchor position (`\G`) on the current line where this state was pushed; -1 once the line is done.
	anchor_pos: Cell<i64>,
	/// Whether the begin rule's match reached the end of the line.
	pub begin_rule_captured_eol: bool,
	/// The end (or while) pattern, with its back references resolved, when it had any.
	pub end_rule: Option<Rc<str>>,
	/// The scopes of the rule's name.
	pub name_scopes_list: Rc<AttributedScopeStack>,
	/// The scopes of the rule's name and content name.
	pub content_name_scopes_list: Rc<AttributedScopeStack>,
	pub depth: u32,
}

impl StateStack {
	#[allow(clippy::too_many_arguments)]
	fn new(
		parent: Option<Rc<StateStack>>,
		rule_id: i32,
		enter_pos: i64,
		anchor_pos: i64,
		begin_rule_captured_eol: bool,
		end_rule: Option<Rc<str>>,
		name_scopes_list: Rc<AttributedScopeStack>,
		content_name_scopes_list: Rc<AttributedScopeStack>,
	) -> StateStack {
		let depth = parent.as_ref().map_or(1, |p| p.depth + 1);
		StateStack {
			parent,
			rule_id,
			enter_pos: Cell::new(enter_pos),
			anchor_pos: Cell::new(anchor_pos),
			begin_rule_captured_eol,
			end_rule,
			name_scopes_list,
			content_name_scopes_list,
			depth,
		}
	}

	pub fn equals(self: &Rc<Self>, other: &Rc<StateStack>) -> bool {
		if Rc::ptr_eq(self, other) {
			return true;
		}
		if !Self::structural_equals(Some(&**self), Some(&**other)) {
			return false;
		}
		AttributedScopeStack::equals(
			Some(&*self.content_name_scopes_list),
			Some(&*other.content_name_scopes_list),
		)
	}

	fn structural_equals(mut a: Option<&StateStack>, mut b: Option<&StateStack>) -> bool {
		loop {
			match (a, b) {
				(None, None) => return true,
				(Some(x), Some(y)) => {
					if std::ptr::eq(x, y) {
						return true;
					}
					if x.depth != y.depth || x.rule_id != y.rule_id || x.end_rule != y.end_rule {
						return false;
					}
					a = x.parent.as_deref();
					b = y.parent.as_deref();
				}
				_ => return false,
			}
		}
	}

	fn reset(&self) {
		let mut el = Some(self);
		while let Some(e) = el {
			e.enter_pos.set(-1);
			e.anchor_pos.set(-1);
			el = e.parent.as_deref();
		}
	}

	pub fn pop(&self) -> Option<Rc<StateStack>> {
		self.parent.clone()
	}

	pub fn safe_pop(self: &Rc<Self>) -> Rc<StateStack> {
		match &self.parent {
			Some(parent) => parent.clone(),
			None => self.clone(),
		}
	}

	#[allow(clippy::too_many_arguments)]
	fn push(
		self: &Rc<Self>,
		rule_id: i32,
		enter_pos: i64,
		anchor_pos: i64,
		begin_rule_captured_eol: bool,
		end_rule: Option<Rc<str>>,
		name_scopes_list: Rc<AttributedScopeStack>,
		content_name_scopes_list: Rc<AttributedScopeStack>,
	) -> Rc<StateStack> {
		Rc::new(StateStack::new(
			Some(self.clone()),
			rule_id,
			enter_pos,
			anchor_pos,
			begin_rule_captured_eol,
			end_rule,
			name_scopes_list,
			content_name_scopes_list,
		))
	}

	pub fn get_enter_pos(&self) -> i64 {
		self.enter_pos.get()
	}

	pub fn get_anchor_pos(&self) -> i64 {
		self.anchor_pos.get()
	}

	fn with_content_name_scopes_list(
		self: &Rc<Self>,
		content_name_scope_stack: &Rc<AttributedScopeStack>,
	) -> Rc<StateStack> {
		if Rc::ptr_eq(&self.content_name_scopes_list, content_name_scope_stack) {
			return self.clone();
		}
		// `this.parent!.push(...)`
		Rc::new(StateStack::new(
			self.parent.clone(),
			self.rule_id,
			self.enter_pos.get(),
			self.anchor_pos.get(),
			self.begin_rule_captured_eol,
			self.end_rule.clone(),
			self.name_scopes_list.clone(),
			content_name_scope_stack.clone(),
		))
	}

	fn with_end_rule(self: &Rc<Self>, end_rule: Rc<str>) -> Rc<StateStack> {
		if self.end_rule.as_deref() == Some(&*end_rule) {
			return self.clone();
		}
		Rc::new(StateStack::new(
			self.parent.clone(),
			self.rule_id,
			self.enter_pos.get(),
			self.anchor_pos.get(),
			self.begin_rule_captured_eol,
			Some(end_rule),
			self.name_scopes_list.clone(),
			self.content_name_scopes_list.clone(),
		))
	}

	/// Used to warn of endless loops.
	fn has_same_rule_as(&self, other: &StateStack) -> bool {
		let mut el = Some(self);
		while let Some(e) = el {
			if e.enter_pos.get() != other.enter_pos.get() {
				break;
			}
			if e.rule_id == other.rule_id {
				return true;
			}
			el = e.parent.as_deref();
		}
		false
	}

	/// `StateStackImpl.toStateStackFrame()`: this element without its parent.
	pub fn to_state_stack_frame(&self) -> StateStackFrame {
		let parent_name_scopes_list = self.parent.as_ref().map(|p| &*p.name_scopes_list);
		StateStackFrame {
			rule_id: self.rule_id,
			enter_pos: None,
			anchor_pos: None,
			begin_rule_captured_eol: self.begin_rule_captured_eol,
			end_rule: self.end_rule.clone(),
			name_scopes_list: self
				.name_scopes_list
				.get_extension_if_defined(parent_name_scopes_list)
				.unwrap_or_default(),
			content_name_scopes_list: self
				.content_name_scopes_list
				.get_extension_if_defined(Some(&*self.name_scopes_list))
				.unwrap_or_default(),
		}
	}

	/// `StateStackImpl.pushFrame(self, frame)`, where `None` stands for `INITIAL`.
	pub fn push_frame(this: Option<&Rc<StateStack>>, frame: &StateStackFrame) -> Rc<StateStack> {
		let name_scopes_list = AttributedScopeStack::from_extension(
			this.map(|s| s.name_scopes_list.clone()),
			&frame.name_scopes_list,
		)
		.expect("a frame pushed on INITIAL has the root scope");
		let content_name_scopes_list = AttributedScopeStack::from_extension(
			Some(name_scopes_list.clone()),
			&frame.content_name_scopes_list,
		)
		.expect("built on a stack");
		Rc::new(StateStack::new(
			this.cloned(),
			frame.rule_id,
			frame.enter_pos.unwrap_or(-1),
			frame.anchor_pos.unwrap_or(-1),
			frame.begin_rule_captured_eol,
			frame.end_rule.clone(),
			name_scopes_list,
			content_name_scopes_list,
		))
	}
}

/// grammar.ts `StateStackFrame`: one element of a `StateStack`, without its parent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateStackFrame {
	pub rule_id: i32,
	pub enter_pos: Option<i64>,
	pub anchor_pos: Option<i64>,
	pub begin_rule_captured_eol: bool,
	pub end_rule: Option<Rc<str>>,
	/// The name scopes after the parent's name scopes.
	pub name_scopes_list: Vec<AttributedScopeStackFrame>,
	/// The content name scopes after this element's name scopes.
	pub content_name_scopes_list: Vec<AttributedScopeStackFrame>,
}

// ---------------------------------------------------------------- grammar.ts: BalancedBracketSelectors

pub struct BalancedBracketSelectors {
	balanced_bracket_scopes: Vec<Matcher>,
	unbalanced_bracket_scopes: Vec<Matcher>,
	allow_any: bool,
}

impl BalancedBracketSelectors {
	pub fn new(
		balanced_bracket_scopes: &[String],
		unbalanced_bracket_scopes: &[String],
	) -> BalancedBracketSelectors {
		let mut allow_any = false;
		let mut balanced = Vec::new();
		for selector in balanced_bracket_scopes {
			if selector == "*" {
				allow_any = true;
			} else {
				balanced.extend(create_matchers(selector).into_iter().map(|m| m.matcher));
			}
		}
		let mut unbalanced = Vec::new();
		for selector in unbalanced_bracket_scopes {
			unbalanced.extend(create_matchers(selector).into_iter().map(|m| m.matcher));
		}
		BalancedBracketSelectors {
			balanced_bracket_scopes: balanced,
			unbalanced_bracket_scopes: unbalanced,
			allow_any,
		}
	}

	fn matches_always(&self) -> bool {
		self.allow_any && self.unbalanced_bracket_scopes.is_empty()
	}

	fn matches_never(&self) -> bool {
		self.balanced_bracket_scopes.is_empty() && !self.allow_any
	}

	fn matches(&self, scopes: &[Rc<str>]) -> bool {
		for excluder in &self.unbalanced_bracket_scopes {
			if excluder.matches(scopes) {
				return false;
			}
		}
		for includer in &self.balanced_bracket_scopes {
			if includer.matches(scopes) {
				return true;
			}
		}
		self.allow_any
	}
}

// ---------------------------------------------------------------- grammar.ts: LineTokens

/// One token of `tokenizeLine`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
	pub start_index: usize,
	pub end_index: usize,
	pub scopes: Vec<Rc<str>>,
}

struct LineTokens<'a> {
	emit_binary_tokens: bool,
	/// `(startIndex, endIndex, scopes)`; the start is -1 only between `getResult` setting it and fixing it.
	tokens: Vec<(i64, usize, Vec<Rc<str>>)>,
	binary_tokens: Vec<u32>,
	last_token_end_index: i64,
	merge_consecutive_tokens_with_equal_metadata: bool,
	token_type_overrides: &'a [(Matcher, u32)],
	balanced_bracket_selectors: Option<&'a BalancedBracketSelectors>,
}

impl<'a> LineTokens<'a> {
	fn new(
		emit_binary_tokens: bool,
		line_text: &str,
		token_type_overrides: &'a [(Matcher, u32)],
		balanced_bracket_selectors: Option<&'a BalancedBracketSelectors>,
	) -> LineTokens<'a> {
		LineTokens {
			emit_binary_tokens,
			tokens: Vec::new(),
			binary_tokens: Vec::new(),
			last_token_end_index: 0,
			merge_consecutive_tokens_with_equal_metadata: !contains_rtl(line_text),
			token_type_overrides,
			balanced_bracket_selectors,
		}
	}

	fn produce_from_scopes(&mut self, scopes_list: &AttributedScopeStack, end_index: usize) {
		let end = end_index as i64;
		if self.last_token_end_index >= end {
			return;
		}

		if self.emit_binary_tokens {
			let mut metadata = scopes_list.token_attributes;
			let mut contains_balanced_brackets = self
				.balanced_bracket_selectors
				.is_some_and(|b| b.matches_always());

			if !self.token_type_overrides.is_empty()
				|| self
					.balanced_bracket_selectors
					.is_some_and(|b| !b.matches_always() && !b.matches_never())
			{
				// Only compute the scopes if necessary
				let scopes = scopes_list.get_scope_names();
				for (matcher, token_type) in self.token_type_overrides {
					if matcher.matches(&scopes) {
						metadata = set(metadata, 0, *token_type, None, -1, 0, 0);
					}
				}
				if let Some(selectors) = self.balanced_bracket_selectors {
					contains_balanced_brackets = selectors.matches(&scopes);
				}
			}

			if contains_balanced_brackets {
				metadata = set(metadata, 0, 8, Some(true), -1, 0, 0);
			}

			if self.merge_consecutive_tokens_with_equal_metadata
				&& self.binary_tokens.last() == Some(&metadata)
			{
				// no need to push a token with the same metadata
				self.last_token_end_index = end;
				return;
			}

			// -1 only when `get_binary_result` produces the whole line; it then sets it to 0.
			self.binary_tokens.push(self.last_token_end_index as u32);
			self.binary_tokens.push(metadata);

			self.last_token_end_index = end;
			return;
		}

		let scopes = scopes_list.get_scope_names();
		self.tokens
			.push((self.last_token_end_index, end_index, scopes));
		self.last_token_end_index = end;
	}

	fn get_result(&mut self, stack: &StateStack, line_length: usize) -> Vec<Token> {
		if self
			.tokens
			.last()
			.is_some_and(|t| t.0 == line_length as i64 - 1)
		{
			// pop produced token for newline
			self.tokens.pop();
		}
		if self.tokens.is_empty() {
			self.last_token_end_index = -1;
			self.produce_from_scopes(&stack.content_name_scopes_list, line_length);
			if let Some(last) = self.tokens.last_mut() {
				last.0 = 0;
			}
		}
		std::mem::take(&mut self.tokens)
			.into_iter()
			.map(|(start, end, scopes)| Token {
				start_index: start.max(0) as usize,
				end_index: end,
				scopes,
			})
			.collect()
	}

	fn get_binary_result(&mut self, stack: &StateStack, line_length: usize) -> Vec<u32> {
		let n = self.binary_tokens.len();
		if n > 0 && self.binary_tokens[n - 2] as i64 == line_length as i64 - 1 {
			// pop produced token for newline
			self.binary_tokens.truncate(n - 2);
		}
		if self.binary_tokens.is_empty() {
			self.last_token_end_index = -1;
			self.produce_from_scopes(&stack.content_name_scopes_list, line_length);
			let n = self.binary_tokens.len();
			self.binary_tokens[n - 2] = 0;
		}
		std::mem::take(&mut self.binary_tokens)
	}
}

// ---------------------------------------------------------------- grammar.ts: FontInfo, LineFonts

/// grammar.ts `FontInfo`: a range of a line with the font options of its scopes.
#[derive(Clone, Debug, PartialEq)]
pub struct FontInfo {
	pub start_index: usize,
	pub end_index: usize,
	pub font_family: Rc<str>,
	pub font_size_multiplier: f64,
	pub line_height_multiplier: f64,
}

impl FontInfo {
	/// `FontInfo.optionsEqual`.
	pub fn options_equal(&self, other: &FontInfo) -> bool {
		self.font_family == other.font_family
			&& self.font_size_multiplier == other.font_size_multiplier
			&& self.line_height_multiplier == other.line_height_multiplier
	}
}

/// grammar.ts `LineFonts`.
#[derive(Default)]
struct LineFonts {
	fonts: Vec<FontInfo>,
	last_index: usize,
}

impl LineFonts {
	fn produce_from_scopes(
		&mut self,
		scopes_list: Option<&AttributedScopeStack>,
		end_index: usize,
	) {
		let Some(font_attributes) = scopes_list.and_then(|s| s.font_attributes.as_ref()) else {
			self.last_index = end_index;
			return;
		};
		if font_attributes.font_family.is_empty()
			&& !js_truthy(font_attributes.font_size)
			&& !js_truthy(font_attributes.line_height)
		{
			self.last_index = end_index;
			return;
		}
		let font = FontInfo {
			start_index: self.last_index,
			end_index,
			font_family: font_attributes.font_family.clone(),
			font_size_multiplier: font_attributes.font_size,
			line_height_multiplier: font_attributes.line_height,
		};
		match self.fonts.last_mut() {
			Some(last) if last.end_index == self.last_index && last.options_equal(&font) => {
				last.end_index = font.end_index
			}
			_ => self.fonts.push(font),
		}
		self.last_index = end_index;
	}

	fn get_result(&mut self) -> Vec<FontInfo> {
		std::mem::take(&mut self.fonts)
	}
}

// ---------------------------------------------------------------- grammar.ts: TokenHandler

/// grammar.ts `TokenHandler`: what tokenizeString.ts produces tokens and fonts into.
struct TokenHandler<'a> {
	line_tokens: LineTokens<'a>,
	line_fonts: LineFonts,
}

impl<'a> TokenHandler<'a> {
	fn new(
		emit_binary_tokens: bool,
		line_text: &str,
		token_type_overrides: &'a [(Matcher, u32)],
		balanced_bracket_selectors: Option<&'a BalancedBracketSelectors>,
	) -> TokenHandler<'a> {
		TokenHandler {
			line_tokens: LineTokens::new(
				emit_binary_tokens,
				line_text,
				token_type_overrides,
				balanced_bracket_selectors,
			),
			line_fonts: LineFonts::default(),
		}
	}

	fn handle(&mut self, scopes: &AttributedScopeStack, end_index: usize) {
		self.line_tokens.produce_from_scopes(scopes, end_index);
		self.line_fonts.produce_from_scopes(Some(scopes), end_index);
	}

	fn get_token_result(&mut self, stack: &StateStack, line_length: usize) -> Vec<Token> {
		self.line_tokens.get_result(stack, line_length)
	}

	fn get_binary_token_result(&mut self, stack: &StateStack, line_length: usize) -> Vec<u32> {
		self.line_tokens.get_binary_result(stack, line_length)
	}

	fn get_font_result(&mut self) -> Vec<FontInfo> {
		self.line_fonts.get_result()
	}
}

// ---------------------------------------------------------------- grammar.ts: Grammar

struct Injection {
	matcher: Matcher,
	rule_id: i32,
	priority: i32,
}

/// The configuration of `Registry.loadGrammarWithConfiguration`.
#[derive(Clone, Debug, Default)]
pub struct GrammarConfiguration {
	/// Scope names mapped to language ids.
	pub embedded_languages: Vec<(String, u32)>,
	/// Scope selectors mapped to standard token types, in `Object.keys` order.
	pub token_types: Vec<(String, u32)>,
	pub balanced_bracket_selectors: Vec<String>,
	pub unbalanced_bracket_selectors: Vec<String>,
}

pub struct TokenizeLineResult {
	pub tokens: Vec<Token>,
	/// The state at the end of the line, or where tokenization stopped.
	pub rule_stack: Rc<StateStack>,
	/// Whether the time limit was reached; the tokens then end at the line's end with the last state's scopes.
	pub stopped_early: bool,
	/// The ranges whose scopes have font options in the theme.
	pub fonts: Vec<FontInfo>,
}

pub struct TokenizeLineResult2 {
	/// Pairs of start offset and encoded token attributes.
	pub tokens: Vec<u32>,
	/// The state at the end of the line, or where tokenization stopped.
	pub rule_stack: Rc<StateStack>,
	/// Whether the time limit was reached; the tokens then end at the line's end with the last state's scopes.
	pub stopped_early: bool,
	/// The ranges whose scopes have font options in the theme.
	pub fonts: Vec<FontInfo>,
}

pub struct Grammar {
	root_scope_name: String,
	balanced_bracket_selectors: Option<BalancedBracketSelectors>,
	onig_lib: Rc<dyn OnigLib>,
	basic_scope_attributes_provider: BasicScopeAttributesProvider,
	root_id: Cell<i32>,
	last_rule_id: Cell<i32>,
	rule_id_to_desc: RefCell<Vec<Option<Rc<Rule>>>>,
	included_grammars: RefCell<FxHashMap<String, Rc<RawRule>>>,
	grammar_repository: Rc<SyncRegistry>,
	grammar: Rc<RawRule>,
	injections: RefCell<Option<Rc<Vec<Injection>>>>,
	token_type_matchers: Vec<(Matcher, u32)>,
}

impl Grammar {
	#[allow(clippy::too_many_arguments)]
	fn new(
		root_scope_name: &str,
		grammar: &RawRule,
		initial_language: u32,
		embedded_languages: &[(String, u32)],
		token_types: &[(String, u32)],
		balanced_bracket_selectors: Option<BalancedBracketSelectors>,
		grammar_repository: Rc<SyncRegistry>,
		onig_lib: Rc<dyn OnigLib>,
	) -> Grammar {
		let mut token_type_matchers = Vec::new();
		for (selector, token_type) in token_types {
			for matcher in create_matchers(selector) {
				token_type_matchers.push((matcher.matcher, *token_type));
			}
		}
		Grammar {
			root_scope_name: root_scope_name.to_string(),
			balanced_bracket_selectors,
			onig_lib,
			basic_scope_attributes_provider: BasicScopeAttributesProvider::new(
				initial_language,
				embedded_languages,
			),
			root_id: Cell::new(-1),
			last_rule_id: Cell::new(0),
			rule_id_to_desc: RefCell::new(vec![None]),
			included_grammars: RefCell::new(FxHashMap::default()),
			grammar_repository,
			grammar: init_grammar(grammar, None),
			injections: RefCell::new(None),
			token_type_matchers,
		}
	}

	pub fn scope_name(&self) -> &str {
		&self.root_scope_name
	}

	fn collect_injections(&self) -> Vec<Injection> {
		let mut result = Vec::new();
		// `grammarForScopeName(this._rootScopeName)` is `this._grammar`.
		let grammar = self.grammar.clone();
		if let Some(raw_injections) = &grammar.injections {
			for (selector, rule) in raw_injections.iter() {
				self.collect_injection(&mut result, selector, rule, &grammar);
			}
		}
		// add injection grammars contributed for the current scope
		if let Some(injection_scope_names) =
			self.grammar_repository.injections(&self.root_scope_name)
		{
			for injection_scope_name in injection_scope_names {
				if let Some(injection_grammar) =
					self.get_external_grammar(&injection_scope_name, None)
				{
					if let Some(selector) = injection_grammar.injection_selector.clone() {
						self.collect_injection(
							&mut result,
							&selector,
							&injection_grammar,
							&injection_grammar,
						);
					}
				}
			}
		}
		// sort by priority (stable, as `Array.prototype.sort`)
		result.sort_by_key(|i| i.priority);
		result
	}

	/// grammar.ts `collectInjections`.
	fn collect_injection(
		&self,
		result: &mut Vec<Injection>,
		selector: &str,
		rule: &Rc<RawRule>,
		grammar: &RawRule,
	) {
		let matchers = create_matchers(selector);
		let repository = grammar.repository.clone().unwrap_or_default();
		let rule_id = get_compiled_rule_id(rule, self, &repository);
		for matcher in matchers {
			result.push(Injection {
				matcher: matcher.matcher,
				rule_id,
				priority: matcher.priority,
			});
		}
	}

	fn get_injections(&self) -> Rc<Vec<Injection>> {
		let cached = self.injections.borrow().clone();
		if let Some(injections) = cached {
			return injections;
		}
		let injections = Rc::new(self.collect_injections());
		*self.injections.borrow_mut() = Some(injections.clone());
		injections
	}

	/// `tokenizeLine(lineText, prevState)`, with no time limit.
	pub fn tokenize_line(
		&self,
		line_text: &str,
		prev_state: Option<&Rc<StateStack>>,
	) -> TokenizeLineResult {
		self.tokenize_line_with_time_limit(line_text, prev_state, 0)
	}

	/// `tokenizeLine(lineText, prevState, timeLimit)`. A `time_limit_ms` of 0 means no limit.
	pub fn tokenize_line_with_time_limit(
		&self,
		line_text: &str,
		prev_state: Option<&Rc<StateStack>>,
		time_limit_ms: u64,
	) -> TokenizeLineResult {
		let (mut token_handler, rule_stack, line_length, stopped_early) =
			self.tokenize(line_text, prev_state, false, time_limit_ms);
		TokenizeLineResult {
			tokens: token_handler.get_token_result(&rule_stack, line_length),
			rule_stack,
			stopped_early,
			fonts: token_handler.get_font_result(),
		}
	}

	/// `tokenizeLine2(lineText, prevState)`, with no time limit.
	pub fn tokenize_line2(
		&self,
		line_text: &str,
		prev_state: Option<&Rc<StateStack>>,
	) -> TokenizeLineResult2 {
		self.tokenize_line2_with_time_limit(line_text, prev_state, 0)
	}

	/// `tokenizeLine2(lineText, prevState, timeLimit)`. A `time_limit_ms` of 0 means no limit.
	pub fn tokenize_line2_with_time_limit(
		&self,
		line_text: &str,
		prev_state: Option<&Rc<StateStack>>,
		time_limit_ms: u64,
	) -> TokenizeLineResult2 {
		let (mut token_handler, rule_stack, line_length, stopped_early) =
			self.tokenize(line_text, prev_state, true, time_limit_ms);
		TokenizeLineResult2 {
			tokens: token_handler.get_binary_token_result(&rule_stack, line_length),
			rule_stack,
			stopped_early,
			fonts: token_handler.get_font_result(),
		}
	}

	fn tokenize(
		&self,
		line_text: &str,
		prev_state: Option<&Rc<StateStack>>,
		emit_binary_tokens: bool,
		time_limit_ms: u64,
	) -> (TokenHandler<'_>, Rc<StateStack>, usize, bool) {
		if self.root_id.get() == -1 {
			let repository = self.grammar.repository.clone().unwrap_or_default();
			let self_rule = repository
				.get("$self")
				.cloned()
				.expect("initGrammar adds $self");
			self.root_id
				.set(get_compiled_rule_id(&self_rule, self, &repository));
			// This ensures ids are deterministic, and thus equal in renderer and webworker.
			self.get_injections();
		}
		let theme = self.grammar_repository.theme();
		let injections = self.get_injections();

		let is_first_line;
		let prev_state = match prev_state {
			Some(prev_state) => {
				is_first_line = false;
				prev_state.reset();
				prev_state.clone()
			}
			None => {
				is_first_line = true;
				let raw_default_metadata = self
					.basic_scope_attributes_provider
					.get_default_attributes();
				let defaults = theme.get_defaults();
				let default_metadata = set(
					0,
					raw_default_metadata.language_id,
					raw_default_metadata.token_type,
					None,
					defaults.font_style,
					defaults.foreground_id,
					defaults.background_id,
				);
				let default_font = Rc::new(FontAttribute {
					font_family: defaults.font_family.clone(),
					font_size: defaults.font_size,
					line_height: defaults.line_height,
				});
				let root_scope_name = self
					.get_rule(self.root_id.get())
					.and_then(|r| r.get_name(None, None));
				let scope_list = match root_scope_name {
					Some(name) if !name.is_empty() => {
						AttributedScopeStack::create_root_and_look_up_scope_name(
							name,
							default_metadata,
							default_font,
							&self.basic_scope_attributes_provider,
							&theme,
						)
					}
					_ => AttributedScopeStack::create_root(
						Rc::from("unknown"),
						default_metadata,
						default_font,
					),
				};
				Rc::new(StateStack::new(
					None,
					self.root_id.get(),
					-1,
					-1,
					false,
					None,
					scope_list.clone(),
					scope_list,
				))
			}
		};

		let line_text = format!("{line_text}\n");
		let mut token_handler = TokenHandler::new(
			emit_binary_tokens,
			&line_text,
			&self.token_type_matchers,
			self.balanced_bracket_selectors.as_ref(),
		);
		let onig_line_text = self.onig_lib.create_onig_string(line_text);
		let line_length = onig_line_text.len16();
		let cx = TokenizeContext {
			grammar: self,
			theme: &theme,
			injections: &injections,
		};
		let (stack, stopped_early) = tokenize_string(
			&cx,
			&onig_line_text,
			is_first_line,
			0,
			prev_state,
			&mut token_handler,
			true,
			time_limit_ms,
		);
		(token_handler, stack, line_length, stopped_early)
	}
}

impl RuleFactoryHelper for Grammar {
	fn alloc_rule_id(&self) -> i32 {
		let id = self.last_rule_id.get() + 1;
		self.last_rule_id.set(id);
		let mut rules = self.rule_id_to_desc.borrow_mut();
		if rules.len() <= id as usize {
			rules.resize(id as usize + 1, None);
		}
		id
	}

	fn set_rule(&self, id: i32, rule: Rc<Rule>) {
		self.rule_id_to_desc.borrow_mut()[id as usize] = Some(rule);
	}

	fn get_rule(&self, id: i32) -> Option<Rc<Rule>> {
		if id < 0 {
			return None;
		}
		self.rule_id_to_desc
			.borrow()
			.get(id as usize)
			.cloned()
			.flatten()
	}

	fn get_external_grammar(
		&self,
		scope_name: &str,
		repository: Option<&Rc<RawRepository>>,
	) -> Option<Rc<RawRule>> {
		if let Some(grammar) = self.included_grammars.borrow().get(scope_name) {
			return Some(grammar.clone());
		}
		let raw_included_grammar = self.grammar_repository.lookup(scope_name)?;
		let base = repository.and_then(|r| r.get("$base").cloned());
		let grammar = init_grammar(&raw_included_grammar, base);
		self.included_grammars
			.borrow_mut()
			.insert(scope_name.to_string(), grammar.clone());
		Some(grammar)
	}

	fn onig_lib(&self) -> &dyn OnigLib {
		&*self.onig_lib
	}
}

// ---------------------------------------------------------------- tokenizeString.ts

struct TokenizeContext<'a> {
	grammar: &'a Grammar,
	theme: &'a Theme,
	injections: &'a [Injection],
}

impl TokenizeContext<'_> {
	fn push_attributed(
		&self,
		target: &Rc<AttributedScopeStack>,
		scope_path: Option<Rc<str>>,
	) -> Rc<AttributedScopeStack> {
		target.push_attributed(
			scope_path,
			&self.grammar.basic_scope_attributes_provider,
			self.theme,
		)
	}
}

/// tokenizeString.ts `_tokenizeString`: returns the stack and whether the time limit (0 for none) stopped it early.
#[allow(clippy::too_many_arguments)]
fn tokenize_string(
	cx: &TokenizeContext<'_>,
	line_text: &OnigString,
	mut is_first_line: bool,
	mut line_pos: usize,
	mut stack: Rc<StateStack>,
	token_handler: &mut TokenHandler<'_>,
	check_while_conditions: bool,
	time_limit_ms: u64,
) -> (Rc<StateStack>, bool) {
	let grammar = cx.grammar;
	let line_length = line_text.len16();
	let mut anchor_position: i64 = -1;

	if check_while_conditions {
		// tokenizeString.ts `_checkWhileConditions`
		anchor_position = if stack.begin_rule_captured_eol { 0 } else { -1 };
		let mut while_rules: Vec<(Rc<StateStack>, Rc<Rule>)> = Vec::new();
		let mut node = Some(stack.clone());
		while let Some(n) = node {
			if let Some(rule) = grammar.get_rule(n.rule_id) {
				if matches!(rule.kind, RuleKind::BeginWhile { .. }) {
					while_rules.push((n.clone(), rule));
				}
			}
			node = n.parent.clone();
		}
		while let Some((while_stack, while_rule)) = while_rules.pop() {
			let rule_scanner = while_rule.compile_while_ag(
				grammar,
				while_stack.end_rule.as_deref(),
				is_first_line,
				line_pos as i64 == anchor_position,
			);
			let r = rule_scanner.find_next_match_sync(line_text, line_pos);
			let r = match r {
				Some(r) if r.rule_id == WHILE_RULE_ID => r,
				_ => {
					stack = while_stack.pop().expect("a while rule is never the root");
					break;
				}
			};
			if !r.capture_indices.is_empty() {
				let c0 = r.capture_indices[0];
				token_handler.handle(&while_stack.content_name_scopes_list, c0.start);
				if let RuleKind::BeginWhile { while_captures, .. } = &while_rule.kind {
					handle_captures(
						cx,
						line_text,
						is_first_line,
						&while_stack,
						token_handler,
						while_captures,
						&r.capture_indices,
					);
				}
				token_handler.handle(&while_stack.content_name_scopes_list, c0.end);
				anchor_position = c0.end as i64;
				if c0.end > line_pos {
					line_pos = c0.end;
					is_first_line = false;
				}
			}
		}
	}

	let start_time = (time_limit_ms != 0).then(Instant::now);
	loop {
		if let Some(start_time) = start_time {
			if start_time.elapsed().as_millis() > u128::from(time_limit_ms) {
				return (stack, true);
			}
		}
		// scanNext
		let Some((capture_indices, matched_rule_id)) = match_rule_or_injections(
			cx,
			line_text,
			is_first_line,
			line_pos,
			&stack,
			anchor_position,
		) else {
			// No match
			token_handler.handle(&stack.content_name_scopes_list, line_length);
			break;
		};

		let c0 = capture_indices[0];
		let has_advanced = !capture_indices.is_empty() && c0.end > line_pos;

		if matched_rule_id == END_RULE_ID {
			// We matched the `end` for this rule => pop it
			let popped_rule = grammar
				.get_rule(stack.rule_id)
				.expect("the rule of a pushed state");

			token_handler.handle(&stack.content_name_scopes_list, c0.start);
			let name_scopes_list = stack.name_scopes_list.clone();
			stack = stack.with_content_name_scopes_list(&name_scopes_list);
			let end_captures: &[Option<Rc<Rule>>] = match &popped_rule.kind {
				RuleKind::BeginEnd { end_captures, .. } => end_captures,
				_ => &[],
			};
			handle_captures(
				cx,
				line_text,
				is_first_line,
				&stack,
				token_handler,
				end_captures,
				&capture_indices,
			);
			token_handler.handle(&stack.content_name_scopes_list, c0.end);

			// pop
			let popped = stack.clone();
			stack = popped.pop().expect("an end rule is never the root");
			anchor_position = popped.get_anchor_pos();

			if !has_advanced && popped.get_enter_pos() == line_pos as i64 {
				// Grammar pushed & popped a rule without advancing
				// See https://github.com/Microsoft/vscode-textmate/issues/12
				// Let's assume this was a mistake by the grammar author and the intent was to continue in this state
				stack = popped;
				token_handler.handle(&stack.content_name_scopes_list, line_length);
				break;
			}
		} else {
			// We matched a rule!
			let rule = grammar.get_rule(matched_rule_id).expect("a matched rule");

			token_handler.handle(&stack.content_name_scopes_list, c0.start);

			let before_push = stack.clone();
			// push it on the stack rule
			let scope_name = rule.get_name(Some(line_text), Some(&capture_indices));
			let name_scopes_list = cx.push_attributed(&stack.content_name_scopes_list, scope_name);
			stack = stack.push(
				matched_rule_id,
				line_pos as i64,
				anchor_position,
				c0.end == line_length,
				None,
				name_scopes_list.clone(),
				name_scopes_list.clone(),
			);

			match &rule.kind {
				RuleKind::BeginEnd {
					begin_captures,
					end_has_back_references,
					..
				} => {
					handle_captures(
						cx,
						line_text,
						is_first_line,
						&stack,
						token_handler,
						begin_captures,
						&capture_indices,
					);
					token_handler.handle(&stack.content_name_scopes_list, c0.end);
					anchor_position = c0.end as i64;

					let content_name = rule.get_content_name(line_text, &capture_indices);
					let content_name_scopes_list =
						cx.push_attributed(&name_scopes_list, content_name);
					stack = stack.with_content_name_scopes_list(&content_name_scopes_list);

					if *end_has_back_references {
						stack = stack.with_end_rule(Rc::from(
							rule.get_end_with_resolved_back_references(line_text, &capture_indices),
						));
					}

					if !has_advanced && before_push.has_same_rule_as(&stack) {
						// Grammar pushed the same rule without advancing
						stack = stack.pop().expect("just pushed");
						token_handler.handle(&stack.content_name_scopes_list, line_length);
						break;
					}
				}
				RuleKind::BeginWhile {
					begin_captures,
					while_has_back_references,
					..
				} => {
					handle_captures(
						cx,
						line_text,
						is_first_line,
						&stack,
						token_handler,
						begin_captures,
						&capture_indices,
					);
					token_handler.handle(&stack.content_name_scopes_list, c0.end);
					anchor_position = c0.end as i64;

					let content_name = rule.get_content_name(line_text, &capture_indices);
					let content_name_scopes_list =
						cx.push_attributed(&name_scopes_list, content_name);
					stack = stack.with_content_name_scopes_list(&content_name_scopes_list);

					if *while_has_back_references {
						stack = stack.with_end_rule(Rc::from(
							rule.get_while_with_resolved_back_references(
								line_text,
								&capture_indices,
							),
						));
					}

					if !has_advanced && before_push.has_same_rule_as(&stack) {
						// Grammar pushed the same rule without advancing
						stack = stack.pop().expect("just pushed");
						token_handler.handle(&stack.content_name_scopes_list, line_length);
						break;
					}
				}
				_ => {
					let captures: &[Option<Rc<Rule>>] = match &rule.kind {
						RuleKind::Match { captures, .. } => captures,
						_ => &[],
					};
					handle_captures(
						cx,
						line_text,
						is_first_line,
						&stack,
						token_handler,
						captures,
						&capture_indices,
					);
					token_handler.handle(&stack.content_name_scopes_list, c0.end);

					// pop rule immediately since it is a MatchRule
					stack = stack.pop().expect("just pushed");

					if !has_advanced {
						// Grammar is not advancing, nor is it pushing/popping
						stack = stack.safe_pop();
						token_handler.handle(&stack.content_name_scopes_list, line_length);
						break;
					}
				}
			}
		}

		if c0.end > line_pos {
			// Advance stream
			line_pos = c0.end;
			is_first_line = false;
		}
	}

	(stack, false)
}

/// tokenizeString.ts `matchRuleOrInjections`, with `matchRule`.
fn match_rule_or_injections(
	cx: &TokenizeContext<'_>,
	line_text: &OnigString,
	is_first_line: bool,
	line_pos: usize,
	stack: &StateStack,
	anchor_position: i64,
) -> Option<(Vec<CaptureIndex>, i32)> {
	// Look for normal grammar rule
	let rule = cx
		.grammar
		.get_rule(stack.rule_id)
		.expect("the rule of a state");
	let rule_scanner = rule.compile_ag(
		cx.grammar,
		stack.end_rule.as_deref(),
		is_first_line,
		line_pos as i64 == anchor_position,
	);
	let match_result = rule_scanner
		.find_next_match_sync(line_text, line_pos)
		.map(|r| (r.capture_indices, r.rule_id));

	// Look for injected rules
	if cx.injections.is_empty() {
		// No injections whatsoever => early return
		return match_result;
	}

	let Some((injection_capture_indices, injection_rule_id, priority_match)) = match_injections(
		cx,
		line_text,
		is_first_line,
		line_pos,
		stack,
		anchor_position,
	) else {
		// No injections matched => early return
		return match_result;
	};
	let Some(match_result) = match_result else {
		// Only injections matched => early return
		return Some((injection_capture_indices, injection_rule_id));
	};

	// Decide if `matchResult` or `injectionResult` should win
	let match_result_score = match_result.0[0].start;
	let injection_result_score = injection_capture_indices[0].start;

	if injection_result_score < match_result_score
		|| (priority_match && injection_result_score == match_result_score)
	{
		// injection won!
		return Some((injection_capture_indices, injection_rule_id));
	}
	Some(match_result)
}

/// tokenizeString.ts `matchInjections`: the captures, the rule id and whether it is a priority match.
fn match_injections(
	cx: &TokenizeContext<'_>,
	line_text: &OnigString,
	is_first_line: bool,
	line_pos: usize,
	stack: &StateStack,
	anchor_position: i64,
) -> Option<(Vec<CaptureIndex>, i32, bool)> {
	// The lower the better
	let mut best_match_rating = usize::MAX;
	let mut best: Option<(Vec<CaptureIndex>, i32, i32)> = None;

	let scopes = stack.content_name_scopes_list.get_scope_names();

	for injection in cx.injections {
		if !injection.matcher.matches(&scopes) {
			// injection selector doesn't match stack
			continue;
		}
		let rule = cx
			.grammar
			.get_rule(injection.rule_id)
			.expect("an injection rule");
		let rule_scanner = rule.compile_ag(
			cx.grammar,
			None,
			is_first_line,
			line_pos as i64 == anchor_position,
		);
		let Some(match_result) = rule_scanner.find_next_match_sync(line_text, line_pos) else {
			continue;
		};

		let match_rating = match_result.capture_indices[0].start;
		if match_rating >= best_match_rating {
			// Injections are sorted by priority, so the previous injection had a better or equal priority
			continue;
		}

		best_match_rating = match_rating;
		best = Some((
			match_result.capture_indices,
			match_result.rule_id,
			injection.priority,
		));

		if best_match_rating == line_pos {
			// No more need to look at the rest of the injections.
			break;
		}
	}

	best.map(|(capture_indices, rule_id, priority)| (capture_indices, rule_id, priority == -1))
}

/// tokenizeString.ts `handleCaptures`.
#[allow(clippy::too_many_arguments)]
fn handle_captures(
	cx: &TokenizeContext<'_>,
	line_text: &OnigString,
	is_first_line: bool,
	stack: &Rc<StateStack>,
	token_handler: &mut TokenHandler<'_>,
	captures: &[Option<Rc<Rule>>],
	capture_indices: &[CaptureIndex],
) {
	if captures.is_empty() {
		return;
	}

	let len = captures.len().min(capture_indices.len());
	let mut local_stack: Vec<(Rc<AttributedScopeStack>, usize)> = Vec::new();
	let max_end = capture_indices[0].end;

	for i in 0..len {
		let Some(capture_rule) = &captures[i] else {
			// Not interested
			continue;
		};

		let capture_index = capture_indices[i];

		if capture_index.length() == 0 {
			// Nothing really captured
			continue;
		}

		if capture_index.start > max_end {
			// Capture going beyond consumed string
			break;
		}

		// pop captures while needed
		while local_stack
			.last()
			.is_some_and(|(_, end_pos)| *end_pos <= capture_index.start)
		{
			// pop!
			let (scopes, end_pos) = local_stack.pop().expect("checked");
			token_handler.handle(&scopes, end_pos);
		}

		match local_stack.last() {
			Some((scopes, _)) => token_handler.handle(scopes, capture_index.start),
			None => token_handler.handle(&stack.content_name_scopes_list, capture_index.start),
		}

		if let RuleKind::Capture {
			retokenize_captured_with_rule_id,
		} = &capture_rule.kind
		{
			if *retokenize_captured_with_rule_id != 0 {
				// the capture requires additional matching
				let scope_name = capture_rule.get_name(Some(line_text), Some(capture_indices));
				let name_scopes_list =
					cx.push_attributed(&stack.content_name_scopes_list, scope_name);
				let content_name = capture_rule.get_content_name(line_text, capture_indices);
				let content_name_scopes_list = cx.push_attributed(&name_scopes_list, content_name);

				let stack_clone = stack.push(
					*retokenize_captured_with_rule_id,
					capture_index.start as i64,
					-1,
					false,
					None,
					name_scopes_list,
					content_name_scopes_list,
				);
				let onig_sub_str = cx
					.grammar
					.onig_lib
					.create_onig_string(line_text.slice16(0, capture_index.end).to_string());
				tokenize_string(
					cx,
					&onig_sub_str,
					is_first_line && capture_index.start == 0,
					capture_index.start,
					stack_clone,
					token_handler,
					false,
					0,
				);
				continue;
			}
		}

		let capture_scope_name = capture_rule.get_name(Some(line_text), Some(capture_indices));
		if capture_scope_name.is_some() {
			// push
			let base = match local_stack.last() {
				Some((scopes, _)) => scopes.clone(),
				None => stack.content_name_scopes_list.clone(),
			};
			let capture_scope = cx.push_attributed(&base, capture_scope_name);
			local_stack.push((capture_scope, capture_index.end));
		}
	}

	while let Some((scopes, end_pos)) = local_stack.pop() {
		// pop!
		token_handler.handle(&scopes, end_pos);
	}
}

// ---------------------------------------------------------------- grammarDependencies.ts

/// `TopLevelRuleReference` and `TopLevelRepositoryRuleReference`.
enum AbsoluteRuleReference {
	TopLevel(String),
	TopLevelRepository(String, String),
}

impl AbsoluteRuleReference {
	fn scope_name(&self) -> &str {
		match self {
			AbsoluteRuleReference::TopLevel(scope_name)
			| AbsoluteRuleReference::TopLevelRepository(scope_name, _) => scope_name,
		}
	}

	fn to_key(&self) -> String {
		match self {
			AbsoluteRuleReference::TopLevel(scope_name) => scope_name.clone(),
			AbsoluteRuleReference::TopLevelRepository(scope_name, rule_name) => {
				format!("{scope_name}#{rule_name}")
			}
		}
	}
}

#[derive(Default)]
struct ExternalReferenceCollector {
	references: Vec<AbsoluteRuleReference>,
	seen_reference_keys: FxHashSet<String>,
	visited_rule: FxHashSet<*const RawRule>,
}

impl ExternalReferenceCollector {
	fn add(&mut self, reference: AbsoluteRuleReference) {
		if self.seen_reference_keys.insert(reference.to_key()) {
			self.references.push(reference);
		}
	}
}

struct ScopeDependencyProcessor<'a> {
	repo: &'a SyncRegistry,
	initial_scope_name: String,
	seen_full_scope_requests: FxHashSet<String>,
	seen_partial_scope_requests: FxHashSet<String>,
	q: Vec<AbsoluteRuleReference>,
}

impl<'a> ScopeDependencyProcessor<'a> {
	fn new(repo: &'a SyncRegistry, initial_scope_name: &str) -> ScopeDependencyProcessor<'a> {
		let mut seen_full_scope_requests = FxHashSet::default();
		seen_full_scope_requests.insert(initial_scope_name.to_string());
		ScopeDependencyProcessor {
			repo,
			initial_scope_name: initial_scope_name.to_string(),
			seen_full_scope_requests,
			seen_partial_scope_requests: FxHashSet::default(),
			q: vec![AbsoluteRuleReference::TopLevel(
				initial_scope_name.to_string(),
			)],
		}
	}

	fn process_queue(&mut self) -> Result<(), String> {
		let q = std::mem::take(&mut self.q);

		let mut deps = ExternalReferenceCollector::default();
		for dep in &q {
			collect_references_of_reference(dep, &self.initial_scope_name, self.repo, &mut deps)?;
		}

		for dep in deps.references {
			match &dep {
				AbsoluteRuleReference::TopLevel(scope_name) => {
					if self.seen_full_scope_requests.contains(scope_name) {
						// already processed
						continue;
					}
					self.seen_full_scope_requests.insert(scope_name.clone());
				}
				AbsoluteRuleReference::TopLevelRepository(scope_name, _) => {
					if self.seen_full_scope_requests.contains(scope_name) {
						// already processed in full
						continue;
					}
					let key = dep.to_key();
					if self.seen_partial_scope_requests.contains(&key) {
						// already processed
						continue;
					}
					self.seen_partial_scope_requests.insert(key);
				}
			}
			self.q.push(dep);
		}
		Ok(())
	}
}

fn collect_references_of_reference(
	reference: &AbsoluteRuleReference,
	base_grammar_scope_name: &str,
	repo: &SyncRegistry,
	result: &mut ExternalReferenceCollector,
) -> Result<(), String> {
	let Some(self_grammar) = repo.lookup(reference.scope_name()) else {
		if reference.scope_name() == base_grammar_scope_name {
			return Err(format!(
				"No grammar provided for <{base_grammar_scope_name}>"
			));
		}
		return Ok(());
	};

	let base_grammar = repo
		.lookup(base_grammar_scope_name)
		.expect("the base grammar is processed first");

	match reference {
		AbsoluteRuleReference::TopLevel(_) => {
			collect_external_references_in_top_level_rule(&base_grammar, &self_grammar, result)
		}
		AbsoluteRuleReference::TopLevelRepository(_, rule_name) => {
			collect_external_references_in_top_level_repository_rule(
				rule_name,
				&base_grammar,
				&self_grammar,
				self_grammar.repository.as_ref(),
				result,
			)
		}
	}

	if let Some(injections) = repo.injections(reference.scope_name()) {
		for injection in injections {
			result.add(AbsoluteRuleReference::TopLevel(injection));
		}
	}
	Ok(())
}

fn collect_external_references_in_top_level_repository_rule(
	rule_name: &str,
	base_grammar: &Rc<RawRule>,
	self_grammar: &Rc<RawRule>,
	repository: Option<&Rc<RawRepository>>,
	result: &mut ExternalReferenceCollector,
) {
	if let Some(rule) = repository.and_then(|r| r.get(rule_name)) {
		let rules = [rule.clone()];
		collect_external_references_in_rules(
			&rules,
			base_grammar,
			self_grammar,
			repository,
			result,
		);
	}
}

fn collect_external_references_in_top_level_rule(
	base_grammar: &Rc<RawRule>,
	self_grammar: &Rc<RawRule>,
	result: &mut ExternalReferenceCollector,
) {
	let repository = self_grammar.repository.as_ref();
	if let Some(patterns) = &self_grammar.patterns {
		collect_external_references_in_rules(
			patterns,
			base_grammar,
			self_grammar,
			repository,
			result,
		);
	}
	if let Some(injections) = &self_grammar.injections {
		let rules: Vec<Rc<RawRule>> = injections.iter().map(|(_, rule)| rule.clone()).collect();
		collect_external_references_in_rules(
			&rules,
			base_grammar,
			self_grammar,
			repository,
			result,
		);
	}
}

fn collect_external_references_in_rules(
	rules: &[Rc<RawRule>],
	base_grammar: &Rc<RawRule>,
	self_grammar: &Rc<RawRule>,
	repository: Option<&Rc<RawRepository>>,
	result: &mut ExternalReferenceCollector,
) {
	for rule in rules {
		if !result.visited_rule.insert(Rc::as_ptr(rule)) {
			continue;
		}

		let pattern_repository: Option<Rc<RawRepository>> = match &rule.repository {
			Some(own) => Some(merge_objects(repository.map(|r| &**r), own)),
			None => repository.cloned(),
		};

		if let Some(patterns) = &rule.patterns {
			collect_external_references_in_rules(
				patterns,
				base_grammar,
				self_grammar,
				pattern_repository.as_ref(),
				result,
			);
		}

		let Some(include) = &rule.include else {
			continue;
		};

		match parse_include(include) {
			IncludeReference::Base => {
				collect_external_references_in_top_level_rule(base_grammar, base_grammar, result)
			}
			IncludeReference::SelfRef => {
				collect_external_references_in_top_level_rule(base_grammar, self_grammar, result)
			}
			IncludeReference::Relative(rule_name) => {
				collect_external_references_in_top_level_repository_rule(
					rule_name,
					base_grammar,
					self_grammar,
					pattern_repository.as_ref(),
					result,
				)
			}
			IncludeReference::TopLevel(scope_name) => {
				match select_grammar(scope_name, base_grammar, self_grammar) {
					Some(self_grammar) => collect_external_references_in_top_level_rule(
						base_grammar,
						&self_grammar,
						result,
					),
					None => result.add(AbsoluteRuleReference::TopLevel(scope_name.to_string())),
				}
			}
			IncludeReference::TopLevelRepository(scope_name, rule_name) => {
				match select_grammar(scope_name, base_grammar, self_grammar) {
					// Uses the repository of the including pattern, as grammarDependencies.ts does.
					Some(self_grammar) => collect_external_references_in_top_level_repository_rule(
						rule_name,
						base_grammar,
						&self_grammar,
						pattern_repository.as_ref(),
						result,
					),
					None => result.add(AbsoluteRuleReference::TopLevelRepository(
						scope_name.to_string(),
						rule_name.to_string(),
					)),
				}
			}
		}
	}
}

fn select_grammar(
	scope_name: &str,
	base_grammar: &Rc<RawRule>,
	self_grammar: &Rc<RawRule>,
) -> Option<Rc<RawRule>> {
	if self_grammar.scope_name.as_deref() == Some(scope_name) {
		Some(self_grammar.clone())
	} else if base_grammar.scope_name.as_deref() == Some(scope_name) {
		Some(base_grammar.clone())
	} else {
		None
	}
}

// ---------------------------------------------------------------- registry.ts

/// registry.ts `SyncRegistry`, without the grammar cache, which is in `Registry` so that grammars don't keep their
/// registry alive through a cycle.
pub struct SyncRegistry {
	raw_grammars: RefCell<FxHashMap<String, Rc<RawRule>>>,
	injection_grammars: RefCell<FxHashMap<String, Vec<String>>>,
	theme: RefCell<Rc<Theme>>,
}

impl SyncRegistry {
	fn new(theme: Theme) -> SyncRegistry {
		SyncRegistry {
			raw_grammars: RefCell::new(FxHashMap::default()),
			injection_grammars: RefCell::new(FxHashMap::default()),
			theme: RefCell::new(Rc::new(theme)),
		}
	}

	pub fn set_theme(&self, theme: Theme) {
		*self.theme.borrow_mut() = Rc::new(theme);
	}

	pub fn get_color_map(&self) -> Vec<String> {
		self.theme.borrow().get_color_map()
	}

	/// Add `grammar` to registry and return a list of referenced scope names
	pub fn add_grammar(&self, grammar: Rc<RawRule>, injection_scope_names: Option<Vec<String>>) {
		let scope_name = grammar
			.scope_name
			.as_deref()
			.unwrap_or_default()
			.to_string();
		self.raw_grammars
			.borrow_mut()
			.insert(scope_name.clone(), grammar);
		if let Some(injection_scope_names) = injection_scope_names {
			self.injection_grammars
				.borrow_mut()
				.insert(scope_name, injection_scope_names);
		}
	}

	pub fn lookup(&self, scope_name: &str) -> Option<Rc<RawRule>> {
		self.raw_grammars.borrow().get(scope_name).cloned()
	}

	pub fn injections(&self, target_scope: &str) -> Option<Vec<String>> {
		self.injection_grammars.borrow().get(target_scope).cloned()
	}

	fn theme(&self) -> Rc<Theme> {
		self.theme.borrow().clone()
	}
}

// ---------------------------------------------------------------- main.ts

pub type LoadGrammar = Box<dyn Fn(&str) -> Option<Rc<RawRule>>>;
pub type GetInjections = Box<dyn Fn(&str) -> Option<Vec<String>>>;

/// main.ts `RegistryOptions`.
pub struct RegistryOptions {
	pub onig_lib: Rc<dyn OnigLib>,
	pub theme: Option<Json>,
	pub color_map: Option<Vec<String>>,
	pub load_grammar: LoadGrammar,
	pub get_injections: Option<GetInjections>,
}

/// main.ts `Registry`: the public API for loading grammars.
pub struct Registry {
	options: RegistryOptions,
	sync_registry: Rc<SyncRegistry>,
	ensure_grammar_cache: RefCell<FxHashSet<String>>,
	grammars: RefCell<FxHashMap<String, Rc<Grammar>>>,
}

impl Registry {
	pub fn new(options: RegistryOptions) -> Registry {
		let theme =
			Theme::create_from_raw_theme(options.theme.as_ref(), options.color_map.as_deref());
		Registry {
			options,
			sync_registry: Rc::new(SyncRegistry::new(theme)),
			ensure_grammar_cache: RefCell::new(FxHashSet::default()),
			grammars: RefCell::new(FxHashMap::default()),
		}
	}

	/// Change the theme. Once called, no previous `ruleStack` should be used anymore.
	pub fn set_theme(&self, theme: &Json, color_map: Option<&[String]>) {
		self.sync_registry
			.set_theme(Theme::create_from_raw_theme(Some(theme), color_map));
	}

	/// Returns a lookup array for color ids.
	pub fn get_color_map(&self) -> Vec<String> {
		self.sync_registry.get_color_map()
	}

	/// Load the grammar for `scopeName` and all referenced included grammars, with embedded languages.
	pub fn load_grammar_with_embedded_languages(
		&self,
		initial_scope_name: &str,
		initial_language: u32,
		embedded_languages: &[(String, u32)],
	) -> Result<Option<Rc<Grammar>>, String> {
		let configuration = GrammarConfiguration {
			embedded_languages: embedded_languages.to_vec(),
			..Default::default()
		};
		self.load_grammar_with_configuration(initial_scope_name, initial_language, &configuration)
	}

	/// Load the grammar for `scopeName` and all referenced included grammars.
	pub fn load_grammar_with_configuration(
		&self,
		initial_scope_name: &str,
		initial_language: u32,
		configuration: &GrammarConfiguration,
	) -> Result<Option<Rc<Grammar>>, String> {
		let selectors = BalancedBracketSelectors::new(
			&configuration.balanced_bracket_selectors,
			&configuration.unbalanced_bracket_selectors,
		);
		self.load_grammar_impl(
			initial_scope_name,
			initial_language,
			&configuration.embedded_languages,
			&configuration.token_types,
			Some(selectors),
		)
	}

	/// Load the grammar for `scopeName` and all referenced included grammars.
	pub fn load_grammar(&self, initial_scope_name: &str) -> Result<Option<Rc<Grammar>>, String> {
		self.load_grammar_impl(initial_scope_name, 0, &[], &[], None)
	}

	fn load_grammar_impl(
		&self,
		initial_scope_name: &str,
		initial_language: u32,
		embedded_languages: &[(String, u32)],
		token_types: &[(String, u32)],
		balanced_bracket_selectors: Option<BalancedBracketSelectors>,
	) -> Result<Option<Rc<Grammar>>, String> {
		let mut dependency_processor =
			ScopeDependencyProcessor::new(&self.sync_registry, initial_scope_name);
		while !dependency_processor.q.is_empty() {
			for request in &dependency_processor.q {
				self.load_single_grammar(request.scope_name());
			}
			dependency_processor.process_queue()?;
		}
		Ok(self.grammar_for_scope_name(
			initial_scope_name,
			initial_language,
			embedded_languages,
			token_types,
			balanced_bracket_selectors,
		))
	}

	fn load_single_grammar(&self, scope_name: &str) {
		if !self
			.ensure_grammar_cache
			.borrow_mut()
			.insert(scope_name.to_string())
		{
			return;
		}
		if let Some(grammar) = (self.options.load_grammar)(scope_name) {
			let injections = self
				.options
				.get_injections
				.as_ref()
				.and_then(|f| f(scope_name));
			self.sync_registry.add_grammar(grammar, injections);
		}
	}

	/// Adds a rawGrammar.
	pub fn add_grammar(
		&self,
		raw_grammar: Rc<RawRule>,
		injections: Option<Vec<String>>,
		initial_language: u32,
		embedded_languages: &[(String, u32)],
	) -> Option<Rc<Grammar>> {
		let scope_name = raw_grammar
			.scope_name
			.as_deref()
			.unwrap_or_default()
			.to_string();
		self.sync_registry
			.add_grammar(raw_grammar, Some(injections.unwrap_or_default()));
		self.grammar_for_scope_name(&scope_name, initial_language, embedded_languages, &[], None)
	}

	fn grammar_for_scope_name(
		&self,
		scope_name: &str,
		initial_language: u32,
		embedded_languages: &[(String, u32)],
		token_types: &[(String, u32)],
		balanced_bracket_selectors: Option<BalancedBracketSelectors>,
	) -> Option<Rc<Grammar>> {
		if let Some(grammar) = self.grammars.borrow().get(scope_name) {
			return Some(grammar.clone());
		}
		let raw_grammar = self.sync_registry.lookup(scope_name)?;
		let grammar = Rc::new(Grammar::new(
			scope_name,
			&raw_grammar,
			initial_language,
			embedded_languages,
			token_types,
			balanced_bracket_selectors,
			self.sync_registry.clone(),
			self.options.onig_lib.clone(),
		));
		self.grammars
			.borrow_mut()
			.insert(scope_name.to_string(), grammar.clone());
		Some(grammar)
	}
}
