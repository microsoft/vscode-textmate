/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import { clone } from './utils';
import { IRawGrammar, IRawRepository, IRawRule } from './types';
import { IRuleRegistry, IRuleFactoryHelper, RuleFactory, Rule, CaptureRule, BeginEndRule, BeginWhileRule, MatchRule, ICompiledRule, createOnigString, getString } from './rule';
import { IOnigCaptureIndex, OnigString } from 'oniguruma';
import { createMatcher, Matcher } from './matcher';
import { MetadataConsts, IGrammar, ITokenizeLineResult, ITokenizeLineResult2, IToken, IEmbeddedLanguagesMap, StandardTokenType, StackElement as StackElementDef } from './main';
import { IN_DEBUG_MODE } from './debug';
import { FontStyle, ThemeTrieElementRule } from './theme';

export function createGrammar(grammar: IRawGrammar, initialLanguage: number, embeddedLanguages: IEmbeddedLanguagesMap, grammarRepository: IGrammarRepository & IThemeProvider): IGrammar {
	return new Grammar(grammar, initialLanguage, embeddedLanguages, grammarRepository);
}

export interface IThemeProvider {
	themeMatch(scopeName: string): ThemeTrieElementRule[];
	getDefaults(): ThemeTrieElementRule;
}

export interface IGrammarRepository {
	lookup(scopeName: string): IRawGrammar;
	injections(scopeName: string): string[];
}

export interface IScopeNameSet {
	[scopeName: string]: boolean;
}

/**
 * Fill in `result` all external included scopes in `patterns`
 */
function _extractIncludedScopesInPatterns(result: IScopeNameSet, patterns: IRawRule[]): void {
	for (let i = 0, len = patterns.length; i < len; i++) {

		if (Array.isArray(patterns[i].patterns)) {
			_extractIncludedScopesInPatterns(result, patterns[i].patterns);
		}

		let include = patterns[i].include;

		if (!include) {
			continue;
		}

		if (include === '$base' || include === '$self') {
			// Special includes that can be resolved locally in this grammar
			continue;
		}

		if (include.charAt(0) === '#') {
			// Local include from this grammar
			continue;
		}

		let sharpIndex = include.indexOf('#');
		if (sharpIndex >= 0) {
			result[include.substring(0, sharpIndex)] = true;
		} else {
			result[include] = true;
		}
	}
}

/**
 * Fill in `result` all external included scopes in `repository`
 */
function _extractIncludedScopesInRepository(result: IScopeNameSet, repository: IRawRepository): void {
	for (let name in repository) {
		let rule = repository[name];

		if (rule.patterns && Array.isArray(rule.patterns)) {
			_extractIncludedScopesInPatterns(result, rule.patterns);
		}

		if (rule.repository) {
			_extractIncludedScopesInRepository(result, rule.repository);
		}
	}
}

/**
 * Collects the list of all external included scopes in `grammar`.
 */
export function collectIncludedScopes(result: IScopeNameSet, grammar: IRawGrammar): void {
	if (grammar.patterns && Array.isArray(grammar.patterns)) {
		_extractIncludedScopesInPatterns(result, grammar.patterns);
	}

	if (grammar.repository) {
		_extractIncludedScopesInRepository(result, grammar.repository);
	}

	// remove references to own scope (avoid recursion)
	delete result[grammar.scopeName];
}

interface Injection {
	readonly matcher: Matcher<StackElement>;
	readonly priorityMatch: boolean;
	readonly ruleId: number;
	readonly grammar: IRawGrammar;
}

function collectInjections(result: Injection[], selector: string, rule: IRawRule, ruleFactoryHelper: IRuleFactoryHelper, grammar: IRawGrammar): void {
	function scopesAreMatching(thisScopeName: string, scopeName: string): boolean {
		if (!thisScopeName) {
			return false;
		}
		if (thisScopeName === scopeName) {
			return true;
		}
		var len = scopeName.length;
		return thisScopeName.length > len && thisScopeName.substr(0, len) === scopeName && thisScopeName[len] === '.';
	}

	function nameMatcher(identifers: string[], stackElements: StackElement) {
		let scopes = stackElements.generateScopes();
		var lastIndex = 0;
		return identifers.every(identifier => {
			for (var i = lastIndex; i < scopes.length; i++) {
				if (scopesAreMatching(scopes[i], identifier)) {
					lastIndex = i;
					return true;
				}
			}
			return false;
		});
	};

	var subExpressions = selector.split(',');
	subExpressions.forEach(subExpression => {
		var expressionString = subExpression.replace(/L:/g, '');

		result.push({
			matcher: createMatcher(expressionString, nameMatcher),
			ruleId: RuleFactory.getCompiledRuleId(rule, ruleFactoryHelper, grammar.repository),
			grammar: grammar,
			priorityMatch: expressionString.length < subExpression.length
		});
	});
}

