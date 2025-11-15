const mysql = require('mysql2');
require('dotenv').config();

const db = mysql.createConnection({
	host: process.env.DB_HOST || 'localhost',
	user: process.env.DB_USER || 'root',
	password: process.env.DB_PASSWORD || '',
	database: process.env.DB_NAME || 'vendor_portal'
});

async function purgeSuperAdmins() {
	try {
		console.log('Scanning for super_admin users...');
		const [rows] = await db.promise().query(`SELECT id, username, email, role FROM admin_users WHERE role = 'super_admin'`);
		if (rows.length === 0) {
			console.log('No super_admin users found.');
			return;
		}
		console.log(`Found ${rows.length} super_admin user(s). Removing...`);
		const ids = rows.map(r => r.id);
		await db.promise().query(`DELETE FROM admin_users WHERE role = 'super_admin'`);
		console.log('Deleted users with IDs:', ids.join(','));
		// Ensure at least one admin user exists (id=1)
		await db.promise().query(`
			INSERT INTO admin_users (id, username, email, password, role)
			VALUES (1, 'admin', 'admin@vendorportal.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin')
			ON DUPLICATE KEY UPDATE role = 'admin'
		`);
		console.log('Ensured default admin exists (id=1).');
	} catch (e) {
		console.error('Error purging super_admin users:', e);
	} finally {
		db.end();
	}
}

if (require.main === module) purgeSuperAdmins();

module.exports = purgeSuperAdmins;


