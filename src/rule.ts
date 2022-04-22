/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { RegexSource, mergeObjects, basename } from './utils';
import { IOnigLib, OnigScanner, IOnigCaptureIndex } from './onigLib';
import { ILocation, IRawGrammar, IRawRepository, IRawRule, IRawCaptures } from './rawGrammar';

const HAS_BACK_REFERENCES = /\\(\d+)/;
const BACK_REFERENCING_END = /\\(\d+)/g;

export interface IRuleRegistry {
	getRule(patternId: number): Rule;
	registerRule<T extends Rule>(factory: (id: number) => T): T;
}

export interface IGrammarRegistry {
	getExternalGrammar(scopeName: string, repository: IRawRepository): IRawGrammar | null | undefined;
}

export interface IRuleFactoryHelper extends IRuleRegistry, IGrammarRegistry {
}

export class CompiledRule {

	public readonly debugRegExps: string[];
	public readonly rules: number[];
	public readonly scanner: OnigScanner;

	constructor(onigLib: IOnigLib, regExps: string[], rules: number[]) {
		this.debugRegExps = regExps;
		this.rules = rules;
		this.scanner = onigLib.createOnigScanner(regExps);
	}

	public dispose(): void {
		if (typeof this.scanner.dispose === 'function') {
			this.scanner.dispose();
		}
	}
}

export abstract class Rule {

	public readonly $location: ILocation | undefined;
	public readonly id: number;

	private readonly _nameIsCapturing: boolean;
	private readonly _name: string | null;

	private readonly _contentNameIsCapturing: boolean;
	private readonly _contentName: string | null;

	constructor($location: ILocation | undefined, id: number, name: string | null | undefined, contentName: string | null | undefined) {
		this.$location = $location;
		this.id = id;
		this._name = name || null;
		this._nameIsCapturing = RegexSource.hasCaptures(this._name);
		this._contentName = contentName || null;
		this._contentNameIsCapturing = RegexSource.hasCaptures(this._contentName);
	}

	public abstract dispose(): void;

	public get debugName(): string {
		const location = this.$location ? `${basename(this.$location.filename)}:${this.$location.line}` : 'unknown';
		return `${(<any>this.constructor).name}#${this.id} @ ${location}`;
	}

	public getName(lineText: string | null, captureIndices: IOnigCaptureIndex[] | null): string | null {
		if (!this._nameIsCapturing || this._name === null || lineText === null || captureIndices === null) {
			return this._name;
		}
		return RegexSource.replaceCaptures(this._name, lineText, captureIndices);
	}

	public getContentName(lineText: string, captureIndices: IOnigCaptureIndex[]): string | null {
		if (!this._contentNameIsCapturing || this._contentName === null) {
			return this._contentName;
		}
		return RegexSource.replaceCaptures(this._contentName, lineText, captureIndices);
	}

	public abstract collectPatternsRecursive(grammar: IRuleRegistry, out: RegExpSourceList, isFirst: boolean): void;

	public abstract compile(grammar: IRuleRegistry & IOnigLib, endRegexSource: string | null): CompiledRule;

	public abstract compileAG(grammar: IRuleRegistry & IOnigLib, endRegexSource: string | null, allowA: boolean, allowG: boolean): CompiledRule;
}

export interface ICompilePatternsResult {
	readonly patterns: number[];
	readonly hasMissingPatterns: boolean;
}

export class CaptureRule extends Rule {

	public readonly retokenizeCapturedWithRuleId: number;

	constructor($location: ILocation | undefined, id: number, name: string | null | undefined, contentName: string | null | undefined, retokenizeCapturedWithRuleId: number) {
		super($location, id, name, contentName);
		this.retokenizeCapturedWithRuleId = retokenizeCapturedWithRuleId;
	}

	public dispose(): void {
		// nothing to dispose
	}

	public collectPatternsRecursive(grammar: IRuleRegistry, out: RegExpSourceList, isFirst: boolean) {
		throw new Error('Not supported!');
	}

	public compile(grammar: IRuleRegistry & IOnigLib, endRegexSource: string): CompiledRule {
		throw new Error('Not supported!');
	}

	public compileAG(grammar: IRuleRegistry & IOnigLib, endRegexSource: string, allowA: boolean, allowG: boolean): CompiledRule {
		throw new Error('Not supported!');
	}
}

interface IRegExpSourceAnchorCache {
	readonly A0_G0: string;
	readonly A0_G1: string;
	readonly A1_G0: string;
	readonly A1_G1: string;
}

