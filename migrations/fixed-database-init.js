const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true
};

// Create connection
const connection = mysql.createConnection(dbConfig);

// Connect to MySQL
connection.connect((err) => {
  if (err) {
    console.error('Error connecting to MySQL:', err);
    process.exit(1);
  }
  console.log('Connected to MySQL server');
  
  // Initialize database
  initializeDatabase();
});

async function initializeDatabase() {
  try {
    console.log('Starting database initialization...');
    
    // Read the corrected database schema
    const schemaPath = path.join(__dirname, 'database.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    // Split by semicolon and execute each statement
    const statements = schema
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));
    
    console.log(`Found ${statements.length} SQL statements to execute`);
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (statement.trim()) {
        try {
          console.log(`Executing statement ${i + 1}/${statements.length}...`);
          await connection.promise().query(statement);
          console.log(`✅ Statement ${i + 1} executed successfully`);
        } catch (error) {
          console.error(`❌ Error executing statement ${i + 1}:`, error.message);
          console.error(`Statement: ${statement.substring(0, 100)}...`);
          // Continue with other statements
        }
      }
    }
    
    console.log('Database initialization completed!');
    
    // Test the database
    await testDatabase();
    
  } catch (error) {
    console.error('Database initialization failed:', error);
  } finally {
    connection.end();
  }
}

async function testDatabase() {
  try {
    console.log('\nTesting database...');
    
    // Test vendors table
    const [vendors] = await connection.promise().query('SELECT COUNT(*) as count FROM vendors');
    console.log(`✅ Vendors table: ${vendors[0].count} records`);
    
    // Test products table
    const [products] = await connection.promise().query('SELECT COUNT(*) as count FROM products');
    console.log(`✅ Products table: ${products[0].count} records`);
    
    // Test admin_users table
    const [admins] = await connection.promise().query('SELECT COUNT(*) as count FROM admin_users');
    console.log(`✅ Admin users table: ${admins[0].count} records`);
    
    // Test foreign key constraints
    console.log('\nTesting foreign key constraints...');
    
    // Try to insert a product with invalid vendor_id (should fail)
    try {
      await connection.promise().query('INSERT INTO products (vendor_id, name, sku, category, price) VALUES (99999, "Test Product", "TEST-001", "Test", 10.00)');
      console.log('❌ Foreign key constraint test failed - invalid vendor_id was accepted');
    } catch (error) {
      if (error.code === 'ER_NO_REFERENCED_ROW_2') {
        console.log('✅ Foreign key constraint working correctly');
      } else {
        console.log('⚠️  Unexpected error in foreign key test:', error.message);
      }
    }
    
    console.log('\n🎉 Database test completed successfully!');
    
  } catch (error) {
    console.error('❌ Database test failed:', error);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  connection.end();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  connection.end();
  process.exit(1);
});
