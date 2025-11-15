const mysql = require('mysql2');

const connection = mysql.createConnection({
	host: process.env.DB_HOST || 'localhost',
	user: process.env.DB_USER || 'root',
	password: process.env.DB_PASSWORD || '',
	database: process.env.DB_NAME || 'vendor_portal'
});

async function dumpAllTables() {
	try {
		console.log('Connecting to database...');
		await connection.promise().connect();

		const [tables] = await connection.promise().query('SHOW TABLES');
		if (!tables.length) {
			console.log('No tables found.');
			return;
		}

		const dbName = process.env.DB_NAME || 'vendor_portal';
		const tableKey = `Tables_in_${dbName}`;

		for (const row of tables) {
			const tableName = row[tableKey] || Object.values(row)[0];
			console.log(`\n=== Table: ${tableName} ===`);
			try {
				const [rows] = await connection.promise().query(`SELECT * FROM \`${tableName}\``);
				console.log(JSON.stringify(rows, null, 2));
			} catch (err) {
				console.error(`Failed to query table ${tableName}:`, err.message);
			}
		}
	} catch (error) {
		console.error('Database dump error:', error.message);
	} finally {
		connection.end();
	}
}

dumpAllTables();
