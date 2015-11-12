/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

// -- raw grammar typings

export interface IRawGrammar {
	repository: IRawRepository;
	scopeName: string;
	patterns: IRawRule[];
	injections?: { [expression:string]: IRawRule };

	fileTypes?: string[];
	name?: string;
	firstLineMatch?: string;
}

export interface IRawRepository {
	[name:string]: IRawRule;
	$self: IRawRule;
	$base: IRawRule;
}

export interface IRawRule {
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
	patterns?: IRawRule[];

	repository?: IRawRepository;

	applyEndPatternLast?:boolean;
}

export interface IRawCaptures {
	[captureId:string]: IRawRule;
}
