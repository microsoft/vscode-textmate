/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

interface IModule {
	exports: any;
}

interface IModuleMap {
	[path:string]: IModule;
}

// declare var require;

var $map:IModuleMap = {};

function $load(name, factory) {
	var mod: IModule = {
		exports: {}
	};

	factory.call(this, function(mod) {
		if ($map[mod]) {
			return $map[mod].exports;
		}
		return require(mod);
	}, mod, mod.exports);

	$map[name] = mod;
}