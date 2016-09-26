/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

// -- raw grammar typings

export interface ILocation {
	filename: string;
	line: number;
	char: number;
}

export interface ILocatable {
	$vscodeTextmateLocation?:ILocation;
}

export interface IRawGrammar extends ILocatable {
	repository: IRawRepository;
	scopeName: string;
	patterns: IRawRule[];
	injections?: { [expression:string]: IRawRule };
	injectionSelector?: string;

	fileTypes?: string[];
	name?: string;
	firstLineMatch?: string;
}

export interface IRawRepository extends ILocatable {
	[name:string]: IRawRule;
	$self: IRawRule;
	$base: IRawRule;
}

export interface IRawRule extends ILocatable {
	id?: number;

	include?: string;

	name?: string;
	contentName?: string;

	match?:string;
	captures?: IRawCaptures;
	begin?:string;
	beginCaptures?: IRawCaptures;
	end?:string;
	endCaptures?: IRawCaptures;
	while?:string;
	whileCaptures?: IRawCaptures;
	patterns?: IRawRule[];

	repository?: IRawRepository;

	applyEndPatternLast?:boolean;
}

export interface IRawCaptures extends ILocatable {
	[captureId:string]: IRawRule;
}
