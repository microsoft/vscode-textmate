var path = require('path');
var tests = require('./release/tests/tests');

tests.runMatcherTests(path.join(__dirname, './test-cases/matcher/testData.json'));