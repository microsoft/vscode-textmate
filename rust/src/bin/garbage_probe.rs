/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! Prints what this crate's scanner finds with patterns Oniguruma rejects, in the format of probe/garbage.js
//! (vscode-oniguruma 1.7.0), so that the two outputs can be compared with diff.
//! Usage: garbage_probe
use vscode_textmate::onig_lib::{NativeOnigLib, OnigLib, OnigMatch, OnigString};

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

fn fmt(m: Option<OnigMatch>) -> String {
	match m {
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
	}
}

fn run(label: &str, patterns: &[&str], input: &str, start: usize, repeat: usize) {
	let patterns: Vec<String> = patterns.iter().map(|p| p.to_string()).collect();
	let sc = NativeOnigLib.create_onig_scanner(&patterns);
	let s = OnigString::new(input.to_string());
	let mut res: Vec<String> = Vec::new();
	for _ in 0..repeat {
		let r = fmt(sc.find_next_match_sync(&s, start));
		if !res.contains(&r) {
			res.push(r);
		}
	}
	println!("{:<58} {}", label, res.join(" | "));
}

fn main() {
	let long = "x".repeat(1200) + "abc";
	let non_ascii = "ééé abc ééé";
	for bad in ["(", "[a", "\\p{Foo}", "^*", "(?<a>x)\\k<b>"] {
		println!("--- invalid pattern {}", json_string(bad));
		run("alone, short, start 0", &[bad], "abc abc", 0, 1);
		run("alone, short, start 3", &[bad], "abc abc", 3, 1);
		run("alone, short, start 7 (end)", &[bad], "abc abc", 7, 1);
		run("alone, empty string", &[bad], "", 0, 1);
		// garbage.js passes a plain JS string here; this crate only has OnigString.
		run(
			"alone, short, plain JS string, start 2",
			&[bad],
			"abc abc",
			2,
			1,
		);
		run("alone, non-ASCII, start 4", &[bad], non_ascii, 4, 1);
		run("alone, 1203-byte string, start 0", &[bad], &long, 0, 1);
		run(
			"alone, 1203-byte string, start 1200",
			&[bad],
			&long,
			1200,
			1,
		);
		run(
			"alone, short, same scanner x5, start 2",
			&[bad],
			"abc abc",
			2,
			5,
		);
		run(
			"[valid \"b\", bad], short, start 0",
			&["b", bad],
			"abc abc",
			0,
			1,
		);
		run(
			"[bad, valid \"b\"], short, start 0",
			&[bad, "b"],
			"abc abc",
			0,
			1,
		);
		run(
			"[valid \"c\", bad, valid \"a\"], short, start 3",
			&["c", bad, "a"],
			"abc abc",
			3,
			1,
		);
		run(
			"[valid \"b\", bad], 1203-byte string, start 0",
			&["b", bad],
			&long,
			0,
			1,
		);
		run(
			"[bad, valid \"b\"], 1203-byte string, start 0",
			&[bad, "b"],
			&long,
			0,
			1,
		);
		run(
			"[valid \"zzz\" (no match), bad], short, start 1",
			&["zzz", bad],
			"abc abc",
			1,
			1,
		);
		run(
			"afterwards: valid [\"b\"] still works, start 0",
			&["b"],
			"abc abc",
			0,
			1,
		);
		run(
			"afterwards: valid [\"b\"] on 1203-byte string",
			&["b"],
			&long,
			0,
			1,
		);
	}
	println!("--- empty pattern list");
	run("[], short, start 0", &[], "abc abc", 0, 1);
	run("[], 1203-byte string, start 0", &[], &long, 0, 1);
	println!("--- 1000-byte boundary (vscode-textmate searches line + \"\\n\")");
	run(
		"alone \"(\", 999-byte string, start 0",
		&["("],
		&"x".repeat(999),
		0,
		1,
	);
	run(
		"alone \"(\", 1000-byte string, start 0",
		&["("],
		&"x".repeat(1000),
		0,
		1,
	);
	run(
		"[valid \"x\", \"(\"], 999-byte string, start 5",
		&["x", "("],
		&"x".repeat(999),
		5,
		1,
	);
	run(
		"[valid \"x\", \"(\"], 1000-byte string, start 5",
		&["x", "("],
		&"x".repeat(1000),
		5,
		1,
	);
	println!("--- valid patterns that onig_regset_new rejects (find-longest option)");
	run("alone \"(?L)a\", short, start 0", &["(?L)a"], "xaa", 0, 1);
	run(
		"[valid \"x\", \"(?L)a\"], short, start 0",
		&["x", "(?L)a"],
		"xaa",
		0,
		1,
	);
	run(
		"alone \"(?L)a\", 1203-byte string, start 0",
		&["(?L)a"],
		&long,
		0,
		1,
	);
	run(
		"[valid \"x\", \"(?L)a\"], 1203-byte string, start 1200",
		&["x", "(?L)a"],
		&long,
		1200,
		1,
	);
}
