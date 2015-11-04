/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

import {RegexSource, mergeObjects} from './utils';
import {IRawGrammar, IRawRepository, IRawRule, IRawPattern, IRawCaptures} from './types';
import {OnigScanner, IOnigCaptureIndex} from 'oniguruma';

const BACK_REFERENCING_END = /\\(\d+)/;

export interface IRuleRegistry {
	getRule(patternId:number): Rule;
	registerRule<T extends Rule>(factory:(id:number)=>T): T;
}

export interface IGrammarRegistry {
	getExternalGrammar(scopeName:string, repository:IRawRepository): IRawGrammar;
}

export interface IRuleFactoryHelper extends IRuleRegistry, IGrammarRegistry {
}

export interface ICompiledRule {
	scanner: OnigScanner;
	rules: number[];
}

export class Rule {

	public id:number;

	private _nameIsCapturing: boolean;
	private _name: string;

	private _contentNameIsCapturing: boolean;
	private _contentName: string;

	constructor(id:number, name:string, contentName:string) {
		this.id = id;
		this._name = name || null;
		this._nameIsCapturing = RegexSource.hasCaptures(this._name);
		this._contentName = contentName || null;
		this._contentNameIsCapturing = RegexSource.hasCaptures(this._contentName);
	}

	public getName(lineText: string, captureIndices:IOnigCaptureIndex[]): string {
		if (!this._nameIsCapturing) {
			return this._name;
		}
		return RegexSource.replaceCaptures(this._name, lineText, captureIndices);
	}

	public getContentName(lineText: string, captureIndices:IOnigCaptureIndex[]): string {
		if (!this._contentNameIsCapturing) {
			return this._contentName;
		}
		return RegexSource.replaceCaptures(this._contentName, lineText, captureIndices);
	}

	public collectPatternsRecursive(grammar:IRuleRegistry, out:RegExpSourceList, isFirst:boolean) {
		throw new Error('Implement me!');
	}

	public compile(grammar:IRuleRegistry, endRegexSource: string, allowA:boolean, allowG:boolean): ICompiledRule {
		throw new Error('Implement me!');
	}
}

export interface ICompilePatternsResult {
	patterns: number[];
	hasMissingPatterns: boolean;
}

export class CaptureRule extends Rule {

	public retokenizeCapturedWithRuleId: number;

	constructor(id:number, name:string, contentName:string, retokenizeCapturedWithRuleId:number) {
		super(id, name, contentName);
		this.retokenizeCapturedWithRuleId = retokenizeCapturedWithRuleId;
	}
}

interface IRegExpSourceAnchorCache {
	A0_G0: string;
	A0_G1: string;
	A1_G0: string;
	A1_G1: string;
}

export class RegExpSource {

	public source: string;
	public ruleId: number;
	public hasAnchor: boolean;
	public hasBackReferences: boolean;
	private _anchorCache: IRegExpSourceAnchorCache;

	constructor(regExpSource:string, ruleId:number, handleAnchors:boolean = true) {
		if (handleAnchors) {
			this._handleAnchors(regExpSource);
		} else {
			this.source = regExpSource;
			this.hasAnchor = false;
		}

		if (this.hasAnchor) {
			this._anchorCache = this._buildAnchorCache();
		}

		this.ruleId = ruleId;
		this.hasBackReferences = BACK_REFERENCING_END.test(this.source);

		// console.log('input: ' + regExpSource + ' => ' + this.source + ', ' + this.hasAnchor);
	}

	public clone(): RegExpSource {
		return new RegExpSource(this.source, this.ruleId, true);
	}

	public setSource(newSource: string): void {
		if (this.source === newSource) {
			return;
		}
		this.source = newSource;

		if (this.hasAnchor) {
			this._anchorCache = this._buildAnchorCache();
		}
	}

	private _handleAnchors(regExpSource:string): void {
		if (regExpSource) {
			let pos:number,
				len:number,
				ch:string,
				nextCh:string,
				lastPushedPos = 0,
				output: string[] = [];

			let hasAnchor = false;
			for (pos = 0, len = regExpSource.length; pos < len; pos++) {
				ch = regExpSource.charAt(pos);

				if (ch === '\\') {
					if (pos + 1 < len) {
						nextCh = regExpSource.charAt(pos + 1);
						if (nextCh === 'z') {
							output.push(regExpSource.substring(lastPushedPos, pos));
							output.push('$(?!\\n)(?<!\\n)');
							lastPushedPos = pos + 2;
						} else if (nextCh === 'A' || nextCh === 'G') {
							hasAnchor = true;
						}
						pos++;
					}
				}
			}

			this.hasAnchor = hasAnchor;
			if (lastPushedPos === 0) {
				// No \z hit
				this.source = regExpSource;
			} else {
				output.push(regExpSource.substring(lastPushedPos, len));
				this.source = output.join('');
			}
		} else {
			this.hasAnchor = false;
			this.source = regExpSource;
		}
	}

