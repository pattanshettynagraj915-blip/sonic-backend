const mysql = require('mysql2');
require('dotenv').config();

const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal'
});

async function checkMissingComponents() {
  console.log('🔍 Checking for missing payout system components...\n');
  
  const requiredTables = [
    'vendor_payment_methods',
    'vendor_payouts', 
    'vendor_wallet_transactions',
    'vendor_wallet_balances',
    'payout_configurations',
    'payout_audit_logs',
    'payout_notifications',
    'bank_reconciliation'
  ];
  
  const missingTables = [];
  const existingTables = [];
  
  try {
    // Check each required table
    for (const table of requiredTables) {
      try {
        const [result] = await db.promise().query(`SHOW TABLES LIKE '${table}'`);
        if (result.length > 0) {
          existingTables.push(table);
          console.log(`✅ ${table} - EXISTS`);
        } else {
          missingTables.push(table);
          console.log(`❌ ${table} - MISSING`);
        }
      } catch (error) {
        missingTables.push(table);
        console.log(`❌ ${table} - ERROR: ${error.message}`);
      }
    }
    
    console.log(`\n📊 Summary:`);
    console.log(`✅ Existing tables: ${existingTables.length}`);
    console.log(`❌ Missing tables: ${missingTables.length}`);
    
    if (missingTables.length > 0) {
      console.log(`\n🔧 Missing tables that need to be created:`);
      missingTables.forEach(table => console.log(`   - ${table}`));
    }
    
    // Check if comprehensive payout tables exist vs old payout table
    const [oldPayouts] = await db.promise().query(`SHOW TABLES LIKE 'payouts'`);
    const [newPayouts] = await db.promise().query(`SHOW TABLES LIKE 'vendor_payouts'`);
    
    console.log(`\n🔄 Payout Table Status:`);
    console.log(`   Old 'payouts' table: ${oldPayouts.length > 0 ? 'EXISTS' : 'MISSING'}`);
    console.log(`   New 'vendor_payouts' table: ${newPayouts.length > 0 ? 'EXISTS' : 'MISSING'}`);
    
    if (oldPayouts.length > 0 && newPayouts.length === 0) {
      console.log(`\n⚠️ WARNING: Old payout table exists but new comprehensive table is missing!`);
      console.log(`   Need to run: node init-comprehensive-payouts.js`);
    }
    
    // Check for required views
    const requiredViews = ['vendor_payout_summary', 'admin_payout_queue'];
    console.log(`\n👁️ Checking Views:`);
    
    for (const view of requiredViews) {
      try {
        const [result] = await db.promise().query(`SHOW FULL TABLES WHERE Table_type = 'VIEW' AND Tables_in_vendor_portal = '${view}'`);
        if (result.length > 0) {
          console.log(`✅ ${view} - EXISTS`);
        } else {
          console.log(`❌ ${view} - MISSING`);
        }
      } catch (error) {
        console.log(`❌ ${view} - ERROR: ${error.message}`);
      }
    }
    
    // Check for sample data
    if (existingTables.includes('vendor_wallet_balances')) {
      const [balances] = await db.promise().query(`SELECT COUNT(*) as count FROM vendor_wallet_balances`);
      console.log(`\n💰 Wallet Balances: ${balances[0].count} records`);
    }
    
    if (existingTables.includes('payout_configurations')) {
      const [configs] = await db.promise().query(`SELECT COUNT(*) as count FROM payout_configurations`);
      console.log(`⚙️ Payout Configurations: ${configs[0].count} records`);
      
      if (configs[0].count === 0) {
        console.log(`⚠️ WARNING: No payout configuration found! System won't work properly.`);
      }
    }
    
    // Check if routes are properly loaded
    console.log(`\n🛣️ Checking Route Files:`);
    const fs = require('fs');
    const routeFiles = [
      'routes/payouts.js',
      'routes/admin-payouts.js'
    ];
    
    for (const file of routeFiles) {
      if (fs.existsSync(file)) {
        console.log(`✅ ${file} - EXISTS`);
      } else {
        console.log(`❌ ${file} - MISSING`);
      }
    }
    
    // Check if utility files exist
    console.log(`\n🔧 Checking Utility Files:`);
    const utilFiles = [
      'utils/payoutSecurity.js',
      'utils/payoutNotifications.js'
    ];
    
    for (const file of utilFiles) {
      if (fs.existsSync(file)) {
        console.log(`✅ ${file} - EXISTS`);
      } else {
        console.log(`❌ ${file} - MISSING`);
      }
    }
    
    return {
      missingTables,
      existingTables,
      needsInitialization: missingTables.length > 0
    };
    
  } catch (error) {
    console.error('❌ Error checking components:', error);
    return { error: error.message };
  } finally {
    db.end();
  }
}

// Run the check
if (require.main === module) {
  checkMissingComponents().then(result => {
    if (result.needsInitialization) {
      console.log(`\n🚀 RECOMMENDED ACTIONS:`);
      console.log(`1. Run: node init-comprehensive-payouts.js`);
      console.log(`2. Restart the server`);
      console.log(`3. Run tests again: node ../test-payout-system.js`);
    } else if (!result.error) {
      console.log(`\n🎉 All components are present!`);
    }
  }).catch(console.error);
}

module.exports = checkMissingComponents;
