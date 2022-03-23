const fs = require('fs');
const path = require('path');

const OUT_FOLDER = path.join(__dirname, '../out');
const RELEASE_FOLDER = path.join(__dirname, '../release');
``
if (!fs.existsSync(RELEASE_FOLDER)) {
	fs.mkdirSync(RELEASE_FOLDER);
}

fs.writeFileSync(path.join(RELEASE_FOLDER, 'main.d.ts'), fs.readFileSync(path.join(OUT_FOLDER, 'main.d.ts')));
fs.writeFileSync(path.join(RELEASE_FOLDER, 'types.d.ts'), fs.readFileSync(path.join(OUT_FOLDER, 'types.d.ts')));
