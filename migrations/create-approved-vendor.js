// Script to create an approved vendor for testing
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

async function createApprovedVendor() {
  let connection;
  
  try {
    // Database connection
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'vendor_portal'
    });

    console.log('Creating approved vendor for testing...');

    // Check if vendor already exists
    const [existing] = await connection.execute(
      'SELECT id FROM vendors WHERE owner_email = ?',
      ['test@example.com']
    );

    if (existing.length > 0) {
      console.log('Vendor already exists, updating status to approved...');
      await connection.execute(
        'UPDATE vendors SET status = ? WHERE owner_email = ?',
        ['approved', 'test@example.com']
      );
      console.log('✅ Vendor status updated to approved');
    } else {
      // Create new vendor
      const passwordHash = await bcrypt.hash('testpassword123', 10);
      
      const [result] = await connection.execute(
        'INSERT INTO vendors (business_name, owner_name, owner_email, owner_phone, address, city, password, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['Test Shop', 'Test Owner', 'test@example.com', '1234567890', '123 Test Street, Test City', 'Test City', passwordHash, 'approved']
      );
      
      console.log('✅ Vendor created with ID:', result.insertId);
    }

    // Also create a demo vendor
    const [demoExisting] = await connection.execute(
      'SELECT id FROM vendors WHERE owner_email = ?',
      ['vendor@example.com']
    );

    if (demoExisting.length > 0) {
      console.log('Demo vendor already exists, updating status to approved...');
      await connection.execute(
        'UPDATE vendors SET status = ? WHERE owner_email = ?',
        ['approved', 'vendor@example.com']
      );
      console.log('✅ Demo vendor status updated to approved');
    } else {
      const passwordHash = await bcrypt.hash('password', 10);
      
      const [result] = await connection.execute(
        'INSERT INTO vendors (business_name, owner_name, owner_email, owner_phone, address, city, password, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['Demo Shop', 'Demo Owner', 'vendor@example.com', '9876543210', '456 Demo Street, Demo City', 'Demo City', passwordHash, 'approved']
      );
      
      console.log('✅ Demo vendor created with ID:', result.insertId);
    }

    console.log('\n=== Test Credentials ===');
    console.log('Email: test@example.com');
    console.log('Password: testpassword123');
    console.log('Status: approved');
    console.log('\nDemo Credentials:');
    console.log('Email: vendor@example.com');
    console.log('Password: password');
    console.log('Status: approved');

  } catch (error) {
    console.error('Error creating vendor:', error);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

createApprovedVendor();
