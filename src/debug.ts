/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

export const CAPTURE_METADATA = (typeof process !== 'undefined') && process.env['VSCODE_TEXTMATE_DEBUG'];
export const IN_DEBUG_MODE = (typeof process !== 'undefined') && process.env['VSCODE_TEXTMATE_DEBUG'];
