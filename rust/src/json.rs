/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! The values `JSON.parse` and plist.ts `parsePLIST` produce, with JavaScript object key order:
//! array-index keys first in ascending order, then the other keys in insertion order; a repeated key keeps
//! its first position and takes the last value.

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
	Null,
	Bool(bool),
	Number(f64),
	String(String),
	Array(Vec<Json>),
	Object(Vec<(String, Json)>),
}

impl Json {
	/// JavaScript truthiness.
	pub fn is_truthy(&self) -> bool {
		match self {
			Json::Null => false,
			Json::Bool(b) => *b,
			Json::Number(n) => *n != 0.0 && !n.is_nan(),
			Json::String(s) => !s.is_empty(),
			Json::Array(_) | Json::Object(_) => true,
		}
	}
	/// `obj[key]` on an object (None for a missing key or a non-object).
	pub fn get(&self, key: &str) -> Option<&Json> {
		match self {
			Json::Object(v) => v.iter().find(|(k, _)| k == key).map(|(_, v)| v),
			_ => None,
		}
	}
	pub fn as_str(&self) -> Option<&str> {
		match self {
			Json::String(s) => Some(s),
			_ => None,
		}
	}
	pub fn as_array(&self) -> Option<&[Json]> {
		match self {
			Json::Array(v) => Some(v),
			_ => None,
		}
	}
	pub fn as_object(&self) -> Option<&[(String, Json)]> {
		match self {
			Json::Object(v) => Some(v),
			_ => None,
		}
	}
	pub fn as_f64(&self) -> Option<f64> {
		match self {
			Json::Number(n) => Some(*n),
			_ => None,
		}
	}
}

/// An array index: the canonical decimal form of an integer in 0..2^32-1.
fn array_index(key: &str) -> Option<u32> {
	let b = key.as_bytes();
	if b.is_empty()
		|| b.len() > 10
		|| !b.iter().all(u8::is_ascii_digit)
		|| (b.len() > 1 && b[0] == b'0')
	{
		return None;
	}
	let v: u64 = key.parse().ok()?;
	if v < u32::MAX as u64 {
		Some(v as u32)
	} else {
		None
	}
}

/// Builds an object the way property assignment does.
#[derive(Default)]
pub struct ObjectBuilder {
	entries: Vec<(String, Json)>,
}

impl ObjectBuilder {
	pub fn set(&mut self, key: String, value: Json) {
		if let Some(e) = self.entries.iter_mut().find(|(k, _)| *k == key) {
			e.1 = value;
		} else {
			self.entries.push((key, value));
		}
	}
	pub fn finish(mut self) -> Json {
		if self.entries.iter().any(|(k, _)| array_index(k).is_some()) {
			let (mut idx, rest): (Vec<_>, Vec<_>) = self
				.entries
				.into_iter()
				.partition(|(k, _)| array_index(k).is_some());
			idx.sort_by_key(|(k, _)| array_index(k).unwrap());
			idx.extend(rest);
			self.entries = idx;
		}
		Json::Object(self.entries)
	}
}

// ---------------------------------------------------------------- JSON.parse

/// `JSON.parse`, which parseRawGrammar.ts uses for `.json` grammars: strict JSON, so a leading BOM is an error
/// (only the plist parser skips one). Lone surrogate escapes, which a Rust `String` cannot hold, become U+FFFD.
pub fn parse_json(source: &str) -> Result<Json, String> {
	let s = source;
	let mut p = JsonParser {
		b: s.as_bytes(),
		s,
		pos: 0,
	};
	p.ws();
	let v = p.value()?;
	p.ws();
	if p.pos != p.b.len() {
		return Err(p.err("unexpected trailing characters"));
	}
	Ok(v)
}

struct JsonParser<'a> {
	b: &'a [u8],
	s: &'a str,
	pos: usize,
}

