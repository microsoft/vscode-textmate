/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { clone, mergeObjects } from './utils';
import { IRawGrammar, IRawRepository, IRawRule, IOnigLib, IOnigCaptureIndex, OnigString, OnigScanner, FindOption } from './types';
import { IRuleRegistry, IRuleFactoryHelper, RuleFactory, Rule, CaptureRule, BeginEndRule, BeginWhileRule, MatchRule, CompiledRule } from './rule';
import { ScopeSelector } from './scope';
import { MetadataConsts, IGrammar, ITokenizeLineResult, ITokenizeLineResult2, IToken, IEmbeddedLanguagesMap, StandardTokenType, StackElement as StackElementDef, ITokenTypeMap } from './main';
import { DebugFlags, UseOnigurumaFindOptions } from './debug';
import { FontStyle, ThemeTrieElementRule } from './theme';

declare let performance: { now: () => number } | undefined;
const performanceNow = (function () {
	if (typeof performance === 'undefined') {
		// performance.now() is not available in this environment, so use Date.now()
		return () => Date.now();
	} else {
		return () => performance!.now();
	}
})();

// Must have the same values as `StandardTokenType`!
export const enum OptionalStandardTokenType {
	Other = 0,
	Comment = 1,
	String = 2,
	RegEx = 3,
	// Indicates that no token type is set.
	NotSet = 8
}

export function createGrammar(scopeName: string, grammar: IRawGrammar, initialLanguage: number, embeddedLanguages: IEmbeddedLanguagesMap | null, tokenTypes: ITokenTypeMap | null, grammarRepository: IGrammarRepository & IThemeProvider, onigLib: IOnigLib): Grammar {
	return new Grammar(scopeName, grammar, initialLanguage, embeddedLanguages, tokenTypes, grammarRepository, onigLib);//TODO
}

export interface IThemeProvider {
	themeMatch(scopeName: string): ThemeTrieElementRule[];
	getDefaults(): ThemeTrieElementRule;
}

export interface IGrammarRepository {
	lookup(scopeName: string): IRawGrammar | undefined;
	injections(scopeName: string): string[];
}

export interface IScopeNameSet {
	[scopeName: string]: boolean;
}

export class FullScopeDependency {
	constructor(
		public readonly scopeName: string
	) { }
}

export class PartialScopeDependency {
	constructor(
		public readonly scopeName: string,
		public readonly include: string
	) { }

	public toKey(): string {
		return `${this.scopeName}#${this.include}`;
	}
}

export type ScopeDependency = FullScopeDependency | PartialScopeDependency;

export class ScopeDependencyCollector {

	public readonly full: FullScopeDependency[];
	public readonly partial: PartialScopeDependency[];

	public readonly visitedRule: Set<IRawRule>;
	private readonly _seenFull: Set<string>;
	private readonly _seenPartial: Set<string>;

