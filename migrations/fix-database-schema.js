const mysql = require('mysql2');
require('dotenv').config();

const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal'
});

async function fixDatabaseSchema() {
  try {
    console.log('🔧 Fixing database schema issues...\n');

    // 1. Fix payout_audit_logs table - add missing columns
    console.log('1. Fixing payout_audit_logs table...');
    try {
      await db.promise().query(`
        ALTER TABLE payout_audit_logs 
        ADD COLUMN IF NOT EXISTS performed_by_type ENUM('system', 'admin', 'vendor') DEFAULT 'system' AFTER performed_by
      `);
      console.log('✅ Added performed_by_type column to payout_audit_logs');
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME') {
        console.log('⚠️ payout_audit_logs column may already exist:', error.message);
      }
    }

    // 2. Fix payout_notifications table - ensure created_at column exists
    console.log('2. Fixing payout_notifications table...');
    try {
      // Check if table exists and has correct structure
      const [columns] = await db.promise().query(`
        SHOW COLUMNS FROM payout_notifications LIKE 'created_at'
      `);
      
      if (columns.length === 0) {
        await db.promise().query(`
          ALTER TABLE payout_notifications 
          ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER message
        `);
        console.log('✅ Added created_at column to payout_notifications');
      } else {
        console.log('✅ payout_notifications.created_at already exists');
      }
    } catch (error) {
      console.log('⚠️ payout_notifications issue:', error.message);
    }

    // 3. Verify all required columns exist
    console.log('3. Verifying table structures...');
    
    const requiredColumns = {
      'payout_audit_logs': ['id', 'payout_id', 'action', 'performed_by', 'performed_by_type', 'created_at'],
      'payout_notifications': ['id', 'vendor_id', 'notification_type', 'title', 'message', 'is_read', 'created_at', 'read_at'],
      'vendor_payouts': ['id', 'vendor_id', 'requested_amount', 'status', 'created_at'],
      'vendor_payment_methods': ['id', 'vendor_id', 'method_type', 'verification_status']
    };

    for (const [tableName, columns] of Object.entries(requiredColumns)) {
      try {
        const [tableColumns] = await db.promise().query(`DESCRIBE ${tableName}`);
        const existingColumns = tableColumns.map(col => col.Field);
        
        console.log(`✅ ${tableName}: ${existingColumns.length} columns`);
        
        const missingColumns = columns.filter(col => !existingColumns.includes(col));
        if (missingColumns.length > 0) {
          console.log(`⚠️ ${tableName} missing columns:`, missingColumns);
        }
      } catch (error) {
        console.log(`❌ ${tableName} table issue:`, error.message);
      }
    }

    // 4. Add sample data for testing
    console.log('4. Adding sample data...');
    
    // Ensure vendor exists
    await db.promise().query(`
      INSERT IGNORE INTO vendors (id, business_name, owner_name, owner_email, owner_phone, address, status) 
      VALUES (1, 'Test Vendor', 'Test Owner', 'vendor@test.com', '1234567890', 'Test Address', 'approved')
    `);

    // Ensure admin exists
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await db.promise().query(`
      INSERT IGNORE INTO admin_users (id, username, email, password, role) 
      VALUES (1, 'admin', 'admin@test.com', ?, 'admin')
    `, [hashedPassword]);

    // Initialize wallet balance
    await db.promise().query(`
      INSERT INTO vendor_wallet_balances (vendor_id, available_balance, total_earnings) 
      VALUES (1, 5000.00, 10000.00)
      ON DUPLICATE KEY UPDATE 
        available_balance = GREATEST(available_balance, 5000.00),
        total_earnings = GREATEST(total_earnings, 10000.00)
    `);

    console.log('✅ Sample data added');

    // 5. Test critical queries
    console.log('5. Testing critical queries...');
    
    try {
      const [stats] = await db.promise().query(`
        SELECT COUNT(*) as total_requests FROM vendor_payouts
      `);
      console.log(`✅ vendor_payouts query works: ${stats[0].total_requests} records`);
    } catch (error) {
      console.log('❌ vendor_payouts query failed:', error.message);
    }

    try {
      const [notifications] = await db.promise().query(`
        SELECT COUNT(*) as total FROM payout_notifications
      `);
      console.log(`✅ payout_notifications query works: ${notifications[0].total} records`);
    } catch (error) {
      console.log('❌ payout_notifications query failed:', error.message);
    }

    console.log('\n🎉 Database schema fixes completed!');

  } catch (error) {
    console.error('❌ Error fixing database schema:', error);
  } finally {
    db.end();
  }
}

if (require.main === module) {
  fixDatabaseSchema();
}

module.exports = fixDatabaseSchema;
