const mysql = require('mysql2');
require('dotenv').config();

const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal'
});

async function checkVendorStructure() {
  try {
    console.log('Checking vendor table structure...');
    
    const [columns] = await db.promise().query('DESCRIBE vendors');
    console.log('Vendor table columns:');
    columns.forEach(col => {
      console.log(`  ${col.Field} - ${col.Type} - ${col.Null} - ${col.Key} - ${col.Default}`);
    });
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    db.end();
  }
}

checkVendorStructure();
