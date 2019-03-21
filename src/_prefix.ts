/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
'use strict';

interface IModule {
	exports: any;
}

interface IModuleMap {
	[path: string]: IModule;
}

interface IFactoryFunc {
	(require: IFactoryRequireFunc, exports: any, module: IModule): void;
}

interface IFactoryRequireFunc {
	(name: string): any;
}

let $map: IModuleMap = {};

declare var define: any;

function $load(name: string, factory: IFactoryFunc) {
	if (typeof define === 'function' && define.amd) {
		if (name === './main') {
			define(['require', 'exports'], factory);
		} else {
			define(name, ['require', 'exports'], factory);
		}
	} else {
		let mod: IModule = {
			exports: {}
		};

		let requireFunc: IFactoryRequireFunc = (mod) => {
			if ($map[mod]) {
				return $map[mod].exports;
			}
			return require(mod);
		};

		factory.call(this, requireFunc, mod, mod.exports);

		$map[name] = mod;
	}
}
