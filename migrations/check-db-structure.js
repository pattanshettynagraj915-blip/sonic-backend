const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal'
};

async function checkDatabaseStructure() {
  let connection;
  
  try {
    console.log('🔍 Checking database structure...');
    
    // Create connection
    connection = await mysql.createConnection(dbConfig);
    console.log('✅ Connected to MySQL database');

    // Check orders table structure
    console.log('\n📋 Orders table structure:');
    const [ordersColumns] = await connection.execute(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders'
      ORDER BY ORDINAL_POSITION
    `, [dbConfig.database]);

    if (ordersColumns.length === 0) {
      console.log('❌ Orders table does not exist!');
      return;
    }

    ordersColumns.forEach(col => {
      console.log(`  - ${col.COLUMN_NAME}: ${col.DATA_TYPE} ${col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'} ${col.COLUMN_DEFAULT ? `DEFAULT ${col.COLUMN_DEFAULT}` : ''} ${col.EXTRA || ''}`);
    });

    // Check order_items table structure
    console.log('\n📋 Order_items table structure:');
    const [itemsColumns] = await connection.execute(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'order_items'
      ORDER BY ORDINAL_POSITION
    `, [dbConfig.database]);

    if (itemsColumns.length === 0) {
      console.log('❌ Order_items table does not exist!');
    } else {
      itemsColumns.forEach(col => {
        console.log(`  - ${col.COLUMN_NAME}: ${col.DATA_TYPE} ${col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'} ${col.COLUMN_DEFAULT ? `DEFAULT ${col.COLUMN_DEFAULT}` : ''} ${col.EXTRA || ''}`);
      });
    }

    // Check other order management tables
    const tables = ['order_status_history', 'order_notifications'];
    for (const tableName of tables) {
      console.log(`\n📋 ${tableName} table:`);
      const [tableExists] = await connection.execute(`
        SELECT COUNT(*) as count
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      `, [dbConfig.database, tableName]);

      if (tableExists[0].count > 0) {
        console.log('✅ Table exists');
        const [columns] = await connection.execute(`
          SELECT COLUMN_NAME, DATA_TYPE
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION
        `, [dbConfig.database, tableName]);
        
        columns.forEach(col => {
          console.log(`  - ${col.COLUMN_NAME}: ${col.DATA_TYPE}`);
        });
      } else {
        console.log('❌ Table does not exist');
      }
    }

    // Check sample data
    console.log('\n📊 Sample data check:');
    try {
      const [orderCount] = await connection.execute('SELECT COUNT(*) as count FROM orders');
      console.log(`✅ Orders table has ${orderCount[0].count} records`);
      
      if (orderCount[0].count > 0) {
        const [sampleOrder] = await connection.execute('SELECT * FROM orders LIMIT 1');
        console.log('📝 Sample order columns:', Object.keys(sampleOrder[0]));
      }
    } catch (error) {
      console.log('❌ Error checking sample data:', error.message);
    }

  } catch (error) {
    console.error('❌ Error checking database structure:', error);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

// Run the check
if (require.main === module) {
  checkDatabaseStructure();
}

module.exports = checkDatabaseStructure;