impl JsonParser<'_> {
	fn err(&self, m: &str) -> String {
		format!("JSON: {m} at byte {}", self.pos)
	}
	fn ws(&mut self) {
		while self.pos < self.b.len() && matches!(self.b[self.pos], b' ' | b'\t' | b'\n' | b'\r') {
			self.pos += 1;
		}
	}
	fn value(&mut self) -> Result<Json, String> {
		match self.b.get(self.pos) {
			Some(b'{') => {
				self.pos += 1;
				let mut o = ObjectBuilder::default();
				self.ws();
				if self.b.get(self.pos) == Some(&b'}') {
					self.pos += 1;
					return Ok(o.finish());
				}
				loop {
					self.ws();
					if self.b.get(self.pos) != Some(&b'"') {
						return Err(self.err("expected a key"));
					}
					let k = self.string()?;
					self.ws();
					if self.b.get(self.pos) != Some(&b':') {
						return Err(self.err("expected ':'"));
					}
					self.pos += 1;
					self.ws();
					let v = self.value()?;
					o.set(k, v);
					self.ws();
					match self.b.get(self.pos) {
						Some(b',') => self.pos += 1,
						Some(b'}') => {
							self.pos += 1;
							return Ok(o.finish());
						}
						_ => return Err(self.err("expected ',' or '}'")),
					}
				}
			}
			Some(b'[') => {
				self.pos += 1;
				let mut a = Vec::new();
				self.ws();
				if self.b.get(self.pos) == Some(&b']') {
					self.pos += 1;
					return Ok(Json::Array(a));
				}
				loop {
					self.ws();
					a.push(self.value()?);
					self.ws();
					match self.b.get(self.pos) {
						Some(b',') => self.pos += 1,
						Some(b']') => {
							self.pos += 1;
							return Ok(Json::Array(a));
						}
						_ => return Err(self.err("expected ',' or ']'")),
					}
				}
			}
			Some(b'"') => Ok(Json::String(self.string()?)),
			Some(b't') if self.b[self.pos..].starts_with(b"true") => {
				self.pos += 4;
				Ok(Json::Bool(true))
			}
			Some(b'f') if self.b[self.pos..].starts_with(b"false") => {
				self.pos += 5;
				Ok(Json::Bool(false))
			}
			Some(b'n') if self.b[self.pos..].starts_with(b"null") => {
				self.pos += 4;
				Ok(Json::Null)
			}
			Some(c) if *c == b'-' || c.is_ascii_digit() => {
				// -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
				let start = self.pos;
				if self.b[self.pos] == b'-' {
					self.pos += 1;
				}
				match self.b.get(self.pos) {
					Some(b'0') => self.pos += 1,
					Some(b'1'..=b'9') => {
						self.digits();
					}
					_ => return Err(self.err("bad number")),
				}
				if self.b.get(self.pos) == Some(&b'.') {
					self.pos += 1;
					if !self.digits() {
						return Err(self.err("bad number"));
					}
				}
				if matches!(self.b.get(self.pos), Some(b'e' | b'E')) {
					self.pos += 1;
					if matches!(self.b.get(self.pos), Some(b'+' | b'-')) {
						self.pos += 1;
					}
					if !self.digits() {
						return Err(self.err("bad number"));
					}
				}
				self.s[start..self.pos]
					.parse::<f64>()
					.map(Json::Number)
					.map_err(|_| self.err("bad number"))
			}
			_ => Err(self.err("unexpected character")),
		}
	}
	/// Consumes `[0-9]*`; returns whether it consumed any digit.
	fn digits(&mut self) -> bool {
		let start = self.pos;
		while self.pos < self.b.len() && self.b[self.pos].is_ascii_digit() {
			self.pos += 1;
		}
		self.pos > start
	}
	fn hex4(&mut self) -> Result<u32, String> {
		let b = self.b;
		let h = b
			.get(self.pos..self.pos + 4)
			.filter(|h| h.iter().all(u8::is_ascii_hexdigit))
			.ok_or_else(|| self.err("bad \\u escape"))?;
		let v = h
			.iter()
			.fold(0, |v, &c| v * 16 + (c as char).to_digit(16).unwrap());
		self.pos += 4;
		Ok(v)
	}
	fn string(&mut self) -> Result<String, String> {
		self.pos += 1;
		let mut out = String::new();
		loop {
			let start = self.pos;
			while self.pos < self.b.len() && self.b[self.pos] != b'"' && self.b[self.pos] != b'\\' {
				if self.b[self.pos] < 0x20 {
					return Err(self.err("control character in string"));
				}
				self.pos += 1;
			}
			out.push_str(&self.s[start..self.pos]);
			match self.b.get(self.pos) {
				Some(b'"') => {
					self.pos += 1;
					return Ok(out);
				}
				Some(b'\\') => {
					self.pos += 1;
					let c = *self
						.b
						.get(self.pos)
						.ok_or_else(|| self.err("unterminated string"))?;
					self.pos += 1;
					match c {
						b'"' => out.push('"'),
						b'\\' => out.push('\\'),
						b'/' => out.push('/'),
						b'b' => out.push('\u{8}'),
						b'f' => out.push('\u{C}'),
						b'n' => out.push('\n'),
						b'r' => out.push('\r'),
						b't' => out.push('\t'),
						b'u' => {
							let u = self.hex4()?;
							if (0xD800..0xDC00).contains(&u)
								&& self.b[self.pos..].starts_with(b"\\u")
							{
								let save = self.pos;
								self.pos += 2;
								let l = self.hex4()?;
								if (0xDC00..0xE000).contains(&l) {
									out.push(
										char::from_u32(
											0x10000 + ((u - 0xD800) << 10) + (l - 0xDC00),
										)
										.unwrap(),
									);
									continue;
								}
								self.pos = save;
							}
							out.push(char::from_u32(u).unwrap_or('\u{FFFD}'));
						}
						_ => return Err(self.err("bad escape")),
					}
				}
				_ => return Err(self.err("unterminated string")),
			}
		}
	}
}

