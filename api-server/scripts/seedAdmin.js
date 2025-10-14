// scripts/seedAdmin.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../models/db');

(async () => {
  const email = process.argv[2] || 'admin@kiosk.com';
  const name = process.argv[3] || 'Admin';
  const password = process.argv[4] || 'StrongPass!123';

  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES (?, ?, ?, 'admin')
       ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), name=VALUES(name)`,
      [email, hash, name]
    );
    console.log(`✅ Admin ready: ${email} / ${password}`);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
