/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

// -- raw grammar typings

export interface IRawGrammar {
	repository: IRawRepository;
	scopeName: string;
	patterns: IRawPattern[];

	fileTypes?: string[];
	name?: string;
	firstLineMatch?: string;
}

export interface IRawRepository {
	[name:string]: IRawRule;
	$self: IRawRule;
	$base: IRawRule;
}

export interface IRawPattern {
	include: string;
}

export interface IRawRule {
	id?: number;

	name?: string;
	contentName?: string;

	match?:string;
	captures?: IRawCaptures;
	begin?:string;
	beginCaptures?: IRawCaptures;
	end?:string;
	endCaptures?: IRawCaptures;
	patterns?: IRawPattern[];

	applyEndPatternLast?:boolean;
}

export interface IRawCaptures {
	[captureId:string]: IRawRule;
}
