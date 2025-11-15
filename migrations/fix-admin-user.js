const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal'
});

async function fixAdminUser() {
  try {
    console.log('🔧 Checking and fixing admin user...');
    
    // Check if admin user exists
    const [existingAdmin] = await db.promise().query(`
      SELECT id, username, role FROM admin_users WHERE id = 1
    `);
    
    if (existingAdmin.length > 0) {
      console.log('✅ Admin user already exists:');
      console.log(`   ID: ${existingAdmin[0].id}`);
      console.log(`   Username: ${existingAdmin[0].username}`);
      console.log(`   Role: ${existingAdmin[0].role}`);
    } else {
      console.log('❌ Admin user with ID 1 not found. Creating...');
      
      // Hash password
      const hashedPassword = await bcrypt.hash('admin123', 10);
      
      // Create admin user
      await db.promise().query(`
        INSERT INTO admin_users (id, username, email, password, role) 
        VALUES (1, 'admin', 'admin@vendorportal.com', ?, 'admin')
        ON DUPLICATE KEY UPDATE 
          username = VALUES(username),
          email = VALUES(email),
          role = VALUES(role)
      `, [hashedPassword]);
      
      console.log('✅ Admin user created successfully');
      console.log('   Username: admin');
      console.log('   Password: admin123');
      console.log('   Role: admin');
    }
    
    // Check if vendor exists for testing
    const [existingVendor] = await db.promise().query(`
      SELECT id, business_name FROM vendors WHERE id = 1
    `);
    
    if (existingVendor.length > 0) {
      console.log('✅ Test vendor exists:');
      console.log(`   ID: ${existingVendor[0].id}`);
      console.log(`   Business Name: ${existingVendor[0].business_name}`);
    } else {
      console.log('❌ Test vendor with ID 1 not found. Creating...');
      
      // Create test vendor
      const hashedVendorPassword = await bcrypt.hash('vendor123', 10);
      
      await db.promise().query(`
        INSERT INTO vendors (id, business_name, owner_name, owner_email, owner_phone, address, password, status) 
        VALUES (1, 'Test Vendor', 'Test Owner', 'vendor@test.com', '1234567890', 'Test Address', ?, 'approved')
        ON DUPLICATE KEY UPDATE 
          business_name = VALUES(business_name),
          status = VALUES(status)
      `, [hashedVendorPassword]);
      
      console.log('✅ Test vendor created successfully');
      console.log('   Business Name: Test Vendor');
      console.log('   Email: vendor@test.com');
      console.log('   Password: vendor123');
    }
    
    // Initialize wallet balance for vendor
    await db.promise().query(`
      INSERT INTO vendor_wallet_balances (vendor_id, available_balance, total_earnings) 
      VALUES (1, 5000.00, 10000.00)
      ON DUPLICATE KEY UPDATE 
        available_balance = GREATEST(available_balance, 5000.00),
        total_earnings = GREATEST(total_earnings, 10000.00)
    `);
    
    console.log('✅ Vendor wallet balance initialized');
    
  } catch (error) {
    console.error('❌ Error fixing admin user:', error);
  } finally {
    db.end();
  }
}

if (require.main === module) {
  fixAdminUser();
}

module.exports = fixAdminUser;
