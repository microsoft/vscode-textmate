/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
///<amd-module name='debug'/>
'use strict';

export const CAPTURE_METADATA = typeof process !== 'undefined' ? !!process.env['VSCODE_TEXTMATE_DEBUG'] : false;
export const IN_DEBUG_MODE = typeof process !== 'undefined' ? !!process.env['VSCODE_TEXTMATE_DEBUG'] : false;