export class ScopeMetadata {
	public readonly scopeName: string;
	public readonly languageId: number;
	public readonly tokenType: number;
	public readonly themeData: ThemeTrieElementRule[];

	constructor(scopeName: string, languageId: number, tokenType: number, themeData: ThemeTrieElementRule[]) {
		this.scopeName = scopeName;
		this.languageId = languageId;
		this.tokenType = tokenType;
		this.themeData = themeData;
	}
}

class ScopeMetadataProvider {

	private readonly _themeProvider: IThemeProvider;
	private readonly _cache: { [scopeName: string]: ScopeMetadata; };
	private readonly _rootMetaData: ScopeMetadata;
	private readonly _embeddedLanguages: IEmbeddedLanguagesMap;
	private readonly _embeddedLanguagesRegex: RegExp;

	constructor(initialLanguage: number, themeProvider: IThemeProvider, embeddedLanguages: IEmbeddedLanguagesMap) {
		this._themeProvider = themeProvider;
		this._cache = Object.create(null);
		this._rootMetaData = new ScopeMetadata(
			'',
			initialLanguage,
			StandardTokenType.Other,
			[this._themeProvider.getDefaults()]
		);

		// embeddedLanguages handling
		this._embeddedLanguages = Object.create(null);

		if (embeddedLanguages) {
			// If embeddedLanguages are configured, fill in `this._embeddedLanguages`
			let scopes = Object.keys(embeddedLanguages);
			for (let i = 0, len = scopes.length; i < len; i++) {
				let scope = scopes[i];
				let language = embeddedLanguages[scope];
				if (typeof language !== 'number' || language === 0) {
					console.warn('Invalid embedded language found at scope ' + scope + ': <<' + language + '>>');
					// never hurts to be too careful
					continue;
				}
				this._embeddedLanguages[scope] = language;
			}
		}

		// create the regex
		let escapedScopes = Object.keys(this._embeddedLanguages).map((scopeName) => ScopeMetadataProvider._escapeRegExpCharacters(scopeName));
		if (escapedScopes.length === 0) {
			// no scopes registered
			this._embeddedLanguagesRegex = null;
		} else {
			escapedScopes.sort();
			escapedScopes.reverse();
			this._embeddedLanguagesRegex = new RegExp(`^((${escapedScopes.join(')|(')}))($|\\.)`, '');
		}
	}

	public getRootMetadata(): ScopeMetadata {
		return this._rootMetaData;
	}

