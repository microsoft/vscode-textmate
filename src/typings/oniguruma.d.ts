
declare module "oniguruma" {

	export interface IOnigCaptureIndex {
		start: number;
		end: number;
		length: number;
	}

	export interface IOnigNextMatchResult {
		index: number;
		captureIndices: IOnigCaptureIndex[];
	}

	export class OnigScanner {
		constructor(regexps:string[]);
		_findNextMatchSync(lin:string, pos:number): IOnigNextMatchResult;
	}

}