	public resolveBackReferences(lineText:string, captureIndices:IOnigCaptureIndex[]): string {
		let capturedValues = captureIndices.map((capture) => {
			return lineText.substring(capture.start, capture.end);
		});
		return this.source.replace(BACK_REFERENCING_END, (match, g1) => {
			return escapeRegExpCharacters(capturedValues[parseInt(g1, 10)] || '');
		});
	}

	private _buildAnchorCache(): IRegExpSourceAnchorCache {
		let A0_G0_result: string[] = [];
		let A0_G1_result: string[] = [];
		let A1_G0_result: string[] = [];
		let A1_G1_result: string[] = [];

		let pos:number,
			len:number,
			ch:string,
			nextCh:string;

		for (pos = 0, len = this.source.length; pos < len; pos++) {
			ch = this.source.charAt(pos);
			A0_G0_result[pos] = ch;
			A0_G1_result[pos] = ch;
			A1_G0_result[pos] = ch;
			A1_G1_result[pos] = ch;

			if (ch === '\\') {
				if (pos + 1 < len) {
					nextCh = this.source.charAt(pos+1);
					if (nextCh === 'A') {
						A0_G0_result[pos + 1] = '\uFFFF';
						A0_G1_result[pos + 1] = '\uFFFF';
						A1_G0_result[pos + 1] = 'A';
						A1_G1_result[pos + 1] = 'A';
					} else if (nextCh === 'G') {
						A0_G0_result[pos + 1] = '\uFFFF';
						A0_G1_result[pos + 1] = 'G';
						A1_G0_result[pos + 1] = '\uFFFF';
						A1_G1_result[pos + 1] = 'G';
					} else {
						A0_G0_result[pos + 1] = nextCh;
						A0_G1_result[pos + 1] = nextCh;
						A1_G0_result[pos + 1] = nextCh;
						A1_G1_result[pos + 1] = nextCh;
					}
					pos++;
				}
			}
		}

		return {
			A0_G0: A0_G0_result.join(''),
			A0_G1: A0_G1_result.join(''),
			A1_G0: A1_G0_result.join(''),
			A1_G1: A1_G1_result.join('')
		}
	}

	public resolveAnchors(allowA:boolean, allowG:boolean): string {
		if (!this.hasAnchor) {
			return this.source;
		}

		if (allowA) {
			if (allowG) {
				return this._anchorCache.A1_G1;
			} else {
				return this._anchorCache.A1_G0;
			}
		} else {
			if (allowG) {
				return this._anchorCache.A0_G1;
			} else {
				return this._anchorCache.A0_G0;
			}
		}
	}
}

interface IRegExpSourceListAnchorCache {
	A0_G0: ICompiledRule;
	A0_G1: ICompiledRule;
	A1_G0: ICompiledRule;
	A1_G1: ICompiledRule;
}

let createOnigScanner = (function() {
	var onigurumaModule: any = null;
	return function createOnigScanner(sources:string[]): OnigScanner {
		if (!onigurumaModule) {
			onigurumaModule = require('oniguruma');
		}
		return new onigurumaModule.OnigScanner(sources);
	}
})();

export class RegExpSourceList {

	private _items: RegExpSource[];
	private _hasAnchors: boolean;
	private _cached: ICompiledRule;
	private _anchorCache: IRegExpSourceListAnchorCache;
	private _cachedSources: string[];

	constructor() {
		this._items = [];
		this._hasAnchors = false;
		this._cached = null;
		this._cachedSources = null;
		this._anchorCache = {
			A0_G0: null,
			A0_G1: null,
			A1_G0: null,
			A1_G1: null
		};
	}

	public push(item:RegExpSource): void {
		this._items.push(item);
		this._hasAnchors = this._hasAnchors || item.hasAnchor;
	}

	public unshift(item:RegExpSource): void {
		this._items.unshift(item);
		this._hasAnchors = this._hasAnchors || item.hasAnchor;
	}

