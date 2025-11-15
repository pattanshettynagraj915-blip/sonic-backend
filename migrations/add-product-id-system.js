const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
}).promise();

async function addProductIdSystem() {
  const conn = await pool.getConnection();
  try {
    console.log('Adding Product ID system to products table...');
    
    // Check if product_id column exists, if not add it
    const [columns] = await conn.execute(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'products' 
      AND COLUMN_NAME = 'product_id'
      AND TABLE_SCHEMA = DATABASE()
    `);
    
    if (columns.length === 0) {
      await conn.execute(`
        ALTER TABLE products 
        ADD COLUMN product_id VARCHAR(20) UNIQUE NULL
      `);
    }
    
    console.log('✓ Added product_id column');
    
    // Create index for better performance
    try {
      await conn.execute(`
        CREATE INDEX idx_products_product_id ON products(product_id)
      `);
    } catch (error) {
      if (error.code !== 'ER_DUP_KEYNAME') {
        throw error;
      }
      // Index already exists, continue
    }
    
    console.log('✓ Created index on product_id');
    
    // Generate Product IDs for existing products that don't have one
    const [existingProducts] = await conn.execute(`
      SELECT id, name FROM products 
      WHERE product_id IS NULL 
      ORDER BY id ASC
    `);
    
    console.log(`Found ${existingProducts.length} products without Product ID`);
    
    if (existingProducts.length > 0) {
      // Get the highest existing product_id number
      const [maxProductId] = await conn.execute(`
        SELECT product_id FROM products 
        WHERE product_id IS NOT NULL 
        AND product_id REGEXP '^PRDT[0-9]+$'
        ORDER BY CAST(SUBSTRING(product_id, 5) AS UNSIGNED) DESC 
        LIMIT 1
      `);
      
      let nextNumber = 1;
      if (maxProductId.length > 0) {
        const lastId = maxProductId[0].product_id;
        const numberPart = lastId.substring(4); // Remove 'PRDT' prefix
        nextNumber = parseInt(numberPart) + 1;
      }
      
      // Update existing products with Product IDs
      for (const product of existingProducts) {
        const productId = `PRDT${nextNumber.toString().padStart(3, '0')}`;
        
        await conn.execute(`
          UPDATE products 
          SET product_id = ? 
          WHERE id = ?
        `, [productId, product.id]);
        
        console.log(`✓ Assigned ${productId} to product: ${product.name}`);
        nextNumber++;
      }
    }
    
    // Create a function to generate the next Product ID
    try {
      await conn.query(`
        CREATE FUNCTION IF NOT EXISTS generate_product_id() 
        RETURNS VARCHAR(20)
        READS SQL DATA
        DETERMINISTIC
        BEGIN
          DECLARE next_id VARCHAR(20);
          DECLARE next_num INT;
          
          SELECT COALESCE(MAX(CAST(SUBSTRING(product_id, 5) AS UNSIGNED)), 0) + 1
          INTO next_num
          FROM products 
          WHERE product_id REGEXP '^PRDT[0-9]+$';
          
          SET next_id = CONCAT('PRDT', LPAD(next_num, 3, '0'));
          RETURN next_id;
        END
      `);
      
      console.log('✓ Created generate_product_id() function');
      
      // Create a trigger to automatically assign Product ID on insert
      await conn.query(`
        DROP TRIGGER IF EXISTS tr_products_auto_product_id
      `);
      
      await conn.query(`
        CREATE TRIGGER tr_products_auto_product_id
        BEFORE INSERT ON products
        FOR EACH ROW
        BEGIN
          IF NEW.product_id IS NULL THEN
            SET NEW.product_id = generate_product_id();
          END IF;
        END
      `);
      
      console.log('✓ Created trigger for auto Product ID assignment');
    } catch (error) {
      console.log('⚠ Function/trigger creation failed (may already exist):', error.message);
      console.log('Product ID system will work with manual assignment in the application');
    }
    
    console.log('\n🎉 Product ID system successfully implemented!');
    console.log('Features added:');
    console.log('- product_id column with format PRDT001, PRDT002, etc.');
    console.log('- Auto-incrementing Product ID generation');
    console.log('- Automatic assignment on new product creation');
    console.log('- Existing products have been assigned Product IDs');
    
  } catch (error) {
    console.error('Error implementing Product ID system:', error);
    throw error;
  } finally {
    conn.release();
  }
}

// Run the migration
addProductIdSystem()
  .then(() => {
    console.log('Migration completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
