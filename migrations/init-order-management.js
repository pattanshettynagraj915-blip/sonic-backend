const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal',
  multipleStatements: true
};

async function initOrderManagement() {
  let connection;
  
  try {
    console.log('🚀 Initializing Order Management System...');
    
    // Create connection
    connection = await mysql.createConnection(dbConfig);
    console.log('✅ Connected to MySQL database');

    // Check if orders table exists and has the new structure
    const [tables] = await connection.execute(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders'
      ORDER BY ORDINAL_POSITION
    `, [dbConfig.database]);

    const existingColumns = tables.map(col => col.COLUMN_NAME);
    const requiredColumns = [
      'customer_email', 'payment_mode', 'transaction_id', 
      'subtotal', 'shipping_charges', 'cancellation_reason'
    ];

    const missingColumns = requiredColumns.filter(col => !existingColumns.includes(col));

    if (missingColumns.length > 0) {
      console.log('📝 Updating orders table structure...');
      
      // Add missing columns to orders table
      const alterQueries = [
        `ALTER TABLE orders 
         MODIFY COLUMN status ENUM('pending', 'shipped', 'delivered', 'cancelled') DEFAULT 'pending'`,
        `ALTER TABLE orders 
         MODIFY COLUMN payment_status ENUM('pending', 'paid', 'failed') DEFAULT 'pending'`
      ];

      // Add columns one by one with existence check
      const columnsToAdd = [
        { name: 'payment_mode', sql: `ALTER TABLE orders ADD COLUMN payment_mode ENUM('cash', 'card', 'upi', 'wallet', 'net_banking') DEFAULT 'cash' AFTER payment_status` },
        { name: 'transaction_id', sql: `ALTER TABLE orders ADD COLUMN transaction_id VARCHAR(100) NULL AFTER payment_mode` },
        { name: 'customer_email', sql: `ALTER TABLE orders ADD COLUMN customer_email VARCHAR(255) NULL AFTER customer_phone` },
        { name: 'subtotal', sql: `ALTER TABLE orders ADD COLUMN subtotal DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER total_amount` },
        { name: 'shipping_charges', sql: `ALTER TABLE orders ADD COLUMN shipping_charges DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER tax_amount` },
        { name: 'cancellation_reason', sql: `ALTER TABLE orders ADD COLUMN cancellation_reason TEXT NULL AFTER rejection_reason` }
      ];

      // Add columns that don't exist
      for (const column of columnsToAdd) {
        if (!existingColumns.includes(column.name)) {
          alterQueries.push(column.sql);
        }
      }

      for (const query of alterQueries) {
        try {
          await connection.execute(query);
        } catch (error) {
          if (!error.message.includes('Duplicate column name')) {
            console.warn('Warning:', error.message);
          }
        }
      }

      // Add indexes
      const indexQueries = [
        `CREATE INDEX idx_orders_vendor_status ON orders(vendor_id, status)`,
        `CREATE INDEX idx_orders_payment_status ON orders(payment_status)`,
        `CREATE INDEX idx_orders_created_at ON orders(created_at)`,
        `CREATE INDEX idx_orders_customer_name ON orders(customer_name)`,
        `CREATE INDEX idx_orders_order_number ON orders(order_number)`
      ];

      for (const query of indexQueries) {
        try {
          await connection.execute(query);
        } catch (error) {
          if (!error.message.includes('Duplicate key name')) {
            console.warn('Warning:', error.message);
          }
        }
      }

      console.log('✅ Orders table structure updated');
    }

    // Check if order_items table has the new structure
    const [itemsColumns] = await connection.execute(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'order_items'
    `, [dbConfig.database]);

    const existingItemsColumns = itemsColumns.map(col => col.COLUMN_NAME);
    if (!existingItemsColumns.includes('product_name') || !existingItemsColumns.includes('product_sku')) {
      console.log('📝 Updating order_items table structure...');
      
      if (!existingItemsColumns.includes('product_name')) {
        await connection.execute(`
          ALTER TABLE order_items 
          ADD COLUMN product_name VARCHAR(255) NOT NULL DEFAULT '' AFTER product_id
        `);
      }
      
      if (!existingItemsColumns.includes('product_sku')) {
        await connection.execute(`
          ALTER TABLE order_items 
          ADD COLUMN product_sku VARCHAR(100) NOT NULL DEFAULT '' AFTER product_name
        `);
      }

      console.log('✅ Order items table structure updated');
    }

    // Check if order_status_history table needs to be updated
    const [statusHistoryExists] = await connection.execute(`
      SELECT COUNT(*) as count
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'order_status_history'
    `, [dbConfig.database]);

    if (statusHistoryExists[0].count === 0) {
      // Create order_status_history table with compatible structure
      await connection.execute(`
        CREATE TABLE order_status_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id INT NOT NULL,
          status ENUM('pending', 'confirmed', 'prepared', 'ready', 'out_for_delivery', 'delivered', 'cancelled', 'rejected') NOT NULL,
          previous_status ENUM('pending', 'confirmed', 'prepared', 'ready', 'out_for_delivery', 'delivered', 'cancelled', 'rejected') NULL,
          changed_by INT NULL,
          changed_by_type ENUM('vendor', 'admin', 'system') DEFAULT 'vendor',
          reason TEXT NULL,
          notes TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
          INDEX idx_order_status_history_order_id (order_id),
          INDEX idx_order_status_history_created_at (created_at)
        )
      `);
    }

    // Check if order_notifications table needs to be updated
    const [notificationsExists] = await connection.execute(`
      SELECT COUNT(*) as count
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'order_notifications'
    `, [dbConfig.database]);

    if (notificationsExists[0].count === 0) {
      // Create order_notifications table with compatible structure
      await connection.execute(`
        CREATE TABLE order_notifications (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id INT NOT NULL,
          vendor_id INT NOT NULL,
          notification_type ENUM('new_order', 'status_change', 'payment_update', 'cancellation', 'assignment') NOT NULL,
          title VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          is_read TINYINT(1) DEFAULT 0,
          sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          read_at TIMESTAMP NULL,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
          FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
          INDEX idx_order_notifications_vendor_id (vendor_id),
          INDEX idx_order_notifications_is_read (is_read),
          INDEX idx_order_notifications_sent_at (sent_at)
        )
      `);
    }

    console.log('✅ Order management tables created/updated');

    // Insert sample data if orders table is empty
    const [orderCount] = await connection.execute('SELECT COUNT(*) as count FROM orders');
    
    if (orderCount[0].count === 0) {
      console.log('📝 Inserting sample order data...');
      
      // Insert sample orders using existing column structure
      await connection.execute(`
        INSERT INTO orders (vendor_id, order_number, customer_name, customer_phone, customer_email, customer_address, status, payment_status, payment_method, total_amount, tax_amount, created_at) VALUES
        (1, 'ORD-2024-001', 'John Doe', '+91-9876543210', 'john.doe@email.com', '123 Main Street, Delhi, 110001', 'pending', 'paid', 'upi', 581.00, 81.00, DATE_SUB(NOW(), INTERVAL 2 HOUR)),
        (1, 'ORD-2024-002', 'Jane Smith', '+91-9876543211', 'jane.smith@email.com', '456 Park Avenue, Mumbai, 400001', 'out_for_delivery', 'paid', 'cod', 417.60, 57.60, DATE_SUB(NOW(), INTERVAL 1 DAY)),
        (1, 'ORD-2024-003', 'Bob Johnson', '+91-9876543212', 'bob.johnson@email.com', '789 Oak Street, Bangalore, 560001', 'delivered', 'paid', 'cod', 862.40, 122.40, DATE_SUB(NOW(), INTERVAL 3 DAY)),
        (1, 'ORD-2024-004', 'Alice Brown', '+91-9876543213', 'alice.brown@email.com', '321 Pine Street, Chennai, 600001', 'cancelled', 'failed', 'cod', 325.00, 45.00, DATE_SUB(NOW(), INTERVAL 5 DAY))
        ON DUPLICATE KEY UPDATE order_number = order_number
      `);

      // Get the inserted order IDs
      const [orders] = await connection.execute('SELECT id, order_number FROM orders ORDER BY id LIMIT 4');

      // Insert sample order items
      await connection.execute(`
        INSERT INTO order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, total_price) VALUES
        (${orders[0].id}, 1, 'Fresh Apples', 'APPLE-001', 2, 150.00, 300.00),
        (${orders[0].id}, 2, 'Organic Bananas', 'BANANA-001', 3, 50.00, 150.00),
        (${orders[1].id}, 1, 'Fresh Apples', 'APPLE-001', 1, 150.00, 150.00),
        (${orders[1].id}, 3, 'Premium Oranges', 'ORANGE-001', 2, 85.00, 170.00),
        (${orders[2].id}, 2, 'Organic Bananas', 'BANANA-001', 4, 50.00, 200.00),
        (${orders[2].id}, 4, 'Fresh Grapes', 'GRAPE-001', 3, 160.00, 480.00),
        (${orders[3].id}, 1, 'Fresh Apples', 'APPLE-001', 1, 150.00, 150.00),
        (${orders[3].id}, 5, 'Mixed Vegetables', 'VEG-001', 2, 50.00, 100.00)
        ON DUPLICATE KEY UPDATE product_name = product_name
      `);

      // Insert sample order status history
      await connection.execute(`
        INSERT INTO order_status_history (order_id, status, previous_status, changed_by_type, reason, created_at) VALUES
        (${orders[0].id}, 'pending', NULL, 'system', 'Order placed', DATE_SUB(NOW(), INTERVAL 2 HOUR)),
        (${orders[1].id}, 'pending', NULL, 'system', 'Order placed', DATE_SUB(NOW(), INTERVAL 1 DAY)),
        (${orders[1].id}, 'out_for_delivery', 'pending', 'vendor', 'Order packed and out for delivery', DATE_SUB(NOW(), INTERVAL 12 HOUR)),
        (${orders[2].id}, 'pending', NULL, 'system', 'Order placed', DATE_SUB(NOW(), INTERVAL 3 DAY)),
        (${orders[2].id}, 'out_for_delivery', 'pending', 'vendor', 'Order packed and out for delivery', DATE_SUB(NOW(), INTERVAL 2 DAY)),
        (${orders[2].id}, 'delivered', 'out_for_delivery', 'system', 'Order delivered successfully', DATE_SUB(NOW(), INTERVAL 1 DAY)),
        (${orders[3].id}, 'pending', NULL, 'system', 'Order placed', DATE_SUB(NOW(), INTERVAL 5 DAY)),
        (${orders[3].id}, 'cancelled', 'pending', 'system', 'Payment failed', DATE_SUB(NOW(), INTERVAL 4 DAY))
        ON DUPLICATE KEY UPDATE reason = reason
      `);

      console.log('✅ Sample order data inserted');
    }

    console.log('🎉 Order Management System initialization completed successfully!');
    console.log('\n📋 Summary:');
    console.log('- Enhanced orders table with customer info and payment details');
    console.log('- Updated order_items table with product names and SKUs');
    console.log('- Created order_status_history table for tracking status changes');
    console.log('- Created order_notifications table for vendor notifications');
    console.log('- Added sample data for testing');
    console.log('\n🚀 You can now use the Order Management module in your Vendor Portal!');

  } catch (error) {
    console.error('❌ Error initializing Order Management System:', error);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

// Run the initialization
if (require.main === module) {
  initOrderManagement();
}

module.exports = initOrderManagement;
