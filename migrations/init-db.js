const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true
});

async function initializeDatabase() {
  try {
    console.log('Connecting to MySQL...');
    
    // Read the SQL file
    const sqlFile = fs.readFileSync(path.join(__dirname, 'database.sql'), 'utf8');
    
    // Execute the SQL
    console.log('Creating database and tables...');
    await db.promise().query(sqlFile);
    
    console.log('Database initialized successfully!');
    console.log('Tables created:');
    console.log('- vendors');
    console.log('- kyc_documents');
    console.log('- admin_users');
    console.log('- vendor_docs');
    console.log('- vendor_products');
    console.log('- audit_log');
    console.log('- vendor_summary view');
    console.log('- GetVendorStatistics procedure');
    
  } catch (error) {
    console.error('Database initialization error:', error);
  } finally {
    db.end();
  }
}

initializeDatabase();
