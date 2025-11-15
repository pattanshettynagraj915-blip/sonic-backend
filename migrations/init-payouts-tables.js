const mysql = require('mysql2');
require('dotenv').config();

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal'
});

async function initPayoutsTables() {
  try {
    console.log('Initializing payouts and bank details tables...');

    // Create vendor_bank_details table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendor_bank_details (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        account_holder_name VARCHAR(255) NOT NULL,
        account_number_encrypted TEXT NOT NULL,
        account_number_hash VARCHAR(255) NOT NULL,
        ifsc_code VARCHAR(11) NOT NULL,
        bank_name VARCHAR(255) NOT NULL,
        upi_id VARCHAR(255) NULL,
        cancelled_cheque_path VARCHAR(500) NULL,
        verification_status ENUM('PENDING', 'VERIFIED', 'REJECTED') DEFAULT 'PENDING',
        verification_notes TEXT NULL,
        verified_by INT NULL,
        verified_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (verified_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        UNIQUE KEY unique_vendor_bank (vendor_id),
        INDEX idx_vendor_bank_vendor_id (vendor_id),
        INDEX idx_vendor_bank_status (verification_status),
        INDEX idx_vendor_bank_ifsc (ifsc_code)
      )
    `);

    // Create vendor_earnings table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendor_earnings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        order_id INT NULL,
        gross_revenue DECIMAL(10, 2) NOT NULL DEFAULT 0,
        platform_commission DECIMAL(10, 2) NOT NULL DEFAULT 0,
        delivery_fee_share DECIMAL(10, 2) NOT NULL DEFAULT 0,
        tds_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
        gst_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
        net_earnings DECIMAL(10, 2) NOT NULL DEFAULT 0,
        commission_rate DECIMAL(5, 2) NOT NULL DEFAULT 5.00,
        delivery_share_rate DECIMAL(5, 2) NOT NULL DEFAULT 2.00,
        tds_rate DECIMAL(5, 2) NOT NULL DEFAULT 1.00,
        gst_rate DECIMAL(5, 2) NOT NULL DEFAULT 18.00,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        status ENUM('pending', 'calculated', 'paid') DEFAULT 'pending',
        payout_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
        FOREIGN KEY (payout_id) REFERENCES payouts(id) ON DELETE SET NULL,
        INDEX idx_vendor_earnings_vendor_id (vendor_id),
        INDEX idx_vendor_earnings_period (period_start, period_end),
        INDEX idx_vendor_earnings_status (status)
      )
    `);

    // Create payout_schedules table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_schedules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        frequency ENUM('weekly', 'bi_weekly', 'monthly') DEFAULT 'weekly',
        day_of_week INT DEFAULT 5,
        day_of_month INT DEFAULT 1,
        min_payout_amount DECIMAL(10, 2) DEFAULT 100.00,
        is_active BOOLEAN DEFAULT TRUE,
        next_payout_date DATE NULL,
        last_payout_date DATE NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        UNIQUE KEY unique_vendor_schedule (vendor_id),
        INDEX idx_payout_schedules_vendor_id (vendor_id),
        INDEX idx_payout_schedules_next_date (next_payout_date)
      )
    `);

    // Create payout_statements table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_statements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        payout_id INT NOT NULL,
        statement_type ENUM('pdf', 'excel') NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        file_size INT NOT NULL,
        generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (payout_id) REFERENCES payouts(id) ON DELETE CASCADE,
        INDEX idx_payout_statements_vendor_id (vendor_id),
        INDEX idx_payout_statements_payout_id (payout_id)
      )
    `);

    // Update existing payouts table to include more fields
    try {
      await db.promise().query(`
        ALTER TABLE payouts 
        ADD COLUMN IF NOT EXISTS gross_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER amount,
        ADD COLUMN IF NOT EXISTS commission_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER gross_amount,
        ADD COLUMN IF NOT EXISTS delivery_fee_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER commission_amount,
        ADD COLUMN IF NOT EXISTS tds_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER delivery_fee_amount,
        ADD COLUMN IF NOT EXISTS gst_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER tds_amount,
        ADD COLUMN IF NOT EXISTS period_start DATE NULL AFTER gst_amount,
        ADD COLUMN IF NOT EXISTS period_end DATE NULL AFTER period_start,
        ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100) NULL AFTER reference,
        ADD COLUMN IF NOT EXISTS failure_reason TEXT NULL AFTER notes
      `);
    } catch (error) {
      console.log('Some columns may already exist in payouts table:', error.message);
    }

    // Create indexes for new tables
    try {
      await db.promise().query(`
        CREATE INDEX IF NOT EXISTS idx_vendor_earnings_order_id ON vendor_earnings(order_id)
      `);
      await db.promise().query(`
        CREATE INDEX IF NOT EXISTS idx_vendor_earnings_payout_id ON vendor_earnings(payout_id)
      `);
      await db.promise().query(`
        CREATE INDEX IF NOT EXISTS idx_payouts_period ON payouts(period_start, period_end)
      `);
      await db.promise().query(`
        CREATE INDEX IF NOT EXISTS idx_payouts_transaction_id ON payouts(transaction_id)
      `);
    } catch (error) {
      console.log('Some indexes may already exist:', error.message);
    }

    // Insert default payout schedules for existing vendors
    const [vendors] = await db.promise().query('SELECT id FROM vendors');
    for (const vendor of vendors) {
      try {
        await db.promise().query(`
          INSERT IGNORE INTO payout_schedules (vendor_id, frequency, day_of_week, min_payout_amount, is_active)
          VALUES (?, 'weekly', 5, 100.00, TRUE)
        `, [vendor.id]);
      } catch (error) {
        console.log(`Payout schedule may already exist for vendor ${vendor.id}`);
      }
    }

    console.log('✅ Payouts and bank details tables initialized successfully!');
    console.log('📊 Created tables:');
    console.log('   - vendor_bank_details');
    console.log('   - vendor_earnings');
    console.log('   - payout_schedules');
    console.log('   - payout_statements');
    console.log('   - Updated payouts table with additional fields');

  } catch (error) {
    console.error('❌ Error initializing payouts tables:', error);
  } finally {
    db.end();
  }
}

// Run the initialization
initPayoutsTables();