// ---------------------------------------------------------------- plist.ts parsePLIST

enum Frame {
	Dict(ObjectBuilder, Option<String>),
	Array(Vec<Json>, Option<String>),
}

pub fn parse_plist(content: &str) -> Result<Json, String> {
	let s = content.strip_prefix('\u{FEFF}').unwrap_or(content);
	let b = s.as_bytes();
	let len = b.len();
	let mut pos = 0usize;
	let mut stack: Vec<Frame> = Vec::new();
	let mut cur_key: Option<String> = None;
	let mut result: Option<Json> = None;
	let fail = |pos: usize, m: &str| -> String { format!("Near offset {pos}: {m}") };
	let index_of = |from: usize, pat: &str| s[from..].find(pat).map(|i| i + from);

	// The value of a primitive element, as `parseValue`'s callers put it into the current container.
	fn put(
		stack: &mut [Frame],
		cur_key: &mut Option<String>,
		result: &mut Option<Json>,
		v: Json,
	) -> Result<(), String> {
		match stack.last_mut() {
			Some(Frame::Dict(o, _)) => {
				let Some(k) = cur_key.take() else {
					return Err("missing <key>".into());
				};
				o.set(k, v);
			}
			Some(Frame::Array(a, _)) => a.push(v),
			None => *result = Some(v),
		}
		Ok(())
	}
	fn close(
		stack: &mut Vec<Frame>,
		cur_key: &mut Option<String>,
		result: &mut Option<Json>,
		dict: bool,
	) -> Result<(), String> {
		let frame = match stack.pop() {
			Some(f @ Frame::Dict(..)) if dict => f,
			Some(f @ Frame::Array(..)) if !dict => f,
			_ => {
				return Err(if dict {
					"unexpected </dict>".into()
				} else {
					"unexpected </array>".into()
				});
			}
		};
		let (v, key) = match frame {
			Frame::Dict(o, k) => (o.finish(), k),
			Frame::Array(a, k) => (Json::Array(a), k),
		};
		match stack.last_mut() {
			Some(Frame::Dict(o, _)) => o.set(key.unwrap_or_default(), v),
			Some(Frame::Array(a, _)) => a.push(v),
			None => *result = Some(v),
		}
		let _ = cur_key;
		Ok(())
	}
	fn open(
		stack: &mut Vec<Frame>,
		cur_key: &mut Option<String>,
		dict: bool,
	) -> Result<(), String> {
		let key = match stack.last() {
			Some(Frame::Dict(..)) => match cur_key.take() {
				Some(k) => Some(k),
				None => return Err("missing <key>".into()),
			},
			_ => None,
		};
		stack.push(if dict {
			Frame::Dict(ObjectBuilder::default(), key)
		} else {
			Frame::Array(Vec::new(), key)
		});
		Ok(())
	}
	fn decode(t: &str) -> String {
		// The three `replace` calls of parseValue, in order.
		fn rep(t: &str, prefix: &str, radix: u32, digit: fn(u8) -> bool) -> String {
			let mut out = String::with_capacity(t.len());
			let mut i = 0;
			let b = t.as_bytes();
			while let Some(off) = t[i..].find(prefix) {
				let at = i + off;
				let ds = at + prefix.len();
				let mut de = ds;
				while de < b.len() && digit(b[de]) {
					de += 1;
				}
				if de > ds && b.get(de) == Some(&b';') {
					out.push_str(&t[i..at]);
					let cp = u32::from_str_radix(&t[ds..de], radix)
						.ok()
						.and_then(char::from_u32)
						.unwrap_or('\u{FFFD}');
					out.push(cp);
					i = de + 1;
				} else {
					out.push_str(&t[i..ds]);
					i = ds;
				}
			}
			out.push_str(&t[i..]);
			out
		}
		let t = rep(t, "&#", 10, |c| c.is_ascii_digit());
		let t = rep(&t, "&#x", 16, |c| {
			c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
		});
		let mut out = String::with_capacity(t.len());
		let mut i = 0;
		while let Some(off) = t[i..].find('&') {
			let at = i + off;
			out.push_str(&t[i..at]);
			let rest = &t[at..];
			let mut done = false;
			for (e, r) in [
				("&amp;", '&'),
				("&lt;", '<'),
				("&gt;", '>'),
				("&quot;", '"'),
				("&apos;", '\''),
			] {
				if rest.starts_with(e) {
					out.push(r);
					i = at + e.len();
					done = true;
					break;
				}
			}
			if !done {
				out.push('&');
				i = at + 1;
			}
		}
		out.push_str(&t[i..]);
		out
	}

	while pos < len {
		while pos < len && matches!(b[pos], b' ' | b'\t' | b'\r' | b'\n') {
			pos += 1;
		}
		if pos >= len {
			break;
		}
		let c = b[pos];
		pos += 1;
		if c != b'<' {
			return Err(fail(pos, "expected <"));
		}
		if pos >= len {
			return Err(fail(pos, "unexpected end of input"));
		}
		let p2 = b[pos];
		if p2 == b'?' {
			pos += 1;
			pos = index_of(pos, "?>").map_or(len, |i| i + 2);
			continue;
		}
		if p2 == b'!' {
			pos += 1;
			if b[pos..].starts_with(b"--") {
				pos += 2;
				pos = index_of(pos, "-->").map_or(len, |i| i + 3);
				continue;
			}
			pos = index_of(pos, ">").map_or(len, |i| i + 1);
			continue;
		}
		if p2 == b'/' {
			pos += 1;
			while pos < len && matches!(b[pos], b' ' | b'\t' | b'\r' | b'\n') {
				pos += 1;
			}
			let tag = if b[pos..].starts_with(b"plist") {
				pos += 5;
				0
			} else if b[pos..].starts_with(b"dict") {
				pos += 4;
				1
			} else if b[pos..].starts_with(b"array") {
				pos += 5;
				2
			} else {
				return Err(fail(pos, "unexpected closed tag"));
			};
			pos = index_of(pos, ">").map_or(len, |i| i + 1);
			match tag {
				1 => {
					close(&mut stack, &mut cur_key, &mut result, true).map_err(|m| fail(pos, &m))?
				}
				2 => close(&mut stack, &mut cur_key, &mut result, false)
					.map_err(|m| fail(pos, &m))?,
				_ => {}
			}
			continue;
		}
		// parseOpenTag
		let (mut name, next) = match index_of(pos, ">") {
			Some(i) => (&s[pos..i], i + 1),
			None => (&s[pos..], len),
		};
		pos = next;
		let mut is_closed = false;
		if name.ends_with('/') {
			is_closed = true;
			name = &name[..name.len() - 1];
		}
		let name = name.trim();
		// parseTagValue
		let value = |pos: &mut usize| -> String {
			if is_closed {
				return String::new();
			}
			let (t, next) = match index_of(*pos, "</") {
				Some(i) => (&s[*pos..i], i + 2),
				None => (&s[*pos..], len),
			};
			*pos = next;
			*pos = index_of(*pos, ">").map_or(len, |i| i + 1);
			decode(t)
		};
		match name {
			"dict" | "array" => {
				let dict = name == "dict";
				open(&mut stack, &mut cur_key, dict).map_err(|m| fail(pos, &m))?;
				if is_closed {
					close(&mut stack, &mut cur_key, &mut result, dict)
						.map_err(|m| fail(pos, &m))?;
				}
			}
			"key" => {
				let k = value(&mut pos);
				if !matches!(stack.last(), Some(Frame::Dict(..))) {
					return Err(fail(pos, "unexpected <key>"));
				}
				if cur_key.is_some() {
					return Err(fail(pos, "too many <key>"));
				}
				cur_key = Some(k);
			}
			"string" | "date" | "data" => {
				let v = value(&mut pos);
				put(&mut stack, &mut cur_key, &mut result, Json::String(v))
					.map_err(|m| fail(pos, &m))?;
			}
			"real" | "integer" => {
				let v = value(&mut pos);
				let n = if name == "real" {
					parse_float(&v)
				} else {
					crate::utils::parse_int(&v).map(|x| x as f64)
				};
				let Some(n) = n else {
					return Err(fail(
						pos,
						if name == "real" {
							"cannot parse float"
						} else {
							"cannot parse integer"
						},
					));
				};
				put(&mut stack, &mut cur_key, &mut result, Json::Number(n))
					.map_err(|m| fail(pos, &m))?;
			}
			"true" | "false" => {
				value(&mut pos);
				put(
					&mut stack,
					&mut cur_key,
					&mut result,
					Json::Bool(name == "true"),
				)
				.map_err(|m| fail(pos, &m))?;
			}
			_ => {
				if !name.starts_with("plist") {
					return Err(fail(pos, &format!("unexpected opened tag {name}")));
				}
			}
		}
	}
	Ok(result.unwrap_or(Json::Null))
}

