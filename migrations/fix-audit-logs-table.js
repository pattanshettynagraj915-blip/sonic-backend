const mysql = require('mysql2');
require('dotenv').config();

const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal'
});

async function fixAuditLogsTable() {
  try {
    console.log('🔧 Fixing payout_audit_logs table structure...\n');

    // Check current structure
    const [columns] = await db.promise().query('DESCRIBE payout_audit_logs');
    console.log('Current columns:', columns.map(c => c.Field));

    const existingColumns = columns.map(c => c.Field);

    // Add missing columns one by one
    if (!existingColumns.includes('performed_by')) {
      try {
        await db.promise().query(`
          ALTER TABLE payout_audit_logs 
          ADD COLUMN performed_by INT NULL AFTER action
        `);
        console.log('✅ Added performed_by column');
      } catch (error) {
        console.log('⚠️ performed_by column issue:', error.message);
      }
    }

    if (!existingColumns.includes('performed_by_type')) {
      try {
        await db.promise().query(`
          ALTER TABLE payout_audit_logs 
          ADD COLUMN performed_by_type ENUM('system', 'admin', 'vendor') DEFAULT 'system' AFTER performed_by
        `);
        console.log('✅ Added performed_by_type column');
      } catch (error) {
        console.log('⚠️ performed_by_type column issue:', error.message);
      }
    }

    if (!existingColumns.includes('notes')) {
      try {
        await db.promise().query(`
          ALTER TABLE payout_audit_logs 
          ADD COLUMN notes TEXT NULL AFTER performed_by_type
        `);
        console.log('✅ Added notes column');
      } catch (error) {
        console.log('⚠️ notes column issue:', error.message);
      }
    }

    if (!existingColumns.includes('ip_address')) {
      try {
        await db.promise().query(`
          ALTER TABLE payout_audit_logs 
          ADD COLUMN ip_address VARCHAR(45) NULL AFTER notes
        `);
        console.log('✅ Added ip_address column');
      } catch (error) {
        console.log('⚠️ ip_address column issue:', error.message);
      }
    }

    if (!existingColumns.includes('user_agent')) {
      try {
        await db.promise().query(`
          ALTER TABLE payout_audit_logs 
          ADD COLUMN user_agent TEXT NULL AFTER ip_address
        `);
        console.log('✅ Added user_agent column');
      } catch (error) {
        console.log('⚠️ user_agent column issue:', error.message);
      }
    }

    // Verify final structure
    const [finalColumns] = await db.promise().query('DESCRIBE payout_audit_logs');
    console.log('\nFinal table structure:');
    finalColumns.forEach(col => {
      console.log(`  ${col.Field} - ${col.Type} - ${col.Null} - ${col.Default || 'NULL'}`);
    });

    // Test the problematic query
    console.log('\nTesting the admin dashboard query...');
    try {
      const [testResult] = await db.promise().query(`
        SELECT 
          pal.action, pal.created_at, au.username,
          vp.id as payout_id, vp.requested_amount, v.business_name
        FROM payout_audit_logs pal
        LEFT JOIN vendor_payouts vp ON pal.payout_id = vp.id
        LEFT JOIN vendors v ON vp.vendor_id = v.id
        LEFT JOIN admin_users au ON pal.performed_by = au.id
        WHERE pal.performed_by_type = 'admin'
        ORDER BY pal.created_at DESC
        LIMIT 10
      `);
      console.log('✅ Admin dashboard query works! Found', testResult.length, 'records');
    } catch (error) {
      console.log('❌ Admin dashboard query still failing:', error.message);
    }

    console.log('\n🎉 Audit logs table fix completed!');

  } catch (error) {
    console.error('❌ Error fixing audit logs table:', error);
  } finally {
    db.end();
  }
}

if (require.main === module) {
  fixAuditLogsTable();
}

module.exports = fixAuditLogsTable;
