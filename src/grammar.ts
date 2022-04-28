/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { clone, mergeObjects } from './utils';
import { IOnigLib, IOnigCaptureIndex, OnigString, OnigScanner, FindOption } from './onigLib';
import { IRuleRegistry, IRuleFactoryHelper, RuleFactory, Rule, CaptureRule, BeginEndRule, BeginWhileRule, MatchRule, CompiledRule } from './rule';
import { createMatchers, Matcher } from './matcher';
import { IGrammar, ITokenizeLineResult, ITokenizeLineResult2, IToken, IEmbeddedLanguagesMap, StandardTokenType, StateStack as StackElementDef, ITokenTypeMap } from './main';
import { DebugFlags, UseOnigurumaFindOptions } from './debug';
import { FontStyle, ScopeName, ScopeStack, ScopePath, StyleAttributes, ThemeTrieElementRule } from './theme';
import { OptionalStandardTokenType, EncodedTokenAttributes, toOptionalTokenType } from './encodedTokenAttributes';
import { IRawGrammar, IRawRule, IRawRepository } from './rawGrammar';

declare let performance: { now: () => number } | undefined;
const performanceNow = (function () {
	if (typeof performance === 'undefined') {
		// performance.now() is not available in this environment, so use Date.now()
		return () => Date.now();
	} else {
		return () => performance!.now();
	}
})();

export function createGrammar(
	scopeName: ScopeName,
	grammar: IRawGrammar,
	initialLanguage: number,
	embeddedLanguages: IEmbeddedLanguagesMap | null,
	tokenTypes: ITokenTypeMap | null,
	balancedBracketSelectors: BalancedBracketSelectors | null,
	grammarRepository: IGrammarRepository & IThemeProvider,
	onigLib: IOnigLib
): Grammar {
	return new Grammar(
		scopeName,
		grammar,
		initialLanguage,
		embeddedLanguages,
		tokenTypes,
		balancedBracketSelectors,
		grammarRepository,
		onigLib
	); //TODO
}

export interface IThemeProvider {
	themeMatch(scopePath: ScopeStack): StyleAttributes | null;
	getDefaults(): StyleAttributes;
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
	readonly matcher: Matcher<string[]>;
	readonly priority: -1 | 0 | 1; // 0 is the default. -1 for 'L' and 1 for 'R'
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

function nameMatcher(identifers: string[], scopes: string[]) {
	if (scopes.length < identifers.length) {
		return false;
	}
	let lastIndex = 0;
	return identifers.every(identifier => {
		for (let i = lastIndex; i < scopes.length; i++) {
			if (scopesAreMatching(scopes[i], identifier)) {
				lastIndex = i + 1;
				return true;
			}
		}
		return false;
	});
}

function collectInjections(result: Injection[], selector: string, rule: IRawRule, ruleFactoryHelper: IRuleFactoryHelper, grammar: IRawGrammar): void {
	const matchers = createMatchers(selector, nameMatcher);
	const ruleId = RuleFactory.getCompiledRuleId(rule, ruleFactoryHelper, grammar.repository);
	for (const matcher of matchers) {
		result.push({
			debugSelector: selector,
			matcher: matcher.matcher,
			ruleId: ruleId,
			grammar: grammar,
			priority: matcher.priority
		});
	}
}

export class BasicScopeAttributes {
	constructor(
		public readonly languageId: number,
		public readonly tokenType: OptionalStandardTokenType
	) {
	}
}

class ScopeMetadataProvider {

	private readonly _initialLanguage: number;
	private readonly _themeProvider: IThemeProvider;
	private readonly _cache = new Map<string, BasicScopeAttributes>();
	private _defaultMetaData: BasicScopeAttributes;
	private readonly _embeddedLanguages: IEmbeddedLanguagesMap;
	private readonly _embeddedLanguagesRegex: RegExp | null;