	/**
	 * Escapes regular expression characters in a given string
	 */
	private static _escapeRegExpCharacters(value: string): string {
		return value.replace(/[\-\\\{\}\*\+\?\|\^\$\.\,\[\]\(\)\#\s]/g, '\\$&');
	}

	private static _NULL_SCOPE_METADATA = new ScopeMetadata('', 0, 0, null);
	public getMetadataForScope(scopeName: string): ScopeMetadata {
		if (scopeName === null) {
			return ScopeMetadataProvider._NULL_SCOPE_METADATA;
		}
		let value = this._cache[scopeName];
		if (value) {
			return value;
		}
		value = this._doGetMetadataForScope(scopeName);
		this._cache[scopeName] = value;
		return value;
	}

	private _doGetMetadataForScope(scopeName: string): ScopeMetadata {
		let languageId = this._scopeToLanguage(scopeName);
		let standardTokenType = ScopeMetadataProvider._toStandardTokenType(scopeName);
		let themeData = this._themeProvider.themeMatch(scopeName);

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
		let m = scope.match(this._embeddedLanguagesRegex);
		if (!m) {
			// no scopes matched
			return 0;
		}

		let language = this._embeddedLanguages[m[1]] || 0;
		if (!language) {
			return 0;
		}

		return language;
	}

	private static STANDARD_TOKEN_TYPE_REGEXP = /\b(comment|string|regex)\b/;
	private static _toStandardTokenType(tokenType: string): StandardTokenType {
		let m = tokenType.match(ScopeMetadataProvider.STANDARD_TOKEN_TYPE_REGEXP);
		if (!m) {
			return StandardTokenType.Other;
		}
		switch (m[1]) {
			case 'comment':
				return StandardTokenType.Comment;
			case 'string':
				return StandardTokenType.String;
			case 'regex':
				return StandardTokenType.RegEx;
		}
		throw new Error('Unexpected match for standard token type!');
	}
}

class Grammar implements IGrammar, IRuleFactoryHelper {

	private _rootId: number;
	private _lastRuleId: number;
	private readonly _ruleId2desc: Rule[];
	private readonly _includedGrammars: { [scopeName: string]: IRawGrammar; };
	private readonly _grammarRepository: IGrammarRepository;
	private readonly _grammar: IRawGrammar;
	private _injections: Injection[];
	private readonly _scopeMetadataProvider: ScopeMetadataProvider;

	constructor(grammar: IRawGrammar, initialLanguage: number, embeddedLanguages: IEmbeddedLanguagesMap, grammarRepository: IGrammarRepository & IThemeProvider) {
		this._scopeMetadataProvider = new ScopeMetadataProvider(initialLanguage, grammarRepository, embeddedLanguages);

		this._rootId = -1;
		this._lastRuleId = 0;
		this._ruleId2desc = [];
		this._includedGrammars = {};
		this._grammarRepository = grammarRepository;
		this._grammar = initGrammar(grammar, null);
	}

	public getMetadataForScope(scope: string): ScopeMetadata {
		return this._scopeMetadataProvider.getMetadataForScope(scope);
	}

	public getInjections(states: StackElement): Injection[] {
		if (!this._injections) {
			this._injections = [];
			// add injections from the current grammar
			var rawInjections = this._grammar.injections;
			if (rawInjections) {
				for (var expression in rawInjections) {
					collectInjections(this._injections, expression, rawInjections[expression], this, this._grammar);
				}
			}

			// add injection grammars contributed for the current scope
			if (this._grammarRepository) {
				let injectionScopeNames = this._grammarRepository.injections(this._grammar.scopeName);
				if (injectionScopeNames) {
					injectionScopeNames.forEach(injectionScopeName => {
						let injectionGrammar = this.getExternalGrammar(injectionScopeName);
						if (injectionGrammar) {
							let selector = injectionGrammar.injectionSelector;
							if (selector) {
								collectInjections(this._injections, selector, injectionGrammar, this, injectionGrammar);
							}
						}
					});
				}
			}
		}
		if (this._injections.length === 0) {
			return this._injections;
		}
		return this._injections.filter(injection => injection.matcher(states));
	}

	public registerRule<T extends Rule>(factory: (id: number) => T): T {
		let id = (++this._lastRuleId);
		let result = factory(id);
		this._ruleId2desc[id] = result;
		return result;
	}

	public getRule(patternId: number): Rule {
		return this._ruleId2desc[patternId];
	}

	public getExternalGrammar(scopeName: string, repository?: IRawRepository): IRawGrammar {
		if (this._includedGrammars[scopeName]) {
			return this._includedGrammars[scopeName];
		} else if (this._grammarRepository) {
			let rawIncludedGrammar = this._grammarRepository.lookup(scopeName);
			if (rawIncludedGrammar) {
				// console.log('LOADED GRAMMAR ' + pattern.include);
				this._includedGrammars[scopeName] = initGrammar(rawIncludedGrammar, repository && repository.$base);
				return this._includedGrammars[scopeName];
			}
		}
	}

	public tokenizeLine(lineText: string, prevState: StackElement): ITokenizeLineResult {
		let r = this._tokenize(lineText, prevState, false);
		return {
			tokens: r.lineTokens.getResult(r.ruleStack, r.lineLength),
			ruleStack: r.ruleStack
		};
	}

	public tokenizeLine2(lineText: string, prevState: StackElement): ITokenizeLineResult2 {
		let r = this._tokenize(lineText, prevState, true);
		return {
			tokens: r.lineTokens.getBinaryResult(r.ruleStack, r.lineLength),
			ruleStack: r.ruleStack
		};
	}

	private _tokenize(lineText: string, prevState: StackElement, emitBinaryTokens: boolean): { lineLength: number; lineTokens: LineTokens; ruleStack: StackElement; } {
		if (this._rootId === -1) {
			this._rootId = RuleFactory.getCompiledRuleId(this._grammar.repository.$self, this, this._grammar.repository);
		}

		let isFirstLine: boolean;
		if (!prevState) {
			isFirstLine = true;
			let rootMetadata = this._scopeMetadataProvider.getRootMetadata();
			let themeData = rootMetadata.themeData[0];
			let _rootMetadata = StackElementMetadata.set(0, rootMetadata.languageId, rootMetadata.tokenType, themeData.fontStyle, themeData.foreground, themeData.background);

			let scopeName = this.getRule(this._rootId).getName(null, null);
			let scopeNameMetadata = this._scopeMetadataProvider.getMetadataForScope(scopeName);
			let _scopeNameMetadata = StackElementMetadata.merge(_rootMetadata, scopeNameMetadata, null);

			prevState = new StackElement(null, this._rootId, -1, null, scopeName, _scopeNameMetadata, null, _scopeNameMetadata);
		} else {
			isFirstLine = false;
			prevState.reset();
		}

		lineText = lineText + '\n';
		let onigLineText = createOnigString(lineText);
		let lineLength = getString(onigLineText).length;
		let lineTokens = new LineTokens(emitBinaryTokens, lineText);
		let nextState = _tokenizeString(this, onigLineText, isFirstLine, 0, prevState, lineTokens);

		return {
			lineLength: lineLength,
			lineTokens: lineTokens,
			ruleStack: nextState
		};
	}
}

function initGrammar(grammar: IRawGrammar, base: IRawRule): IRawGrammar {
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

function handleCaptures(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, stack: StackElement, lineTokens: LineTokens, captures: CaptureRule[], captureIndices: IOnigCaptureIndex[]): void {
	if (captures.length === 0) {
		return;
	}

	let len = Math.min(captures.length, captureIndices.length);
	let localStack: LocalStackElement[] = [];
	let maxEnd = captureIndices[0].end;

	for (let i = 0; i < len; i++) {
		let captureRule = captures[i];
		if (captureRule === null) {
			// Not interested
			continue;
		}

		let captureIndex = captureIndices[i];

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
			lineTokens.produce(stack, localStack[localStack.length - 1].endPos, localStack);
			localStack.pop();
		}

		lineTokens.produce(stack, captureIndex.start, localStack);

		if (captureRule.retokenizeCapturedWithRuleId) {
			// the capture requires additional matching
			let scopeName = captureRule.getName(getString(lineText), captureIndices);
			let scopeNameMetadata = grammar.getMetadataForScope(scopeName);
			let contentName = captureRule.getContentName(getString(lineText), captureIndices);
			let contentNameMetadata = grammar.getMetadataForScope(contentName);
			let stackClone = stack.push(captureRule.retokenizeCapturedWithRuleId, captureIndex.start, null, scopeName, scopeNameMetadata, contentName, contentNameMetadata);
			_tokenizeString(grammar,
				createOnigString(
					getString(lineText).substring(0, captureIndex.end)
				),
				(isFirstLine && captureIndex.start === 0), captureIndex.start, stackClone, lineTokens
			);
			continue;
		}

		let captureRuleScopeName = captureRule.getName(getString(lineText), captureIndices);
		if (captureRuleScopeName !== null) {
			// push
			let captureRuleScopeNameMetadata = grammar.getMetadataForScope(captureRuleScopeName);
			let base = localStack.length === 0 ? stack.contentMetadata : localStack[localStack.length - 1].scopeMetadata;
			let _captureRuleScopeNameMetadata = StackElementMetadata.merge(base, captureRuleScopeNameMetadata, new ScopeListProvider(stack, localStack, null));
			localStack.push(new LocalStackElement(captureRuleScopeName, _captureRuleScopeNameMetadata, captureIndex.end));
		}
	}

	while (localStack.length > 0) {
		// pop!
		lineTokens.produce(stack, localStack[localStack.length - 1].endPos, localStack);
		localStack.pop();
	}
}

interface IMatchInjectionsResult {
	readonly priorityMatch: boolean;
	readonly captureIndices: IOnigCaptureIndex[];
	readonly matchedRuleId: number;
}

function debugCompiledRuleToString(ruleScanner: ICompiledRule): string {
	let r: string[] = [];
	for (let i = 0, len = ruleScanner.rules.length; i < len; i++) {
		r.push('   - ' + ruleScanner.rules[i] + ': ' + ruleScanner.debugRegExps[i]);
	}
	return r.join('\n');
}

function matchInjections(injections: Injection[], grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, anchorPosition: number): IMatchInjectionsResult {
	// The lower the better
	let bestMatchRating = Number.MAX_VALUE;
	let bestMatchCaptureIndices: IOnigCaptureIndex[] = null;
	let bestMatchRuleId: number;
	let bestMatchResultPriority: boolean = false;

	for (let i = 0, len = injections.length; i < len; i++) {
		let injection = injections[i];
		let ruleScanner = grammar.getRule(injection.ruleId).compile(grammar, null, isFirstLine, linePos === anchorPosition);
		let matchResult = ruleScanner.scanner._findNextMatchSync(lineText, linePos);
		if (IN_DEBUG_MODE) {
			console.log('  scanning for injections');
			console.log(debugCompiledRuleToString(ruleScanner));
		}

		if (!matchResult) {
			continue;
		}

		let matchRating = matchResult.captureIndices[0].start;

		if (matchRating >= bestMatchRating) {
			continue;
		}

		bestMatchRating = matchRating;
		bestMatchCaptureIndices = matchResult.captureIndices;
		bestMatchRuleId = ruleScanner.rules[matchResult.index];
		bestMatchResultPriority = injection.priorityMatch;

		if (bestMatchRating === linePos && bestMatchResultPriority) {
			// No more need to look at the rest of the injections
			break;
		}
	}

	if (bestMatchCaptureIndices) {
		return {
			priorityMatch: bestMatchResultPriority,
			captureIndices: bestMatchCaptureIndices,
			matchedRuleId: bestMatchRuleId
		};
	}

	return null;
}

interface IMatchResult {
	readonly captureIndices: IOnigCaptureIndex[];
	readonly matchedRuleId: number;
}

function matchRule(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, anchorPosition: number): IMatchResult {
	let rule = stack.getRule(grammar);
	let ruleScanner = rule.compile(grammar, stack.endRule, isFirstLine, linePos === anchorPosition);
	let r = ruleScanner.scanner._findNextMatchSync(lineText, linePos);
	if (IN_DEBUG_MODE) {
		console.log('  scanning for');
		console.log(debugCompiledRuleToString(ruleScanner));
	}

	if (r) {
		return {
			captureIndices: r.captureIndices,
			matchedRuleId: ruleScanner.rules[r.index]
		};
	}
	return null;
}

function matchRuleOrInjections(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, anchorPosition: number): IMatchResult {
	// Look for normal grammar rule
	let matchResult = matchRule(grammar, lineText, isFirstLine, linePos, stack, anchorPosition);

	// Look for injected rules
	let injections = grammar.getInjections(stack);
	if (injections.length === 0) {
		// No injections whatsoever => early return
		return matchResult;
	}

	let injectionResult = matchInjections(injections, grammar, lineText, isFirstLine, linePos, stack, anchorPosition);
	if (!injectionResult) {
		// No injections matched => early return
		return matchResult;
	}

	if (!matchResult) {
		// Only injections matched => early return
		return injectionResult;
	}

	// Decide if `matchResult` or `injectionResult` should win
	let matchResultScore = matchResult.captureIndices[0].start;
	let injectionResultScore = injectionResult.captureIndices[0].start;

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
	let anchorPosition = -1;
	let whileRules: IWhileStack[] = [];
	for (let node = stack; node; node = node.pop()) {
		let nodeRule = node.getRule(grammar);
		if (nodeRule instanceof BeginWhileRule) {
			whileRules.push({
				rule: nodeRule,
				stack: node
			});
		}
	}

	for (let whileRule = whileRules.pop(); whileRule; whileRule = whileRules.pop()) {
		let ruleScanner = whileRule.rule.compileWhile(grammar, whileRule.stack.endRule, isFirstLine, anchorPosition === linePos);
		let r = ruleScanner.scanner._findNextMatchSync(lineText, linePos);
		if (IN_DEBUG_MODE) {
			console.log('  scanning for while rule');
			console.log(debugCompiledRuleToString(ruleScanner));
		}

		if (r) {
			let matchedRuleId = ruleScanner.rules[r.index];
			if (matchedRuleId !== -2) {
				// we shouldn't end up here
				stack = whileRule.stack.pop();
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
			stack = whileRule.stack.pop();
			break;
		}
	}

	return { stack: stack, linePos: linePos, anchorPosition: anchorPosition, isFirstLine: isFirstLine };
}

function _tokenizeString(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, lineTokens: LineTokens): StackElement {
	const lineLength = getString(lineText).length;

	let STOP = false;

	let whileCheckResult = _checkWhileConditions(grammar, lineText, isFirstLine, linePos, stack, lineTokens);
	stack = whileCheckResult.stack;
	linePos = whileCheckResult.linePos;
	isFirstLine = whileCheckResult.isFirstLine;
	let anchorPosition = whileCheckResult.anchorPosition;

	while (!STOP) {
		scanNext(); // potentially modifies linePos && anchorPosition
	}

	function scanNext(): void {
		if (IN_DEBUG_MODE) {
			console.log('');
			console.log('@@scanNext: |' + getString(lineText).replace(/\n$/, '\\n').substr(linePos) + '|');
		}
		let r = matchRuleOrInjections(grammar, lineText, isFirstLine, linePos, stack, anchorPosition);

		if (!r) {
			if (IN_DEBUG_MODE) {
				console.log('  no more matches.');
			}
			// No match
			lineTokens.produce(stack, lineLength);
			STOP = true;
			return;
		}

		let captureIndices: IOnigCaptureIndex[] = r.captureIndices;
		let matchedRuleId: number = r.matchedRuleId;

		let hasAdvanced = (captureIndices && captureIndices.length > 0) ? (captureIndices[0].end > linePos) : false;

		if (matchedRuleId === -1) {
			// We matched the `end` for this rule => pop it
			let poppedRule = <BeginEndRule>stack.getRule(grammar);

			if (IN_DEBUG_MODE) {
				console.log('  popping ' + poppedRule.debugName + ' - ' + poppedRule.debugEndRegExp);
			}

			lineTokens.produce(stack, captureIndices[0].start);
			stack = stack.withContentName(null, null);
			handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, poppedRule.endCaptures, captureIndices);
			lineTokens.produce(stack, captureIndices[0].end);

			// pop
			let popped = stack;
			stack = stack.pop();

			if (!hasAdvanced && popped.getEnterPos() === linePos) {
				// Grammar pushed & popped a rule without advancing
				console.error('[1] - Grammar is in an endless loop - Grammar pushed & popped a rule without advancing');

				// See https://github.com/Microsoft/vscode-textmate/issues/12
				// Let's assume this was a mistake by the grammar author and the intent was to continue in this state
				stack = popped;

				lineTokens.produce(stack, lineLength);
				STOP = true;
				return;
			}
		} else {
			// We matched a rule!
			let _rule = grammar.getRule(matchedRuleId);

			lineTokens.produce(stack, captureIndices[0].start);

			let beforePush = stack;
			// push it on the stack rule
			let scopeName = _rule.getName(getString(lineText), captureIndices);
			let scopeNameMetadata = grammar.getMetadataForScope(scopeName);
			stack = stack.push(matchedRuleId, linePos, null, scopeName, scopeNameMetadata, null, null);

			if (_rule instanceof BeginEndRule) {
				let pushedRule = <BeginEndRule>_rule;
				if (IN_DEBUG_MODE) {
					console.log('  pushing ' + pushedRule.debugName + ' - ' + pushedRule.debugBeginRegExp);
				}

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);
				anchorPosition = captureIndices[0].end;

				let contentName = pushedRule.getContentName(getString(lineText), captureIndices);
				let contentNameMetadata = grammar.getMetadataForScope(contentName);
				stack = stack.withContentName(contentName, contentNameMetadata);

				if (pushedRule.endHasBackReferences) {
					stack = stack.withEndRule(pushedRule.getEndWithResolvedBackReferences(getString(lineText), captureIndices));
				}

				if (!hasAdvanced && beforePush.hasSameRuleAs(stack)) {
					// Grammar pushed the same rule without advancing
					console.error('[2] - Grammar is in an endless loop - Grammar pushed the same rule without advancing');
					stack = stack.pop();
					lineTokens.produce(stack, lineLength);
					STOP = true;
					return;
				}
			} else if (_rule instanceof BeginWhileRule) {
				let pushedRule = <BeginWhileRule>_rule;
				if (IN_DEBUG_MODE) {
					console.log('  pushing ' + pushedRule.debugName);
				}

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);
				anchorPosition = captureIndices[0].end;
				let contentName = pushedRule.getContentName(getString(lineText), captureIndices);
				let contentNameMetadata = grammar.getMetadataForScope(contentName);
				stack = stack.withContentName(contentName, contentNameMetadata);

				if (pushedRule.whileHasBackReferences) {
					stack = stack.withEndRule(pushedRule.getWhileWithResolvedBackReferences(getString(lineText), captureIndices));
				}

				if (!hasAdvanced && beforePush.hasSameRuleAs(stack)) {
					// Grammar pushed the same rule without advancing
					console.error('[3] - Grammar is in an endless loop - Grammar pushed the same rule without advancing');
					stack = stack.pop();
					lineTokens.produce(stack, lineLength);
					STOP = true;
					return;
				}
			} else {
				let matchingRule = <MatchRule>_rule;
				if (IN_DEBUG_MODE) {
					console.log('  matched ' + matchingRule.debugName + ' - ' + matchingRule.debugMatchRegExp);
				}

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, matchingRule.captures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);

				// pop rule immediately since it is a MatchRule
				stack = stack.pop();

				if (!hasAdvanced) {
					// Grammar is not advancing, nor is it pushing/popping
					console.error('[4] - Grammar is in an endless loop - Grammar is not advancing, nor is it pushing/popping');
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

	return stack;
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
		let languageId = StackElementMetadata.getLanguageId(metadata);
		let tokenType = StackElementMetadata.getTokenType(metadata);
		let fontStyle = StackElementMetadata.getFontStyle(metadata);
		let foreground = StackElementMetadata.getForeground(metadata);
		let background = StackElementMetadata.getBackground(metadata);

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

	public static getTokenType(metadata: number): number {
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

	public static set(metadata: number, languageId: number, tokenType: StandardTokenType, fontStyle: FontStyle, foreground: number, background: number): number {
		let _languageId = StackElementMetadata.getLanguageId(metadata);
		let _tokenType = StackElementMetadata.getTokenType(metadata);
		let _fontStyle = StackElementMetadata.getFontStyle(metadata);
		let _foreground = StackElementMetadata.getForeground(metadata);
		let _background = StackElementMetadata.getBackground(metadata);

		if (languageId !== 0) {
			_languageId = languageId;
		}
		if (tokenType !== StandardTokenType.Other) {
			_tokenType = tokenType;
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

	public static merge(metadata: number, source: ScopeMetadata, scopeList: ScopeListProvider): number {
		if (source === null) {
			return metadata;
		}

		let fontStyle = FontStyle.NotSet;
		let foreground = 0;
		let background = 0;

		if (source.themeData === null || source.themeData.length === 0) {
			// No themeing...
		} else if (source.themeData.length === 1 && source.themeData[0].parentScopes === null) {
			let themeData = source.themeData[0];
			fontStyle = themeData.fontStyle;
			foreground = themeData.foreground;
			background = themeData.background;
		} else {
			// find the first themeData that matches
			for (let i = 0, len = source.themeData.length; i < len; i++) {
				let themeData = source.themeData[i];
				if (scopeList && scopeList.matches(themeData.parentScopes)) {
					fontStyle = themeData.fontStyle;
					foreground = themeData.foreground;
					background = themeData.background;
					break;
				}
			}
		}

		return this.set(metadata, source.languageId, source.tokenType, fontStyle, foreground, background);
	}

}

/**
 * **IMPORTANT** - Immutable!
 */
export class StackElement implements StackElementDef {
	public _stackElementBrand: void;

	private _enterPos: number;

	public readonly depth: number;
	public readonly parent: StackElement;

	public readonly ruleId: number;
	public readonly endRule: string;
	public readonly scopeName: string;
	public readonly scopeMetadata: number;
	public readonly contentName: string;
	public readonly contentMetadata: number;

	constructor(parent: StackElement, ruleId: number, enterPos: number, endRule: string, scopeName: string, scopeMetadata: number, contentName: string, contentMetadata: number) {
		this.parent = parent;
		this.depth = (this.parent ? this.parent.depth + 1 : 1);
		this.ruleId = ruleId;
		this._enterPos = enterPos;
		this.endRule = endRule;
		this.scopeName = scopeName;
		this.scopeMetadata = scopeMetadata;
		this.contentName = contentName;
		this.contentMetadata = contentMetadata;
	}

	private static _equals(a: StackElement, b: StackElement): boolean {
		do {
			if (
				a.depth !== b.depth
				|| a.ruleId !== b.ruleId
				|| a.endRule !== b.endRule
				|| a.scopeName !== b.scopeName
				|| a.contentName !== b.contentName
			) {
				return false;
			}

			a = a.parent;
			b = b.parent;

			if (!a && !b) {
				return true;
			}
			if (!a || !b) {
				return false;
			}
		} while (true);
	}

	public equals(other: StackElement): boolean {
		return StackElement._equals(this, other);
	}

	private static _reset(el: StackElement): void {
		while (el) {
			el._enterPos = -1;
			el = el.parent;
		}
	}

	public reset(): void {
		StackElement._reset(this);
	}

	public pop(): StackElement {
		return this.parent;
	}

	public safePop(): StackElement {
		if (this.parent) {
			return this.parent;
		}
		return this;
	}

	public push(ruleId: number, enterPos: number, endRule: string, scopeName: string, scopeNameMetadata: ScopeMetadata, contentName: string, contentNameMetadata: ScopeMetadata): StackElement {
		let _scopeNameMetadata = StackElementMetadata.merge(this.contentMetadata, scopeNameMetadata, new ScopeListProvider(this, null, null));
		return this._push(ruleId, enterPos, endRule, scopeName, _scopeNameMetadata, contentName, contentNameMetadata);
	}

	private _push(ruleId: number, enterPos: number, endRule: string, scopeName: string, scopeMetadata: number, contentName: string, contentNameMetadata: ScopeMetadata): StackElement {
		let _contentNameMetadata = StackElementMetadata.merge(scopeMetadata, contentNameMetadata, new ScopeListProvider(this, null, scopeName));
		return new StackElement(this, ruleId, enterPos, endRule, scopeName, scopeMetadata, contentName, _contentNameMetadata);
	}

	public getEnterPos(): number {
		return this._enterPos;
	}

	public getRule(grammar: IRuleRegistry): Rule {
		return grammar.getRule(this.ruleId);
	}

	private _writeString(res: string[], outIndex: number): number {
		if (this.parent) {
			outIndex = this.parent._writeString(res, outIndex);
		}

		res[outIndex++] = `(${this.ruleId}, ${this.scopeName}, ${this.contentName})`;

		return outIndex;
	}

	public toString(): string {
		let r: string[] = [];
		this._writeString(r, 0);
		return '[' + r.join(',') + ']';
	}

	public withContentName(contentName: string, contentNameMetadata: ScopeMetadata): StackElement {
		if (this.contentName === contentName) {
			return this;
		}
		return this.parent._push(this.ruleId, this._enterPos, this.endRule, this.scopeName, this.scopeMetadata, contentName, contentNameMetadata);
	}

	public withEndRule(endRule: string): StackElement {
		if (this.endRule === endRule) {
			return this;
		}
		return new StackElement(this.parent, this.ruleId, this._enterPos, endRule, this.scopeName, this.scopeMetadata, this.contentName, this.contentMetadata);
	}

	private _writeScopes(scopes: string[], outIndex: number): number {
		if (this.parent) {
			outIndex = this.parent._writeScopes(scopes, outIndex);
		}

		if (this.scopeName) {
			scopes[outIndex++] = this.scopeName;
		}

		if (this.contentName) {
			scopes[outIndex++] = this.contentName;
		}

		return outIndex;
	}

	/**
	 * Token scopes
	 */
	public generateScopes(): string[] {
		let result: string[] = [];
		this._writeScopes(result, 0);
		return result;
	}

	public hasSameRuleAs(other: StackElement): boolean {
		return this.ruleId === other.ruleId;
	}
}

export class LocalStackElement {
	public readonly scopeName: string;
	public readonly scopeMetadata: number;
	public readonly endPos: number;

	constructor(scopeName: string, scopeMetadata: number, endPos: number) {
		this.scopeName = scopeName;
		this.scopeMetadata = scopeMetadata;
		this.endPos = endPos;
	}
}

class LineTokens {

	private readonly _emitBinaryTokens: boolean;
	/**
	 * defined only if `IN_DEBUG_MODE`.
	 */
	private readonly _lineText: string;
	/**
	 * used only if `_emitBinaryTokens` is false.
	 */
	private readonly _tokens: IToken[];
	/**
	 * used only if `_emitBinaryTokens` is true.
	 */
	private readonly _binaryTokens: number[];

	private _lastTokenEndIndex: number;

	constructor(emitBinaryTokens: boolean, lineText: string) {
		this._emitBinaryTokens = emitBinaryTokens;
		if (IN_DEBUG_MODE) {
			this._lineText = lineText;
		}
		if (this._emitBinaryTokens) {
			this._binaryTokens = [];
		} else {
			this._tokens = [];
		}
		this._lastTokenEndIndex = 0;
	}

	public produce(stack: StackElement, endIndex: number, extraScopes?: LocalStackElement[]): void {
		if (this._lastTokenEndIndex >= endIndex) {
			return;
		}

		if (this._emitBinaryTokens) {
			let metadata: number;
			if (extraScopes && extraScopes.length > 0) {
				metadata = extraScopes[extraScopes.length - 1].scopeMetadata;
			} else {
				metadata = stack.contentMetadata;
			}

			if (this._binaryTokens.length > 0 && this._binaryTokens[this._binaryTokens.length - 1] === metadata) {
				// no need to push a token with the same metadata
				this._lastTokenEndIndex = endIndex;
				return;
			}

			this._binaryTokens.push(this._lastTokenEndIndex);
			this._binaryTokens.push(metadata);

			this._lastTokenEndIndex = endIndex;
			return;
		}

		let scopes = stack.generateScopes();
		let outIndex = scopes.length;

		if (extraScopes) {
			for (let i = 0; i < extraScopes.length; i++) {
				scopes[outIndex++] = extraScopes[i].scopeName;
			}
		}

		if (IN_DEBUG_MODE) {
			console.log('  token: |' + this._lineText.substring(this._lastTokenEndIndex, endIndex).replace(/\n$/, '\\n') + '|');
			for (var k = 0; k < scopes.length; k++) {
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
			this.produce(stack, lineLength, null);
			this._tokens[this._tokens.length - 1].startIndex = 0;
		}

		return this._tokens;
	}

	public getBinaryResult(stack: StackElement, lineLength: number): number[] {
		if (this._binaryTokens.length > 0 && this._binaryTokens[this._binaryTokens.length - 2] === lineLength - 1) {
			// pop produced token for newline
			this._binaryTokens.pop();
			this._binaryTokens.pop();
		}

		if (this._binaryTokens.length === 0) {
			this._lastTokenEndIndex = -1;
			this.produce(stack, lineLength, null);
			this._binaryTokens[this._binaryTokens.length - 2] = 0;
		}

		return this._binaryTokens;
	}
}

export class ScopeListProvider {

	private _stack: StackElement;
	private _localStack: LocalStackElement[];
	private _extraScope: string;

	constructor(stack: StackElement, localStack: LocalStackElement[], extraScope: string) {
		this._stack = stack;
		this._localStack = localStack;
		this._extraScope = extraScope;
	}

	private static _matches(scope: string, selector: string, selectorPrefix: string): boolean {
		return (
			scope !== null
			&& (selector === scope || scope.substring(0, selectorPrefix.length) === selectorPrefix)
		);
	}

	public matches(parentScopes:string[]): boolean {
		if (parentScopes === null) {
			return true;
		}

		let len = parentScopes.length;
		let index = 0;
		let selector = parentScopes[index];
		let selectorPrefix = selector + '.';

		if (ScopeListProvider._matches(this._extraScope, selector, selectorPrefix)) {
			index++;
			if (index === len) {
				return true;
			}
			selector = parentScopes[index];
			selectorPrefix = selector + '.';
		}

		if (this._localStack) {
			for (let j = this._localStack.length - 1; j >= 0; j--) {
				if (ScopeListProvider._matches(this._localStack[j].scopeName, selector, selectorPrefix)) {
					index++;
					if (index === len) {
						return true;
					}
					selector = parentScopes[index];
					selectorPrefix = selector + '.';
				}
			}
		}

		let stack = this._stack;
		while (stack) {
			if (ScopeListProvider._matches(stack.contentName, selector, selectorPrefix)) {
				index++;
				if (index === len) {
					return true;
				}
				selector = parentScopes[index];
				selectorPrefix = selector + '.';
			}
			if (ScopeListProvider._matches(stack.scopeName, selector, selectorPrefix)) {
				index++;
				if (index === len) {
					return true;
				}
				selector = parentScopes[index];
				selectorPrefix = selector + '.';
			}
			stack = stack.parent;
		}

		return false;
	}

}
