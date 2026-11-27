/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! The cases of vscode-textmate's `src/tests/json.test.ts` (the same in v9.3.2 and on main), transcribed.
//!
//! Upstream checks its debug-mode `parseJSON` against `JSON.parse`. The port's `parse_json` is the `JSON.parse` that
//! parseRawGrammar.ts uses outside debug mode, so each valid case is checked against what node prints for
//! `JSON.stringify(JSON.parse(input))`, and each invalid case must fail.

use vscode_textmate::json::{Json, parse_json};

/// `JSON.stringify`, for the values in these tests (numbers print like JS between 1e-6 and 1e21).
fn stringify(v: &Json) -> String {
	let mut out = String::new();
	write_value(v, &mut out);
	out
}

fn write_value(v: &Json, out: &mut String) {
	match v {
		Json::Null => out.push_str("null"),
		Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
		Json::Number(n) if !n.is_finite() => out.push_str("null"),
		Json::Number(n) if *n == 0.0 => out.push('0'),
		Json::Number(n) => out.push_str(&n.to_string()),
		Json::String(s) => write_string(s, out),
		Json::Array(a) => {
			out.push('[');
			for (i, v) in a.iter().enumerate() {
				if i > 0 {
					out.push(',');
				}
				write_value(v, out);
			}
			out.push(']');
		}
		Json::Object(o) => {
			out.push('{');
			for (i, (k, v)) in o.iter().enumerate() {
				if i > 0 {
					out.push(',');
				}
				write_string(k, out);
				out.push(':');
				write_value(v, out);
			}
			out.push('}');
		}
	}
}

fn write_string(s: &str, out: &mut String) {
	out.push('"');
	for c in s.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\u{8}' => out.push_str("\\b"),
			'\u{c}' => out.push_str("\\f"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
			c => out.push(c),
		}
	}
	out.push('"');
}

fn is_valid(json: &str, expected: &str) {
	match parse_json(json) {
		Ok(v) => assert_eq!(stringify(&v), expected, "for {json:?}"),
		Err(e) => panic!("expected valid: {json:?}: {e}"),
	}
}

fn is_invalid(json: &str) {
	assert!(parse_json(json).is_err(), "expected invalid: {json:?}");
}

#[test]
fn json_invalid_body() {
	is_invalid("{}[]");
	is_invalid("*");
}

#[test]
fn json_trailing_whitespace() {
	is_valid("{}\n\n", "{}");
}

#[test]
fn json_objects() {
	is_valid("{}", "{}");
	is_valid(r#"{"key": "value"}"#, r#"{"key":"value"}"#);
	is_valid(
		r#"{"key1": true, "key2": 3, "key3": [null], "key4": { "nested": {}}}"#,
		r#"{"key1":true,"key2":3,"key3":[null],"key4":{"nested":{}}}"#,
	);
	is_valid(r#"{"constructor": true }"#, r#"{"constructor":true}"#);

	is_invalid("{");
	is_invalid("{3:3}");
	is_invalid("{'key': 3}");
	is_invalid(r#"{"key" 3}"#);
	is_invalid(r#"{"key":3 "key2": 4}"#);
	is_invalid(r#"{"key":42, }"#);
	is_invalid(r#"{"key:42"#);
}

#[test]
fn json_arrays() {
	is_valid("[]", "[]");
	is_valid("[1, 2]", "[1,2]");
	is_valid(
		r#"[1, "string", false, {}, [null]]"#,
		r#"[1,"string",false,{},[null]]"#,
	);

	is_invalid("[");
	is_invalid("[,]");
	is_invalid("[1 2]");
	is_invalid("[true false]");
	is_invalid("[1, ]");
	is_invalid("[[]");
	is_invalid(r#"["something""#);
	is_invalid("[magic]");
}

#[test]
fn json_strings() {
	is_valid(r#"["string"]"#, r#"["string"]"#);
	is_valid(
		r#"["\"\\\/\b\f\n\r\t\u1234\u12AB"]"#,
		"[\"\\\"\\\\/\\b\\f\\n\\r\\t\u{1234}\u{12AB}\"]",
	);
	is_valid(r#"["\\"]"#, r#"["\\"]"#);

	is_invalid(r#"[""#);
	is_invalid(r#"["]"#);
	is_invalid(r#"["\z"]"#);
	is_invalid(r#"["\u"]"#);
	is_invalid(r#"["\u123"]"#);
	is_invalid(r#"["\u123Z"]"#);
	is_invalid("['string']");
}

#[test]
fn json_numbers() {
	is_valid(
		"[0, -1, 186.1, 0.123, -1.583e+4, 1.583E-4, 5e8]",
		"[0,-1,186.1,0.123,-15830,0.0001583,500000000]",
	);
}

#[test]
fn json_misc() {
	is_valid("{}", "{}");
	is_valid("[null]", "[null]");
	is_valid(r#"{"a":true}"#, r#"{"a":true}"#);
	is_valid(
		"{\n\t\"key\" : {\n\t\"key2\": 42\n\t}\n}",
		r#"{"key":{"key2":42}}"#,
	);
	is_valid(r#"{"key":[{"key2":42}]}"#, r#"{"key":[{"key2":42}]}"#);
	is_valid("{\n\t\n}", "{}");
	is_valid("{\n\"first\":true\n\n}", r#"{"first":true}"#);
	is_valid("{\n\"key\":32,\n\n\"key2\":45}", r#"{"key":32,"key2":45}"#);
	is_valid("{\"a\": 1,\n\n\"d\": 2}", r#"{"a":1,"d":2}"#);
	is_valid(r#"{"a": 1, "a": 2}"#, r#"{"a":2}"#);
	is_valid(r#"{"a": { "a": 2, "a": 3}}"#, r#"{"a":{"a":3}}"#);
	is_valid(r#"[{ "a": 2, "a": 3}]"#, r#"[{"a":3}]"#);
	is_valid(
		r#"{"key1":"first string", "key2":["second string"]}"#,
		r#"{"key1":"first string","key2":["second string"]}"#,
	);

	is_invalid("{\n\"key\":32,\nerror\n}");
}

/// Not in upstream: `JSON.parse` behavior beyond its cases, each checked with node. The first six are the number cases
/// upstream has commented out.
#[test]
fn json_parse_semantics_beyond_upstream() {
	let invalid = [
		"[+1]",
		"[01]",
		"[1.]",
		"[1.1+3]",
		"[1.4e]",
		"[-A]",
		"[-01]",
		"[.5]",
		"[-]",
		"[1,]",
		r#"["\u+123"]"#,
		"[\"\\u12\u{e9}Z\"]",
		r#"["a\u00"]"#,
		"\u{feff}{}",
		"[\"a\tb\"]",
		"\u{a0}[]",
		"\u{b}[]",
		"\u{c}[]",
		"[\u{2028}1]",
	];
	for json in invalid {
		is_invalid(json);
	}
	is_valid("[-0]", "[0]");
	is_valid("[0.0e-0]", "[0]");
	is_valid("[1e400]", "[null]");
	is_valid("[1E+2]", "[100]");
	is_valid("[ 1 ]", "[1]");
	is_valid("[\"\u{7f}\"]", "[\"\u{7f}\"]");
	is_valid(r#"{"__proto__":1}"#, r#"{"__proto__":1}"#);
	// JS keeps the lone surrogate ("\ud800A"), which a Rust String cannot hold: the port gives U+FFFD.
	is_valid(r#"["\ud800\u0041"]"#, "[\"\u{fffd}A\"]");
}