	constructor(initialLanguage: number, themeProvider: IThemeProvider, embeddedLanguages: IEmbeddedLanguagesMap | null) {
		this._initialLanguage = initialLanguage;
		this._themeProvider = themeProvider;
		this._defaultMetaData = new BasicScopeAttributes(
			this._initialLanguage,
			OptionalStandardTokenType.NotSet
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
		this._cache.clear();
		this._defaultMetaData = new BasicScopeAttributes(
			this._initialLanguage,
			OptionalStandardTokenType.NotSet
		);
	}

	public getDefaultMetadata(): BasicScopeAttributes {
		return this._defaultMetaData;
	}

	/**
	 * Escapes regular expression characters in a given string
	 */
	private static _escapeRegExpCharacters(value: string): string {
		return value.replace(/[\-\\\{\}\*\+\?\|\^\$\.\,\[\]\(\)\#\s]/g, '\\$&');
	}

	private static readonly _NULL_SCOPE_METADATA = new BasicScopeAttributes(0, 0);
	public getBasicScopeAttributes(scopeName: ScopeName | null): BasicScopeAttributes {
		if (scopeName === null) {
			return ScopeMetadataProvider._NULL_SCOPE_METADATA;
		}
		let value = this._cache.get(scopeName);
		if (value) {
			return value;
		}
		value = this._getBasicScopeAttributes(scopeName);
		this._cache.set(scopeName, value);
		return value;
	}

	private _getBasicScopeAttributes(scopeName: ScopeName): BasicScopeAttributes {
		const languageId = this._scopeToLanguage(scopeName);
		const standardTokenType = this._toStandardTokenType(scopeName);

		return new BasicScopeAttributes(languageId, standardTokenType);
	}

	/**
	 * Given a produced TM scope, return the language that token describes or null if unknown.
	 * e.g. source.html => html, source.css.embedded.html => css, punctuation.definition.tag.html => null
	 */
	private _scopeToLanguage(scope: ScopeName): number {
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
	private readonly _includedGrammars: { [scopeName: string]: IRawGrammar };
	private readonly _grammarRepository: IGrammarRepository & IThemeProvider;
	private readonly _grammar: IRawGrammar;
	private _injections: Injection[] | null;
	private readonly _scopeMetadataProvider: ScopeMetadataProvider;
	private readonly _tokenTypeMatchers: TokenTypeMatcher[];
	private readonly _onigLib: IOnigLib;

	public get themeProvider(): IThemeProvider { return this._grammarRepository; }

	constructor(
		scopeName: ScopeName,
		grammar: IRawGrammar,
		initialLanguage: number,
		embeddedLanguages: IEmbeddedLanguagesMap | null,
		tokenTypes: ITokenTypeMap | null,
		private readonly balancedBracketSelectors: BalancedBracketSelectors | null,
		grammarRepository: IGrammarRepository & IThemeProvider,
		onigLib: IOnigLib
	) {
		this._scopeName = scopeName;
		this._scopeMetadataProvider = new ScopeMetadataProvider(
			initialLanguage,
			grammarRepository,
			embeddedLanguages
		);

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
				const matchers = createMatchers(selector, nameMatcher);
				for (const matcher of matchers) {
					this._tokenTypeMatchers.push({
						matcher: matcher.matcher,
						type: tokenTypes[selector],
					});
				}
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

	public getMetadataForScope(scope: string): BasicScopeAttributes {
		return this._scopeMetadataProvider.getBasicScopeAttributes(scope);
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
			},
		};

		const dependencyProcessor = new ScopeDependencyProcessor(
			grammarRepository,
			this._scopeName
		);
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
					collectInjections(
						result,
						expression,
						rawInjections[expression],
						this,
						grammar
					);
				}
			}

			// add injection grammars contributed for the current scope
			if (this._grammarRepository) {
				const injectionScopeNames =
					this._grammarRepository.injections(scopeName);
				if (injectionScopeNames) {
					injectionScopeNames.forEach((injectionScopeName) => {
						const injectionGrammar =
							this.getExternalGrammar(injectionScopeName);
						if (injectionGrammar) {
							const selector = injectionGrammar.injectionSelector;
							if (selector) {
								collectInjections(
									result,
									selector,
									injectionGrammar,
									this,
									injectionGrammar
								);
							}
						}
					});
				}
			}
		});

		result.sort((i1, i2) => i1.priority - i2.priority); // sort by priority

		return result;
	}

