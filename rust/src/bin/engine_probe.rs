/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Runs probe/cases.json through the native Oniguruma that this crate links, one JSON line per case,
//! in the format of probe/probe.js (vscode-oniguruma 1.7.0), so that the two outputs can be compared line by line.
//! By default a pattern that doesn't compile prints Oniguruma's error (`try_create_onig_scanner`); with --lenient,
//! the scanner is built as the tokenizer builds it (`create_onig_scanner`), which matches what vscode-oniguruma does.
//! Usage: engine_probe [--lenient] [cases.json]
use std::fs;
use vscode_textmate::json::{Json, parse_json};
use vscode_textmate::onig_lib::{NativeOnigLib, OnigLib, OnigString};

fn json_string(s: &str) -> String {
	let mut out = String::from("\"");
	for c in s.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
			c => out.push(c),
		}
	}
	out.push('"');
	out
}

fn main() {
	let args: Vec<String> = std::env::args().skip(1).collect();
	let lenient = args.iter().any(|a| a == "--lenient");
	let path = args
		.iter()
		.find(|a| *a != "--lenient")
		.cloned()
		.unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/probe/cases.json").to_string());
	let cases = parse_json(&fs::read_to_string(path).unwrap()).unwrap();
	let lib = NativeOnigLib;
	let version = unsafe { std::ffi::CStr::from_ptr(onig_sys::onig_version()) }
		.to_string_lossy()
		.into_owned();
	println!(
		"{{\"engine\":{}}}",
		json_string(&format!("native Oniguruma {version}"))
	);
	for (i, c) in cases.as_array().unwrap().iter().enumerate() {
		let patterns: Vec<String> = c
			.get("patterns")
			.and_then(Json::as_array)
			.unwrap()
			.iter()
			.map(|p| p.as_str().unwrap().to_string())
			.collect();
		let input = c.get("input").and_then(Json::as_str).unwrap().to_string();
		let start = c.get("start").and_then(Json::as_f64).unwrap() as usize;
		let scanner = if lenient {
			Ok(lib.create_onig_scanner(&patterns))
		} else {
			lib.try_create_onig_scanner(&patterns)
		};
		let r = match scanner {
			Err(e) => format!("{{\"error\":{}}}", json_string(&e)),
			Ok(sc) => match sc.find_next_match_sync(&OnigString::new(input), start) {
				None => "null".to_string(),
				Some(m) => {
					let caps: Vec<String> = m
						.capture_indices
						.iter()
						.map(|x| format!("[{},{}]", x.start, x.end))
						.collect();
					format!(
						"{{\"index\":{},\"captures\":[{}]}}",
						m.index,
						caps.join(",")
					)
				}
			},
		};
		println!("{{\"i\":{i},\"r\":{r}}}");
	}
}
