/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

const path = require('path');
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
	entry: './out/main.js',
	mode: 'production',
	// mode: 'development',
	output: {
		library: 'vscodetextmate',
		libraryTarget: 'umd',
		globalObject: 'this',
		path: path.resolve(__dirname, 'release')
	},
	devtool: 'source-map',
	resolve: {
		extensions: ['.js']
	},
	plugins: [
		new CopyPlugin({
			patterns: [
				{ context: './out', from: '**/*.d.ts', to: '.' },
			],
		}),
	],
};
