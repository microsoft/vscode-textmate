/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

// -- raw grammar typings

export interface ILocation {
	readonly filename: string;
	readonly line: number;
	readonly char: number;
}

export interface ILocatable {
	readonly $vscodeTextmateLocation?:ILocation;
}

export interface IRawGrammar extends ILocatable {
	repository: IRawRepository;
	readonly scopeName: string;
	readonly patterns: IRawRule[];
	readonly injections?: { [expression:string]: IRawRule };
	readonly injectionSelector?: string;

	readonly fileTypes?: string[];
	readonly name?: string;
	readonly firstLineMatch?: string;
}

export interface IRawRepository extends ILocatable {
	[name:string]: IRawRule;
	$self: IRawRule;
	$base: IRawRule;
}

export interface IRawRule extends ILocatable {
	id?: number;

	readonly include?: string;

	readonly name?: string;
	readonly contentName?: string;

	readonly match?:string;
	readonly captures?: IRawCaptures;
	readonly begin?:string;
	readonly beginCaptures?: IRawCaptures;
	readonly end?:string;
	readonly endCaptures?: IRawCaptures;
	readonly while?:string;
	readonly whileCaptures?: IRawCaptures;
	readonly patterns?: IRawRule[];

	readonly repository?: IRawRepository;

	readonly applyEndPatternLast?:boolean;
}

export interface IRawCaptures extends ILocatable {
	[captureId:string]: IRawRule;
}
