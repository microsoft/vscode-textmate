/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//! diffStateStacks.ts: `diffStateStacksRefEq` and `applyStateStackDiff`, to pass a line's end state as its
//! difference from the previous line's end state.
//!
//! `INITIAL` is `None` here, where vscode-textmate has a `StateStackImpl.NULL` element of depth 1: a diff from
//! `INITIAL` counts one pop fewer than vscode-textmate's, and leads to an equal state.
use crate::grammar::{StateStack, StateStackFrame};
use std::rc::Rc;

/// diffStateStacks.ts `StackDiff`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StackDiff {
	pub pops: usize,
	pub new_frames: Vec<StateStackFrame>,
}

fn same(a: Option<&Rc<StateStack>>, b: Option<&Rc<StateStack>>) -> bool {
	match (a, b) {
		(None, None) => true,
		(Some(a), Some(b)) => Rc::ptr_eq(a, b),
		_ => false,
	}
}

/// `diffStateStacksRefEq(first, second)`: the pops and pushes that turn `first` into `second`, comparing elements
/// by reference.
pub fn diff_state_stacks_ref_eq(
	first: Option<&Rc<StateStack>>,
	second: Option<&Rc<StateStack>>,
) -> StackDiff {
	let mut pops = 0;
	let mut new_frames = Vec::new();
	let mut cur_first = first;
	let mut cur_second = second;
	while !same(cur_first, cur_second) {
		if let Some(f) = cur_first.filter(|f| cur_second.is_none_or(|s| f.depth >= s.depth)) {
			pops += 1;
			cur_first = f.parent.as_ref();
		} else if let Some(s) = cur_second {
			new_frames.push(s.to_state_stack_frame());
			cur_second = s.parent.as_ref();
		}
	}
	new_frames.reverse();
	StackDiff { pops, new_frames }
}

/// `applyStateStackDiff(stack, diff)`.
pub fn apply_state_stack_diff(
	stack: Option<&Rc<StateStack>>,
	diff: &StackDiff,
) -> Option<Rc<StateStack>> {
	let mut result = stack.cloned();
	for _ in 0..diff.pops {
		result = result.and_then(|s| s.parent.clone());
	}
	for frame in &diff.new_frames {
		result = Some(StateStack::push_frame(result.as_ref(), frame));
	}
	result
}
