const mysql = require('mysql2');

const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'vendor_portal',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
}).promise();

async function verifySchema() {
  try {
    console.log('🔍 Verifying Database Schema...\n');
    console.log('='.repeat(60));
    
    // Get all columns from products table
    const [columns] = await db.query(`
      SELECT 
        COLUMN_NAME,
        DATA_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        COLUMN_KEY,
        EXTRA,
        COLUMN_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
      ORDER BY ORDINAL_POSITION
    `);
    
    console.log(`\n📋 Products Table Structure (${columns.length} columns):\n`);
    
    columns.forEach((col, index) => {
      const key = col.COLUMN_KEY ? `[${col.COLUMN_KEY}]` : '';
      const nullable = col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL';
      const defaultVal = col.COLUMN_DEFAULT ? ` DEFAULT ${col.COLUMN_DEFAULT}` : '';
      console.log(`${(index + 1).toString().padStart(2)}. ${col.COLUMN_NAME.padEnd(20)} ${col.COLUMN_TYPE.padEnd(25)} ${nullable.padEnd(10)} ${key}${defaultVal}`);
    });
    
    // Check indexes
    console.log('\n📊 Indexes:\n');
    const [indexes] = await db.query(`SHOW INDEXES FROM products`);
    const indexGroups = {};
    indexes.forEach(idx => {
      if (!indexGroups[idx.Key_name]) {
        indexGroups[idx.Key_name] = [];
      }
      indexGroups[idx.Key_name].push(idx.Column_name);
    });
    
    Object.entries(indexGroups).forEach(([name, cols]) => {
      console.log(`   ${name.padEnd(30)} (${cols.join(', ')})`);
    });
    
    // Check foreign keys
    console.log('\n🔗 Foreign Keys:\n');
    const [fks] = await db.query(`
      SELECT 
        CONSTRAINT_NAME,
        COLUMN_NAME,
        REFERENCED_TABLE_NAME,
        REFERENCED_COLUMN_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
      AND REFERENCED_TABLE_NAME IS NOT NULL
    `);
    
    if (fks.length > 0) {
      fks.forEach(fk => {
        console.log(`   ${fk.CONSTRAINT_NAME}: ${fk.COLUMN_NAME} -> ${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME}`);
      });
    } else {
      console.log('   No foreign keys found');
    }
    
    // Expected columns from database.sql
    const expectedColumns = [
      'id', 'product_id', 'vendor_id', 'name', 'description', 'sku', 'category',
      'price', 'mrp', 'cost_price', 'image_url', 'product_images', 'unit',
      'weight', 'dimensions', 'barcode', 'gst_slab', 'hsn_code', 'status',
      'created_at', 'updated_at'
    ];
    
    const actualColumns = columns.map(c => c.COLUMN_NAME.toLowerCase());
    const missing = expectedColumns.filter(col => !actualColumns.includes(col.toLowerCase()));
    const extra = actualColumns.filter(col => !expectedColumns.includes(col.toLowerCase()));
    
    console.log('\n' + '='.repeat(60));
    console.log('\n✅ VERIFICATION SUMMARY\n');
    console.log(`Total columns: ${columns.length}`);
    console.log(`Expected columns: ${expectedColumns.length}`);
    console.log(`Missing columns: ${missing.length}`);
    console.log(`Extra columns: ${extra.length}`);
    
    if (missing.length > 0) {
      console.log(`\n❌ Missing columns: ${missing.join(', ')}`);
    }
    
    if (extra.length > 0) {
      console.log(`\nℹ️  Extra columns: ${extra.join(', ')}`);
    }
    
    if (missing.length === 0 && extra.length === 0) {
      console.log('\n✅ Schema matches database.sql perfectly!');
    }
    
    // Test insert/read
    console.log('\n🧪 Testing Insert/Read...\n');
    const [vendors] = await db.query('SELECT id FROM vendors LIMIT 1');
    
    if (vendors.length > 0) {
      const testData = {
        product_id: 'PRDTTEST',
        vendor_id: vendors[0].id,
        name: 'Schema Test Product',
        description: 'Testing schema',
        sku: `TEST-${Date.now()}`,
        category: 'Test',
        price: 100.00,
        mrp: 120.00,
        cost_price: 80.00,
        image_url: 'https://example.com/test.jpg',
        product_images: JSON.stringify(['https://example.com/img1.jpg']),
        unit: 'piece',
        weight: 1.0,
        status: 'active'
      };
      
      const [result] = await db.query(`
        INSERT INTO products (
          product_id, vendor_id, name, description, sku, category,
          price, mrp, cost_price, image_url, product_images,
          unit, weight, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        testData.product_id, testData.vendor_id, testData.name,
        testData.description, testData.sku, testData.category,
        testData.price, testData.mrp, testData.cost_price,
        testData.image_url, testData.product_images,
        testData.unit, testData.weight, testData.status
      ]);
      
      const [read] = await db.query('SELECT * FROM products WHERE id = ?', [result.insertId]);
      console.log(`✅ Insert successful (ID: ${result.insertId})`);
      console.log(`✅ Read successful - All fields accessible`);
      console.log(`   - product_id: ${read[0].product_id}`);
      console.log(`   - cost_price: ${read[0].cost_price}`);
      console.log(`   - status: ${read[0].status}`);
      
      await db.query('DELETE FROM products WHERE id = ?', [result.insertId]);
      console.log(`✅ Cleanup successful`);
    }
    
    console.log('\n✅ Schema verification complete!');
    db.end();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Verification failed:', error.message);
    db.end();
    process.exit(1);
  }
}

verifySchema();