/// `parseFloat`: the longest decimal prefix (after whitespace), else NaN (None).
fn parse_float(s: &str) -> Option<f64> {
	let t = s.trim_start();
	let b = t.as_bytes();
	let mut end = 0;
	let mut best = None;
	while end < b.len() && matches!(b[end], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-') {
		end += 1;
		if let Ok(v) = t[..end].parse::<f64>() {
			best = Some(v);
		}
	}
	best
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn js_key_order() {
		let v = parse_json(r#"{"b":1,"2":2,"a":3,"1":4,"b":5,"01":6}"#).unwrap();
		let keys: Vec<_> = v
			.as_object()
			.unwrap()
			.iter()
			.map(|(k, v)| format!("{k}={}", v.as_f64().unwrap()))
			.collect();
		assert_eq!(keys, ["1=4", "2=2", "b=5", "a=3", "01=6"]);
	}

	#[test]
	fn plist() {
		let v = parse_plist("<?xml version=\"1.0\"?>\n<!DOCTYPE plist>\n<plist version=\"1.0\"><dict><key>a</key><string>x &amp;lt; &#65;</string><key>p</key><array><dict/><true/></array></dict></plist>").unwrap();
		assert_eq!(
			v,
			Json::Object(vec![
				("a".into(), Json::String("x &lt; A".into())),
				(
					"p".into(),
					Json::Array(vec![Json::Object(vec![]), Json::Bool(true)])
				)
			])
		);
	}
}
