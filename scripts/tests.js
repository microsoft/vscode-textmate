
var fs = require('fs');
var path = require('path');
var tests = require('../out/tests/tests');


exports.runTests = function() {
	tests.runTests([
		path.join(__dirname, '../test-cases/first-mate/tests.json'),
		path.join(__dirname, '../test-cases/suite1/tests.json')
	], [
		path.join(__dirname, '../test-cases/matcher/testData.json')
	]);
}

if (process.env['ATOM_SHELL_INTERNAL_RUN_AS_NODE']) {
	exports.runTests();
}
