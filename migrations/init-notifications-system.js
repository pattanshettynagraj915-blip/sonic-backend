const mysql = require('mysql2');
require('dotenv').config();

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: '', // Empty password for local MySQL
  database: process.env.DB_NAME || 'vendor_portal'
});

async function initNotificationsSystem() {
  try {
    console.log('🔔 Initializing real-time notifications system...');

    // 1. Create notifications table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_type ENUM('admin', 'vendor') NOT NULL,
        user_id INT NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status ENUM('unread', 'read') DEFAULT 'unread',
        metadata JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        INDEX idx_notifications_user (user_type, user_id),
        INDEX idx_notifications_event_type (event_type),
        INDEX idx_notifications_status (status),
        INDEX idx_notifications_created_at (created_at)
      )
    `);

    // 2. Create notification_settings table for user preferences
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS notification_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_type ENUM('admin', 'vendor') NOT NULL,
        user_id INT NOT NULL,
        email_notifications BOOLEAN DEFAULT TRUE,
        sms_notifications BOOLEAN DEFAULT FALSE,
        push_notifications BOOLEAN DEFAULT TRUE,
        kyc_notifications BOOLEAN DEFAULT TRUE,
        order_notifications BOOLEAN DEFAULT TRUE,
        inventory_notifications BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        UNIQUE KEY unique_user_settings (user_type, user_id)
      )
    `);

    // 3. Create notification_templates table for consistent messaging
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS notification_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL UNIQUE,
        title_template VARCHAR(255) NOT NULL,
        message_template TEXT NOT NULL,
        email_template TEXT NULL,
        sms_template TEXT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // 4. Insert default notification templates
    const templates = [
      {
        event_type: 'KYC_SUBMITTED',
        title_template: 'New KYC Submission',
        message_template: 'Vendor {{vendor_name}} has submitted KYC documents for review.',
        email_template: 'Dear Admin,\n\nVendor {{vendor_name}} ({{vendor_email}}) has submitted their KYC documents and is awaiting your review.\n\nPlease review the documents in the admin panel.\n\nBest regards,\nVendor Portal System',
        sms_template: 'New KYC submission from {{vendor_name}}. Please review in admin panel.'
      },
      {
        event_type: 'VENDOR_APPROVED',
        title_template: 'KYC Approved',
        message_template: 'Congratulations! Your KYC has been approved and your vendor account is now active.',
        email_template: 'Dear {{vendor_name}},\n\nGreat news! Your KYC documents have been reviewed and approved. Your vendor account is now active and you can start managing your products and orders.\n\nWelcome to the platform!\n\nBest regards,\nAdmin Team',
        sms_template: 'Congratulations! Your KYC has been approved. Your vendor account is now active.'
      },
      {
        event_type: 'VENDOR_REJECTED',
        title_template: 'KYC Rejected',
        message_template: 'Your KYC submission has been rejected. Please review the feedback and resubmit.',
        email_template: 'Dear {{vendor_name}},\n\nWe have reviewed your KYC documents, but unfortunately they do not meet our requirements.\n\nReason: {{rejection_reason}}\n\nPlease review the feedback and resubmit your documents.\n\nBest regards,\nAdmin Team',
        sms_template: 'Your KYC has been rejected. Please check email for details and resubmit.'
      },
      {
        event_type: 'LOW_STOCK_ALERT',
        title_template: 'Low Stock Alert',
        message_template: 'Product "{{product_name}}" is running low on stock ({{current_stock}} remaining).',
        email_template: 'Dear {{vendor_name}},\n\nThis is to inform you that your product "{{product_name}}" is running low on stock.\n\nCurrent stock: {{current_stock}}\nMinimum threshold: {{threshold}}\n\nPlease restock soon to avoid stockouts.\n\nBest regards,\nInventory Management System',
        sms_template: 'Low stock alert: {{product_name}} has {{current_stock}} units left.'
      },
      {
        event_type: 'NEW_ORDER',
        title_template: 'New Order Received',
        message_template: 'You have received a new order #{{order_id}} for {{total_amount}}.',
        email_template: 'Dear {{vendor_name}},\n\nYou have received a new order!\n\nOrder ID: #{{order_id}}\nTotal Amount: ₹{{total_amount}}\nCustomer: {{customer_name}}\n\nPlease prepare the order for delivery.\n\nBest regards,\nOrder Management System',
        sms_template: 'New order #{{order_id}} received for ₹{{total_amount}}.'
      },
      {
        event_type: 'ORDER_ASSIGNED',
        title_template: 'Order Assigned',
        message_template: 'Order #{{order_id}} has been assigned to you.',
        email_template: 'Dear {{vendor_name}},\n\nOrder #{{order_id}} has been assigned to you for fulfillment.\n\nPlease check the order details and prepare for delivery.\n\nBest regards,\nOrder Management System',
        sms_template: 'Order #{{order_id}} assigned to you.'
      },
      {
        event_type: 'ORDER_REASSIGNED',
        title_template: 'Order Reassigned',
        message_template: 'Order #{{order_id}} has been reassigned to you.',
        email_template: 'Dear {{vendor_name}},\n\nOrder #{{order_id}} has been reassigned to you for fulfillment.\n\nPlease check the order details and prepare for delivery.\n\nBest regards,\nOrder Management System',
        sms_template: 'Order #{{order_id}} reassigned to you.'
      }
    ];

    for (const template of templates) {
      await db.promise().query(`
        INSERT INTO notification_templates (event_type, title_template, message_template, email_template, sms_template)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        title_template = VALUES(title_template),
        message_template = VALUES(message_template),
        email_template = VALUES(email_template),
        sms_template = VALUES(sms_template)
      `, [
        template.event_type,
        template.title_template,
        template.message_template,
        template.email_template,
        template.sms_template
      ]);
    }

    // 5. Create default notification settings for existing users
    // For admin users
    await db.promise().query(`
      INSERT IGNORE INTO notification_settings (user_type, user_id, email_notifications, sms_notifications, push_notifications)
      SELECT 'admin', id, TRUE, FALSE, TRUE
      FROM admin_users
    `);

    // For vendor users
    await db.promise().query(`
      INSERT IGNORE INTO notification_settings (user_type, user_id, email_notifications, sms_notifications, push_notifications)
      SELECT 'vendor', id, TRUE, FALSE, TRUE
      FROM vendors
    `);

    console.log('✅ Notifications system initialized successfully!');
    console.log('📊 Created tables: notifications, notification_settings, notification_templates');
    console.log('📝 Inserted default notification templates');
    console.log('⚙️  Created default notification settings for existing users');

  } catch (error) {
    console.error('❌ Error initializing notifications system:', error);
    throw error;
  } finally {
    db.end();
  }
}

// Run if called directly
if (require.main === module) {
  initNotificationsSystem()
    .then(() => {
      console.log('🎉 Notifications system setup complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Setup failed:', error);
      process.exit(1);
    });
}

module.exports = { initNotificationsSystem };
