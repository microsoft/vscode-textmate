/**
 * A registry helper that can locate grammar file paths given scope names.
 */
export interface IGrammarLocator {
    getFilePath(scopeName: string): string;
    getInjections?(scopeName: string): string[];
}
/**
 * The registry that will hold all grammars.
 */
export declare class Registry {
    private _locator;
    private _syncRegistry;
    constructor(locator?: IGrammarLocator);
    /**
     * Load the grammar for `scopeName` and all referenced included grammars asynchronously.
     */
    loadGrammar(initialScopeName: string, callback: (err: any, grammar: IGrammar) => void): void;
    /**
     * Load the grammar at `path` synchronously.
     */
    loadGrammarFromPathSync(path: string): IGrammar;
    /**
     * Get the grammar for `scopeName`. The grammar must first be created via `loadGrammar` or `loadGrammarFromPathSync`.
     */
    grammarForScopeName(scopeName: string): IGrammar;
}
export interface IGrammarInfo {
    fileTypes: string[];
    name: string;
    scopeName: string;
    firstLineMatch: string;
}
/**
 * A grammar
 */
export interface IGrammar {
    /**
     * Tokenize `lineText` using previous line state `prevState`.
     */
    tokenizeLine(lineText: string, prevState: StackElement): ITokenizeLineResult;
}
export interface ITokenizeLineResult {
    tokens: IToken[];
    /**
     * The `prevState` to be passed on to the next line tokenization.
     */
    ruleStack: StackElement;
}
export interface IToken {
    startIndex: number;
    endIndex: number;
    scopes: string[];
}
/**
 * **IMPORTANT** - Immutable!
 */
export interface StackElement {
    _parent: StackElement;
    _stackElementBrand: void;
    equals(other: StackElement): boolean;
}