	public length(): number {
		return this._items.length;
	}

	public setSource(index:number, newSource:string): void {
		if (this._items[index].source !== newSource) {
			// bust the cache
			this._cached = null;
			this._anchorCache.A0_G0 = null;
			this._anchorCache.A0_G1 = null;
			this._anchorCache.A1_G0 = null;
			this._anchorCache.A1_G1 = null;
			this._items[index].setSource(newSource);
		}
	}

	public compile(grammar:IRuleRegistry, allowA:boolean, allowG:boolean): ICompiledRule {
		if (!this._hasAnchors) {
			if (!this._cached) {
				this._cached = {
					scanner: createOnigScanner(this._items.map(e => e.source)),
					rules: this._items.map(e => e.ruleId)
				};
			}
			return this._cached;
		} else {
			this._anchorCache = {
				A0_G0: this._anchorCache.A0_G0 || (allowA === false && allowG === false ? this._resolveAnchors(allowA, allowG) : null),
				A0_G1: this._anchorCache.A0_G1 || (allowA === false && allowG === true ? this._resolveAnchors(allowA, allowG) : null),
				A1_G0: this._anchorCache.A1_G0 || (allowA === true && allowG === false ? this._resolveAnchors(allowA, allowG) : null),
				A1_G1: this._anchorCache.A1_G1 || (allowA === true && allowG === true ? this._resolveAnchors(allowA, allowG) : null),
			};
			if (allowA) {
				if (allowG) {
					return this._anchorCache.A1_G1;
				} else {
					return this._anchorCache.A1_G0;
				}
			} else {
				if (allowG) {
					return this._anchorCache.A0_G1;
				} else {
					return this._anchorCache.A0_G0;
				}
			}
		}

	}

	private _resolveAnchors(allowA:boolean, allowG:boolean): ICompiledRule {
		return {
			scanner: createOnigScanner(this._items.map(e => e.resolveAnchors(allowA, allowG))),
			rules: this._items.map(e => e.ruleId)
		};
	}
}

export class MatchRule extends Rule {
	private _match: RegExpSource;
	public captures: CaptureRule[];
	private _cachedCompiledPatterns: RegExpSourceList;

	constructor(id: number, name: string, match: string, captures: CaptureRule[]) {
		super(id, name, null);
		this._match = new RegExpSource(match, this.id);
		this.captures = captures;
		this._cachedCompiledPatterns = null;
	}

	public collectPatternsRecursive(grammar:IRuleRegistry, out:RegExpSourceList, isFirst:boolean) {
		out.push(this._match);
	}

	public compile(grammar:IRuleRegistry, endRegexSource: string, allowA:boolean, allowG:boolean): ICompiledRule {
		if (!this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns = new RegExpSourceList();
			this.collectPatternsRecursive(grammar, this._cachedCompiledPatterns, true);
		}
		return this._cachedCompiledPatterns.compile(grammar, allowA, allowG);
	}
}

export class IncludeOnlyRule extends Rule {
	public hasMissingPatterns: boolean;
	public patterns: number[];
	private _cachedCompiledPatterns: RegExpSourceList;

	constructor(id: number, name: string, contentName: string, patterns: ICompilePatternsResult) {
		super(id, name, contentName);
		this.patterns = patterns.patterns;
		this.hasMissingPatterns = patterns.hasMissingPatterns;
		this._cachedCompiledPatterns = null;
	}

	public collectPatternsRecursive(grammar:IRuleRegistry, out:RegExpSourceList, isFirst:boolean) {
		let i:number,
			len:number,
			rule:Rule;

		for (i = 0, len = this.patterns.length; i < len; i++) {
			rule = grammar.getRule(this.patterns[i]);
			rule.collectPatternsRecursive(grammar, out, false);
		}
	}

	public compile(grammar:IRuleRegistry, endRegexSource: string, allowA:boolean, allowG:boolean): ICompiledRule {
		if (!this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns = new RegExpSourceList();
			this.collectPatternsRecursive(grammar, this._cachedCompiledPatterns, true);
		}
		return this._cachedCompiledPatterns.compile(grammar, allowA, allowG);
	}
}

