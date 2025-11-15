const mysql = require('mysql2');

// Try connection with empty password first (like server.js default)
let db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '', // Empty password for local MySQL (same as server.js)
  database: 'vendor_portal',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
}).promise();

async function testProductColumns() {
  try {
    console.log('🔍 Testing Products Table Columns...\n');
    console.log('='.repeat(60));
    
    // 1. Check if products table exists
    console.log('\n1. Checking if products table exists...');
    const [tables] = await db.query(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
    `);
    
    if (tables.length === 0) {
      console.log('❌ Products table does not exist!');
      process.exit(1);
    }
    console.log('✅ Products table exists');
    
    // 2. Get all columns from products table
    console.log('\n2. Fetching all columns from products table...');
    const [columns] = await db.query(`
      SELECT 
        COLUMN_NAME,
        DATA_TYPE,
        IS_NULLABLE,
        COLUMN_DEFAULT,
        COLUMN_KEY,
        EXTRA
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
      ORDER BY ORDINAL_POSITION
    `);
    
    console.log(`✅ Found ${columns.length} columns in products table\n`);
    
    // 3. Check for required columns
    console.log('3. Checking for required columns...\n');
    const requiredColumns = [
      { name: 'id', type: 'int', required: true },
      { name: 'product_id', type: 'varchar', required: true },
      { name: 'vendor_id', type: 'int', required: true },
      { name: 'name', type: 'varchar', required: true },
      { name: 'description', type: 'text', required: false },
      { name: 'sku', type: 'varchar', required: true },
      { name: 'category', type: 'varchar', required: true },
      { name: 'price', type: 'decimal', required: true },
      { name: 'mrp', type: 'decimal', required: false },
      { name: 'cost_price', type: 'decimal', required: false },
      { name: 'image_url', type: 'varchar', required: false },
      { name: 'product_images', type: 'json', required: true },
      { name: 'unit', type: 'varchar', required: false },
      { name: 'weight', type: 'decimal', required: false },
      { name: 'dimensions', type: 'varchar', required: false },
      { name: 'barcode', type: 'varchar', required: false },
      { name: 'gst_slab', type: 'decimal', required: false },
      { name: 'hsn_code', type: 'varchar', required: false },
      { name: 'status', type: 'enum', required: true },
      { name: 'created_at', type: 'timestamp', required: true },
      { name: 'updated_at', type: 'timestamp', required: true }
    ];
    
    const foundColumns = columns.map(c => c.COLUMN_NAME.toLowerCase());
    const missingColumns = [];
    const foundRequiredColumns = [];
    
    for (const reqCol of requiredColumns) {
      const found = foundColumns.includes(reqCol.name.toLowerCase());
      if (found) {
        foundRequiredColumns.push(reqCol);
        const colInfo = columns.find(c => c.COLUMN_NAME.toLowerCase() === reqCol.name.toLowerCase());
        console.log(`✅ ${reqCol.name.padEnd(20)} - ${colInfo.DATA_TYPE.toUpperCase().padEnd(15)} ${colInfo.IS_NULLABLE === 'YES' ? '(NULL)' : '(NOT NULL)'} ${colInfo.COLUMN_KEY ? `[${colInfo.COLUMN_KEY}]` : ''}`);
      } else {
        if (reqCol.required) {
          missingColumns.push(reqCol);
          console.log(`❌ ${reqCol.name.padEnd(20)} - MISSING (REQUIRED)`);
        } else {
          console.log(`⚠️  ${reqCol.name.padEnd(20)} - MISSING (OPTIONAL)`);
        }
      }
    }
    
    // 4. Check for indexes
    console.log('\n4. Checking indexes...');
    const [indexes] = await db.query(`
      SHOW INDEXES FROM products
    `);
    
    const indexNames = [...new Set(indexes.map(idx => idx.Key_name))];
    console.log(`✅ Found ${indexNames.length} indexes:`);
    indexNames.forEach(idx => {
      const idxCols = indexes.filter(i => i.Key_name === idx).map(i => i.Column_name).join(', ');
      console.log(`   - ${idx} (${idxCols})`);
    });
    
    // 5. Test inserting a sample product (if vendors exist)
    console.log('\n5. Testing column accessibility...');
    const [vendors] = await db.query('SELECT id FROM vendors LIMIT 1');
    
    if (vendors.length > 0) {
      const vendorId = vendors[0].id;
      
      // Test if we can insert with all new columns
      const testProduct = {
        product_id: 'PRDT999',
        vendor_id: vendorId,
        name: 'Test Product',
        description: 'Test description',
        sku: `TEST-SKU-${Date.now()}`,
        category: 'Test Category',
        price: 100.00,
        mrp: 120.00,
        cost_price: 80.00,
        image_url: 'https://example.com/image.jpg',
        product_images: JSON.stringify(['https://example.com/img1.jpg', 'https://example.com/img2.jpg']),
        unit: 'piece',
        weight: 1.5,
        gst_slab: 18.00,
        hsn_code: '12345',
        status: 'active'
      };
      
      try {
        const [result] = await db.query(`
          INSERT INTO products (
            product_id, vendor_id, name, description, sku, category, 
            price, mrp, cost_price, image_url, product_images, 
            unit, weight, gst_slab, hsn_code, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          testProduct.product_id,
          testProduct.vendor_id,
          testProduct.name,
          testProduct.description,
          testProduct.sku,
          testProduct.category,
          testProduct.price,
          testProduct.mrp,
          testProduct.cost_price,
          testProduct.image_url,
          testProduct.product_images,
          testProduct.unit,
          testProduct.weight,
          testProduct.gst_slab,
          testProduct.hsn_code,
          testProduct.status
        ]);
        
        const insertedId = result.insertId;
        console.log(`✅ Successfully inserted test product (ID: ${insertedId})`);
        
        // Test reading the product back
        const [readProduct] = await db.query('SELECT * FROM products WHERE id = ?', [insertedId]);
        if (readProduct.length > 0) {
          const product = readProduct[0];
          console.log(`✅ Successfully read test product`);
          console.log(`   - product_id: ${product.product_id}`);
          console.log(`   - product_images: ${product.product_images ? 'Present' : 'NULL'}`);
          console.log(`   - cost_price: ${product.cost_price}`);
          
          // Test parsing product_images JSON
          if (product.product_images) {
            try {
              const images = JSON.parse(product.product_images);
              console.log(`   - Parsed product_images: ${Array.isArray(images) ? `${images.length} images` : 'Not an array'}`);
            } catch (e) {
              console.log(`   ⚠️  product_images is not valid JSON`);
            }
          }
        }
        
        // Clean up test product
        await db.query('DELETE FROM products WHERE id = ?', [insertedId]);
        console.log(`✅ Cleaned up test product`);
        
      } catch (insertError) {
        console.log(`❌ Error inserting test product: ${insertError.message}`);
        console.log(`   SQL Error Code: ${insertError.code}`);
        if (insertError.sql) {
          console.log(`   SQL: ${insertError.sql.substring(0, 200)}`);
        }
      }
    } else {
      console.log('⚠️  No vendors found, skipping insert test');
    }
    
    // 6. Summary
    console.log('\n' + '='.repeat(60));
    console.log('\n📊 TEST SUMMARY\n');
    console.log(`Total columns found: ${columns.length}`);
    console.log(`Required columns found: ${foundRequiredColumns.length}/${requiredColumns.filter(c => c.required).length}`);
    console.log(`Missing required columns: ${missingColumns.length}`);
    
    if (missingColumns.length === 0) {
      console.log('\n✅ ALL REQUIRED COLUMNS ARE PRESENT!');
      console.log('✅ Database schema is up to date');
      process.exit(0);
    } else {
      console.log('\n❌ SOME REQUIRED COLUMNS ARE MISSING!');
      console.log('Please run the migration script: node add-missing-product-columns.js');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
    process.exit(1);
  }
}

testProductColumns();

