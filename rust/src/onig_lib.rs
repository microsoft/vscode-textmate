/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! onigLib.ts: the regex engine seam (IOnigLib, OnigScanner, OnigString), and a native backend on C Oniguruma
//! that reproduces vscode-oniguruma's search (regset search for short lines, per-regex cached search for long ones).
use onig_sys as o;
use std::cell::RefCell;
use std::os::raw::c_int;
use std::ptr::null_mut;
use std::sync::Once;
use std::sync::atomic::{AtomicI64, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaptureIndex {
	pub start: usize,
	pub end: usize,
}

impl CaptureIndex {
	pub fn length(&self) -> usize {
		self.end.saturating_sub(self.start)
	}
}

pub struct OnigMatch {
	pub index: usize,
	pub capture_indices: Vec<CaptureIndex>,
}

/// IOnigLib's `OnigScanner`.
pub trait OnigScanner {
	fn find_next_match_sync(&self, string: &OnigString, start_position: usize)
	-> Option<OnigMatch>;
}

/// IOnigLib.
pub trait OnigLib {
	fn create_onig_scanner(&self, sources: &[String]) -> Box<dyn OnigScanner>;
	fn create_onig_string(&self, s: String) -> OnigString {
		OnigString::new(s)
	}
}

static NEXT_STRING_ID: AtomicI64 = AtomicI64::new(1);

/// A line as vscode-oniguruma's OnigString sees it: UTF-8 bytes, UTF-16 positions, and the offset maps (only for non-ASCII text).
pub struct OnigString {
	pub content: String,
	sid: i64,
	u8len: usize,
	u16len: usize,
	m16to8: Option<Vec<u32>>,
	m8to16: Option<Vec<u32>>,
}

impl OnigString {
	pub fn new(text: String) -> OnigString {
		let sid = NEXT_STRING_ID.fetch_add(1, Ordering::Relaxed);
		let u8len = text.len();
		if text.is_ascii() {
			return OnigString {
				content: text,
				sid,
				u8len,
				u16len: u8len,
				m16to8: None,
				m8to16: None,
			};
		}
		let u16len: usize = text.chars().map(|c| c.len_utf16()).sum();
		let mut m16to8 = vec![0u32; u16len + 1];
		let mut m8to16 = vec![0u32; u8len + 1];
		let (mut i8, mut i16) = (0usize, 0usize);
		for c in text.chars() {
			let (l8, l16) = (c.len_utf8(), c.len_utf16());
			m16to8[i16] = i8 as u32;
			if l16 == 2 {
				m16to8[i16 + 1] = i8 as u32;
			}
			for k in 0..l8 {
				m8to16[i8 + k] = i16 as u32;
			}
			i8 += l8;
			i16 += l16;
		}
		m16to8[u16len] = u8len as u32;
		m8to16[u8len] = u16len as u32;
		OnigString {
			content: text,
			sid,
			u8len,
			u16len,
			m16to8: Some(m16to8),
			m8to16: Some(m8to16),
		}
	}
	/// `content.length` in JavaScript (UTF-16 code units).
	pub fn len16(&self) -> usize {
		self.u16len
	}
	/// `content.substring(start, end)`, with UTF-16 positions.
	pub fn slice16(&self, start: usize, end: usize) -> &str {
		let (mut s, mut e) = (start.min(self.u16len), end.min(self.u16len));
		if s > e {
			std::mem::swap(&mut s, &mut e);
		}
		let (s8, e8) = (self.to8(s as i64) as usize, self.to8(e as i64) as usize);
		&self.content[s8..e8]
	}
	fn to8(&self, o: i64) -> i64 {
		match &self.m16to8 {
			None => o,
			Some(m) => {
				if o < 0 {
					0
				} else if o as usize > self.u16len {
					self.u8len as i64
				} else {
					m[o as usize] as i64
				}
			}
		}
	}
	fn to16(&self, o: i64) -> i64 {
		match &self.m8to16 {
			None => o,
			Some(m) => {
				if o < 0 {
					0
				} else if o as usize > self.u8len {
					self.u16len as i64
				} else {
					m[o as usize] as i64
				}
			}
		}
	}
}

/// The native backend: C Oniguruma 6.9.8 (the sources vscode-oniguruma 1.7.0 compiles to WASM, bundled by
/// onig_sys 69.8.1), searched like vscode-oniguruma's onig.cc.
pub struct NativeOnigLib;

impl NativeOnigLib {
	/// Like `create_onig_scanner`, but returns Oniguruma's message when a pattern doesn't compile, where
	/// vscode-oniguruma 1.7.0 builds a scanner anyway (see `create_onig_scanner`).
	pub fn try_create_onig_scanner(
		&self,
		sources: &[String],
	) -> Result<Box<dyn OnigScanner>, String> {
		if sources.is_empty() {
			return Ok(Box::new(NativeScanner(RefCell::new(None))));
		}
		let sc = onig_compile(sources, true)?;
		Ok(Box::new(NativeScanner(RefCell::new(Some(sc)))))
	}
}

impl OnigLib for NativeOnigLib {
	/// Never fails, like vscode-oniguruma 1.7.0's `createOnigScanner`: its onig.cc reads a failed pattern's regex
	/// before checking it for NULL, and ignores what `onig_regset_new` returns. What such a scanner then finds is
	/// deterministic, and reproduced here. On lines shorter than 1000 UTF-8 bytes, a scanner whose patterns all fail
	/// matches the empty string at the start position as pattern 0, and a scanner that mixes failing and compiling
	/// patterns never matches. On longer lines, failing patterns never match and the others work as usual.
	fn create_onig_scanner(&self, sources: &[String]) -> Box<dyn OnigScanner> {
		if sources.is_empty() {
			return Box::new(NativeScanner(RefCell::new(None)));
		}
		match onig_compile(sources, false) {
			Ok(sc) => Box::new(NativeScanner(RefCell::new(Some(sc)))),
			Err(e) => unreachable!("lenient compile failed: {e}"),
		}
	}
}

struct NativeScanner(RefCell<Option<Scanner>>);

impl OnigScanner for NativeScanner {
	fn find_next_match_sync(
		&self,
		string: &OnigString,
		start_position: usize,
	) -> Option<OnigMatch> {
		let mut b = self.0.borrow_mut();
		let sc = b.as_mut()?;
		let mut out = Vec::new();
		let idx = onig_find(sc, string, string.sid, start_position as i64, &mut out)?;
		let capture_indices = out
			.chunks(2)
			.map(|p| CaptureIndex {
				start: p[0] as usize,
				end: p[1] as usize,
			})
			.collect();
		Some(OnigMatch {
			index: idx,
			capture_indices,
		})
	}
}

struct Scanner {
	/// Null when a pattern failed to compile, or when Oniguruma refused to put the regexes in a set.
	set: *mut o::OnigRegSet,
	/// Null for a pattern that failed to compile.
	regs: Vec<o::OnigRegex>,
	regions: Vec<*mut o::OnigRegion>,
	has_g: Vec<bool>,
	cache: Vec<(i64, i64, bool)>,
	/// Every pattern failed to compile (see `create_onig_scanner`).
	all_invalid: bool,
}

impl Drop for Scanner {
	fn drop(&mut self) {
		unsafe {
			if self.set.is_null() {
				free_regs(&self.regs);
			} else {
				o::onig_regset_free(self.set); // also frees the regexes
			}
			for &r in &self.regions {
				o::onig_region_free(r, 1);
			}
		}
	}
}

fn free_regs(regs: &[o::OnigRegex]) {
	for &r in regs {
		if !r.is_null() {
			unsafe { o::onig_free(r) };
		}
	}
}

static ONIG_INIT: Once = Once::new();

/// Oniguruma initializes its global tables (encodings, built-in callouts) lazily and without a lock on the first
/// `onig_new`, so two threads compiling their first regex at the same time race on them. Initialize them once,
/// up front; after that, compiling only reads them. (vscode-oniguruma runs in single-threaded WASM and never races.)
fn ensure_onig_initialized() {
	ONIG_INIT.call_once(|| {
		let mut encodings = [&raw mut o::OnigEncodingUTF8 as o::OnigEncoding];
		let r = unsafe { o::onig_initialize(encodings.as_mut_ptr(), encodings.len() as c_int) };
		assert_eq!(r, o::ONIG_NORMAL as c_int, "onig_initialize failed: {r}");
	});
}

fn onig_new_one(p: &str) -> Result<o::OnigRegex, String> {
	ensure_onig_initialized();
	let b = p.as_bytes();
	let mut reg: o::OnigRegex = null_mut();
	unsafe {
		let mut einfo: o::OnigErrorInfo = std::mem::zeroed();
		let r = o::onig_new(
			&mut reg,
			b.as_ptr(),
			b.as_ptr().add(b.len()),
			o::ONIG_OPTION_CAPTURE_GROUP,
			&raw mut o::OnigEncodingUTF8,
			o::OnigDefaultSyntax,
			&mut einfo,
		);
		if r != o::ONIG_NORMAL as c_int {
			let mut buf = [0u8; 256];
			let n =
				o::onig_error_code_to_str(buf.as_mut_ptr(), r, &mut einfo as *mut o::OnigErrorInfo);
			return Err(String::from_utf8_lossy(&buf[..n.max(0) as usize]).into_owned());
		}
	}
	Ok(reg)
}

/// Compiles the patterns and puts them in a regset. `strict` fails on the first pattern Oniguruma rejects, or when
/// it refuses the set; otherwise the scanner keeps what vscode-oniguruma 1.7.0 keeps (see `create_onig_scanner`).
fn onig_compile(pats: &[String], strict: bool) -> Result<Scanner, String> {
	let mut regs: Vec<o::OnigRegex> = Vec::with_capacity(pats.len());
	for p in pats {
		match onig_new_one(p) {
			Ok(r) => regs.push(r),
			Err(e) if strict => {
				free_regs(&regs);
				return Err(e);
			}
			Err(_) => regs.push(null_mut()),
		}
	}
	let mut set: *mut o::OnigRegSet = null_mut();
	if regs.iter().all(|r| !r.is_null()) {
		// On failure, onig_regset_new leaves `set` null and the regexes to us.
		let r = unsafe { o::onig_regset_new(&mut set, regs.len() as c_int, regs.as_mut_ptr()) };
		if r != o::ONIG_NORMAL as c_int {
			if strict {
				free_regs(&regs);
				return Err(format!("onig_regset_new failed: {r}"));
			}
			set = null_mut();
		}
	}
	let all_invalid = !regs.is_empty() && regs.iter().all(|r| r.is_null());
	let regions = (0..regs.len())
		.map(|_| unsafe { o::onig_region_new() })
		.collect();
	let has_g = pats.iter().map(|p| p.contains("\\G")).collect();
	let cache = vec![(0, 0, false); regs.len()];
	Ok(Scanner {
		set,
		regs,
		regions,
		has_g,
		cache,
		all_invalid,
	})
}

/// onig.cc `_searchOnigRegExp`: per-regex result cache for long lines, skipped for patterns with \G.
fn search_cached(
	sc: &mut Scanner,
	i: usize,
	s: &OnigString,
	sid: i64,
	pos8: i64,
) -> Option<*mut o::OnigRegion> {
	let region = sc.regions[i];
	if !sc.has_g[i] {
		let (csid, cpos, cmatched) = sc.cache[i];
		if csid == sid && cpos <= pos8 {
			if !cmatched {
				return None;
			}
			let beg0 = unsafe { *(*region).beg } as i64;
			if beg0 >= pos8 {
				return Some(region);
			}
		}
	}
	let p = s.content.as_ptr();
	let status = unsafe {
		let end = p.add(s.u8len);
		o::onig_search(
			sc.regs[i],
			p,
			end,
			p.add(pos8 as usize),
			end,
			region,
			o::ONIG_OPTION_NONE,
		)
	};
	if !sc.has_g[i] {
		sc.cache[i] = (sid, pos8, status >= 0);
	}
	if status >= 0 { Some(region) } else { None }
}

/// onig.cc `findNextOnigScannerMatch` + index.ts `_findNextMatchSync`.
fn onig_find(
	sc: &mut Scanner,
	s: &OnigString,
	sid: i64,
	pos16: i64,
	out: &mut Vec<i64>,
) -> Option<usize> {
	out.clear();
	let pos8 = s.to8(pos16);
	if pos8 > s.u8len as i64 {
		return None;
	}
	let (idx, region) = if s.u8len < 1000 {
		if sc.set.is_null() {
			// vscode-oniguruma 1.7.0 without a regset (see `create_onig_scanner`).
			if !sc.all_invalid {
				return None;
			}
			out.push(s.to16(pos8));
			out.push(s.to16(pos8));
			return Some(0);
		}
		let p = s.content.as_ptr();
		let mut best: c_int = 0;
		let idx = unsafe {
			let end = p.add(s.u8len);
			o::onig_regset_search(
				sc.set,
				p,
				end,
				p.add(pos8 as usize),
				end,
				o::OnigRegSetLead_ONIG_REGSET_POSITION_LEAD,
				o::ONIG_OPTION_NONE,
				&mut best,
			)
		};
		if idx < 0 {
			return None;
		}
		(idx as usize, unsafe {
			o::onig_regset_get_region(sc.set, idx)
		})
	} else {
		let mut best: Option<(usize, *mut o::OnigRegion)> = None;
		let mut best_loc = 0i64;
		for i in 0..sc.regs.len() {
			if sc.regs[i].is_null() {
				continue;
			}
			if let Some(r) = search_cached(sc, i, s, sid, pos8) {
				if unsafe { (*r).num_regs } > 0 {
					let loc = unsafe { *(*r).beg } as i64;
					if best.is_none() || loc < best_loc {
						best_loc = loc;
						best = Some((i, r));
					}
					if loc == pos8 {
						break;
					}
				}
			}
		}
		best?
	};
	let nr = unsafe { (*region).num_regs };
	if nr > 1000 {
		return None;
	}
	for k in 0..nr as usize {
		let (b, e) = unsafe { (*(*region).beg.add(k), *(*region).end.add(k)) };
		out.push(s.to16(b as u32 as i64));
		out.push(s.to16(e as u32 as i64));
	}
	Some(idx)
}
