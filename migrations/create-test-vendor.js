const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

// Database connection
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'vendor_portal'
};

async function createTestVendor() {
  let db;
  try {
    db = await mysql.createConnection(dbConfig);
    console.log('✅ Database connected');
    
    // Check if test vendor already exists
    const [existingVendors] = await db.execute(
      'SELECT * FROM vendors WHERE owner_email = ?',
      ['testvendor@example.com']
    );
    
    if (existingVendors.length > 0) {
      console.log('✅ Test vendor already exists');
      console.log('Email: testvendor@example.com');
      console.log('Password: TestPassword123!');
      console.log('Status:', existingVendors[0].status);
      return;
    }
    
    // Create test vendor
    const hashedPassword = await bcrypt.hash('TestPassword123!', 10);
    
    const [result] = await db.execute(`
      INSERT INTO vendors (
        business_name, shop_name, owner_name, owner_email, 
        owner_phone, address, password, status, 
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [
      'Test Vendor Business',
      'Test Shop',
      'Test Owner',
      'testvendor@example.com',
      '1234567890',
      '123 Test Street, Test City',
      hashedPassword,
      'approved'
    ]);
    
    console.log('✅ Test vendor created successfully');
    console.log('Email: testvendor@example.com');
    console.log('Password: TestPassword123!');
    console.log('Status: approved');
    console.log('Vendor ID:', result.insertId);
    
  } catch (error) {
    console.error('❌ Error creating test vendor:', error.message);
  } finally {
    if (db) await db.end();
  }
}

createTestVendor();
