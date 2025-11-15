const mysql = require('mysql2');

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true
});

async function initializeDatabase() {
  try {
    console.log('Connecting to MySQL...');
    
    // Create database
    await db.promise().query('CREATE DATABASE IF NOT EXISTS vendor_portal');
    await db.promise().query('USE vendor_portal');
    
    // Create vendors table
    console.log('Creating vendors table...');
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendors (
        id INT AUTO_INCREMENT PRIMARY KEY,
        shop_name VARCHAR(100) NOT NULL,
        owner_name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        phone VARCHAR(20) NOT NULL,
        shop_address TEXT NOT NULL,
        latitude DECIMAL(10, 8),
        longitude DECIMAL(11, 8),
        password VARCHAR(255) NOT NULL,
        status ENUM('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED') DEFAULT 'DRAFT',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        location_updated_at TIMESTAMP NULL,
        kyc_submitted_at TIMESTAMP NULL,
        kyc_reviewed_at TIMESTAMP NULL,
        review_notes TEXT NULL
      )
    `);
    
    // Create KYC documents table
    console.log('Creating kyc_documents table...');
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS kyc_documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        document_type ENUM('gst', 'fssai', 'shopLicense', 'pan', 'aadhaar', 'bankProof') NOT NULL,
        filename VARCHAR(100) NOT NULL,
        original_name VARCHAR(100) NOT NULL,
        file_path VARCHAR(200) NOT NULL,
        file_size INT NOT NULL,
        mime_type VARCHAR(50) NOT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        UNIQUE KEY unique_vendor_document (vendor_id, document_type)
      )
    `);
    
    // Create admin users table
    console.log('Creating admin_users table...');
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role ENUM('admin', 'reviewer') DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Insert default admin user
    console.log('Inserting default admin user...');
    await db.promise().query(`
      INSERT INTO admin_users (username, email, password, role) VALUES 
      ('admin', 'admin@vendorportal.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin')
      ON DUPLICATE KEY UPDATE username = username
    `);
    
    console.log('Database initialized successfully!');
    console.log('Tables created:');
    console.log('- vendors');
    console.log('- kyc_documents');
    console.log('- admin_users');
    console.log('Default admin user created: admin@vendorportal.com (password: admin123)');
    
  } catch (error) {
    console.error('Database initialization error:', error);
  } finally {
    db.end();
  }
}

initializeDatabase();
