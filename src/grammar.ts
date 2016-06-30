/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import {clone} from './utils';
import {IRawGrammar, IRawRepository, IRawRule} from './types';
import {IRuleFactoryHelper, RuleFactory, Rule, CaptureRule, BeginEndRule, BeginWhileRule, MatchRule, ICompiledRule, createOnigString, getString} from './rule';
import {IOnigCaptureIndex, IOnigNextMatchResult, OnigString} from 'oniguruma';
import {createMatcher, Matcher} from './matcher';

export function createGrammar(grammar:IRawGrammar, grammarRepository:IGrammarRepository): IGrammar {
	return new Grammar(grammar, grammarRepository);
}

export interface IGrammarRepository {
	lookup(scopeName:string): IRawGrammar;
	injections(scopeName:string): string[];
}

export interface IGrammar {
	tokenizeLine(lineText: string, prevState: StackElement[]): ITokenizeLineResult;
}

export interface ITokenizeLineResult {
	tokens: IToken[];
	ruleStack: StackElement[];
}

export interface IToken {
	startIndex: number;
	endIndex: number;
	scopes: string[];
}

export interface IScopeNameSet {
	[scopeName:string]: boolean;
}

/**
 * Fill in `result` all external included scopes in `patterns`
 */
function _extractIncludedScopesInPatterns(result:IScopeNameSet, patterns:IRawRule[]): void {
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
function _extractIncludedScopesInRepository(result:IScopeNameSet, repository:IRawRepository): void {
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
export function collectIncludedScopes(result: IScopeNameSet, grammar:IRawGrammar) : void {
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
	matcher: Matcher<StackElement[]>;
	priorityMatch: boolean,
	ruleId:number;
	grammar: IRawGrammar;
}

function collectInjections(result: Injection[], selector: string, rule: IRawRule, ruleFactoryHelper: IRuleFactoryHelper, grammar: IRawGrammar) : void {
	function nameMatcher(identifers: string[], stackElements: StackElement[]) {
		var lastIndex = 0;
		return identifers.every(identifier => {
			for (var i = lastIndex; i < stackElements.length; i++) {
				if (stackElements[i].matches(identifier)) {
					lastIndex = i;
					return true;
				}
			}
			return false;
		});
	};

	var subExpressions = selector.split(',');
	subExpressions.forEach(subExpression => {
		var expressionString = subExpression.replace(/L:/g, '')

		result.push({
			matcher: createMatcher(expressionString, nameMatcher),
			ruleId: RuleFactory.getCompiledRuleId(rule, ruleFactoryHelper, grammar.repository),
			grammar: grammar,
			priorityMatch: expressionString.length < subExpression.length
		});
	});
}

class Grammar implements IGrammar, IRuleFactoryHelper {

	private _rootId: number;
	private _lastRuleId: number;
	private _ruleId2desc: Rule[];
	private _includedGrammars: { [scopeName:string]:IRawGrammar; };
	private _grammarRepository: IGrammarRepository;
	private _grammar: IRawGrammar;
	private _injections : Injection[];

	constructor(grammar:IRawGrammar, grammarRepository:IGrammarRepository) {
		this._rootId = -1;
		this._lastRuleId = 0;
		this._ruleId2desc = [];
		this._includedGrammars = {};
		this._grammarRepository = grammarRepository;
		this._grammar = initGrammar(grammar, null);
	}

	public getInjections(states: StackElement[]) : Injection[] {
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

	public registerRule<T extends Rule>(factory:(id:number)=>T): T {
		let id = (++this._lastRuleId);
		let result = factory(id);
		this._ruleId2desc[id] = result;
		return result;
	}

	public getRule(patternId:number): Rule {
		return this._ruleId2desc[patternId];
	}

	public getExternalGrammar(scopeName:string, repository?:IRawRepository): IRawGrammar {
		let actualGrammar: IRawGrammar = null;

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

	public tokenizeLine(lineText: string, prevState: StackElement[]): ITokenizeLineResult {
		if (this._rootId === -1) {
			this._rootId = RuleFactory.getCompiledRuleId(this._grammar.repository.$self, this, this._grammar.repository);
		}

		let isFirstLine:boolean;
		if (!prevState) {
			isFirstLine = true;
			prevState = [new StackElement(this._rootId, -1, null, this.getRule(this._rootId).getName(null, null), null)]
		} else {
			isFirstLine = false;
			for (let i = 0; i < prevState.length; i++) {
				prevState[i].enterPos = -1;
			}
		}

		lineText = lineText + '\n';
		let onigLineText = createOnigString(lineText);
		let lineLength = getString(onigLineText).length;
		let lineTokens = new LineTokens();
		_tokenizeString(this, onigLineText, isFirstLine, 0, prevState, lineTokens);

		let _produced = lineTokens.getResult(prevState, lineLength);

		return {
			tokens: _produced,
			ruleStack: prevState
		};
	}
}

function initGrammar(grammar:IRawGrammar, base:IRawRule): IRawGrammar {
	grammar = clone(grammar);

	grammar.repository = grammar.repository || <any>{};
	grammar.repository.$self = {
		patterns: grammar.patterns,
		name: grammar.scopeName
	};
	grammar.repository.$base = base || grammar.repository.$self;
	return grammar;
}

function handleCaptures(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, stack: StackElement[], lineTokens: LineTokens, captures: CaptureRule[], captureIndices: IOnigCaptureIndex[]): void {
	if (captures.length === 0) {
		return;
	}

	let len = Math.min(captures.length, captureIndices.length),
		localStack: LocalStackElement[] = [],
		maxEnd = captureIndices[0].end,
		i: number,
		captureRule: CaptureRule,
		captureIndex: IOnigCaptureIndex;

	for (i = 0; i < len; i++) {
		captureRule = captures[i];
		if (captureRule === null) {
			// Not interested
			continue;
		}

		captureIndex = captureIndices[i];

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
			let stackClone = stack.map((el) => el.clone());
			stackClone.push(new StackElement(captureRule.retokenizeCapturedWithRuleId, captureIndex.start, null, captureRule.getName(getString(lineText), captureIndices), captureRule.getContentName(getString(lineText), captureIndices)))
			_tokenizeString(grammar,
				createOnigString(
					getString(lineText).substring(0, captureIndex.end)
				),
				(isFirstLine && captureIndex.start === 0), captureIndex.start, stackClone, lineTokens
			);
			continue;
		}

		// push
		localStack.push(new LocalStackElement(captureRule.getName(getString(lineText), captureIndices), captureIndex.end));
	}

	while (localStack.length > 0) {
		// pop!
		lineTokens.produce(stack, localStack[localStack.length - 1].endPos, localStack);
		localStack.pop();
	}
}

interface IMatchInjectionsResult {
	priorityMatch: boolean;
	captureIndices: IOnigCaptureIndex[];
	matchedRuleId: number;
}

function matchInjections(injections:Injection[], grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement[], anchorPosition:number): IMatchInjectionsResult {
	// The lower the better
	let bestMatchRating = Number.MAX_VALUE;
	let bestMatchCaptureIndices : IOnigCaptureIndex[] = null;
	let bestMatchRuleId : number;
	let bestMatchResultPriority: boolean = false;

	for (let i = 0, len = injections.length; i < len; i++) {
		let injection = injections[i];
		let ruleScanner = grammar.getRule(injection.ruleId).compile(grammar, null, isFirstLine, linePos === anchorPosition);
		let matchResult = ruleScanner.scanner._findNextMatchSync(lineText, linePos);

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
	captureIndices: IOnigCaptureIndex[];
	matchedRuleId: number;
}

function matchRule(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement[], anchorPosition:number): IMatchResult {
	let stackElement = stack[stack.length - 1];
	let rule = grammar.getRule(stackElement.ruleId);

	if (rule instanceof BeginWhileRule && stackElement.enterPos === -1) {

		let ruleScanner = rule.compileWhile(grammar, stackElement.endRule, isFirstLine, linePos === anchorPosition);
		let r = ruleScanner.scanner._findNextMatchSync(lineText, linePos);

		let doNotContinue: IMatchResult = {
			captureIndices: null,
			matchedRuleId: -3
		};

		if (r) {
			let matchedRuleId = ruleScanner.rules[r.index];
			if (matchedRuleId != -2) {
				// we shouldn't end up here
				return doNotContinue;
			}
		} else {
			return doNotContinue;
		}
	}


	let ruleScanner = rule.compile(grammar, stackElement.endRule, isFirstLine, linePos === anchorPosition);
	let r = ruleScanner.scanner._findNextMatchSync(lineText, linePos);

	if (r) {
		return {
			captureIndices: r.captureIndices,
			matchedRuleId: ruleScanner.rules[r.index]
		};
	}
	return null;
}

function matchRuleOrInjections(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement[], anchorPosition:number): IMatchResult {
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

function _tokenizeString(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement[], lineTokens: LineTokens): void {
	const lineLength = getString(lineText).length;

	let anchorPosition = -1;

	while (linePos < lineLength) {
		scanNext(); // potentially modifies linePos && anchorPosition
	}

	function scanNext() : boolean {
		let stackElement = stack[stack.length - 1];
		let r = matchRuleOrInjections(grammar, lineText, isFirstLine, linePos, stack, anchorPosition);

		if (!r) {
			// No match
			lineTokens.produce(stack, lineLength);
			linePos = lineLength;
			return true;
		}

		let captureIndices: IOnigCaptureIndex[] = r.captureIndices;
		let matchedRuleId: number = r.matchedRuleId;

		let hasAdvanced = (captureIndices && captureIndices.length > 0) ? (captureIndices[0].end > linePos) : false;

		if (matchedRuleId === -1) {
			// We matched the `end` for this rule => pop it
			let poppedRule = <BeginEndRule>grammar.getRule(stackElement.ruleId);

			lineTokens.produce(stack, captureIndices[0].start);
			stackElement.contentName = null;
			handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, poppedRule.endCaptures, captureIndices);
			lineTokens.produce(stack, captureIndices[0].end);

			// pop
			let popped = stack.pop();

			if (!hasAdvanced && stackElement.enterPos === linePos) {
				// Grammar pushed & popped a rule without advancing
				console.error('[1] - Grammar is in an endless loop - Grammar pushed & popped a rule without advancing');

				// See https://github.com/Microsoft/vscode-textmate/issues/12
				// Let's assume this was a mistake by the grammar author and the intent was to continue in this state
				stack.push(popped);

				lineTokens.produce(stack, lineLength);
				linePos = lineLength;

				return false;
			}
		} else if (matchedRuleId === -3) {
			// A while clause failed
			stack.pop();
			return true;

		} else {
			// We matched a rule!
			let _rule = grammar.getRule(matchedRuleId);

			lineTokens.produce(stack, captureIndices[0].start);

			// push it on the stack rule
			stack.push(new StackElement(matchedRuleId, linePos, null, _rule.getName(getString(lineText), captureIndices), null));

			if (_rule instanceof BeginEndRule) {
				let pushedRule = <BeginEndRule>_rule;

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);
				anchorPosition = captureIndices[0].end;
				stack[stack.length-1].contentName = pushedRule.getContentName(getString(lineText), captureIndices);

				if (pushedRule.endHasBackReferences) {
					stack[stack.length-1].endRule = pushedRule.getEndWithResolvedBackReferences(getString(lineText), captureIndices);
				}

				if (!hasAdvanced && stackElement.ruleId === stack[stack.length - 1].ruleId) {
					// Grammar pushed the same rule without advancing
					console.error('[2] - Grammar is in an endless loop - Grammar pushed the same rule without advancing');
					stack.pop();
					lineTokens.produce(stack, lineLength);
					linePos = lineLength;
					return false;
				}
			} else if (_rule instanceof BeginWhileRule) {
				let pushedRule = <BeginWhileRule>_rule;

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);
				anchorPosition = captureIndices[0].end;
				stack[stack.length - 1].contentName = pushedRule.getContentName(getString(lineText), captureIndices);

				if (pushedRule.whileHasBackReferences) {
					stack[stack.length - 1].endRule = pushedRule.getWhileWithResolvedBackReferences(getString(lineText), captureIndices);
				}

				if (!hasAdvanced && stackElement.ruleId === stack[stack.length - 1].ruleId) {
					// Grammar pushed the same rule without advancing
					console.error('[3] - Grammar is in an endless loop - Grammar pushed the same rule without advancing');
					stack.pop();
					lineTokens.produce(stack, lineLength);
					linePos = lineLength;
					return false;
				}
			} else {
				let matchingRule = <MatchRule>_rule;

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, matchingRule.captures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);

				// pop rule immediately since it is a MatchRule
				stack.pop();

				if (!hasAdvanced) {
					// Grammar is not advancing, nor is it pushing/popping
					console.error('[4] - Grammar is in an endless loop - Grammar is not advancing, nor is it pushing/popping');
					if (stack.length > 1) {
						stack.pop();
					}
					lineTokens.produce(stack, lineLength);
					linePos = lineLength;
					return false;
				}
			}
		}

		if (captureIndices[0].end > linePos) {
			// Advance stream
			linePos = captureIndices[0].end;
			isFirstLine = false;
		}
		return true;
	}
}

export class StackElement {
	private _ruleId: number;
	public get ruleId(): number { return this._ruleId; }

	public enterPos: number;

	public endRule: string;
	public scopeName: string;
	public contentName: string;

	private scopeNameSegments: { [segment:string]:boolean };

	constructor(ruleId:number, enterPos:number, endRule:string, scopeName:string, contentName: string) {
		this.ruleId = ruleId;
		this.enterPos = enterPos;
		this.endRule = endRule;
		this.scopeName = scopeName;
		this.contentName = contentName;
	}

	public clone(): StackElement {
		return new StackElement(this.ruleId, this.enterPos, this.endRule, this.scopeName, this.contentName);
	}

	public matches(scopeName: string) : boolean {
		if (!this.scopeName) {
			return false;
		}
		if (this.scopeName === scopeName) {
			return true;
		}
		var len = scopeName.length;
		return this.scopeName.length > len && this.scopeName.substr(0, len) === scopeName && this.scopeName[len] === '.';
	}

}

class LocalStackElement {
	public scopeName: string;
	public endPos: number;

	constructor (scopeName: string, endPos: number) {
		this.scopeName = scopeName;
		this.endPos = endPos;
	}
}

class LineTokens {

	private _tokens: IToken[];
	private _lastTokenEndIndex: number;

	constructor() {
		this._tokens = [];
		this._lastTokenEndIndex = 0;
	}

	public produce(stack:StackElement[], endIndex:number, extraScopes?:LocalStackElement[]): void {
		// console.log('PRODUCE TOKEN: lastTokenEndIndex: ' + lastTokenEndIndex + ', endIndex: ' + endIndex);
		if (this._lastTokenEndIndex >= endIndex) {
			return;
		}

		let scopes: string[] = [],
			out = 0;

		for (let i = 0; i < stack.length; i++) {
			let el = stack[i];

			if (el.scopeName) {
				scopes[out++] = el.scopeName;
			}

			if (el.contentName) {
				scopes[out++] = el.contentName;
			}
		}

		if (extraScopes) {
			for (let i = 0; i < extraScopes.length; i++) {
				scopes[out++] = extraScopes[i].scopeName;
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

	public getResult(stack:StackElement[], lineLength:number): IToken[] {
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
}
