
var fs = require('fs');
var path = require('path');
var tests = require('../out/tests/tests');


exports.runTests = function() {
	var plistFixtures = fs.readdirSync(path.join(__dirname, '../test-cases/plist-parser'));
	// console.log(plistFixtures);

	tests.runTests([
		path.join(__dirname, '../test-cases/first-mate/tests.json'),
		path.join(__dirname, '../test-cases/suite1/tests.json')
	], [
		path.join(__dirname, '../test-cases/matcher/testData.json')
	], plistFixtures.map(function(p) {
		return path.join(__dirname, '../test-cases/plist-parser', p);
	}));
}

if (process.env['ATOM_SHELL_INTERNAL_RUN_AS_NODE']) {
	exports.runTests();
}