export class RegExpSource {

	public source: string;
	public readonly ruleId: number;
	public hasAnchor: boolean;
	public readonly hasBackReferences: boolean;
	private _anchorCache: IRegExpSourceAnchorCache | null;

	constructor(regExpSource: string, ruleId: number, handleAnchors: boolean = true) {
		if (handleAnchors) {
			if (regExpSource) {
				const len = regExpSource.length;
				let lastPushedPos = 0;
				let output: string[] = [];

				let hasAnchor = false;
				for (let pos = 0; pos < len; pos++) {
					const ch = regExpSource.charAt(pos);

					if (ch === '\\') {
						if (pos + 1 < len) {
							const nextCh = regExpSource.charAt(pos + 1);
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
		} else {
			this.hasAnchor = false;
			this.source = regExpSource;
		}

		if (this.hasAnchor) {
			this._anchorCache = this._buildAnchorCache();
		} else {
			this._anchorCache = null;
		}

		this.ruleId = ruleId;
		this.hasBackReferences = HAS_BACK_REFERENCES.test(this.source);

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

	public resolveBackReferences(lineText: string, captureIndices: IOnigCaptureIndex[]): string {
		let capturedValues = captureIndices.map((capture) => {
			return lineText.substring(capture.start, capture.end);
		});
		BACK_REFERENCING_END.lastIndex = 0;
		return this.source.replace(BACK_REFERENCING_END, (match, g1) => {
			return escapeRegExpCharacters(capturedValues[parseInt(g1, 10)] || '');
		});
	}

	private _buildAnchorCache(): IRegExpSourceAnchorCache {
		let A0_G0_result: string[] = [];
		let A0_G1_result: string[] = [];
		let A1_G0_result: string[] = [];
		let A1_G1_result: string[] = [];

		let pos: number,
			len: number,
			ch: string,
			nextCh: string;

		for (pos = 0, len = this.source.length; pos < len; pos++) {
			ch = this.source.charAt(pos);
			A0_G0_result[pos] = ch;
			A0_G1_result[pos] = ch;
			A1_G0_result[pos] = ch;
			A1_G1_result[pos] = ch;

			if (ch === '\\') {
				if (pos + 1 < len) {
					nextCh = this.source.charAt(pos + 1);
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
		};
	}

	public resolveAnchors(allowA: boolean, allowG: boolean): string {
		if (!this.hasAnchor || !this._anchorCache) {
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
	A0_G0: CompiledRule | null;
	A0_G1: CompiledRule | null;
	A1_G0: CompiledRule | null;
	A1_G1: CompiledRule | null;
}

export class RegExpSourceList {

	private readonly _items: RegExpSource[];
	private _hasAnchors: boolean;
	private _cached: CompiledRule | null;
	private _anchorCache: IRegExpSourceListAnchorCache;

	constructor() {
		this._items = [];
		this._hasAnchors = false;
		this._cached = null;
		this._anchorCache = {
			A0_G0: null,
			A0_G1: null,
			A1_G0: null,
			A1_G1: null
		};
	}

	public dispose(): void {
		this._disposeCaches();
	}

	private _disposeCaches(): void {
		if (this._cached) {
			this._cached.dispose();
			this._cached = null;
		}
		if (this._anchorCache.A0_G0) {
			this._anchorCache.A0_G0.dispose();
			this._anchorCache.A0_G0 = null;
		}
		if (this._anchorCache.A0_G1) {
			this._anchorCache.A0_G1.dispose();
			this._anchorCache.A0_G1 = null;
		}
		if (this._anchorCache.A1_G0) {
			this._anchorCache.A1_G0.dispose();
			this._anchorCache.A1_G0 = null;
		}
		if (this._anchorCache.A1_G1) {
			this._anchorCache.A1_G1.dispose();
			this._anchorCache.A1_G1 = null;
		}
	}

	public push(item: RegExpSource): void {
		this._items.push(item);
		this._hasAnchors = this._hasAnchors || item.hasAnchor;
	}

	public unshift(item: RegExpSource): void {
		this._items.unshift(item);
		this._hasAnchors = this._hasAnchors || item.hasAnchor;
	}

	public length(): number {
		return this._items.length;
	}

	public setSource(index: number, newSource: string): void {
		if (this._items[index].source !== newSource) {
			// bust the cache
			this._disposeCaches();
			this._items[index].setSource(newSource);
		}
	}

	public compile(onigLib: IOnigLib): CompiledRule {
		if (!this._cached) {
			let regExps = this._items.map(e => e.source);
			this._cached = new CompiledRule(onigLib, regExps, this._items.map(e => e.ruleId));
		}
		return this._cached;
	}

	public compileAG(onigLib: IOnigLib, allowA: boolean, allowG: boolean): CompiledRule {
		if (!this._hasAnchors) {
			return this.compile(onigLib);
		} else {
			if (allowA) {
				if (allowG) {
					if (!this._anchorCache.A1_G1) {
						this._anchorCache.A1_G1 = this._resolveAnchors(onigLib, allowA, allowG);
					}
					return this._anchorCache.A1_G1;
				} else {
					if (!this._anchorCache.A1_G0) {
						this._anchorCache.A1_G0 = this._resolveAnchors(onigLib, allowA, allowG);
					}
					return this._anchorCache.A1_G0;
				}
			} else {
				if (allowG) {
					if (!this._anchorCache.A0_G1) {
						this._anchorCache.A0_G1 = this._resolveAnchors(onigLib, allowA, allowG);
					}
					return this._anchorCache.A0_G1;
				} else {
					if (!this._anchorCache.A0_G0) {
						this._anchorCache.A0_G0 = this._resolveAnchors(onigLib, allowA, allowG);
					}
					return this._anchorCache.A0_G0;
				}
			}
		}
	}

	private _resolveAnchors(onigLib: IOnigLib, allowA: boolean, allowG: boolean): CompiledRule {
		let regExps = this._items.map(e => e.resolveAnchors(allowA, allowG));
		return new CompiledRule(onigLib, regExps, this._items.map(e => e.ruleId));
	}
}

export class MatchRule extends Rule {
	private readonly _match: RegExpSource;
	public readonly captures: (CaptureRule | null)[];
	private _cachedCompiledPatterns: RegExpSourceList | null;

	constructor($location: ILocation | undefined, id: number, name: string | undefined, match: string, captures: (CaptureRule | null)[]) {
		super($location, id, name, null);
		this._match = new RegExpSource(match, this.id);
		this.captures = captures;
		this._cachedCompiledPatterns = null;
	}

	public dispose(): void {
		if (this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns.dispose();
			this._cachedCompiledPatterns = null;
		}
	}

	public get debugMatchRegExp(): string {
		return `${this._match.source}`;
	}

	public collectPatternsRecursive(grammar: IRuleRegistry, out: RegExpSourceList, isFirst: boolean) {
		out.push(this._match);
	}

	public compile(grammar: IRuleRegistry & IOnigLib, endRegexSource: string): CompiledRule {
		return this._getCachedCompiledPatterns(grammar).compile(grammar);
	}

	public compileAG(grammar: IRuleRegistry & IOnigLib, endRegexSource: string, allowA: boolean, allowG: boolean): CompiledRule {
		return this._getCachedCompiledPatterns(grammar).compileAG(grammar, allowA, allowG);
	}

	private _getCachedCompiledPatterns(grammar: IRuleRegistry & IOnigLib): RegExpSourceList {
		if (!this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns = new RegExpSourceList();
			this.collectPatternsRecursive(grammar, this._cachedCompiledPatterns, true);
		}
		return this._cachedCompiledPatterns;
	}
}

export class IncludeOnlyRule extends Rule {
	public readonly hasMissingPatterns: boolean;
	public readonly patterns: number[];
	private _cachedCompiledPatterns: RegExpSourceList | null;

	constructor($location: ILocation | undefined, id: number, name: string | null | undefined, contentName: string | null | undefined, patterns: ICompilePatternsResult) {
		super($location, id, name, contentName);
		this.patterns = patterns.patterns;
		this.hasMissingPatterns = patterns.hasMissingPatterns;
		this._cachedCompiledPatterns = null;
	}

	public dispose(): void {
		if (this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns.dispose();
			this._cachedCompiledPatterns = null;
		}
	}

	public collectPatternsRecursive(grammar: IRuleRegistry, out: RegExpSourceList, isFirst: boolean) {
		let i: number,
			len: number,
			rule: Rule;

		for (i = 0, len = this.patterns.length; i < len; i++) {
			rule = grammar.getRule(this.patterns[i]);
			rule.collectPatternsRecursive(grammar, out, false);
		}
	}

	public compile(grammar: IRuleRegistry & IOnigLib, endRegexSource: string): CompiledRule {
		return this._getCachedCompiledPatterns(grammar).compile(grammar);
	}

	public compileAG(grammar: IRuleRegistry & IOnigLib, endRegexSource: string, allowA: boolean, allowG: boolean): CompiledRule {
		return this._getCachedCompiledPatterns(grammar).compileAG(grammar, allowA, allowG);
	}

	private _getCachedCompiledPatterns(grammar: IRuleRegistry & IOnigLib): RegExpSourceList {
		if (!this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns = new RegExpSourceList();
			this.collectPatternsRecursive(grammar, this._cachedCompiledPatterns, true);
		}
		return this._cachedCompiledPatterns;
	}
}

function escapeRegExpCharacters(value: string): string {
	return value.replace(/[\-\\\{\}\*\+\?\|\^\$\.\,\[\]\(\)\#\s]/g, '\\$&');
}

export class BeginEndRule extends Rule {
	private readonly _begin: RegExpSource;
	public readonly beginCaptures: (CaptureRule | null)[];
	private readonly _end: RegExpSource;
	public readonly endHasBackReferences: boolean;
	public readonly endCaptures: (CaptureRule | null)[];
	public readonly applyEndPatternLast: boolean;
	public readonly hasMissingPatterns: boolean;
	public readonly patterns: number[];
	private _cachedCompiledPatterns: RegExpSourceList | null;

	constructor($location: ILocation | undefined, id: number, name: string | null | undefined, contentName: string | null | undefined, begin: string, beginCaptures: (CaptureRule | null)[], end: string | undefined, endCaptures: (CaptureRule | null)[], applyEndPatternLast: boolean | undefined, patterns: ICompilePatternsResult) {
		super($location, id, name, contentName);
		this._begin = new RegExpSource(begin, this.id);
		this.beginCaptures = beginCaptures;
		this._end = new RegExpSource(end ? end : '\uFFFF', -1);
		this.endHasBackReferences = this._end.hasBackReferences;
		this.endCaptures = endCaptures;
		this.applyEndPatternLast = applyEndPatternLast || false;
		this.patterns = patterns.patterns;
		this.hasMissingPatterns = patterns.hasMissingPatterns;
		this._cachedCompiledPatterns = null;
	}

	public dispose(): void {
		if (this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns.dispose();
			this._cachedCompiledPatterns = null;
		}
	}

	public get debugBeginRegExp(): string {
		return `${this._begin.source}`;
	}

	public get debugEndRegExp(): string {
		return `${this._end.source}`;
	}

	public getEndWithResolvedBackReferences(lineText: string, captureIndices: IOnigCaptureIndex[]): string {
		return this._end.resolveBackReferences(lineText, captureIndices);
	}

	public collectPatternsRecursive(grammar: IRuleRegistry, out: RegExpSourceList, isFirst: boolean) {
		if (isFirst) {
			let i: number,
				len: number,
				rule: Rule;

			for (i = 0, len = this.patterns.length; i < len; i++) {
				rule = grammar.getRule(this.patterns[i]);
				rule.collectPatternsRecursive(grammar, out, false);
			}
		} else {
			out.push(this._begin);
		}
	}

	public compile(grammar: IRuleRegistry & IOnigLib, endRegexSource: string): CompiledRule {
		return this._getCachedCompiledPatterns(grammar, endRegexSource).compile(grammar);
	}

	public compileAG(grammar: IRuleRegistry & IOnigLib, endRegexSource: string, allowA: boolean, allowG: boolean): CompiledRule {
		return this._getCachedCompiledPatterns(grammar, endRegexSource).compileAG(grammar, allowA, allowG);
	}

	private _getCachedCompiledPatterns(grammar: IRuleRegistry & IOnigLib, endRegexSource: string): RegExpSourceList {
		if (!this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns = new RegExpSourceList();

			this.collectPatternsRecursive(grammar, this._cachedCompiledPatterns, true);

			if (this.applyEndPatternLast) {
				this._cachedCompiledPatterns.push(this._end.hasBackReferences ? this._end.clone() : this._end);
			} else {
				this._cachedCompiledPatterns.unshift(this._end.hasBackReferences ? this._end.clone() : this._end);
			}
		}
		if (this._end.hasBackReferences) {
			if (this.applyEndPatternLast) {
				this._cachedCompiledPatterns.setSource(this._cachedCompiledPatterns.length() - 1, endRegexSource);
			} else {
				this._cachedCompiledPatterns.setSource(0, endRegexSource);
			}
		}
		return this._cachedCompiledPatterns;
	}
}

export class BeginWhileRule extends Rule {
	private readonly _begin: RegExpSource;
	public readonly beginCaptures: (CaptureRule | null)[];
	public readonly whileCaptures: (CaptureRule | null)[];
	private readonly _while: RegExpSource;
	public readonly whileHasBackReferences: boolean;
	public readonly hasMissingPatterns: boolean;
	public readonly patterns: number[];
	private _cachedCompiledPatterns: RegExpSourceList | null;
	private _cachedCompiledWhilePatterns: RegExpSourceList | null;

	constructor($location: ILocation | undefined, id: number, name: string | null | undefined, contentName: string | null | undefined, begin: string, beginCaptures: (CaptureRule | null)[], _while: string, whileCaptures: (CaptureRule | null)[], patterns: ICompilePatternsResult) {
		super($location, id, name, contentName);
		this._begin = new RegExpSource(begin, this.id);
		this.beginCaptures = beginCaptures;
		this.whileCaptures = whileCaptures;
		this._while = new RegExpSource(_while, -2);
		this.whileHasBackReferences = this._while.hasBackReferences;
		this.patterns = patterns.patterns;
		this.hasMissingPatterns = patterns.hasMissingPatterns;
		this._cachedCompiledPatterns = null;
		this._cachedCompiledWhilePatterns = null;
	}

	public dispose(): void {
		if (this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns.dispose();
			this._cachedCompiledPatterns = null;
		}
		if (this._cachedCompiledWhilePatterns) {
			this._cachedCompiledWhilePatterns.dispose();
			this._cachedCompiledWhilePatterns = null;
		}
	}

	public get debugBeginRegExp(): string {
		return `${this._begin.source}`;
	}

	public get debugWhileRegExp(): string {
		return `${this._while.source}`;
	}

	public getWhileWithResolvedBackReferences(lineText: string, captureIndices: IOnigCaptureIndex[]): string {
		return this._while.resolveBackReferences(lineText, captureIndices);
	}

	public collectPatternsRecursive(grammar: IRuleRegistry, out: RegExpSourceList, isFirst: boolean) {
		if (isFirst) {
			let i: number,
				len: number,
				rule: Rule;

			for (i = 0, len = this.patterns.length; i < len; i++) {
				rule = grammar.getRule(this.patterns[i]);
				rule.collectPatternsRecursive(grammar, out, false);
			}
		} else {
			out.push(this._begin);
		}
	}

	public compile(grammar: IRuleRegistry & IOnigLib, endRegexSource: string): CompiledRule {
		return this._getCachedCompiledPatterns(grammar).compile(grammar);
	}

	public compileAG(grammar: IRuleRegistry & IOnigLib, endRegexSource: string, allowA: boolean, allowG: boolean): CompiledRule {
		return this._getCachedCompiledPatterns(grammar).compileAG(grammar, allowA, allowG);
	}

	private _getCachedCompiledPatterns(grammar: IRuleRegistry & IOnigLib): RegExpSourceList {
		if (!this._cachedCompiledPatterns) {
			this._cachedCompiledPatterns = new RegExpSourceList();
			this.collectPatternsRecursive(grammar, this._cachedCompiledPatterns, true);
		}
		return this._cachedCompiledPatterns;
	}

	public compileWhile(grammar: IRuleRegistry & IOnigLib, endRegexSource: string | null): CompiledRule {
		return this._getCachedCompiledWhilePatterns(grammar, endRegexSource).compile(grammar);
	}

	public compileWhileAG(grammar: IRuleRegistry & IOnigLib, endRegexSource: string | null, allowA: boolean, allowG: boolean): CompiledRule {
		return this._getCachedCompiledWhilePatterns(grammar, endRegexSource).compileAG(grammar, allowA, allowG);
	}

	private _getCachedCompiledWhilePatterns(grammar: IRuleRegistry & IOnigLib, endRegexSource: string | null): RegExpSourceList {
		if (!this._cachedCompiledWhilePatterns) {
			this._cachedCompiledWhilePatterns = new RegExpSourceList();
			this._cachedCompiledWhilePatterns.push(this._while.hasBackReferences ? this._while.clone() : this._while);
		}
		if (this._while.hasBackReferences) {
			this._cachedCompiledWhilePatterns.setSource(0, endRegexSource ? endRegexSource : '\uFFFF');
		}
		return this._cachedCompiledWhilePatterns;
	}
}

export class RuleFactory {

	public static createCaptureRule(helper: IRuleFactoryHelper, $location: ILocation | undefined, name: string | null | undefined, contentName: string | null | undefined, retokenizeCapturedWithRuleId: number): CaptureRule {
		return helper.registerRule((id) => {
			return new CaptureRule($location, id, name, contentName, retokenizeCapturedWithRuleId);
		});
	}

	public static getCompiledRuleId(desc: IRawRule, helper: IRuleFactoryHelper, repository: IRawRepository): number {
		if (!desc.id) {
			helper.registerRule((id) => {
				desc.id = id;

				if (desc.match) {
					return new MatchRule(
						desc.$vscodeTextmateLocation,
						desc.id,
						desc.name,
						desc.match,
						RuleFactory._compileCaptures(desc.captures, helper, repository)
					);
				}

				if (typeof desc.begin === 'undefined') {
					if (desc.repository) {
						repository = mergeObjects({}, repository, desc.repository);
					}
					let patterns = desc.patterns;
					if (typeof patterns === 'undefined' && desc.include) {
						patterns = [{ include: desc.include }];
					}
					return new IncludeOnlyRule(
						desc.$vscodeTextmateLocation,
						desc.id,
						desc.name,
						desc.contentName,
						RuleFactory._compilePatterns(patterns, helper, repository)
					);
				}

				if (desc.while) {
					return new BeginWhileRule(
						desc.$vscodeTextmateLocation,
						desc.id,
						desc.name,
						desc.contentName,
						desc.begin, RuleFactory._compileCaptures(desc.beginCaptures || desc.captures, helper, repository),
						desc.while, RuleFactory._compileCaptures(desc.whileCaptures || desc.captures, helper, repository),
						RuleFactory._compilePatterns(desc.patterns, helper, repository)
					);
				}

				return new BeginEndRule(
					desc.$vscodeTextmateLocation,
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

		return desc.id!;
	}

	private static _compileCaptures(captures: IRawCaptures | undefined, helper: IRuleFactoryHelper, repository: IRawRepository): (CaptureRule | null)[] {
		let r: (CaptureRule | null)[] = [];

		if (captures) {
			// Find the maximum capture id
			let maximumCaptureId = 0;
			for (const captureId in captures) {
				if (captureId === '$vscodeTextmateLocation') {
					continue;
				}
				const numericCaptureId = parseInt(captureId, 10);
				if (numericCaptureId > maximumCaptureId) {
					maximumCaptureId = numericCaptureId;
				}
			}

			// Initialize result
			for (let i = 0; i <= maximumCaptureId; i++) {
				r[i] = null;
			}

			// Fill out result
			for (const captureId in captures) {
				if (captureId === '$vscodeTextmateLocation') {
					continue;
				}
				const numericCaptureId = parseInt(captureId, 10);
				let retokenizeCapturedWithRuleId = 0;
				if (captures[captureId].patterns) {
					retokenizeCapturedWithRuleId = RuleFactory.getCompiledRuleId(captures[captureId], helper, repository);
				}
				r[numericCaptureId] = RuleFactory.createCaptureRule(helper, captures[captureId].$vscodeTextmateLocation, captures[captureId].name, captures[captureId].contentName, retokenizeCapturedWithRuleId);
			}
		}

		return r;
	}

	private static _compilePatterns(patterns: IRawRule[] | undefined, helper: IRuleFactoryHelper, repository: IRawRepository): ICompilePatternsResult {
		let r: number[] = [];

		if (patterns) {
			for (let i = 0, len = patterns.length; i < len; i++) {
				const pattern = patterns[i];
				let patternId = -1;

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
						let externalGrammarName: string | null = null;
						let externalGrammarInclude: string | null = null;
						let sharpIndex = pattern.include.indexOf('#');

						if (sharpIndex >= 0) {
							externalGrammarName = pattern.include.substring(0, sharpIndex);
							externalGrammarInclude = pattern.include.substring(sharpIndex + 1);
						} else {
							externalGrammarName = pattern.include;
						}
						// External include
						const externalGrammar = helper.getExternalGrammar(externalGrammarName, repository);

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
					const rule = helper.getRule(patternId);

					let skipRule = false;

					if (rule instanceof IncludeOnlyRule || rule instanceof BeginEndRule || rule instanceof BeginWhileRule) {
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
