const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal',
  port: process.env.DB_PORT || 3306
};

async function addVendorIdField() {
  let connection;
  
  try {
    console.log('Connecting to database...');
    connection = await mysql.createConnection(dbConfig);
    
    console.log('Connected to database successfully');
    
    // Check if vendor_id column already exists
    const [columns] = await connection.execute(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'vendors' AND COLUMN_NAME = 'vendor_id'
    `, [dbConfig.database]);
    
    if (columns.length > 0) {
      console.log('vendor_id column already exists in vendors table');
      return;
    }
    
    // Add vendor_id column
    console.log('Adding vendor_id column to vendors table...');
    await connection.execute(`
      ALTER TABLE vendors 
      ADD COLUMN vendor_id VARCHAR(20) UNIQUE NULL AFTER id
    `);
    
    console.log('vendor_id column added successfully');
    
    // Get all existing vendors and generate vendor IDs for them
    console.log('Generating vendor IDs for existing vendors...');
    const [vendors] = await connection.execute('SELECT id FROM vendors ORDER BY id');
    
    for (let i = 0; i < vendors.length; i++) {
      const vendorId = `VDR${String(i + 1).padStart(3, '0')}`;
      await connection.execute(
        'UPDATE vendors SET vendor_id = ? WHERE id = ?',
        [vendorId, vendors[i].id]
      );
      console.log(`Updated vendor ${vendors[i].id} with vendor_id: ${vendorId}`);
    }
    
    // Make vendor_id NOT NULL after populating all existing records
    console.log('Making vendor_id NOT NULL...');
    await connection.execute(`
      ALTER TABLE vendors 
      MODIFY COLUMN vendor_id VARCHAR(20) UNIQUE NOT NULL
    `);
    
    // Add index for better performance
    console.log('Adding index for vendor_id...');
    await connection.execute(`
      CREATE INDEX idx_vendors_vendor_id ON vendors(vendor_id)
    `);
    
    console.log('✅ Successfully added vendor_id field with VDR prefix to vendors table');
    console.log(`✅ Generated vendor IDs for ${vendors.length} existing vendors`);
    
  } catch (error) {
    console.error('❌ Error adding vendor_id field:', error);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
      console.log('Database connection closed');
    }
  }
}

// Function to generate next vendor ID
async function getNextVendorId(connection) {
  try {
    const [result] = await connection.execute(`
      SELECT vendor_id FROM vendors 
      WHERE vendor_id LIKE 'VDR%' 
      ORDER BY CAST(SUBSTRING(vendor_id, 4) AS UNSIGNED) DESC 
      LIMIT 1
    `);
    
    if (result.length === 0) {
      return 'VDR001';
    }
    
    const lastVendorId = result[0].vendor_id;
    const lastNumber = parseInt(lastVendorId.substring(3));
    const nextNumber = lastNumber + 1;
    
    return `VDR${String(nextNumber).padStart(3, '0')}`;
  } catch (error) {
    console.error('Error generating next vendor ID:', error);
    throw error;
  }
}

// Export the function for use in other modules
module.exports = { addVendorIdField, getNextVendorId };

// Run the script if called directly
if (require.main === module) {
  addVendorIdField()
    .then(() => {
      console.log('Migration completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