	constructor() {
		this.full = [];
		this.partial = [];
		this.visitedRule = new Set<IRawRule>();
		this._seenFull = new Set<string>();
		this._seenPartial = new Set<string>();
	}

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
function _extractIncludedScopesInPatterns(result: ScopeDependencyCollector, baseGrammar: IRawGrammar, selfGrammar: IRawGrammar, patterns: IRawRule[], repository: IRawRepository | undefined): void {
	for (const pattern of patterns) {
		if (result.visitedRule.has(pattern)) {
			continue;
		}
		result.visitedRule.add(pattern);

		const patternRepository = (pattern.repository ? mergeObjects({}, repository, pattern.repository) : repository);

		if (Array.isArray(pattern.patterns)) {
			_extractIncludedScopesInPatterns(result, baseGrammar, selfGrammar, pattern.patterns, patternRepository);
		}

		const include = pattern.include;

		if (!include) {
			continue;
		}

		if (include === '$base' || include === baseGrammar.scopeName) {
			collectDependencies(result, baseGrammar, baseGrammar);
		} else if (include === '$self' || include === selfGrammar.scopeName) {
			collectDependencies(result, baseGrammar, selfGrammar);
		} else if (include.charAt(0) === '#') {
			collectSpecificDependencies(result, baseGrammar, selfGrammar, include.substring(1), patternRepository);
		} else {

			const sharpIndex = include.indexOf('#');
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

	public readonly seenFullScopeRequests = new Set<string>();
	public readonly seenPartialScopeRequests = new Set<string>();
	public Q: ScopeDependency[];

	constructor(
		public readonly repo: IGrammarRepository,
		public readonly initialScopeName: string
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

function collectDependenciesForDep(repo: IGrammarRepository, initialScopeName: string, result: ScopeDependencyCollector, dep: FullScopeDependency | PartialScopeDependency) {
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

export interface Injection {
	readonly debugSelector: string;
	readonly scopeSelector: ScopeSelector;
	readonly ruleId: number;
	readonly grammar: IRawGrammar;
}

function scopesAreMatching(thisScopeName: string, scopeName: string): boolean {
	if (!thisScopeName) {
		return false;
	}
	if (thisScopeName === scopeName) {
		return true;
	}
	const len = scopeName.length;
	return thisScopeName.length > len && thisScopeName.substr(0, len) === scopeName && thisScopeName[len] === '.';
}

function collectInjections(result: Injection[], selector: string, rule: IRawRule, ruleFactoryHelper: IRuleFactoryHelper, grammar: IRawGrammar): void {
	const scopeSelector = new ScopeSelector(selector);
	const ruleId = RuleFactory.getCompiledRuleId(rule, ruleFactoryHelper, grammar.repository);
	result.push({
		debugSelector: selector,
		scopeSelector: scopeSelector,
		ruleId: ruleId,
		grammar: grammar
	});
}

export class ScopeMetadata {
	public readonly scopeName: string;
	public readonly languageId: number;
	public readonly tokenType: OptionalStandardTokenType;
	public readonly themeData: ThemeTrieElementRule[] | null;

	constructor(scopeName: string, languageId: number, tokenType: OptionalStandardTokenType, themeData: ThemeTrieElementRule[] | null) {
		this.scopeName = scopeName;
		this.languageId = languageId;
		this.tokenType = tokenType;
		this.themeData = themeData;
	}
}

class ScopeMetadataProvider {

	private readonly _initialLanguage: number;
	private readonly _themeProvider: IThemeProvider;
	private _cache: Map<string, ScopeMetadata>;
	private _defaultMetaData: ScopeMetadata;
	private readonly _embeddedLanguages: IEmbeddedLanguagesMap;
	private readonly _embeddedLanguagesRegex: RegExp | null;

	constructor(initialLanguage: number, themeProvider: IThemeProvider, embeddedLanguages: IEmbeddedLanguagesMap | null) {
		this._initialLanguage = initialLanguage;
		this._themeProvider = themeProvider;
		this._cache = new Map();
		this._defaultMetaData = new ScopeMetadata(
			'',
			this._initialLanguage,
			OptionalStandardTokenType.NotSet,
			[this._themeProvider.getDefaults()]
		);

		// embeddedLanguages handling
		this._embeddedLanguages = Object.create(null);

		if (embeddedLanguages) {
			// If embeddedLanguages are configured, fill in `this._embeddedLanguages`
			const scopes = Object.keys(embeddedLanguages);
			for (let i = 0, len = scopes.length; i < len; i++) {
				const scope = scopes[i];
				const language = embeddedLanguages[scope];
				if (typeof language !== 'number' || language === 0) {
					console.warn('Invalid embedded language found at scope ' + scope + ': <<' + language + '>>');
					// never hurts to be too careful
					continue;
				}
				this._embeddedLanguages[scope] = language;
			}
		}

		// create the regex
		const escapedScopes = Object.keys(this._embeddedLanguages).map((scopeName) => ScopeMetadataProvider._escapeRegExpCharacters(scopeName));
		if (escapedScopes.length === 0) {
			// no scopes registered
			this._embeddedLanguagesRegex = null;
		} else {
			escapedScopes.sort();
			escapedScopes.reverse();
			this._embeddedLanguagesRegex = new RegExp(`^((${escapedScopes.join(')|(')}))($|\\.)`, '');
		}
	}

	public onDidChangeTheme(): void {
		this._cache = new Map();
		this._defaultMetaData = new ScopeMetadata(
			'',
			this._initialLanguage,
			OptionalStandardTokenType.NotSet,
			[this._themeProvider.getDefaults()]
		);
	}

	public getDefaultMetadata(): ScopeMetadata {
		return this._defaultMetaData;
	}

	/**
	 * Escapes regular expression characters in a given string
	 */
	private static _escapeRegExpCharacters(value: string): string {
		return value.replace(/[\-\\\{\}\*\+\?\|\^\$\.\,\[\]\(\)\#\s]/g, '\\$&');
	}

	private static _NULL_SCOPE_METADATA = new ScopeMetadata('', 0, 0, null);
	public getMetadataForScope(scopeName: string | null): ScopeMetadata {
		if (scopeName === null) {
			return ScopeMetadataProvider._NULL_SCOPE_METADATA;
		}
		let value = this._cache.get(scopeName);
		if (value) {
			return value;
		}
		value = this._doGetMetadataForScope(scopeName);
		this._cache.set(scopeName, value);
		return value;
	}

	private _doGetMetadataForScope(scopeName: string): ScopeMetadata {
		const languageId = this._scopeToLanguage(scopeName);
		const standardTokenType = this._toStandardTokenType(scopeName);
		const themeData = this._themeProvider.themeMatch(scopeName);

		return new ScopeMetadata(scopeName, languageId, standardTokenType, themeData);
	}

	/**
	 * Given a produced TM scope, return the language that token describes or null if unknown.
	 * e.g. source.html => html, source.css.embedded.html => css, punctuation.definition.tag.html => null
	 */
	private _scopeToLanguage(scope: string): number {
		if (!scope) {
			return 0;
		}
		if (!this._embeddedLanguagesRegex) {
			// no scopes registered
			return 0;
		}
		const m = scope.match(this._embeddedLanguagesRegex);
		if (!m) {
			// no scopes matched
			return 0;
		}

		const language = this._embeddedLanguages[m[1]] || 0;
		if (!language) {
			return 0;
		}

		return language;
	}

	private static STANDARD_TOKEN_TYPE_REGEXP = /\b(comment|string|regex|meta\.embedded)\b/;
	private _toStandardTokenType(tokenType: string): OptionalStandardTokenType {
		const m = tokenType.match(ScopeMetadataProvider.STANDARD_TOKEN_TYPE_REGEXP);
		if (!m) {
			return OptionalStandardTokenType.NotSet;
		}
		switch (m[1]) {
			case 'comment':
				return OptionalStandardTokenType.Comment;
			case 'string':
				return OptionalStandardTokenType.String;
			case 'regex':
				return OptionalStandardTokenType.RegEx;
			case 'meta.embedded':
				return OptionalStandardTokenType.Other;
		}
		throw new Error('Unexpected match for standard token type!');
	}
}

export class Grammar implements IGrammar, IRuleFactoryHelper, IOnigLib {

	private readonly _scopeName: string;
	private _rootId: number;
	private _lastRuleId: number;
	private readonly _ruleId2desc: Rule[];
	private readonly _includedGrammars: { [scopeName: string]: IRawGrammar; };
	private readonly _grammarRepository: IGrammarRepository;
	private readonly _grammar: IRawGrammar;
	private _injections: Injection[] | null;
	private readonly _scopeMetadataProvider: ScopeMetadataProvider;
	private readonly _tokenTypeMatchers: TokenTypeMatcher[];
	private readonly _onigLib: IOnigLib;

	constructor(scopeName: string, grammar: IRawGrammar, initialLanguage: number, embeddedLanguages: IEmbeddedLanguagesMap | null, tokenTypes: ITokenTypeMap | null, grammarRepository: IGrammarRepository & IThemeProvider, onigLib: IOnigLib) {
		this._scopeName = scopeName;
		this._scopeMetadataProvider = new ScopeMetadataProvider(initialLanguage, grammarRepository, embeddedLanguages);

		this._onigLib = onigLib;
		this._rootId = -1;
		this._lastRuleId = 0;
		this._ruleId2desc = [null!];
		this._includedGrammars = {};
		this._grammarRepository = grammarRepository;
		this._grammar = initGrammar(grammar, null);
		this._injections = null;

		this._tokenTypeMatchers = [];
		if (tokenTypes) {
			for (const selector of Object.keys(tokenTypes)) {
				const scopeSelector = new ScopeSelector(selector);
				this._tokenTypeMatchers.push({
					scopeSelector: scopeSelector,
					type: tokenTypes[selector]
				});
			}
		}
	}

	public dispose(): void {
		for (const rule of this._ruleId2desc) {
			if (rule) {
				rule.dispose();
			}
		}
	}

	public createOnigScanner(sources: string[]): OnigScanner {
		return this._onigLib.createOnigScanner(sources);
	}

	public createOnigString(sources: string): OnigString {
		return this._onigLib.createOnigString(sources);
	}

	public onDidChangeTheme(): void {
		this._scopeMetadataProvider.onDidChangeTheme();
	}

	public getMetadataForScope(scope: string): ScopeMetadata {
		return this._scopeMetadataProvider.getMetadataForScope(scope);
	}

	private _collectInjections(): Injection[] {
		const grammarRepository: IGrammarRepository = {
			lookup: (scopeName: string): IRawGrammar | undefined => {
				if (scopeName === this._scopeName) {
					return this._grammar;
				}
				return this.getExternalGrammar(scopeName);
			},
			injections: (scopeName: string): string[] => {
				return this._grammarRepository.injections(scopeName);
			}
		};

		const dependencyProcessor = new ScopeDependencyProcessor(grammarRepository, this._scopeName);
		// TODO: uncomment below to visit all scopes
		// while (dependencyProcessor.Q.length > 0) {
		// 	dependencyProcessor.processQueue();
		// }

		const result: Injection[] = [];

		dependencyProcessor.seenFullScopeRequests.forEach((scopeName) => {
			const grammar = grammarRepository.lookup(scopeName);
			if (!grammar) {
				return;
			}

			// add injections from the current grammar
			const rawInjections = grammar.injections;
			if (rawInjections) {
				for (let expression in rawInjections) {
					collectInjections(result, expression, rawInjections[expression], this, grammar);
				}
			}

			// add injection grammars contributed for the current scope
			if (this._grammarRepository) {
				const injectionScopeNames = this._grammarRepository.injections(scopeName);
				if (injectionScopeNames) {
					injectionScopeNames.forEach(injectionScopeName => {
						const injectionGrammar = this.getExternalGrammar(injectionScopeName);
						if (injectionGrammar) {
							const selector = injectionGrammar.injectionSelector;
							if (selector) {
								collectInjections(result, selector, injectionGrammar, this, injectionGrammar);
							}
						}
					});
				}
			}
		});

		result.sort((i1, i2) => i1.scopeSelector.getPriority(this._scopeName) - i2.scopeSelector.getPriority(this._scopeName)); // sort by priority

		return result;
	}

	public getInjections(): Injection[] {
		if (this._injections === null) {
			this._injections = this._collectInjections();

			if (DebugFlags.InDebugMode && this._injections.length > 0) {
				console.log(`Grammar ${this._scopeName} contains the following injections:`);
				for (const injection of this._injections) {
					console.log(`  - ${injection.debugSelector}`);
				}
			}
		}
		return this._injections;
	}

	public registerRule<T extends Rule>(factory: (id: number) => T): T {
		const id = (++this._lastRuleId);
		const result = factory(id);
		this._ruleId2desc[id] = result;
		return result;
	}

	public getRule(patternId: number): Rule {
		return this._ruleId2desc[patternId];
	}

	public getExternalGrammar(scopeName: string, repository?: IRawRepository): IRawGrammar | undefined {
		if (this._includedGrammars[scopeName]) {
			return this._includedGrammars[scopeName];
		} else if (this._grammarRepository) {
			const rawIncludedGrammar = this._grammarRepository.lookup(scopeName);
			if (rawIncludedGrammar) {
				// console.log('LOADED GRAMMAR ' + pattern.include);
				this._includedGrammars[scopeName] = initGrammar(rawIncludedGrammar, repository && repository.$base);
				return this._includedGrammars[scopeName];
			}
		}
		return undefined;
	}

	public tokenizeLine(lineText: string, prevState: StackElement | null, timeLimit: number = 0): ITokenizeLineResult {
		const r = this._tokenize(lineText, prevState, false, timeLimit);
		return {
			tokens: r.lineTokens.getResult(r.ruleStack, r.lineLength),
			ruleStack: r.ruleStack,
			stoppedEarly: r.stoppedEarly
		};
	}

	public tokenizeLine2(lineText: string, prevState: StackElement | null, timeLimit: number = 0): ITokenizeLineResult2 {
		const r = this._tokenize(lineText, prevState, true, timeLimit);
		return {
			tokens: r.lineTokens.getBinaryResult(r.ruleStack, r.lineLength),
			ruleStack: r.ruleStack,
			stoppedEarly: r.stoppedEarly
		};
	}

	private _tokenize(lineText: string, prevState: StackElement | null, emitBinaryTokens: boolean, timeLimit: number): { lineLength: number; lineTokens: LineTokens; ruleStack: StackElement; stoppedEarly: boolean; } {
		if (this._rootId === -1) {
			this._rootId = RuleFactory.getCompiledRuleId(this._grammar.repository.$self, this, this._grammar.repository);
		}

		let isFirstLine: boolean;
		if (!prevState || prevState === StackElement.NULL) {
			isFirstLine = true;
			const rawDefaultMetadata = this._scopeMetadataProvider.getDefaultMetadata();
			const defaultTheme = rawDefaultMetadata.themeData![0];
			const defaultMetadata = StackElementMetadata.set(0, rawDefaultMetadata.languageId, rawDefaultMetadata.tokenType, defaultTheme.fontStyle, defaultTheme.foreground, defaultTheme.background);

			const rootScopeName = this.getRule(this._rootId).getName(null, null);
			const rawRootMetadata = this._scopeMetadataProvider.getMetadataForScope(rootScopeName);
			const rootMetadata = ScopeListElement.mergeMetadata(defaultMetadata, null, rawRootMetadata);

			const scopeList = new ScopeListElement(null, rootScopeName === null ? 'unknown' : rootScopeName, rootMetadata);

			prevState = new StackElement(null, this._rootId, -1, -1, false, null, scopeList, scopeList);
		} else {
			isFirstLine = false;
			prevState.reset();
		}

		lineText = lineText + '\n';
		const onigLineText = this.createOnigString(lineText);
		const lineLength = onigLineText.content.length;
		const lineTokens = new LineTokens(emitBinaryTokens, lineText, this._tokenTypeMatchers);
		const r = _tokenizeString(this, onigLineText, isFirstLine, 0, prevState, lineTokens, true, timeLimit);

		disposeOnigString(onigLineText);

		return {
			lineLength: lineLength,
			lineTokens: lineTokens,
			ruleStack: r.stack,
			stoppedEarly: r.stoppedEarly
		};
	}
}

function disposeOnigString(str: OnigString) {
	if (typeof str.dispose === 'function') {
		str.dispose();
	}
}

function initGrammar(grammar: IRawGrammar, base: IRawRule | null | undefined): IRawGrammar {
	grammar = clone(grammar);

	grammar.repository = grammar.repository || <any>{};
	grammar.repository.$self = {
		$vscodeTextmateLocation: grammar.$vscodeTextmateLocation,
		patterns: grammar.patterns,
		name: grammar.scopeName
	};
	grammar.repository.$base = base || grammar.repository.$self;
	return grammar;
}

function handleCaptures(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, stack: StackElement, lineTokens: LineTokens, captures: (CaptureRule | null)[], captureIndices: IOnigCaptureIndex[]): void {
	if (captures.length === 0) {
		return;
	}

	const lineTextContent = lineText.content;

	const len = Math.min(captures.length, captureIndices.length);
	const localStack: LocalStackElement[] = [];
	const maxEnd = captureIndices[0].end;

	for (let i = 0; i < len; i++) {
		const captureRule = captures[i];
		if (captureRule === null) {
			// Not interested
			continue;
		}

		const captureIndex = captureIndices[i];

		if (captureIndex.length === 0) {
			// Nothing really captured
			continue;
		}

		if (captureIndex.start > maxEnd) {
			// Capture going beyond consumed string
			break;
		}

		// pop captures while needed
		while (localStack.length > 0 && localStack[localStack.length - 1].endPos <= captureIndex.start) {
			// pop!
			lineTokens.produceFromScopes(localStack[localStack.length - 1].scopes, localStack[localStack.length - 1].endPos);
			localStack.pop();
		}

		if (localStack.length > 0) {
			lineTokens.produceFromScopes(localStack[localStack.length - 1].scopes, captureIndex.start);
		} else {
			lineTokens.produce(stack, captureIndex.start);
		}

		if (captureRule.retokenizeCapturedWithRuleId) {
			// the capture requires additional matching
			const scopeName = captureRule.getName(lineTextContent, captureIndices);
			const nameScopesList = stack.contentNameScopesList.push(grammar, scopeName);
			const contentName = captureRule.getContentName(lineTextContent, captureIndices);
			const contentNameScopesList = nameScopesList.push(grammar, contentName);

			const stackClone = stack.push(captureRule.retokenizeCapturedWithRuleId, captureIndex.start, -1, false, null, nameScopesList, contentNameScopesList);
			const onigSubStr = grammar.createOnigString(lineTextContent.substring(0, captureIndex.end));
			_tokenizeString(grammar, onigSubStr, (isFirstLine && captureIndex.start === 0), captureIndex.start, stackClone, lineTokens, false, /* no time limit */0);
			disposeOnigString(onigSubStr);
			continue;
		}

		const captureRuleScopeName = captureRule.getName(lineTextContent, captureIndices);
		if (captureRuleScopeName !== null) {
			// push
			const base = localStack.length > 0 ? localStack[localStack.length - 1].scopes : stack.contentNameScopesList;
			const captureRuleScopesList = base.push(grammar, captureRuleScopeName);
			localStack.push(new LocalStackElement(captureRuleScopesList, captureIndex.end));
		}
	}

	while (localStack.length > 0) {
		// pop!
		lineTokens.produceFromScopes(localStack[localStack.length - 1].scopes, localStack[localStack.length - 1].endPos);
		localStack.pop();
	}
}

interface IMatchInjectionsResult {
	readonly priorityMatch: boolean;
	readonly captureIndices: IOnigCaptureIndex[];
	readonly matchedRuleId: number;
}

function debugCompiledRuleToString(ruleScanner: CompiledRule): string {
	const r: string[] = [];
	for (let i = 0, len = ruleScanner.rules.length; i < len; i++) {
		r.push('   - ' + ruleScanner.rules[i] + ': ' + ruleScanner.debugRegExps[i]);
	}
	return r.join('\n');
}

function getFindOptions(allowA: boolean, allowG: boolean): number {
	let options = FindOption.None;
	if (!allowA) {
		options |= FindOption.NotBeginString;
	}
	if (!allowG) {
		options |= FindOption.NotBeginPosition;
	}
	return options;
}

function prepareRuleSearch(rule: Rule, grammar: Grammar, endRegexSource: string | null, allowA: boolean, allowG: boolean): { ruleScanner: CompiledRule; findOptions: number; } {
	if (UseOnigurumaFindOptions) {
		const ruleScanner = rule.compile(grammar, endRegexSource);
		const findOptions = getFindOptions(allowA, allowG);
		return { ruleScanner, findOptions };
	}
	const ruleScanner = rule.compileAG(grammar, endRegexSource, allowA, allowG);
	return { ruleScanner, findOptions: FindOption.None };
}

function prepareRuleWhileSearch(rule: BeginWhileRule, grammar: Grammar, endRegexSource: string | null, allowA: boolean, allowG: boolean): { ruleScanner: CompiledRule; findOptions: number; } {
	if (UseOnigurumaFindOptions) {
		const ruleScanner = rule.compileWhile(grammar, endRegexSource);
		const findOptions = getFindOptions(allowA, allowG);
		return { ruleScanner, findOptions };
	}
	const ruleScanner = rule.compileWhileAG(grammar, endRegexSource, allowA, allowG);
	return { ruleScanner, findOptions: FindOption.None };
}

function matchInjections(injections: Injection[], grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, anchorPosition: number): IMatchInjectionsResult | null {
	// The lower the better
	let bestMatchRating = Number.MAX_VALUE;
	let bestMatchCaptureIndices: IOnigCaptureIndex[] | null = null;
	let bestMatchRuleId: number;
	let bestMatchResultPriority: number = 0;

	const scopes = stack.contentNameScopesList.generateScopes();

	for (let i = 0, len = injections.length; i < len; i++) {
		const injection = injections[i];
		if (!injection.scopeSelector.matches(scopes)) {
			// injection selector doesn't match stack
			continue;
		}
		const rule = grammar.getRule(injection.ruleId);
		const { ruleScanner, findOptions } = prepareRuleSearch(rule, grammar, null, isFirstLine, linePos === anchorPosition);
		const matchResult = ruleScanner.scanner.findNextMatchSync(lineText, linePos, findOptions);
		if (!matchResult) {
			continue;
		}

		if (DebugFlags.InDebugMode) {
			console.log(`  matched injection: ${injection.debugSelector}`);
			console.log(debugCompiledRuleToString(ruleScanner));
		}

		const matchRating = matchResult.captureIndices[0].start;
		if (matchRating >= bestMatchRating) {
			// Injections are sorted by priority, so the previous injection had a better or equal priority
			continue;
		}

		bestMatchRating = matchRating;
		bestMatchCaptureIndices = matchResult.captureIndices;
		bestMatchRuleId = ruleScanner.rules[matchResult.index];
		bestMatchResultPriority = injection.scopeSelector.getPriority(scopes);

		if (bestMatchRating === linePos) {
			// No more need to look at the rest of the injections.
			break;
		}
	}

	if (bestMatchCaptureIndices) {
		return {
			priorityMatch: bestMatchResultPriority === -1,
			captureIndices: bestMatchCaptureIndices,
			matchedRuleId: bestMatchRuleId!
		};
	}

	return null;
}

interface IMatchResult {
	readonly captureIndices: IOnigCaptureIndex[];
	readonly matchedRuleId: number;
}

function matchRule(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, anchorPosition: number): IMatchResult | null {
	const rule = stack.getRule(grammar);
	const { ruleScanner, findOptions } = prepareRuleSearch(rule, grammar, stack.endRule, isFirstLine, linePos === anchorPosition);

	let perfStart = 0;
	if (DebugFlags.InDebugMode) {
		perfStart = performanceNow();
	}

	const r = ruleScanner.scanner.findNextMatchSync(lineText, linePos, findOptions);

	if (DebugFlags.InDebugMode) {
		const elapsedMillis = performanceNow() - perfStart;
		if (elapsedMillis > 5) {
			console.warn(`Rule ${rule.debugName} (${rule.id}) matching took ${elapsedMillis} against '${lineText}'`);
		}
		console.log(`  scanning for (linePos: ${linePos}, anchorPosition: ${anchorPosition})`);
		console.log(debugCompiledRuleToString(ruleScanner));
		if (r) {
			console.log(`matched rule id: ${ruleScanner.rules[r.index]} from ${r.captureIndices[0].start} to ${r.captureIndices[0].end}`);
		}
	}

	if (r) {
		return {
			captureIndices: r.captureIndices,
			matchedRuleId: ruleScanner.rules[r.index]
		};
	}
	return null;
}

function matchRuleOrInjections(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, anchorPosition: number): IMatchResult | null {
	// Look for normal grammar rule
	const matchResult = matchRule(grammar, lineText, isFirstLine, linePos, stack, anchorPosition);

	// Look for injected rules
	const injections = grammar.getInjections();
	if (injections.length === 0) {
		// No injections whatsoever => early return
		return matchResult;
	}

	const injectionResult = matchInjections(injections, grammar, lineText, isFirstLine, linePos, stack, anchorPosition);
	if (!injectionResult) {
		// No injections matched => early return
		return matchResult;
	}

	if (!matchResult) {
		// Only injections matched => early return
		return injectionResult;
	}

	// Decide if `matchResult` or `injectionResult` should win
	const matchResultScore = matchResult.captureIndices[0].start;
	const injectionResultScore = injectionResult.captureIndices[0].start;

	if (injectionResultScore < matchResultScore || (injectionResult.priorityMatch && injectionResultScore === matchResultScore)) {
		// injection won!
		return injectionResult;
	}
	return matchResult;
}

interface IWhileStack {
	readonly stack: StackElement;
	readonly rule: BeginWhileRule;
}

interface IWhileCheckResult {
	readonly stack: StackElement;
	readonly linePos: number;
	readonly anchorPosition: number;
	readonly isFirstLine: boolean;
}

/**
 * Walk the stack from bottom to top, and check each while condition in this order.
 * If any fails, cut off the entire stack above the failed while condition. While conditions
 * may also advance the linePosition.
 */
function _checkWhileConditions(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, lineTokens: LineTokens): IWhileCheckResult {
	let anchorPosition = (stack.beginRuleCapturedEOL ? 0 : -1);
	const whileRules: IWhileStack[] = [];
	for (let node: StackElement | null = stack; node; node = node.pop()) {
		const nodeRule = node.getRule(grammar);
		if (nodeRule instanceof BeginWhileRule) {
			whileRules.push({
				rule: nodeRule,
				stack: node
			});
		}
	}

	for (let whileRule = whileRules.pop(); whileRule; whileRule = whileRules.pop()) {
		const { ruleScanner, findOptions } = prepareRuleWhileSearch(whileRule.rule, grammar, whileRule.stack.endRule, isFirstLine, linePos === anchorPosition);
		const r = ruleScanner.scanner.findNextMatchSync(lineText, linePos, findOptions);
		if (DebugFlags.InDebugMode) {
			console.log('  scanning for while rule');
			console.log(debugCompiledRuleToString(ruleScanner));
		}

		if (r) {
			const matchedRuleId = ruleScanner.rules[r.index];
			if (matchedRuleId !== -2) {
				// we shouldn't end up here
				stack = whileRule.stack.pop()!;
				break;
			}
			if (r.captureIndices && r.captureIndices.length) {
				lineTokens.produce(whileRule.stack, r.captureIndices[0].start);
				handleCaptures(grammar, lineText, isFirstLine, whileRule.stack, lineTokens, whileRule.rule.whileCaptures, r.captureIndices);
				lineTokens.produce(whileRule.stack, r.captureIndices[0].end);
				anchorPosition = r.captureIndices[0].end;
				if (r.captureIndices[0].end > linePos) {
					linePos = r.captureIndices[0].end;
					isFirstLine = false;
				}
			}
		} else {
			if (DebugFlags.InDebugMode) {
				console.log('  popping ' + whileRule.rule.debugName + ' - ' + whileRule.rule.debugWhileRegExp);
			}

			stack = whileRule.stack.pop()!;
			break;
		}
	}

	return { stack: stack, linePos: linePos, anchorPosition: anchorPosition, isFirstLine: isFirstLine };
}

class TokenizeStringResult {
	constructor(
		public readonly stack: StackElement,
		public readonly stoppedEarly: boolean
	) { }
}

/**
 * Tokenize a string
 * @param grammar
 * @param lineText
 * @param isFirstLine
 * @param linePos
 * @param stack
 * @param lineTokens
 * @param checkWhileConditions
 * @param timeLimit Use `0` to indicate no time limit
 * @returns the StackElement or StackElement.TIME_LIMIT_REACHED if the time limit has been reached
 */
function _tokenizeString(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, lineTokens: LineTokens, checkWhileConditions: boolean, timeLimit: number): TokenizeStringResult {
	const lineLength = lineText.content.length;

	let STOP = false;
	let anchorPosition = -1;

	if (checkWhileConditions) {
		const whileCheckResult = _checkWhileConditions(grammar, lineText, isFirstLine, linePos, stack, lineTokens);
		stack = whileCheckResult.stack;
		linePos = whileCheckResult.linePos;
		isFirstLine = whileCheckResult.isFirstLine;
		anchorPosition = whileCheckResult.anchorPosition;
	}

	const startTime = Date.now();
	while (!STOP) {
		if (timeLimit !== 0) {
			const elapsedTime = Date.now() - startTime;
			if (elapsedTime > timeLimit) {
				return new TokenizeStringResult(stack, true);
			}
		}
		scanNext(); // potentially modifies linePos && anchorPosition
	}

	return new TokenizeStringResult(stack, false);

	function scanNext(): void {
		if (DebugFlags.InDebugMode) {
			console.log('');
			console.log(`@@scanNext ${linePos}: |${lineText.content.substr(linePos).replace(/\n$/, '\\n')}|`);
		}
		const r = matchRuleOrInjections(grammar, lineText, isFirstLine, linePos, stack, anchorPosition);

		if (!r) {
			if (DebugFlags.InDebugMode) {
				console.log('  no more matches.');
			}
			// No match
			lineTokens.produce(stack, lineLength);
			STOP = true;
			return;
		}

		const captureIndices: IOnigCaptureIndex[] = r.captureIndices;
		const matchedRuleId: number = r.matchedRuleId;

		const hasAdvanced = (captureIndices && captureIndices.length > 0) ? (captureIndices[0].end > linePos) : false;

		if (matchedRuleId === -1) {
			// We matched the `end` for this rule => pop it
			const poppedRule = <BeginEndRule>stack.getRule(grammar);

			if (DebugFlags.InDebugMode) {
				console.log('  popping ' + poppedRule.debugName + ' - ' + poppedRule.debugEndRegExp);
			}

			lineTokens.produce(stack, captureIndices[0].start);
			stack = stack.setContentNameScopesList(stack.nameScopesList);
			handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, poppedRule.endCaptures, captureIndices);
			lineTokens.produce(stack, captureIndices[0].end);

			// pop
			const popped = stack;
			stack = stack.pop()!;
			anchorPosition = popped.getAnchorPos();

			if (!hasAdvanced && popped.getEnterPos() === linePos) {
				// Grammar pushed & popped a rule without advancing
				if (DebugFlags.InDebugMode) {
					console.error('[1] - Grammar is in an endless loop - Grammar pushed & popped a rule without advancing');
				}

				// See https://github.com/Microsoft/vscode-textmate/issues/12
				// Let's assume this was a mistake by the grammar author and the intent was to continue in this state
				stack = popped;

				lineTokens.produce(stack, lineLength);
				STOP = true;
				return;
			}
		} else {
			// We matched a rule!
			const _rule = grammar.getRule(matchedRuleId);

			lineTokens.produce(stack, captureIndices[0].start);

			const beforePush = stack;
			// push it on the stack rule
			const scopeName = _rule.getName(lineText.content, captureIndices);
			const nameScopesList = stack.contentNameScopesList.push(grammar, scopeName);
			stack = stack.push(matchedRuleId, linePos, anchorPosition, captureIndices[0].end === lineLength, null, nameScopesList, nameScopesList);

			if (_rule instanceof BeginEndRule) {
				const pushedRule = <BeginEndRule>_rule;
				if (DebugFlags.InDebugMode) {
					console.log('  pushing ' + pushedRule.debugName + ' - ' + pushedRule.debugBeginRegExp);
				}

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);
				anchorPosition = captureIndices[0].end;

				const contentName = pushedRule.getContentName(lineText.content, captureIndices);
				const contentNameScopesList = nameScopesList.push(grammar, contentName);
				stack = stack.setContentNameScopesList(contentNameScopesList);

				if (pushedRule.endHasBackReferences) {
					stack = stack.setEndRule(pushedRule.getEndWithResolvedBackReferences(lineText.content, captureIndices));
				}

				if (!hasAdvanced && beforePush.hasSameRuleAs(stack)) {
					// Grammar pushed the same rule without advancing
					if (DebugFlags.InDebugMode) {
						console.error('[2] - Grammar is in an endless loop - Grammar pushed the same rule without advancing');
					}
					stack = stack.pop()!;
					lineTokens.produce(stack, lineLength);
					STOP = true;
					return;
				}
			} else if (_rule instanceof BeginWhileRule) {
				const pushedRule = <BeginWhileRule>_rule;
				if (DebugFlags.InDebugMode) {
					console.log('  pushing ' + pushedRule.debugName);
				}

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);
				anchorPosition = captureIndices[0].end;
				const contentName = pushedRule.getContentName(lineText.content, captureIndices);
				const contentNameScopesList = nameScopesList.push(grammar, contentName);
				stack = stack.setContentNameScopesList(contentNameScopesList);

				if (pushedRule.whileHasBackReferences) {
					stack = stack.setEndRule(pushedRule.getWhileWithResolvedBackReferences(lineText.content, captureIndices));
				}

				if (!hasAdvanced && beforePush.hasSameRuleAs(stack)) {
					// Grammar pushed the same rule without advancing
					if (DebugFlags.InDebugMode) {
						console.error('[3] - Grammar is in an endless loop - Grammar pushed the same rule without advancing');
					}
					stack = stack.pop()!;
					lineTokens.produce(stack, lineLength);
					STOP = true;
					return;
				}
			} else {
				const matchingRule = <MatchRule>_rule;
				if (DebugFlags.InDebugMode) {
					console.log('  matched ' + matchingRule.debugName + ' - ' + matchingRule.debugMatchRegExp);
				}

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, matchingRule.captures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);

				// pop rule immediately since it is a MatchRule
				stack = stack.pop()!;

				if (!hasAdvanced) {
					// Grammar is not advancing, nor is it pushing/popping
					if (DebugFlags.InDebugMode) {
						console.error('[4] - Grammar is in an endless loop - Grammar is not advancing, nor is it pushing/popping');
					}
					stack = stack.safePop();
					lineTokens.produce(stack, lineLength);
					STOP = true;
					return;
				}
			}
		}

		if (captureIndices[0].end > linePos) {
			// Advance stream
			linePos = captureIndices[0].end;
			isFirstLine = false;
		}
	}
}


export class StackElementMetadata {

	public static toBinaryStr(metadata: number): string {
		let r = metadata.toString(2);
		while (r.length < 32) {
			r = '0' + r;
		}
		return r;
	}

	public static printMetadata(metadata: number): void {
		const languageId = StackElementMetadata.getLanguageId(metadata);
		const tokenType = StackElementMetadata.getTokenType(metadata);
		const fontStyle = StackElementMetadata.getFontStyle(metadata);
		const foreground = StackElementMetadata.getForeground(metadata);
		const background = StackElementMetadata.getBackground(metadata);

		console.log({
			languageId: languageId,
			tokenType: tokenType,
			fontStyle: fontStyle,
			foreground: foreground,
			background: background,
		});
	}

	public static getLanguageId(metadata: number): number {
		return (metadata & MetadataConsts.LANGUAGEID_MASK) >>> MetadataConsts.LANGUAGEID_OFFSET;
	}

	public static getTokenType(metadata: number): StandardTokenType {
		return (metadata & MetadataConsts.TOKEN_TYPE_MASK) >>> MetadataConsts.TOKEN_TYPE_OFFSET;
	}

	public static getFontStyle(metadata: number): number {
		return (metadata & MetadataConsts.FONT_STYLE_MASK) >>> MetadataConsts.FONT_STYLE_OFFSET;
	}

	public static getForeground(metadata: number): number {
		return (metadata & MetadataConsts.FOREGROUND_MASK) >>> MetadataConsts.FOREGROUND_OFFSET;
	}

	public static getBackground(metadata: number): number {
		return (metadata & MetadataConsts.BACKGROUND_MASK) >>> MetadataConsts.BACKGROUND_OFFSET;
	}

	/**
	 * Updates the fields in `metadata`.
	 * A value of `0` or `NotSet` indicates that the corresponding field should be left as is.
	*/
	public static set(metadata: number, languageId: number, tokenType: OptionalStandardTokenType, fontStyle: FontStyle, foreground: number, background: number): number {
		let _languageId = StackElementMetadata.getLanguageId(metadata);
		let _tokenType = StackElementMetadata.getTokenType(metadata);
		let _fontStyle = StackElementMetadata.getFontStyle(metadata);
		let _foreground = StackElementMetadata.getForeground(metadata);
		let _background = StackElementMetadata.getBackground(metadata);

		if (languageId !== 0) {
			_languageId = languageId;
		}
		if (tokenType !== OptionalStandardTokenType.NotSet) {
			_tokenType = fromOptionalTokenType(tokenType);
		}
		if (fontStyle !== FontStyle.NotSet) {
			_fontStyle = fontStyle;
		}
		if (foreground !== 0) {
			_foreground = foreground;
		}
		if (background !== 0) {
			_background = background;
		}

		return (
			(_languageId << MetadataConsts.LANGUAGEID_OFFSET)
			| (_tokenType << MetadataConsts.TOKEN_TYPE_OFFSET)
			| (_fontStyle << MetadataConsts.FONT_STYLE_OFFSET)
			| (_foreground << MetadataConsts.FOREGROUND_OFFSET)
			| (_background << MetadataConsts.BACKGROUND_OFFSET)
		) >>> 0;
	}
}

export class ScopeListElement {

	public readonly parent: ScopeListElement | null;
	public readonly scope: string;
	public readonly metadata: number;

	constructor(parent: ScopeListElement | null, scope: string, metadata: number) {
		this.parent = parent;
		this.scope = scope;
		this.metadata = metadata;
	}

	private static _equals(a: ScopeListElement | null, b: ScopeListElement | null): boolean {
		do {
			if (a === b) {
				return true;
			}

			if (!a && !b) {
				// End of list reached for both
				return true;
			}

			if (!a || !b) {
				// End of list reached only for one
				return false;
			}

			if (a.scope !== b.scope || a.metadata !== b.metadata) {
				return false;
			}

			// Go to previous pair
			a = a.parent;
			b = b.parent;
		} while (true);
	}

	public equals(other: ScopeListElement): boolean {
		return ScopeListElement._equals(this, other);
	}

	private static _matchesScope(scope: string, selector: string, selectorWithDot: string): boolean {
		return (selector === scope || scope.substring(0, selectorWithDot.length) === selectorWithDot);
	}

	private static _matches(target: ScopeListElement | null, parentScopes: string[] | null): boolean {
		if (parentScopes === null) {
			return true;
		}

		const len = parentScopes.length;
		let index = 0;
		let selector = parentScopes[index];
		let selectorWithDot = selector + '.';

		while (target) {
			if (this._matchesScope(target.scope, selector, selectorWithDot)) {
				index++;
				if (index === len) {
					return true;
				}
				selector = parentScopes[index];
				selectorWithDot = selector + '.';
			}
			target = target.parent;
		}

		return false;
	}

	public static mergeMetadata(metadata: number, scopesList: ScopeListElement | null, source: ScopeMetadata): number {
		if (source === null) {
			return metadata;
		}

		let fontStyle = FontStyle.NotSet;
		let foreground = 0;
		let background = 0;

		if (source.themeData !== null) {
			// Find the first themeData that matches
			for (let i = 0, len = source.themeData.length; i < len; i++) {
				const themeData = source.themeData[i];

				if (this._matches(scopesList, themeData.parentScopes)) {
					fontStyle = themeData.fontStyle;
					foreground = themeData.foreground;
					background = themeData.background;
					break;
				}
			}
		}

		return StackElementMetadata.set(metadata, source.languageId, source.tokenType, fontStyle, foreground, background);
	}

	private static _push(target: ScopeListElement, grammar: Grammar, scopes: string[]): ScopeListElement {
		for (let i = 0, len = scopes.length; i < len; i++) {
			const scope = scopes[i];
			const rawMetadata = grammar.getMetadataForScope(scope);
			const metadata = ScopeListElement.mergeMetadata(target.metadata, target, rawMetadata);
			target = new ScopeListElement(target, scope, metadata);
		}
		return target;
	}

	public push(grammar: Grammar, scope: string | null): ScopeListElement {
		if (scope === null) {
			return this;
		}
		if (scope.indexOf(' ') >= 0) {
			// there are multiple scopes to push
			return ScopeListElement._push(this, grammar, scope.split(/ /g));
		}
		// there is a single scope to push
		return ScopeListElement._push(this, grammar, [scope]);
	}

	private static _generateScopes(scopesList: ScopeListElement | null): string[] {
		const result: string[] = [];
		let resultLen = 0;
		while (scopesList) {
			result[resultLen++] = scopesList.scope;
			scopesList = scopesList.parent;
		}
		result.reverse();
		return result;
	}

	public generateScopes(): string[] {
		return ScopeListElement._generateScopes(this);
	}
}

/**
 * Represents a "pushed" state on the stack (as a linked list element).
 */
export class StackElement implements StackElementDef {
	_stackElementBrand: void = undefined;

	public static NULL = new StackElement(null, 0, 0, 0, false, null, null!, null!);

	/**
	 * The position on the current line where this state was pushed.
	 * This is relevant only while tokenizing a line, to detect endless loops.
	 * Its value is meaningless across lines.
	 */
	private _enterPos: number;

	/**
	 * The captured anchor position when this stack element was pushed.
	 * This is relevant only while tokenizing a line, to restore the anchor position when popping.
	 * Its value is meaningless across lines.
	 */
	private _anchorPos: number;

	/**
	 * The previous state on the stack (or null for the root state).
	 */
	public readonly parent: StackElement | null;
	/**
	 * The depth of the stack.
	 */
	public readonly depth: number;

	/**
	 * The state (rule) that this element represents.
	 */
	public readonly ruleId: number;
	/**
	 * The state has entered and captured \n. This means that the next line should have an anchorPosition of 0.
	 */
	public readonly beginRuleCapturedEOL: boolean;
	/**
	 * The "pop" (end) condition for this state in case that it was dynamically generated through captured text.
	 */
	public readonly endRule: string | null;
	/**
	 * The list of scopes containing the "name" for this state.
	 */
	public readonly nameScopesList: ScopeListElement;
	/**
	 * The list of scopes containing the "contentName" (besides "name") for this state.
	 * This list **must** contain as an element `scopeName`.
	 */
	public readonly contentNameScopesList: ScopeListElement;

	constructor(parent: StackElement | null, ruleId: number, enterPos: number, anchorPos: number, beginRuleCapturedEOL: boolean, endRule: string | null, nameScopesList: ScopeListElement, contentNameScopesList: ScopeListElement) {
		this.parent = parent;
		this.depth = (this.parent ? this.parent.depth + 1 : 1);
		this.ruleId = ruleId;
		this._enterPos = enterPos;
		this._anchorPos = anchorPos;
		this.beginRuleCapturedEOL = beginRuleCapturedEOL;
		this.endRule = endRule;
		this.nameScopesList = nameScopesList;
		this.contentNameScopesList = contentNameScopesList;
	}

	/**
	 * A structural equals check. Does not take into account `scopes`.
	 */
	private static _structuralEquals(a: StackElement | null, b: StackElement | null): boolean {
		do {
			if (a === b) {
				return true;
			}

			if (!a && !b) {
				// End of list reached for both
				return true;
			}

			if (!a || !b) {
				// End of list reached only for one
				return false;
			}

			if (a.depth !== b.depth || a.ruleId !== b.ruleId || a.endRule !== b.endRule) {
				return false;
			}

			// Go to previous pair
			a = a.parent;
			b = b.parent;
		} while (true);
	}

	private static _equals(a: StackElement, b: StackElement): boolean {
		if (a === b) {
			return true;
		}
		if (!this._structuralEquals(a, b)) {
			return false;
		}
		return a.contentNameScopesList.equals(b.contentNameScopesList);
	}

	public clone(): StackElement {
		return this;
	}

	public equals(other: StackElement): boolean {
		if (other === null) {
			return false;
		}
		return StackElement._equals(this, other);
	}

	private static _reset(el: StackElement | null): void {
		while (el) {
			el._enterPos = -1;
			el._anchorPos = -1;
			el = el.parent;
		}
	}

	public reset(): void {
		StackElement._reset(this);
	}

	public pop(): StackElement | null {
		return this.parent;
	}

	public safePop(): StackElement {
		if (this.parent) {
			return this.parent;
		}
		return this;
	}

	public push(ruleId: number, enterPos: number, anchorPos: number, beginRuleCapturedEOL: boolean, endRule: string | null, nameScopesList: ScopeListElement, contentNameScopesList: ScopeListElement): StackElement {
		return new StackElement(this, ruleId, enterPos, anchorPos, beginRuleCapturedEOL, endRule, nameScopesList, contentNameScopesList);
	}

	public getEnterPos(): number {
		return this._enterPos;
	}

	public getAnchorPos(): number {
		return this._anchorPos;
	}

	public getRule(grammar: IRuleRegistry): Rule {
		return grammar.getRule(this.ruleId);
	}

	private _writeString(res: string[], outIndex: number): number {
		if (this.parent) {
			outIndex = this.parent._writeString(res, outIndex);
		}

		res[outIndex++] = `(${this.ruleId}, TODO-${this.nameScopesList}, TODO-${this.contentNameScopesList})`;

		return outIndex;
	}

	public toString(): string {
		const r: string[] = [];
		this._writeString(r, 0);
		return '[' + r.join(',') + ']';
	}

	public setContentNameScopesList(contentNameScopesList: ScopeListElement): StackElement {
		if (this.contentNameScopesList === contentNameScopesList) {
			return this;
		}
		return this.parent!.push(this.ruleId, this._enterPos, this._anchorPos, this.beginRuleCapturedEOL, this.endRule, this.nameScopesList, contentNameScopesList);
	}

	public setEndRule(endRule: string): StackElement {
		if (this.endRule === endRule) {
			return this;
		}
		return new StackElement(this.parent, this.ruleId, this._enterPos, this._anchorPos, this.beginRuleCapturedEOL, endRule, this.nameScopesList, this.contentNameScopesList);
	}

	public hasSameRuleAs(other: StackElement): boolean {
		let el: StackElement | null = this;
		while (el && el._enterPos === other._enterPos) {
			if (el.ruleId === other.ruleId) {
				return true;
			}
			el = el.parent;
		}
		return false;
	}
}

export class LocalStackElement {
	public readonly scopes: ScopeListElement;
	public readonly endPos: number;

	constructor(scopes: ScopeListElement, endPos: number) {
		this.scopes = scopes;
		this.endPos = endPos;
	}
}

interface TokenTypeMatcher {
	readonly scopeSelector: ScopeSelector;
	readonly type: StandardTokenType;
}

class LineTokens {

	private readonly _emitBinaryTokens: boolean;
	/**
	 * defined only if `DebugFlags.InDebugMode`.
	 */
	private readonly _lineText: string | null;
	/**
	 * used only if `_emitBinaryTokens` is false.
	 */
	private readonly _tokens: IToken[];
	/**
	 * used only if `_emitBinaryTokens` is true.
	 */
	private readonly _binaryTokens: number[];

	private _lastTokenEndIndex: number;

	private readonly _tokenTypeOverrides: TokenTypeMatcher[];

	constructor(emitBinaryTokens: boolean, lineText: string, tokenTypeOverrides: TokenTypeMatcher[]) {
		this._emitBinaryTokens = emitBinaryTokens;
		this._tokenTypeOverrides = tokenTypeOverrides;
		if (DebugFlags.InDebugMode) {
			this._lineText = lineText;
		} else {
			this._lineText = null;
		}
		this._tokens = [];
		this._binaryTokens = [];
		this._lastTokenEndIndex = 0;
	}

	public produce(stack: StackElement, endIndex: number): void {
		this.produceFromScopes(stack.contentNameScopesList, endIndex);
	}

	public produceFromScopes(scopesList: ScopeListElement, endIndex: number): void {
		if (this._lastTokenEndIndex >= endIndex) {
			return;
		}

		if (this._emitBinaryTokens) {
			let metadata = scopesList.metadata;

			if (this._tokenTypeOverrides.length > 0) {
				const scopes = scopesList.generateScopes();
				for (const tokenType of this._tokenTypeOverrides) {
					if (tokenType.scopeSelector.matches(scopes)) {
						metadata = StackElementMetadata.set(metadata, 0, toOptionalTokenType(tokenType.type), FontStyle.NotSet, 0, 0);
					}
				}
			}

			if (this._binaryTokens.length > 0 && this._binaryTokens[this._binaryTokens.length - 1] === metadata) {
				// no need to push a token with the same metadata
				this._lastTokenEndIndex = endIndex;
				return;
			}

			if (DebugFlags.InDebugMode) {
				const scopes = scopesList.generateScopes();
				console.log('  token: |' + this._lineText!.substring(this._lastTokenEndIndex, endIndex).replace(/\n$/, '\\n') + '|');
				for (let k = 0; k < scopes.length; k++) {
					console.log('      * ' + scopes[k]);
				}
			}

			this._binaryTokens.push(this._lastTokenEndIndex);
			this._binaryTokens.push(metadata);

			this._lastTokenEndIndex = endIndex;
			return;
		}

		const scopes = scopesList.generateScopes();

		if (DebugFlags.InDebugMode) {
			console.log('  token: |' + this._lineText!.substring(this._lastTokenEndIndex, endIndex).replace(/\n$/, '\\n') + '|');
			for (let k = 0; k < scopes.length; k++) {
				console.log('      * ' + scopes[k]);
			}
		}

		this._tokens.push({
			startIndex: this._lastTokenEndIndex,
			endIndex: endIndex,
			// value: lineText.substring(lastTokenEndIndex, endIndex),
			scopes: scopes
		});

		this._lastTokenEndIndex = endIndex;
	}

	public getResult(stack: StackElement, lineLength: number): IToken[] {
		if (this._tokens.length > 0 && this._tokens[this._tokens.length - 1].startIndex === lineLength - 1) {
			// pop produced token for newline
			this._tokens.pop();
		}

		if (this._tokens.length === 0) {
			this._lastTokenEndIndex = -1;
			this.produce(stack, lineLength);
			this._tokens[this._tokens.length - 1].startIndex = 0;
		}

		return this._tokens;
	}

	public getBinaryResult(stack: StackElement, lineLength: number): Uint32Array {
		if (this._binaryTokens.length > 0 && this._binaryTokens[this._binaryTokens.length - 2] === lineLength - 1) {
			// pop produced token for newline
			this._binaryTokens.pop();
			this._binaryTokens.pop();
		}

		if (this._binaryTokens.length === 0) {
			this._lastTokenEndIndex = -1;
			this.produce(stack, lineLength);
			this._binaryTokens[this._binaryTokens.length - 2] = 0;
		}

		const result = new Uint32Array(this._binaryTokens.length);
		for (let i = 0, len = this._binaryTokens.length; i < len; i++) {
			result[i] = this._binaryTokens[i];
		}

		return result;
	}
}

function toOptionalTokenType(standardType: StandardTokenType): OptionalStandardTokenType {
	return standardType as any as OptionalStandardTokenType;
}

function fromOptionalTokenType(
	standardType:
		| OptionalStandardTokenType.Other
		| OptionalStandardTokenType.Comment
		| OptionalStandardTokenType.String
		| OptionalStandardTokenType.RegEx
): StandardTokenType {
	return standardType as any as StandardTokenType;
}