function escapeRegExpCharacters(value: string): string {
	return value.replace(/[\-\\\{\}\*\+\?\|\^\$\.\,\[\]\(\)\#\s]/g, '\\$&');
}

export class BeginEndRule extends Rule {
	private _begin: RegExpSource;
	public beginCaptures: CaptureRule[];
	private _end: RegExpSource;
	public endHasBackReferences:boolean;
	public endCaptures: CaptureRule[];
	public applyEndPatternLast: boolean;
	public hasMissingPatterns: boolean;
	public patterns: number[];
	private _cachedCompiledPatterns: RegExpSourceList;

	constructor(id: number, name: string, contentName: string, begin: string, beginCaptures: CaptureRule[], end: string, endCaptures: CaptureRule[], applyEndPatternLast: boolean, patterns: ICompilePatternsResult) {
		super(id, name, contentName);
		this._begin = new RegExpSource(begin, this.id);
		this.beginCaptures = beginCaptures;
		this._end = new RegExpSource(end, -1);
		this.endHasBackReferences = this._end.hasBackReferences;
		this.endCaptures = endCaptures;
		this.applyEndPatternLast = applyEndPatternLast || false;
		this.patterns = patterns.patterns;
		this.hasMissingPatterns = patterns.hasMissingPatterns;
		this._cachedCompiledPatterns = null;
	}

	public getEndWithResolvedBackReferences(lineText:string, captureIndices:IOnigCaptureIndex[]): string {
		return this._end.resolveBackReferences(lineText, captureIndices);
	}

	public collectPatternsRecursive(grammar:IRuleRegistry, out:RegExpSourceList, isFirst:boolean) {
		if (isFirst) {
			let i:number,
				len:number,
				rule:Rule;

			for (i = 0, len = this.patterns.length; i < len; i++) {
				rule = grammar.getRule(this.patterns[i]);
				rule.collectPatternsRecursive(grammar, out, false);
			}
		} else {
			out.push(this._begin);
		}
	}

	public compile(grammar:IRuleRegistry, endRegexSource: string, allowA:boolean, allowG:boolean): ICompiledRule {
		let precompiled = this._precompile(grammar);

		if (this._end.hasBackReferences) {
			if (this.applyEndPatternLast) {
				precompiled.setSource(precompiled.length() - 1, endRegexSource);
			} else {
				precompiled.setSource(0, endRegexSource);
			}
		}
		return this._cachedCompiledPatterns.compile(grammar, allowA, allowG);
	}

	private _precompile(grammar:IRuleRegistry): RegExpSourceList {
		if (!this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns = new RegExpSourceList();

			this.collectPatternsRecursive(grammar, this._cachedCompiledPatterns, true);

			if (this.applyEndPatternLast) {
				this._cachedCompiledPatterns.push(this._end.hasBackReferences ? this._end.clone() : this._end);
			} else {
				this._cachedCompiledPatterns.unshift(this._end.hasBackReferences ? this._end.clone() : this._end);
			}
		}
		return this._cachedCompiledPatterns;
	}
}

export class RuleFactory {

	public static createCaptureRule(helper: IRuleFactoryHelper, name:string, contentName:string, retokenizeCapturedWithRuleId:number): CaptureRule {
		return helper.registerRule((id) => {
			return new CaptureRule(id, name, contentName, retokenizeCapturedWithRuleId);
		});
	}

	public static getCompiledRuleId(desc: IRawRule, helper: IRuleFactoryHelper, repository:IRawRepository): number {
		if (!desc.id) {
			helper.registerRule((id) => {
				desc.id = id;

				if (desc.match) {
					return new MatchRule(
						desc.id,
						desc.name,
						desc.match,
						RuleFactory._compileCaptures(desc.captures, helper, repository)
					);
				}

				if (!desc.begin) {
					if (desc.repository) {
						repository = mergeObjects({}, repository, desc.repository);
					}
					return new IncludeOnlyRule(
						desc.id,
						desc.name,
						desc.contentName,
						RuleFactory._compilePatterns(desc.patterns, helper, repository)
					);
				}

				return new BeginEndRule(
					desc.id,
					desc.name,
					desc.contentName,
					desc.begin, RuleFactory._compileCaptures(desc.beginCaptures || desc.captures, helper, repository),
					desc.end, RuleFactory._compileCaptures(desc.endCaptures || desc.captures, helper, repository),
					desc.applyEndPatternLast,
					RuleFactory._compilePatterns(desc.patterns, helper, repository)
				);
			});
		}

		return desc.id;
	}

	private static _compileCaptures(captures:IRawCaptures, helper: IRuleFactoryHelper, repository:IRawRepository): CaptureRule[] {
		let r: CaptureRule[] = [],
			numericCaptureId: number,
			maximumCaptureId: number,
			i: number,
			captureId: string;

		if (captures) {
			// Find the maximum capture id
			maximumCaptureId = 0;
			for (captureId in captures) {
				numericCaptureId = parseInt(captureId, 10);
				if (numericCaptureId > maximumCaptureId) {
					maximumCaptureId = numericCaptureId;
				}
			}

			// Initialize result
			for (i = 0; i <= maximumCaptureId; i++) {
				r[i] = null;
			}

			// Fill out result
			for (captureId in captures) {
				numericCaptureId = parseInt(captureId, 10);
				let retokenizeCapturedWithRuleId = 0;
				if (captures[captureId].patterns) {
					retokenizeCapturedWithRuleId = RuleFactory.getCompiledRuleId(captures[captureId], helper, repository);
				}
				r[numericCaptureId] = RuleFactory.createCaptureRule(helper, captures[captureId].name, captures[captureId].contentName, retokenizeCapturedWithRuleId);
			}
		}

		return r;
	}

	private static _compilePatterns(patterns:IRawPattern[], helper: IRuleFactoryHelper, repository:IRawRepository): ICompilePatternsResult {
		let r: number[] = [],
			pattern: IRawPattern,
			i: number,
			len: number,
			patternId: number,
			externalGrammar: IRawGrammar,
			rule: Rule,
			skipRule: boolean;

		if (patterns) {
			for (i = 0, len = patterns.length; i < len; i++) {
				pattern = patterns[i];
				patternId = -1;

				if (pattern.include) {
					if (pattern.include.charAt(0) === '#') {
						// Local include found in `repository`
						let localIncludedRule = repository[pattern.include.substr(1)];
						if (localIncludedRule) {
							patternId = RuleFactory.getCompiledRuleId(localIncludedRule, helper, repository);
						} else {
							// console.warn('CANNOT find rule for scopeName: ' + pattern.include + ', I am: ', repository['$base'].name);
						}
					} else if (pattern.include === '$base' || pattern.include === '$self') {
						// Special include also found in `repository`
						patternId = RuleFactory.getCompiledRuleId(repository[pattern.include], helper, repository);
					} else {
						let externalGrammarName: string = null,
							externalGrammarInclude: string = null,
							sharpIndex = pattern.include.indexOf('#');
						if (sharpIndex >= 0) {
							externalGrammarName = pattern.include.substring(0, sharpIndex);
							externalGrammarInclude = pattern.include.substring(sharpIndex + 1);
						} else {
							externalGrammarName = pattern.include;
						}
						// External include
						externalGrammar = helper.getExternalGrammar(externalGrammarName, repository);

						if (externalGrammar) {
							if (externalGrammarInclude) {
								let externalIncludedRule = externalGrammar.repository[externalGrammarInclude];
								if (externalIncludedRule) {
									patternId = RuleFactory.getCompiledRuleId(externalIncludedRule, helper, externalGrammar.repository);
								} else {
									// console.warn('CANNOT find rule for scopeName: ' + pattern.include + ', I am: ', repository['$base'].name);
								}
							} else {
								patternId = RuleFactory.getCompiledRuleId(externalGrammar.repository.$self, helper, externalGrammar.repository);
							}
						} else {
							// console.warn('CANNOT find grammar for scopeName: ' + pattern.include + ', I am: ', repository['$base'].name);
						}

					}
				} else {
					patternId = RuleFactory.getCompiledRuleId(pattern, helper, repository);
				}

				if (patternId !== -1) {
					rule = helper.getRule(patternId);

					skipRule = false;

					if (rule instanceof IncludeOnlyRule) {
						if (rule.hasMissingPatterns && rule.patterns.length === 0) {
							skipRule = true;
						}
					} else if (rule instanceof BeginEndRule) {
						if (rule.hasMissingPatterns && rule.patterns.length === 0) {
							skipRule = true;
						}
					}

					if (skipRule) {
						// console.log('REMOVING RULE ENTIRELY DUE TO EMPTY PATTERNS THAT ARE MISSING');
						continue;
					}

					r.push(patternId);
				}
			}
		}

		return {
			patterns: r,
			hasMissingPatterns: ((patterns ? patterns.length : 0) !== r.length)
		};
	}
}
