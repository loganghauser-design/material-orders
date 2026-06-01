// Run: node scripts/gen-hash.js yourpassword
// Paste the output as ADMIN_PASSWORD_HASH in Railway env vars
const bcrypt = require('bcryptjs');
const pw = process.argv[2];
if (!pw) { console.error('Usage: node scripts/gen-hash.js <password>'); process.exit(1); }
bcrypt.hash(pw, 12).then(h => console.log(h));
