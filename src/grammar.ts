/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import {clone} from './utils';
import {IRawGrammar, IRawRepository, IRawRule} from './types';
import {IRuleRegistry, IRuleFactoryHelper, RuleFactory, Rule, CaptureRule, BeginEndRule, BeginWhileRule, MatchRule, ICompiledRule, createOnigString, getString} from './rule';
import {IOnigCaptureIndex, IOnigNextMatchResult, OnigString} from 'oniguruma';
import {createMatcher, Matcher} from './matcher';
import {IGrammar, ITokenizeLineResult, IToken, StackElement as StackElementDef} from './main';
import {IN_DEBUG_MODE} from './debug';

export function createGrammar(grammar:IRawGrammar, grammarRepository:IGrammarRepository): IGrammar {
	return new Grammar(grammar, grammarRepository);
}

export interface IGrammarRepository {
	lookup(scopeName:string): IRawGrammar;
	injections(scopeName:string): string[];
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
	matcher: Matcher<StackElement>;
	priorityMatch: boolean,
	ruleId:number;
	grammar: IRawGrammar;
}

function collectInjections(result: Injection[], selector: string, rule: IRawRule, ruleFactoryHelper: IRuleFactoryHelper, grammar: IRawGrammar) : void {
	function scopesAreMatching(thisScopeName:string, scopeName: string) : boolean {
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

	public getInjections(states: StackElement) : Injection[] {
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

	public tokenizeLine(lineText: string, prevState: StackElement): ITokenizeLineResult {
		if (this._rootId === -1) {
			this._rootId = RuleFactory.getCompiledRuleId(this._grammar.repository.$self, this, this._grammar.repository);
		}

		let isFirstLine:boolean;
		if (!prevState) {
			isFirstLine = true;
			prevState = new StackElement(null, this._rootId, -1, null, this.getRule(this._rootId).getName(null, null), null);
		} else {
			isFirstLine = false;
			prevState.reset();
		}

		lineText = lineText + '\n';
		let onigLineText = createOnigString(lineText);
		let lineLength = getString(onigLineText).length;
		let lineTokens = new LineTokens(lineText);
		let nextState = _tokenizeString(this, onigLineText, isFirstLine, 0, prevState, lineTokens);

		let _produced = lineTokens.getResult(nextState, lineLength);

		return {
			tokens: _produced,
			ruleStack: nextState
		};
	}
}

function initGrammar(grammar:IRawGrammar, base:IRawRule): IRawGrammar {
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
			let stackClone = stack.push(captureRule.retokenizeCapturedWithRuleId, captureIndex.start, null, captureRule.getName(getString(lineText), captureIndices), captureRule.getContentName(getString(lineText), captureIndices));
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
			localStack.push(new LocalStackElement(captureRuleScopeName, captureIndex.end));
		}
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

function debugCompiledRuleToString(ruleScanner:ICompiledRule): string {
	let r:string[] = [];
	for (let i = 0, len = ruleScanner.rules.length; i < len; i++) {
		r.push('   - ' + ruleScanner.rules[i] + ': ' + ruleScanner.debugRegExps[i]);
	}
	return r.join('\n');
}

function matchInjections(injections:Injection[], grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, anchorPosition:number): IMatchInjectionsResult {
	// The lower the better
	let bestMatchRating = Number.MAX_VALUE;
	let bestMatchCaptureIndices : IOnigCaptureIndex[] = null;
	let bestMatchRuleId : number;
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
	captureIndices: IOnigCaptureIndex[];
	matchedRuleId: number;
}

function matchRule(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, anchorPosition:number): IMatchResult {
	let rule = stack.getRule(grammar);
	let ruleScanner = rule.compile(grammar, stack.getEndRule(), isFirstLine, linePos === anchorPosition);
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

function matchRuleOrInjections(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, anchorPosition:number): IMatchResult {
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
	stack: StackElement;
	rule: BeginWhileRule;
}

interface IWhileCheckResult {
	stack: StackElement;
	linePos: number;
	anchorPosition: number;
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
		let ruleScanner = whileRule.rule.compileWhile(grammar, whileRule.stack.getEndRule(), isFirstLine, false);
		let r = ruleScanner.scanner._findNextMatchSync(lineText, linePos);
		if (IN_DEBUG_MODE) {
			console.log('  scanning for while rule');
			console.log(debugCompiledRuleToString(ruleScanner));
		}

		if (r) {
			let matchedRuleId = ruleScanner.rules[r.index];
			if (matchedRuleId != -2) {
				// we shouldn't end up here
				stack = whileRule.stack.pop();
				break;
			}
			if (r.captureIndices && r.captureIndices.length) {
				linePos = r.captureIndices[0].end;
				anchorPosition = linePos;
				lineTokens.produce(whileRule.stack, r.captureIndices[0].start);
				handleCaptures(grammar, lineText, isFirstLine, whileRule.stack, lineTokens, whileRule.rule.whileCaptures, r.captureIndices);
				lineTokens.produce(whileRule.stack, r.captureIndices[0].end);
			}
		} else {
			stack = whileRule.stack.pop();
			break;
		}
	}

	return { stack: stack, linePos: linePos, anchorPosition: anchorPosition };
}

function _tokenizeString(grammar: Grammar, lineText: OnigString, isFirstLine: boolean, linePos: number, stack: StackElement, lineTokens: LineTokens): StackElement {
	const lineLength = getString(lineText).length;

	let STOP = false;

	let whileCheckResult = _checkWhileConditions(grammar, lineText, isFirstLine, linePos, stack, lineTokens);
	stack = whileCheckResult.stack;
	linePos = whileCheckResult.linePos;
	let anchorPosition = whileCheckResult.anchorPosition;

	while (!STOP) {
		scanNext(); // potentially modifies linePos && anchorPosition
	}

	function scanNext() : void {
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
			stack = stack.withContentName(null);
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
				stack = stack.pushElement(popped);

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
			stack = stack.push(matchedRuleId, linePos, null, _rule.getName(getString(lineText), captureIndices), null);

			if (_rule instanceof BeginEndRule) {
				let pushedRule = <BeginEndRule>_rule;
				if (IN_DEBUG_MODE) {
					console.log('  pushing ' + pushedRule.debugName + ' - ' + pushedRule.debugBeginRegExp);
				}

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, captureIndices);
				lineTokens.produce(stack, captureIndices[0].end);
				anchorPosition = captureIndices[0].end;
				stack = stack.withContentName(pushedRule.getContentName(getString(lineText), captureIndices));

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
				stack = stack.withContentName(pushedRule.getContentName(getString(lineText), captureIndices));

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

/**
 * **IMPORTANT** - Immutable!
 */
export class StackElement implements StackElementDef {
	public _stackElementBrand: void;

	public _parent: StackElement;
	private _enterPos: number;
	private _ruleId: number;
	private _endRule: string;
	private _scopeName: string;
	private _contentName: string;

	constructor(parent:StackElement, ruleId:number, enterPos:number, endRule:string, scopeName:string, contentName: string) {
		this._parent = parent;
		this._ruleId = ruleId;
		this._enterPos = enterPos;
		this._endRule = endRule;
		this._scopeName = scopeName;
		this._contentName = contentName;
	}

	public equals(other:StackElement): boolean {
		if (!this._shallowEquals(other)) {
			return false;
		}
		if (!this._parent && !other._parent) {
			return true;
		}
		if (!this._parent || !other._parent) {
			return false;
		}
		return this._parent.equals(other._parent);
	}

	private _shallowEquals(other:StackElement): boolean {
		return (
			this._ruleId === other._ruleId
			&& this._endRule === other._endRule
			&& this._scopeName === other._scopeName
			&& this._contentName === other._contentName
		);
	}

	public reset(): void {
		this._enterPos = -1;
		if (this._parent) {
			this._parent.reset();
		}
	}

	public pop(): StackElement {
		return this._parent;
	}

	public safePop(): StackElement {
		if (this._parent) {
			return this._parent;
		}
		return this;
	}

	public pushElement(what:StackElement): StackElement {
		return this.push(what._ruleId, what._enterPos, what._endRule, what._scopeName, what._contentName);
	}

	public push(ruleId:number, enterPos:number, endRule:string, scopeName:string, contentName: string): StackElement {
		return new StackElement(this, ruleId, enterPos, endRule, scopeName, contentName);
	}

	public getEnterPos(): number {
		return this._enterPos;
	}

	public getRule(grammar:IRuleRegistry): Rule {
		return grammar.getRule(this._ruleId);
	}

	public getEndRule(): string {
		return this._endRule;
	}

	private _writeString(res:string[], outIndex:number): number {
		if (this._parent) {
			outIndex = this._parent._writeString(res, outIndex);
		}

		res[outIndex++] = `(${this._ruleId}, ${this._scopeName}, ${this._contentName})`;

		return outIndex;
	}

	public toString(): string {
		let r:string[] = [];
		this._writeString(r, 0);
		return '[' + r.join(',') + ']';
	}

	public withContentName(contentName:string): StackElement {
		if (this._contentName === contentName) {
			return this;
		}
		return new StackElement(this._parent, this._ruleId, this._enterPos, this._endRule, this._scopeName, contentName);
	}

	public withEndRule(endRule:string): StackElement {
		if (this._endRule === endRule) {
			return this;
		}
		return new StackElement(this._parent, this._ruleId, this._enterPos, endRule, this._scopeName, this._contentName);
	}

	private _writeScopes(scopes: string[], outIndex:number): number {
		if (this._parent) {
			outIndex = this._parent._writeScopes(scopes, outIndex);
		}

		if (this._scopeName) {
			scopes[outIndex++] = this._scopeName;
		}

		if (this._contentName) {
			scopes[outIndex++] = this._contentName;
		}

		return outIndex;
	}

	/**
	 * Token scopes
	 */
	public generateScopes(): string[] {
		let result:string[] = [];
		this._writeScopes(result, 0);
		return result;
	}

	public hasSameRuleAs(other:StackElement): boolean {
		return this._ruleId === other._ruleId;
	}
}

class LocalStackElement {
	public scopeName: string;
	public endPos: number;

	constructor (scopeName: string, endPos: number) {
		if (typeof scopeName !== 'string') {
			throw new Error('bubu');
		}
		this.scopeName = scopeName;
		this.endPos = endPos;
	}
}

class LineTokens {

	private _lineText: string;
	private _tokens: IToken[];
	private _lastTokenEndIndex: number;

	constructor(lineText:string) {
		if (IN_DEBUG_MODE) {
			this._lineText = lineText;
		}
		this._tokens = [];
		this._lastTokenEndIndex = 0;
	}

	public produce(stack:StackElement, endIndex:number, extraScopes?:LocalStackElement[]): void {
		// console.log('PRODUCE TOKEN: lastTokenEndIndex: ' + lastTokenEndIndex + ', endIndex: ' + endIndex);
		if (this._lastTokenEndIndex >= endIndex) {
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

	public getResult(stack:StackElement, lineLength:number): IToken[] {
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
