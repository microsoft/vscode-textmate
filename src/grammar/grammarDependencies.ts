/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IRawGrammar, IRawRepository, IRawRule } from '../rawGrammar';
import { ScopeName } from '../theme';
import { mergeObjects } from '../utils';
import { IGrammarRepository } from './grammar';

export class FullScopeDependency {
	constructor(
		public readonly scopeName: ScopeName
	) { }
}

export class PartialScopeDependency {
	constructor(
		public readonly scopeName: ScopeName,
		public readonly include: string
	) { }

	public toKey(): string {
		return `${this.scopeName}#${this.include}`;
	}
}

export type ScopeDependency = FullScopeDependency | PartialScopeDependency;

export class ScopeDependencyCollector {

	public readonly full: FullScopeDependency[] = [];
	public readonly partial: PartialScopeDependency[] = [];

	public readonly visitedRule = new Set<IRawRule>();
	private readonly _seenFull = new Set<ScopeName>();
	private readonly _seenPartial = new Set<ScopeName>();

	public add(dep: ScopeDependency): void {
		if (dep instanceof FullScopeDependency) {
			if (!this._seenFull.has(dep.scopeName)) {
				this._seenFull.add(dep.scopeName);
				this.full.push(dep);
			}
		} else {
			if (!this._seenPartial.has(dep.toKey())) {
				this._seenPartial.add(dep.toKey());
				this.partial.push(dep);
			}
		}
	}
}

/**
 * Fill in `result` all external included scopes in `patterns`
 */
 function _extractIncludedScopesInPatterns(
	result: ScopeDependencyCollector,
	baseGrammar: IRawGrammar,
	selfGrammar: IRawGrammar,
	patterns: IRawRule[],
	repository: IRawRepository | undefined
): void {
	for (const pattern of patterns) {
		if (result.visitedRule.has(pattern)) {
			continue;
		}
		result.visitedRule.add(pattern);

		const patternRepository = pattern.repository ? mergeObjects({}, repository, pattern.repository) : repository;

		if (Array.isArray(pattern.patterns)) {
			_extractIncludedScopesInPatterns(result, baseGrammar, selfGrammar, pattern.patterns, patternRepository);
		}

		const include = pattern.include;

		if (!include) {
			continue;
		}

		if (include === "$base" || include === baseGrammar.scopeName) {
			collectDependencies(result, baseGrammar, baseGrammar);
		} else if (include === "$self" || include === selfGrammar.scopeName) {
			collectDependencies(result, baseGrammar, selfGrammar);
		} else if (include.charAt(0) === "#") {
			collectSpecificDependencies(result, baseGrammar, selfGrammar, include.substring(1), patternRepository);
		} else {
			const sharpIndex = include.indexOf("#");
			if (sharpIndex >= 0) {
				const scopeName = include.substring(0, sharpIndex);
				const includedName = include.substring(sharpIndex + 1);
				if (scopeName === baseGrammar.scopeName) {
					collectSpecificDependencies(result, baseGrammar, baseGrammar, includedName, patternRepository);
				} else if (scopeName === selfGrammar.scopeName) {
					collectSpecificDependencies(result, baseGrammar, selfGrammar, includedName, patternRepository);
				} else {
					result.add(new PartialScopeDependency(scopeName, include.substring(sharpIndex + 1)));
				}
			} else {
				result.add(new FullScopeDependency(include));
			}
		}
	}
}

export class ScopeDependencyProcessor {
	public readonly seenFullScopeRequests = new Set<ScopeName>();
	public readonly seenPartialScopeRequests = new Set<ScopeName>();
	public Q: ScopeDependency[];

	constructor(
		public readonly repo: IGrammarRepository,
		public readonly initialScopeName: ScopeName
	) {
		this.seenFullScopeRequests.add(this.initialScopeName);
		this.Q = [new FullScopeDependency(this.initialScopeName)];
	}

	public processQueue(): void {
		const q = this.Q;
		this.Q = [];

		const deps = new ScopeDependencyCollector();
		for (const dep of q) {
			collectDependenciesForDep(this.repo, this.initialScopeName, deps, dep);
		}

		for (const dep of deps.full) {
			if (this.seenFullScopeRequests.has(dep.scopeName)) {
				// already processed
				continue;
			}
			this.seenFullScopeRequests.add(dep.scopeName);
			this.Q.push(dep);
		}

		for (const dep of deps.partial) {
			if (this.seenFullScopeRequests.has(dep.scopeName)) {
				// already processed in full
				continue;
			}
			if (this.seenPartialScopeRequests.has(dep.toKey())) {
				// already processed
				continue;
			}
			this.seenPartialScopeRequests.add(dep.toKey());
			this.Q.push(dep);
		}
	}
}

function collectDependenciesForDep(repo: IGrammarRepository, initialScopeName: ScopeName, result: ScopeDependencyCollector, dep: FullScopeDependency | PartialScopeDependency) {
	const grammar = repo.lookup(dep.scopeName);
	if (!grammar) {
		if (dep.scopeName === initialScopeName) {
			throw new Error(`No grammar provided for <${initialScopeName}>`);
		}
		return;
	}

	if (dep instanceof FullScopeDependency) {
		collectDependencies(result, repo.lookup(initialScopeName)!, grammar);
	} else {
		collectSpecificDependencies(result, repo.lookup(initialScopeName)!, grammar, dep.include);
	}

	const injections = repo.injections(dep.scopeName);
	if (injections) {
		for (const injection of injections) {
			result.add(new FullScopeDependency(injection));
		}
	}
}

/**
 * Collect a specific dependency from the grammar's repository
 */
function collectSpecificDependencies(result: ScopeDependencyCollector, baseGrammar: IRawGrammar, selfGrammar: IRawGrammar, include: string, repository: IRawRepository | undefined = selfGrammar.repository): void {
	if (repository && repository[include]) {
		const rule = repository[include];
		_extractIncludedScopesInPatterns(result, baseGrammar, selfGrammar, [rule], repository);
	}
}

/**
 * Collects the list of all external included scopes in `grammar`.
 */
function collectDependencies(result: ScopeDependencyCollector, baseGrammar: IRawGrammar, selfGrammar: IRawGrammar): void {
	if (selfGrammar.patterns && Array.isArray(selfGrammar.patterns)) {
		_extractIncludedScopesInPatterns(result, baseGrammar, selfGrammar, selfGrammar.patterns, selfGrammar.repository);
	}
	if (selfGrammar.injections) {
		let injections: IRawRule[] = [];
		for (let injection in selfGrammar.injections) {
			injections.push(selfGrammar.injections[injection]);
		}
		_extractIncludedScopesInPatterns(result, baseGrammar, selfGrammar, injections, selfGrammar.repository);
	}
}
