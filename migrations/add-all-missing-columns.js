const mysql = require('mysql2');
require('dotenv').config();

// Use same connection settings as server.js
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '', // Empty password for local MySQL (same as server.js)
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
    return false;
  }
}

async function addAllMissingColumns() {
  try {
    console.log('🔧 Adding ALL missing columns to products table...\n');
    console.log('='.repeat(60));
    
    const columnsToAdd = [
      {
        name: 'vendor_id',
        definition: 'INT NOT NULL',
        description: 'Foreign key to vendors table',
        after: 'product_id'
      },
      {
        name: 'description',
        definition: 'TEXT NULL',
        description: 'Product description',
        after: 'name'
      },
      {
        name: 'sku',
        definition: 'VARCHAR(100) UNIQUE NOT NULL',
        description: 'Stock Keeping Unit',
        after: 'description'
      },
      {
        name: 'category',
        definition: 'VARCHAR(100) NOT NULL',
        description: 'Product category',
        after: 'sku'
      },
      {
        name: 'cost_price',
        definition: 'DECIMAL(10, 2) NULL',
        description: 'Cost price of the product',
        after: 'mrp'
      },
      {
        name: 'image_url',
        definition: 'VARCHAR(500) NULL',
        description: 'Single product image URL',
        after: 'cost_price'
      },
      {
        name: 'unit',
        definition: 'VARCHAR(50) DEFAULT "piece"',
        description: 'Unit of measurement',
        after: 'product_images'
      },
      {
        name: 'weight',
        definition: 'DECIMAL(8, 2) NULL',
        description: 'Product weight in kg',
        after: 'unit'
      },
      {
        name: 'dimensions',
        definition: 'VARCHAR(100) NULL',
        description: 'Product dimensions',
        after: 'weight'
      },
      {
        name: 'barcode',
        definition: 'VARCHAR(100) NULL',
        description: 'Product barcode',
        after: 'dimensions'
      },
      {
        name: 'status',
        definition: "ENUM('active', 'inactive', 'discontinued') DEFAULT 'active'",
        description: 'Product status',
        after: 'hsn_code'
      }
    ];
    
    let addedCount = 0;
    let skippedCount = 0;
    
    for (const column of columnsToAdd) {
      const exists = await columnExists('products', column.name);
      
      if (!exists) {
        try {
          console.log(`Adding column: ${column.name}...`);
          let alterQuery = `ALTER TABLE products ADD COLUMN ${column.name} ${column.definition}`;
          
          // Try to add AFTER clause if specified
          if (column.after) {
            const afterExists = await columnExists('products', column.after);
            if (afterExists) {
              alterQuery += ` AFTER ${column.after}`;
            }
          }
          
          await db.query(alterQuery);
          console.log(`✅ Successfully added: ${column.name} (${column.description})`);
          addedCount++;
        } catch (error) {
          if (error.code === 'ER_DUP_FIELDNAME') {
            console.log(`ℹ️  Column ${column.name} already exists`);
            skippedCount++;
          } else {
            console.error(`❌ Error adding ${column.name}: ${error.message}`);
            console.error(`   SQL Error Code: ${error.code}`);
          }
        }
      } else {
        console.log(`ℹ️  Column ${column.name} already exists`);
        skippedCount++;
      }
    }
    
    // Ensure product_id and product_images exist
    console.log('\nChecking product_id and product_images...');
    if (!(await columnExists('products', 'product_id'))) {
      try {
        await db.query(`ALTER TABLE products ADD COLUMN product_id VARCHAR(20) UNIQUE NULL`);
        console.log('✅ Added product_id column');
        addedCount++;
      } catch (error) {
        if (error.code !== 'ER_DUP_FIELDNAME') {
          console.error(`❌ Error adding product_id: ${error.message}`);
        }
      }
    } else {
      console.log('ℹ️  Column product_id already exists');
    }
    
    if (!(await columnExists('products', 'product_images'))) {
      try {
        await db.query(`ALTER TABLE products ADD COLUMN product_images JSON NULL`);
        console.log('✅ Added product_images column');
        addedCount++;
      } catch (error) {
        if (error.code !== 'ER_DUP_FIELDNAME') {
          console.error(`❌ Error adding product_images: ${error.message}`);
        }
      }
    } else {
      console.log('ℹ️  Column product_images already exists');
    }
    
    // Create indexes
    console.log('\nCreating/checking indexes...');
    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_products_product_id ON products(product_id)`);
      console.log('✅ Index on product_id exists');
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME') {
        try {
          await db.query(`SHOW INDEX FROM products WHERE Key_name = 'idx_products_product_id'`);
          console.log('ℹ️  Index on product_id already exists');
        } catch (_) {
          try {
            await db.query(`CREATE INDEX idx_products_product_id ON products(product_id)`);
            console.log('✅ Created index on product_id');
          } catch (idxError) {
            if (idxError.code !== 'ER_DUP_KEYNAME') {
              console.error(`⚠️  Could not create index: ${idxError.message}`);
            }
          }
        }
      }
    }
    
    // Add foreign key constraint for vendor_id if it doesn't exist
    console.log('\nChecking foreign key constraints...');
    try {
      const [fks] = await db.query(`
        SELECT CONSTRAINT_NAME 
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'products'
        AND COLUMN_NAME = 'vendor_id'
        AND REFERENCED_TABLE_NAME IS NOT NULL
      `);
      
      if (fks.length === 0) {
        try {
          await db.query(`
            ALTER TABLE products 
            ADD CONSTRAINT fk_products_vendor_id 
            FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
          `);
          console.log('✅ Added foreign key constraint for vendor_id');
        } catch (fkError) {
          if (fkError.code === 'ER_DUP_KEYNAME' || fkError.code === 'ER_CANT_CREATE_TABLE') {
            console.log('ℹ️  Foreign key constraint already exists or cannot be created');
          } else {
            console.error(`⚠️  Could not add foreign key: ${fkError.message}`);
          }
        }
      } else {
        console.log('ℹ️  Foreign key constraint for vendor_id already exists');
      }
    } catch (error) {
      console.error(`⚠️  Error checking foreign keys: ${error.message}`);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('\n📊 MIGRATION SUMMARY\n');
    console.log(`✅ Columns added: ${addedCount}`);
    console.log(`ℹ️  Columns skipped (already exist): ${skippedCount}`);
    console.log(`\n✅ Migration completed successfully!`);
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
    process.exit(1);
  }
}

addAllMissingColumns();

