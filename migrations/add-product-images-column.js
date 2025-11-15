const mysql = require('mysql2');

// Database connection
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function addProductImagesColumn() {
  try {
    console.log('Adding product_images column to products table...');
    
    // Check if column already exists
    const [columns] = await db.promise().query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'products' AND COLUMN_NAME = 'product_images'"
    );
    
    if (columns.length === 0) {
      // Add the product_images column
      await db.promise().query(
        'ALTER TABLE products ADD COLUMN product_images JSON NULL'
      );
      console.log('✅ product_images column added successfully');
    } else {
      console.log('✅ product_images column already exists');
    }
    
    // Also ensure the uploads directory exists
    const fs = require('fs');
    const path = require('path');
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      console.log('✅ uploads directory created');
    }
    
    console.log('Database migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error adding product_images column:', error);
    process.exit(1);
  }
}

addProductImagesColumn();
