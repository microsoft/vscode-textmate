/*---------------------------------------------------------------------------------------------
 *  Copied from https://github.com/atom/first-mate/blob/master/src/scope-selector-parser.pegjs
 *
 *  Copyright (c) 2013 GitHub Inc. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

{ var matchers = require('./scope-selector-matchers'); }

start = _ selector:(selector) _ {
	return selector;
}

segment
	= _ segment:([a-zA-Z0-9+_]+[a-zA-Z0-9-+_]*) _ {
		return new matchers.SegmentMatcher(segment);
	}

	/ _ scopeName:[\*] _ {
		return new matchers.TrueMatcher();
	}

scope
	= first:segment others:("." segment)* {
		return new matchers.ScopeMatcher(first, others);
	}

path
	= prefix:([LRB]":")? first:scope others:(_ scope)* {
		return new matchers.PathMatcher(prefix, first, others);
	}

group
	= prefix:([LRB]":")? "(" _ selector:selector _ ")" {
		return new matchers.GroupMatcher(prefix, selector);
	}

expression
	= "-" _ group:group _ {
		return new matchers.NegateMatcher(group);
	}

	/ "-" _ path:path _ {
		return new matchers.NegateMatcher(path);
	}

	/ group

	/ path

composite
	= left:expression _ operator:[|&-] _ right:composite {
		return new matchers.CompositeMatcher(left, operator, right);
	}

	/ expression

selector
	= left:composite _ "," _ right:selector? {
		if (right)
			return new matchers.OrMatcher(left, right);
		else
			return left;
	}

	/ composite

_
	= [ \t]*
