const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Database connection
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'vendor_portal'
});

const JWT_SECRET = 'your-secret-key';

async function testVendorAuth() {
  try {
    console.log('Testing vendor authentication...\n');

    // Check vendors table
    const [vendors] = await db.promise().query('SELECT * FROM vendors LIMIT 5');
    console.log('Vendors in database:', vendors.length);
    if (vendors.length > 0) {
      console.log('Sample vendor:', {
        id: vendors[0].id,
        business_name: vendors[0].business_name,
        shop_name: vendors[0].shop_name,
        owner_name: vendors[0].owner_name,
        owner_email: vendors[0].owner_email,
        has_password: !!vendors[0].password,
        status: vendors[0].status,
        user_id: vendors[0].user_id
      });
    }

    // Check users table
    const [users] = await db.promise().query('SELECT * FROM users WHERE role = "vendor" LIMIT 5');
    console.log('\nUsers with vendor role:', users.length);
    if (users.length > 0) {
      console.log('Sample vendor user:', {
        id: users[0].id,
        email: users[0].email,
        has_password: !!users[0].password,
        role: users[0].role
      });
    }

    // Test registration
    console.log('\n--- Testing Registration ---');
    const testEmail = 'testvendor@example.com';
    const testPassword = 'password123';
    
    // Check if vendor already exists
    const [existingVendor] = await db.promise().query(
      'SELECT id FROM vendors WHERE owner_email = ?',
      [testEmail]
    );
    
    if (existingVendor.length > 0) {
      console.log('Vendor already exists, testing login...');
      
      // Test login
      const [vendorRows] = await db.promise().query(
        'SELECT * FROM vendors WHERE owner_email = ?',
        [testEmail]
      );
      
      if (vendorRows.length > 0) {
        const vendor = vendorRows[0];
        console.log('Found vendor:', {
          id: vendor.id,
          owner_email: vendor.owner_email,
          has_password: !!vendor.password,
          status: vendor.status
        });
        
        // Check if password is in users table
        if (vendor.user_id) {
          const [userRows] = await db.promise().query(
            'SELECT password FROM users WHERE id = ?',
            [vendor.user_id]
          );
          if (userRows.length > 0) {
            console.log('Password found in users table');
            const isValidPassword = await bcrypt.compare(testPassword, userRows[0].password);
            console.log('Password valid:', isValidPassword);
          }
        } else if (vendor.password) {
          console.log('Password found in vendors table');
          const isValidPassword = await bcrypt.compare(testPassword, vendor.password);
          console.log('Password valid:', isValidPassword);
        } else {
          console.log('No password found for vendor');
        }
      }
    } else {
      console.log('No existing vendor found, would need to register');
    }

  } catch (error) {
    console.error('Error testing vendor auth:', error);
  } finally {
    db.end();
  }
}

testVendorAuth();
