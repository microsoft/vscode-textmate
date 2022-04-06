/*---------------------------------------------------------------------------------------------
 *  Adapted from https://github.com/atom/first-mate/blob/master/src/scope-selector-matchers.coffee
 *
 *  Copyright (c) 2013 GitHub Inc. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export type AtomMatcher = SegmentMatcher | TrueMatcher;

export type ParsedMatcher = (
	| PathMatcher
	| CompositeMatcher
	| OrMatcher
	| AndMatcher
	| NegateMatcher
);

export type CompositeOperator = '|' | '&' | '-';

export type GroupPrefix = 'L' | 'R' | 'B';

export type SegmentMatch = [string[], string[]];

export type PrefixMatch = [GroupPrefix, ':'];

export class SegmentMatcher {
	segment: string;

	constructor(segments: SegmentMatch) {
		this.segment = segments[0].join('') + segments[1].join('');
	}

	matches(scope: string): boolean {
		return scope === this.segment;
	}

	getPrefix(_: string): void {}
};

export class TrueMatcher {
	constructor() {}

	matches(_: string): boolean {
		return true;
	}

	getPrefix(_: string[]): void {}
};

export class ScopeMatcher {
	segments: Array<AtomMatcher>;

	constructor(first: AtomMatcher, others: Array<[[], AtomMatcher]>) {
		this.segments = [first];
		for (let segment of others) {
			this.segments.push(segment[1]);
		}
	}

	matches(scope: string): boolean {
		const scopeSegments = scope.split('.')
		if (scopeSegments.length < this.segments.length) { return false }

		for (let index = 0; index < this.segments.length; index++) {
			const segment = this.segments[index]
			if (!segment.matches(scopeSegments[index])) {
				return false;
			}
		}

		return true;
	}

	getPrefix(_: string): void {}
};


export class GroupMatcher {
	prefix?: GroupPrefix;
	selector: ScopeMatcher;

	constructor(prefix: PrefixMatch | null | undefined, selector: ScopeMatcher) {
		this.prefix = prefix != null ? prefix[0] : void 0;
		this.selector = selector;
	}

	matches(scopes: string): boolean {
		return this.selector.matches(scopes);
	}

	getPrefix(scopes: string): GroupPrefix | undefined {
		if (this.selector.matches(scopes)) {
			return this.prefix;
		}
	}
};

export class PathMatcher {
	prefix?: GroupPrefix;
	matchers: ScopeMatcher[];

	constructor(prefix: PrefixMatch | null | undefined, first: ScopeMatcher, others: Array<[[], ScopeMatcher]>) {
		this.prefix = prefix ? prefix[0] : undefined;
		this.matchers = [first];
		for (let matcher of others) {
			this.matchers.push(matcher[1]);
		}
	}

	matches(scopes: string[]): boolean {
		let index = 0;
		let matcher = this.matchers[index];

		for (let scope of scopes) {
			if (matcher.matches(scope)) {
				matcher = this.matchers[++index];
			}

			if (!matcher) {
				return true;
			}
		}

		return false;
	}

	getPrefix(scopes: string[]): GroupPrefix | undefined {
		if (this.matches(scopes)) {
			return this.prefix;
		}
	}
};

export class OrMatcher {
	left: PathMatcher;
	right: PathMatcher;
	constructor(left1: PathMatcher, right1: PathMatcher) {
		this.left = left1;
		this.right = right1;
	}

	matches(scopes: string[]): boolean {
		return this.left.matches(scopes) || this.right.matches(scopes);
	}

	getPrefix(scopes: string[]): GroupPrefix | undefined {
		return this.left.getPrefix(scopes) || this.right.getPrefix(scopes);
	}
};

export class AndMatcher {
	left: PathMatcher;
	right: PathMatcher | NegateMatcher;
	constructor(left1: PathMatcher, right1: PathMatcher | NegateMatcher) {
		this.left = left1;
		this.right = right1;
	}

	matches(scopes: string[]): boolean {
		return this.left.matches(scopes) && this.right.matches(scopes);
	}

	getPrefix(scopes: string[]): GroupPrefix | undefined {
		if (this.left.matches(scopes) && this.right.matches(scopes)) {
			return this.left.getPrefix(scopes); // The right side can't have prefixes
		}
	}
};

export class NegateMatcher {
	matcher: PathMatcher;

	constructor(matcher1: PathMatcher) {
		this.matcher = matcher1;
	}

	matches(scopes: string[]): boolean {
		return !this.matcher.matches(scopes);
	}

	getPrefix(_: string[]): void {}
};

export class CompositeMatcher {
	matcher: OrMatcher | AndMatcher;

	constructor(left: PathMatcher, operator: CompositeOperator, right: PathMatcher) {
		switch (operator) {
			case '|':
				this.matcher = new OrMatcher(left, right);
				break;
			case '&':
				this.matcher = new AndMatcher(left, right);
				break;
			case '-':
				this.matcher = new AndMatcher(left, new NegateMatcher(right));
		}
	}

	matches(scopes: string[]) {
		return this.matcher.matches(scopes);
	}

	getPrefix(scopes: string[]): GroupPrefix | undefined {
		return this.matcher.getPrefix(scopes);
	}
};
