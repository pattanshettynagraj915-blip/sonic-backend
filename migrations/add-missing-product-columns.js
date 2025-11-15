const mysql = require('mysql2');
require('dotenv').config();

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
}).promise();

async function columnExists(tableName, columnName) {
  try {
    const [rows] = await db.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    return rows.length > 0;
  } catch (error) {
    console.error(`Error checking column ${columnName}:`, error.message);
    return false;
  }
}

async function addMissingColumns() {
  try {
    console.log('Checking and adding missing columns to products table...\n');
    
    const columnsToAdd = [
      {
        name: 'product_id',
        definition: 'VARCHAR(20) UNIQUE NULL',
        description: 'Auto-generated Product ID (e.g., PRDT001)'
      },
      {
        name: 'product_images',
        definition: 'JSON NULL',
        description: 'Array of product image URLs stored as JSON'
      }
    ];
    
    for (const column of columnsToAdd) {
      const exists = await columnExists('products', column.name);
      
      if (!exists) {
        try {
          console.log(`Adding column: ${column.name} (${column.description})...`);
          await db.query(`ALTER TABLE products ADD COLUMN ${column.name} ${column.definition}`);
          console.log(`✅ Successfully added column: ${column.name}\n`);
          
          // Create index for product_id if it's the product_id column
          if (column.name === 'product_id') {
            try {
              await db.query(`CREATE INDEX idx_products_product_id ON products(product_id)`);
              console.log(`✅ Created index on product_id\n`);
            } catch (indexError) {
              if (indexError.code !== 'ER_DUP_KEYNAME') {
                console.error(`⚠️  Warning: Could not create index on product_id:`, indexError.message);
              } else {
                console.log(`✅ Index on product_id already exists\n`);
              }
            }
          }
        } catch (error) {
          if (error.code === 'ER_DUP_FIELDNAME') {
            console.log(`ℹ️  Column ${column.name} already exists\n`);
          } else {
            console.error(`❌ Error adding column ${column.name}:`, error.message);
            console.error(`   SQL Error Code: ${error.code}\n`);
          }
        }
      } else {
        console.log(`ℹ️  Column ${column.name} already exists\n`);
      }
    }
    
    // Generate product_id for existing products that don't have one
    console.log('Checking for existing products without product_id...');
    const [productsWithoutId] = await db.query(`
      SELECT id, name FROM products 
      WHERE product_id IS NULL 
      ORDER BY id ASC
    `);
    
    if (productsWithoutId.length > 0) {
      console.log(`Found ${productsWithoutId.length} products without product_id. Generating IDs...`);
      
      for (const product of productsWithoutId) {
        // Get the next product ID number
        const [maxIdResult] = await db.query(`
          SELECT COALESCE(MAX(CAST(SUBSTRING(product_id, 5) AS UNSIGNED)), 0) + 1 as next_num
          FROM products 
          WHERE product_id REGEXP '^PRDT[0-9]+$'
        `);
        
        const nextNumber = maxIdResult[0]?.next_num || 1;
        const productId = `PRDT${nextNumber.toString().padStart(3, '0')}`;
        
        await db.query(
          'UPDATE products SET product_id = ? WHERE id = ?',
          [productId, product.id]
        );
        
        console.log(`  ✓ Generated ${productId} for product: ${product.name} (ID: ${product.id})`);
      }
      
      console.log(`\n✅ Generated product_id for ${productsWithoutId.length} products\n`);
    } else {
      console.log('✅ All products already have product_id\n');
    }
    
    console.log('✅ Database migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during migration:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
    process.exit(1);
  }
}

addMissingColumns();