	public getInjections(): Injection[] {
		if (this._injections === null) {
			this._injections = this._collectInjections();

			if (DebugFlags.InDebugMode && this._injections.length > 0) {
				console.log(
					`Grammar ${this._scopeName} contains the following injections:`
				);
				for (const injection of this._injections) {
					console.log(`  - ${injection.debugSelector}`);
				}
			}
		}
		return this._injections;
	}

	public registerRule<T extends Rule>(factory: (id: number) => T): T {
		const id = ++this._lastRuleId;
		const result = factory(id);
		this._ruleId2desc[id] = result;
		return result;
	}

	public getRule(patternId: number): Rule {
		return this._ruleId2desc[patternId];
	}

	public getExternalGrammar(
		scopeName: string,
		repository?: IRawRepository
	): IRawGrammar | undefined {
		if (this._includedGrammars[scopeName]) {
			return this._includedGrammars[scopeName];
		} else if (this._grammarRepository) {
			const rawIncludedGrammar =
				this._grammarRepository.lookup(scopeName);
			if (rawIncludedGrammar) {
				// console.log('LOADED GRAMMAR ' + pattern.include);
				this._includedGrammars[scopeName] = initGrammar(
					rawIncludedGrammar,
					repository && repository.$base
				);
				return this._includedGrammars[scopeName];
			}
		}
		return undefined;
	}

	public tokenizeLine(
		lineText: string,
		prevState: StateStack | null,
		timeLimit: number = 0
	): ITokenizeLineResult {
		const r = this._tokenize(lineText, prevState, false, timeLimit);
		return {
			tokens: r.lineTokens.getResult(r.ruleStack, r.lineLength),
			ruleStack: r.ruleStack,
			stoppedEarly: r.stoppedEarly,
		};
	}

	public tokenizeLine2(
		lineText: string,
		prevState: StateStack | null,
		timeLimit: number = 0
	): ITokenizeLineResult2 {
		const r = this._tokenize(lineText, prevState, true, timeLimit);
		return {
			tokens: r.lineTokens.getBinaryResult(r.ruleStack, r.lineLength),
			ruleStack: r.ruleStack,
			stoppedEarly: r.stoppedEarly,
		};
	}

