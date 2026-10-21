// Concatenates src/*.js (in name order) into the userscript. Keeps the @version
// in src/00-header.js as the single source of truth and mirrors it into the
// D0007.version field.
const fs = require('fs');
const path = require('path');
const srcDir = path.join(__dirname, 'src');
const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js')).sort();
let out = files.map(f => fs.readFileSync(path.join(srcDir, f), 'utf8').replace(/\s+$/, '') + '\n').join('\n');
const version = (out.match(/^\/\/ @version\s+(\S+)/m) || [])[1];
if (!version) throw new Error('no @version in src/00-header.js');
out = out.replace(/version: '[^']*'/, `version: '${version}'`);
fs.writeFileSync(path.join(__dirname, 'd0007-ops.user.js'), out);
console.log(`built d0007-ops.user.js v${version} from ${files.length} files (${out.length} chars)`);
