const fs = require('fs');
const path = require('path');

const OUT_FOLDER = path.join(__dirname, '../out');
const RELEASE_FOLDER = path.join(__dirname, '../release');

if (!fs.existsSync(RELEASE_FOLDER)) {
	fs.mkdirSync(RELEASE_FOLDER);
}