	private _tokenize(
		lineText: string,
		prevState: StateStack | null,
		emitBinaryTokens: boolean,
		timeLimit: number
	): {
		lineLength: number;
		lineTokens: LineTokens;
		ruleStack: StateStack;
		stoppedEarly: boolean;
	} {
		if (this._rootId === -1) {
			this._rootId = RuleFactory.getCompiledRuleId(
				this._grammar.repository.$self,
				this,
				this._grammar.repository
			);
		}

		let isFirstLine: boolean;
		if (!prevState || prevState === StateStack.NULL) {
			isFirstLine = true;
			const rawDefaultMetadata =
				this._scopeMetadataProvider.getDefaultMetadata();
			const defaultStyle = this.themeProvider.getDefaults();
			const defaultMetadata = EncodedTokenAttributes.set(
				0,
				rawDefaultMetadata.languageId,
				rawDefaultMetadata.tokenType,
				null,
				defaultStyle.fontStyle,
				defaultStyle.foregroundId,
				defaultStyle.backgroundId
			);

			const rootScopeName = this.getRule(this._rootId).getName(
				null,
				null
			);

			let scopeList: AttributedScopeStack;
			if (rootScopeName) {
				scopeList = AttributedScopeStack.createRootAndLookUpScopeName(
					rootScopeName,
					defaultMetadata,
					this
				);
			} else {
				scopeList = AttributedScopeStack.createRoot(
					 "unknown",
					 defaultMetadata
				);
			}

			prevState = new StateStack(
				null,
				this._rootId,
				-1,
				-1,
				false,
				null,
				scopeList,
				scopeList
			);
		} else {
			isFirstLine = false;
			prevState.reset();
		}

		lineText = lineText + "\n";
		const onigLineText = this.createOnigString(lineText);
		const lineLength = onigLineText.content.length;
		const lineTokens = new LineTokens(
			emitBinaryTokens,
			lineText,
			this._tokenTypeMatchers,
			this.balancedBracketSelectors
		);
		const r = _tokenizeString(
			this,
			onigLineText,
			isFirstLine,
			0,
			prevState,
			lineTokens,
			true,
			timeLimit
		);

		disposeOnigString(onigLineText);

		return {
			lineLength: lineLength,
			lineTokens: lineTokens,
			ruleStack: r.stack,
			stoppedEarly: r.stoppedEarly,
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

function handleCaptures(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, stack: StateStack, lineTokens: LineTokens, captures: (CaptureRule | null)[], captureIndices: IOnigCaptureIndex[]): void {
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
			const nameScopesList = stack.contentNameScopesList.pushAttributed(scopeName, grammar);
			const contentName = captureRule.getContentName(lineTextContent, captureIndices);
			const contentNameScopesList = nameScopesList.pushAttributed(contentName, grammar);

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
			const captureRuleScopesList = base.pushAttributed(captureRuleScopeName, grammar);
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

function matchInjections(injections: Injection[], grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StateStack, anchorPosition: number): IMatchInjectionsResult | null {
	// The lower the better
	let bestMatchRating = Number.MAX_VALUE;
	let bestMatchCaptureIndices: IOnigCaptureIndex[] | null = null;
	let bestMatchRuleId: number;
	let bestMatchResultPriority: number = 0;

	const scopes = stack.contentNameScopesList.getScopeNames();

	for (let i = 0, len = injections.length; i < len; i++) {
		const injection = injections[i];
		if (!injection.matcher(scopes)) {
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
		bestMatchResultPriority = injection.priority;

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

function matchRuleOrInjections(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StateStack, anchorPosition: number): IMatchResult | null {
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

function matchRule(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StateStack, anchorPosition: number): IMatchResult | null {
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


interface IWhileStack {
	readonly stack: StateStack;
	readonly rule: BeginWhileRule;
}

interface IWhileCheckResult {
	readonly stack: StateStack;
	readonly linePos: number;
	readonly anchorPosition: number;
	readonly isFirstLine: boolean;
}

/**
 * Walk the stack from bottom to top, and check each while condition in this order.
 * If any fails, cut off the entire stack above the failed while condition. While conditions
 * may also advance the linePosition.
 */
function _checkWhileConditions(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StateStack, lineTokens: LineTokens): IWhileCheckResult {
	let anchorPosition = (stack.beginRuleCapturedEOL ? 0 : -1);
	const whileRules: IWhileStack[] = [];
	for (let node: StateStack | null = stack; node; node = node.pop()) {
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
		public readonly stack: StateStack,
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
function _tokenizeString(
	grammar: Grammar,
	lineText: OnigString,
	isFirstLine: boolean,
	linePos: number,
	stack: StateStack,
	lineTokens: LineTokens,
	checkWhileConditions: boolean,
	timeLimit: number
): TokenizeStringResult {
	const lineLength = lineText.content.length;

	let STOP = false;
	let anchorPosition = -1;

	if (checkWhileConditions) {
		const whileCheckResult = _checkWhileConditions(
			grammar,
			lineText,
			isFirstLine,
			linePos,
			stack,
			lineTokens
		);
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
			console.log("");
			console.log(
				`@@scanNext ${linePos}: |${lineText.content
					.substr(linePos)
					.replace(/\n$/, "\\n")}|`
			);
		}
		const r = matchRuleOrInjections(
			grammar,
			lineText,
			isFirstLine,
			linePos,
			stack,
			anchorPosition
		);

		if (!r) {
			if (DebugFlags.InDebugMode) {
				console.log("  no more matches.");
			}
			// No match
			lineTokens.produce(stack, lineLength);
			STOP = true;
			return;
		}

		const captureIndices: IOnigCaptureIndex[] = r.captureIndices;
		const matchedRuleId: number = r.matchedRuleId;

		const hasAdvanced =
			captureIndices && captureIndices.length > 0
				? captureIndices[0].end > linePos
				: false;

		if (matchedRuleId === -1) {
			// We matched the `end` for this rule => pop it
			const poppedRule = <BeginEndRule>stack.getRule(grammar);

			if (DebugFlags.InDebugMode) {
				console.log(
					"  popping " +
						poppedRule.debugName +
						" - " +
						poppedRule.debugEndRegExp
				);
			}

			lineTokens.produce(stack, captureIndices[0].start);
			stack = stack.withContentNameScopesList(stack.nameScopesList);
			handleCaptures(
				grammar,
				lineText,
				isFirstLine,
				stack,
				lineTokens,
				poppedRule.endCaptures,
				captureIndices
			);
			lineTokens.produce(stack, captureIndices[0].end);

			// pop
			const popped = stack;
			stack = stack.parent!;
			anchorPosition = popped.getAnchorPos();

			if (!hasAdvanced && popped.getEnterPos() === linePos) {
				// Grammar pushed & popped a rule without advancing
				if (DebugFlags.InDebugMode) {
					console.error(
						"[1] - Grammar is in an endless loop - Grammar pushed & popped a rule without advancing"
					);
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
			const nameScopesList = stack.contentNameScopesList.pushAttributed(
				scopeName,
				grammar
			);
			stack = stack.push(
				matchedRuleId,
				linePos,
				anchorPosition,
				captureIndices[0].end === lineLength,
				null,
				nameScopesList,
				nameScopesList
			);

			if (_rule instanceof BeginEndRule) {
				const pushedRule = _rule;
				if (DebugFlags.InDebugMode) {
					console.log(
						"  pushing " +
							pushedRule.debugName +
							" - " +
							pushedRule.debugBeginRegExp
					);
				}

				handleCaptures(
					grammar,
					lineText,
					isFirstLine,
					stack,
					lineTokens,
					pushedRule.beginCaptures,
					captureIndices
				);
				lineTokens.produce(stack, captureIndices[0].end);
				anchorPosition = captureIndices[0].end;

				const contentName = pushedRule.getContentName(
					lineText.content,
					captureIndices
				);
				const contentNameScopesList = nameScopesList.pushAttributed(
					contentName,
					grammar
				);
				stack = stack.withContentNameScopesList(contentNameScopesList);

				if (pushedRule.endHasBackReferences) {
					stack = stack.withEndRule(
						pushedRule.getEndWithResolvedBackReferences(
							lineText.content,
							captureIndices
						)
					);
				}

				if (!hasAdvanced && beforePush.hasSameRuleAs(stack)) {
					// Grammar pushed the same rule without advancing
					if (DebugFlags.InDebugMode) {
						console.error(
							"[2] - Grammar is in an endless loop - Grammar pushed the same rule without advancing"
						);
					}
					stack = stack.pop()!;
					lineTokens.produce(stack, lineLength);
					STOP = true;
					return;
				}
			} else if (_rule instanceof BeginWhileRule) {
				const pushedRule = <BeginWhileRule>_rule;
				if (DebugFlags.InDebugMode) {
					console.log("  pushing " + pushedRule.debugName);
				}

				handleCaptures(
					grammar,
					lineText,
					isFirstLine,
					stack,
					lineTokens,
					pushedRule.beginCaptures,
					captureIndices
				);
				lineTokens.produce(stack, captureIndices[0].end);
				anchorPosition = captureIndices[0].end;
				const contentName = pushedRule.getContentName(
					lineText.content,
					captureIndices
				);
				const contentNameScopesList = nameScopesList.pushAttributed(
					contentName,
					grammar
				);
				stack = stack.withContentNameScopesList(contentNameScopesList);

				if (pushedRule.whileHasBackReferences) {
					stack = stack.withEndRule(
						pushedRule.getWhileWithResolvedBackReferences(
							lineText.content,
							captureIndices
						)
					);
				}

				if (!hasAdvanced && beforePush.hasSameRuleAs(stack)) {
					// Grammar pushed the same rule without advancing
					if (DebugFlags.InDebugMode) {
						console.error(
							"[3] - Grammar is in an endless loop - Grammar pushed the same rule without advancing"
						);
					}
					stack = stack.pop()!;
					lineTokens.produce(stack, lineLength);
					STOP = true;
					return;
				}
			} else {
				const matchingRule = <MatchRule>_rule;
				if (DebugFlags.InDebugMode) {
					console.log(
						"  matched " +
							matchingRule.debugName +
							" - " +
							matchingRule.debugMatchRegExp
					);
				}

				handleCaptures(
					grammar,
					lineText,
					isFirstLine,
					stack,
					lineTokens,
					matchingRule.captures,
					captureIndices
				);
				lineTokens.produce(stack, captureIndices[0].end);

				// pop rule immediately since it is a MatchRule
				stack = stack.pop()!;

				if (!hasAdvanced) {
					// Grammar is not advancing, nor is it pushing/popping
					if (DebugFlags.InDebugMode) {
						console.error(
							"[4] - Grammar is in an endless loop - Grammar is not advancing, nor is it pushing/popping"
						);
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

export class AttributedScopeStack {
	public static createRoot(scopeName: ScopeName, tokenAttributes: EncodedTokenAttributes): AttributedScopeStack {
		return new AttributedScopeStack(null, new ScopeStack(null, scopeName), tokenAttributes);
	}

	public static createRootAndLookUpScopeName(scopeName: ScopeName, tokenAttributes: EncodedTokenAttributes, grammar: Grammar): AttributedScopeStack {
		const rawRootMetadata = grammar.getMetadataForScope(scopeName);
		const scopePath = new ScopeStack(null, scopeName);
		const rootStyle = grammar.themeProvider.themeMatch(scopePath);

		const resolvedTokenAttributes = AttributedScopeStack.mergeAttributes(
			tokenAttributes,
			rawRootMetadata,
			rootStyle
		);

		return new AttributedScopeStack(null, scopePath, resolvedTokenAttributes);
	}

	public get scopeName(): ScopeName { return this.scopePath.scopeName; }

	private constructor(
		public readonly parent: AttributedScopeStack | null,
		public readonly scopePath: ScopeStack,
		public readonly tokenAttributes: EncodedTokenAttributes
	) {
	}

	public equals(other: AttributedScopeStack): boolean {
		return AttributedScopeStack._equals(this, other);
	}

	private static _equals(
		a: AttributedScopeStack | null,
		b: AttributedScopeStack | null
	): boolean {
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

			if (a.scopeName !== b.scopeName || a.tokenAttributes !== b.tokenAttributes) {
				return false;
			}

			// Go to previous pair
			a = a.parent;
			b = b.parent;
		} while (true);
	}

	private static mergeAttributes(
		existingTokenAttributes: EncodedTokenAttributes,
		basicScopeAttributes: BasicScopeAttributes,
		styleAttributes: StyleAttributes | null
	): EncodedTokenAttributes {
		let fontStyle = FontStyle.NotSet;
		let foreground = 0;
		let background = 0;

		if (styleAttributes !== null) {
			fontStyle = styleAttributes.fontStyle;
			foreground = styleAttributes.foregroundId;
			background = styleAttributes.backgroundId;
		}

		return EncodedTokenAttributes.set(
			existingTokenAttributes,
			basicScopeAttributes.languageId,
			basicScopeAttributes.tokenType,
			null,
			fontStyle,
			foreground,
			background
		);
	}

	public pushAttributed(scopePath: ScopePath | null, grammar: Grammar): AttributedScopeStack {
		if (scopePath === null) {
			return this;
		}

		if (scopePath.indexOf(' ') === -1) {
			// This is the common case and much faster

			return AttributedScopeStack._pushAttributed(this, scopePath, grammar);
		}

		const scopes = scopePath.split(/ /g);
		let result: AttributedScopeStack = this;
		for (const scope of scopes) {
			result = AttributedScopeStack._pushAttributed(result, scope, grammar);
		}
		return result;

	}

	private static _pushAttributed(
		target: AttributedScopeStack,
		scopeName: ScopeName,
		grammar: Grammar,
	): AttributedScopeStack {
		const rawMetadata = grammar.getMetadataForScope(scopeName);

		const newPath = target.scopePath.push(scopeName);
		const scopeThemeMatchResult =
			grammar.themeProvider.themeMatch(newPath);
		const metadata = AttributedScopeStack.mergeAttributes(
			target.tokenAttributes,
			rawMetadata,
			scopeThemeMatchResult
		);
		return new AttributedScopeStack(target, newPath, metadata);
	}

	public getScopeNames(): string[] {
		return this.scopePath.getSegments();
	}
}

/**
 * Represents a "pushed" state on the stack (as a linked list element).
 */
export class StateStack implements StackElementDef {
	_stackElementBrand: void = undefined;

	public static NULL = new StateStack(
		null,
		0,
		0,
		0,
		false,
		null,
		null!,
		null!
	);

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
	 * The depth of the stack.
	 */
	public readonly depth: number;

	constructor(
		/**
		 * The previous state on the stack (or null for the root state).
		 */
		public readonly parent: StateStack | null,

		/**
		 * The state (rule) that this element represents.
		 */
		private readonly ruleId: number,

		enterPos: number,
		anchorPos: number,

		/**
		 * The state has entered and captured \n. This means that the next line should have an anchorPosition of 0.
		 */
		public readonly beginRuleCapturedEOL: boolean,

		/**
		 * The "pop" (end) condition for this state in case that it was dynamically generated through captured text.
		 */
		public readonly endRule: string | null,

		/**
		 * The list of scopes containing the "name" for this state.
		 */
		public readonly nameScopesList: AttributedScopeStack,

		/**
		 * The list of scopes containing the "contentName" (besides "name") for this state.
		 * This list **must** contain as an element `scopeName`.
		 */
		public readonly contentNameScopesList: AttributedScopeStack
	) {
		this.depth = this.parent ? this.parent.depth + 1 : 1;
		this._enterPos = enterPos;
		this._anchorPos = anchorPos;
	}

	public equals(other: StateStack): boolean {
		if (other === null) {
			return false;
		}
		return StateStack._equals(this, other);
	}

	private static _equals(a: StateStack, b: StateStack): boolean {
		if (a === b) {
			return true;
		}
		if (!this._structuralEquals(a, b)) {
			return false;
		}
		return a.contentNameScopesList.equals(b.contentNameScopesList);
	}

	/**
	 * A structural equals check. Does not take into account `scopes`.
	 */
	private static _structuralEquals(
		a: StateStack | null,
		b: StateStack | null
	): boolean {
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

			if (
				a.depth !== b.depth ||
				a.ruleId !== b.ruleId ||
				a.endRule !== b.endRule
			) {
				return false;
			}

			// Go to previous pair
			a = a.parent;
			b = b.parent;
		} while (true);
	}

	public clone(): StateStack {
		return this;
	}

	private static _reset(el: StateStack | null): void {
		while (el) {
			el._enterPos = -1;
			el._anchorPos = -1;
			el = el.parent;
		}
	}

	public reset(): void {
		StateStack._reset(this);
	}

	public pop(): StateStack | null {
		return this.parent;
	}

	public safePop(): StateStack {
		if (this.parent) {
			return this.parent;
		}
		return this;
	}

	public push(
		ruleId: number,
		enterPos: number,
		anchorPos: number,
		beginRuleCapturedEOL: boolean,
		endRule: string | null,
		nameScopesList: AttributedScopeStack,
		contentNameScopesList: AttributedScopeStack
	): StateStack {
		return new StateStack(
			this,
			ruleId,
			enterPos,
			anchorPos,
			beginRuleCapturedEOL,
			endRule,
			nameScopesList,
			contentNameScopesList
		);
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

	public toString(): string {
		const r: string[] = [];
		this._writeString(r, 0);
		return "[" + r.join(",") + "]";
	}

	private _writeString(res: string[], outIndex: number): number {
		if (this.parent) {
			outIndex = this.parent._writeString(res, outIndex);
		}

		res[
			outIndex++
		] = `(${this.ruleId}, TODO-${this.nameScopesList}, TODO-${this.contentNameScopesList})`;

		return outIndex;
	}

	public withContentNameScopesList(
		contentNameScopeStack: AttributedScopeStack
	): StateStack {
		if (this.contentNameScopesList === contentNameScopeStack) {
			return this;
		}
		return this.parent!.push(
			this.ruleId,
			this._enterPos,
			this._anchorPos,
			this.beginRuleCapturedEOL,
			this.endRule,
			this.nameScopesList,
			contentNameScopeStack
		);
	}

	public withEndRule(endRule: string): StateStack {
		if (this.endRule === endRule) {
			return this;
		}
		return new StateStack(
			this.parent,
			this.ruleId,
			this._enterPos,
			this._anchorPos,
			this.beginRuleCapturedEOL,
			endRule,
			this.nameScopesList,
			this.contentNameScopesList
		);
	}

	// Used to warn of endless loops
	public hasSameRuleAs(other: StateStack): boolean {
		let el: StateStack | null = this;
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
	public readonly scopes: AttributedScopeStack;
	public readonly endPos: number;

	constructor(scopes: AttributedScopeStack, endPos: number) {
		this.scopes = scopes;
		this.endPos = endPos;
	}
}

interface TokenTypeMatcher {
	readonly matcher: Matcher<string[]>;
	readonly type: StandardTokenType;
}

export class BalancedBracketSelectors {
	private readonly balancedBracketScopes: Matcher<string[]>[];
	private readonly unbalancedBracketScopes: Matcher<string[]>[];

	private allowAny = false;

	constructor(
		balancedBracketScopes: string[],
		unbalancedBracketScopes: string[],
	) {
		this.balancedBracketScopes = balancedBracketScopes.flatMap((selector) => {
				if (selector === '*') {
					this.allowAny = true;
					return [];
				}
				return createMatchers(selector, nameMatcher).map((m) => m.matcher);
			}
		);
		this.unbalancedBracketScopes = unbalancedBracketScopes.flatMap((selector) =>
			createMatchers(selector, nameMatcher).map((m) => m.matcher)
		);
	}

	public get matchesAlways(): boolean {
		return this.allowAny && this.unbalancedBracketScopes.length === 0;
	}

	public get matchesNever(): boolean {
		return this.balancedBracketScopes.length === 0 && !this.allowAny;
	}

	public match(scopes: string[]): boolean {
		for (const excluder of this.unbalancedBracketScopes) {
			if (excluder(scopes)) {
				return false;
			}
		}

		for (const includer of this.balancedBracketScopes) {
			if (includer(scopes)) {
				return true;
			}
		}
		return this.allowAny;
	}
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

	constructor(
		emitBinaryTokens: boolean,
		lineText: string,
		tokenTypeOverrides: TokenTypeMatcher[],
		private readonly balancedBracketSelectors: BalancedBracketSelectors | null,
	) {
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

	public produce(stack: StateStack, endIndex: number): void {
		this.produceFromScopes(stack.contentNameScopesList, endIndex);
	}

	public produceFromScopes(
		scopesList: AttributedScopeStack,
		endIndex: number
	): void {
		if (this._lastTokenEndIndex >= endIndex) {
			return;
		}

		if (this._emitBinaryTokens) {
			let metadata = scopesList.tokenAttributes;
			let containsBalancedBrackets = false;
			if (this.balancedBracketSelectors?.matchesAlways) {
				containsBalancedBrackets = true;
			}

			if (this._tokenTypeOverrides.length > 0 || (this.balancedBracketSelectors && !this.balancedBracketSelectors.matchesAlways && !this.balancedBracketSelectors.matchesNever)) {
				// Only generate scope array when required to improve performance
				const scopes = scopesList.getScopeNames();
				for (const tokenType of this._tokenTypeOverrides) {
					if (tokenType.matcher(scopes)) {
						metadata = EncodedTokenAttributes.set(
							metadata,
							0,
							toOptionalTokenType(tokenType.type),
							null,
							FontStyle.NotSet,
							0,
							0
						);
					}
				}
				if (this.balancedBracketSelectors) {
					containsBalancedBrackets = this.balancedBracketSelectors.match(scopes);
				}
			}

			if (containsBalancedBrackets) {
				metadata = EncodedTokenAttributes.set(
					metadata,
					0,
					OptionalStandardTokenType.NotSet,
					containsBalancedBrackets,
					FontStyle.NotSet,
					0,
					0
				);
			}

			if (this._binaryTokens.length > 0 && this._binaryTokens[this._binaryTokens.length - 1] === metadata) {
				// no need to push a token with the same metadata
				this._lastTokenEndIndex = endIndex;
				return;
			}

			if (DebugFlags.InDebugMode) {
				const scopes = scopesList.getScopeNames();
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

		const scopes = scopesList.getScopeNames();

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

	public getResult(stack: StateStack, lineLength: number): IToken[] {
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

	public getBinaryResult(stack: StateStack, lineLength: number): Uint32Array {
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

