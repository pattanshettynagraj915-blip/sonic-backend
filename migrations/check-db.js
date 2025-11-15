const mysql = require('mysql2');

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal'
});

async function checkDatabase() {
  try {
    console.log('Connecting to database...');
    
    // Check if database exists
    const databases = await db.promise().query('SHOW DATABASES');
    console.log('Available databases:', databases[0].map(db => db.Database));
    
    // Check if we're connected to the right database
    const currentDb = await db.promise().query('SELECT DATABASE() as current_db');
    console.log('Current database:', currentDb[0][0].current_db);
    
    // Check tables in current database
    const tables = await db.promise().query('SHOW TABLES');
    console.log('Tables in current database:', tables[0].map(table => Object.values(table)[0]));
    
    // Check vendors table structure
    if (tables[0].length > 0) {
      const vendorsStructure = await db.promise().query('DESCRIBE vendors');
      console.log('Vendors table structure:');
      vendorsStructure[0].forEach(column => {
        console.log(`- ${column.Field}: ${column.Type}`);
      });
    }
    
  } catch (error) {
    console.error('Database check error:', error);
  } finally {
    db.end();
  }
}

checkDatabase();
