/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import {clone} from './utils';
import {IRawGrammar, IRawRepository, IRawPattern, IRawRule} from './types';
import {IRuleFactoryHelper, RuleFactory, Rule, CaptureRule, BeginEndRule, MatchRule, ICompiledRule} from './rule';
import {IOnigCaptureIndex, IOnigNextMatchResult} from 'oniguruma';

export function createGrammar(grammar:IRawGrammar, grammarRepository:IGrammarRepository): IGrammar {
	return new Grammar(grammar, grammarRepository);
}

export interface IGrammarRepository {
	lookup(scopeName:string): IRawGrammar;
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

interface IScopeNameSet {
	[scopeName:string]: boolean;
}

/**
 * Fill in `result` all external included scopes in `patterns`
 */
function _extractIncludedScopesInPatterns(result:IScopeNameSet, patterns:IRawPattern[]): void {
	for (let i = 0, len = patterns.length; i < len; i++) {
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
 * Return a list of all external included scopes in `grammar`.
 */
export function extractIncludedScopes(grammar:IRawGrammar): string[] {
	let result: IScopeNameSet = {};

	if (grammar.patterns && Array.isArray(grammar.patterns)) {
		_extractIncludedScopesInPatterns(result, grammar.patterns);
	}

	if (grammar.repository) {
		_extractIncludedScopesInRepository(result, grammar.repository);
	}

	// remove references to own scope (avoid recursion)
	delete result[grammar.scopeName];

	return Object.keys(result);
}

class Grammar implements IGrammar, IRuleFactoryHelper {

	private _rootId: number;
	private _lastRuleId: number;
	private _ruleId2desc: Rule[];
	private _includedGrammars: { [scopeName:string]:IRawGrammar; };
	private _grammarRepository: IGrammarRepository;
	private _grammar: IRawGrammar;

	constructor(grammar:IRawGrammar, grammarRepository:IGrammarRepository) {
		this._rootId = -1;
		this._lastRuleId = 0;
		this._ruleId2desc = [];
		this._includedGrammars = {};
		this._grammarRepository = grammarRepository;
		this._grammar = initGrammar(grammar, null);
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

	public getExternalGrammar(scopeName:string, repository:IRawRepository): IRawGrammar {
		let actualGrammar: IRawGrammar = null;

		if (this._includedGrammars[scopeName]) {
			return this._includedGrammars[scopeName];
		} else if (this._grammarRepository) {
			let rawIncludedGrammar = this._grammarRepository.lookup(scopeName);
			if (rawIncludedGrammar) {
				// console.log('LOADED GRAMMAR ' + pattern.include);
				this._includedGrammars[scopeName] = initGrammar(rawIncludedGrammar, repository.$base);
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
		let lineLength = lineText.length;
		let lineTokens = new LineTokens();
		_tokenizeString(this, lineText, isFirstLine, 0, prevState, lineTokens);

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

function handleCaptures(grammar: Grammar, lineText: string, isFirstLine: boolean, stack: StackElement[], lineTokens: LineTokens, captures: CaptureRule[], captureIndices: IOnigCaptureIndex[]): void {
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
			stack.push(new StackElement(captureRule.retokenizeCapturedWithRuleId, captureIndex.start, null, captureRule.getName(lineText, captureIndices), captureRule.getContentName(lineText, captureIndices)))
			_tokenizeString(grammar, lineText.substring(0, captureIndex.end), (isFirstLine && captureIndex.start === 0), captureIndex.start, stack, lineTokens);
			stack.pop();
			continue;
		}

		// push
		localStack.push(new LocalStackElement(captureRule.getName(lineText, captureIndices), captureIndex.end));
	}

	while (localStack.length > 0) {
		// pop!
		lineTokens.produce(stack, localStack[localStack.length - 1].endPos, localStack);
		localStack.pop();
	}
}

function _tokenizeString(grammar: Grammar, lineText: string, isFirstLine: boolean, linePos: number, stack: StackElement[], lineTokens: LineTokens): void {
	let lineLength = lineText.length,
		stackElement: StackElement,
		ruleScanner: ICompiledRule,
		r: IOnigNextMatchResult,
		matchedRuleId: number,
		anchorPosition = -1,
		hasAdvanced: boolean;

	while (linePos < lineLength) {
		stackElement = stack[stack.length - 1];
		ruleScanner = grammar.getRule(stackElement.ruleId).compile(grammar, stackElement.endRule, isFirstLine, linePos === anchorPosition);

		r = ruleScanner.scanner._findNextMatchSync(lineText, linePos);

		if (r === null) {
			// No match
			lineTokens.produce(stack, lineLength);
			break;
		}

		matchedRuleId = ruleScanner.rules[r.index];
		hasAdvanced = (r.captureIndices[0].end > linePos);

		if (matchedRuleId === -1) {
			// We matched the `end` for this rule => pop it
			let poppedRule = <BeginEndRule>grammar.getRule(stackElement.ruleId);

			lineTokens.produce(stack, r.captureIndices[0].start);
			stackElement.contentName = null;
			handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, poppedRule.endCaptures, r.captureIndices);
			lineTokens.produce(stack, r.captureIndices[0].end);

			// pop
			stack.pop();

			if (!hasAdvanced && stackElement.enterPos === linePos) {
				// Grammar pushed & popped a rule without advancing
				console.error('Grammar is in an endless loop - case 1');
				lineTokens.produce(stack, lineLength);
				break;
			}

		} else {
			// We matched a rule!
			let _rule = grammar.getRule(matchedRuleId);

			lineTokens.produce(stack, r.captureIndices[0].start);

			// push it on the stack rule
			stack.push(new StackElement(matchedRuleId, linePos, null, _rule.getName(lineText, r.captureIndices), null));

			if (_rule instanceof BeginEndRule) {
				let pushedRule = <BeginEndRule>_rule;

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, pushedRule.beginCaptures, r.captureIndices);
				lineTokens.produce(stack, r.captureIndices[0].end);
				anchorPosition = r.captureIndices[0].end;
				stack[stack.length-1].contentName = pushedRule.getContentName(lineText, r.captureIndices);

				if (pushedRule.endHasBackReferences) {
					stack[stack.length-1].endRule = pushedRule.getEndWithResolvedBackReferences(lineText, r.captureIndices);
				}

				if (!hasAdvanced && stackElement.ruleId === stack[stack.length - 1].ruleId) {
					// Grammar pushed the same rule without advancing
					console.error('Grammar is in an endless loop - case 2');
					stack.pop();
					lineTokens.produce(stack, lineLength);
					break;
				}
			} else {
				let matchingRule = <MatchRule>_rule;

				handleCaptures(grammar, lineText, isFirstLine, stack, lineTokens, matchingRule.captures, r.captureIndices);
				lineTokens.produce(stack, r.captureIndices[0].end);

				// pop rule immediately since it is a MatchRule
				stack.pop();

				if (!hasAdvanced) {
					// Grammar is not advancing, nor is it pushing/popping
					console.error('Grammar is in an endless loop - case 3');
					if (stack.length > 1) {
						stack.pop();
					}
					lineTokens.produce(stack, lineLength);
					break;
				}
			}
		}

		if (r.captureIndices[0].end > linePos) {
			// Advance stream
			linePos = r.captureIndices[0].end;
			isFirstLine = false;
		}
	}
}

export class StackElement {
	public ruleId: number;
	public enterPos: number;
	public endRule: string;
	public scopeName: string;
	public contentName: string;

	constructor (ruleId:number, enterPos:number, endRule:string, scopeName:string, contentName:string) {
		this.ruleId = ruleId;
		this.enterPos = enterPos;
		this.endRule = endRule;
		this.scopeName = scopeName;
		this.contentName = contentName;
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
