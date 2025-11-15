const mysql = require('mysql2');
require('dotenv').config();

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal'
});

async function initComprehensivePayoutSystem() {
  try {
    console.log('🚀 Initializing comprehensive payout management system...');

    // 1. Enhanced vendor_payment_methods table (supports multiple payment methods)
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendor_payment_methods (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        method_type ENUM('bank_account', 'upi') NOT NULL,
        is_default BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        
        -- Bank account details
        account_holder_name VARCHAR(255) NULL,
        account_number_encrypted TEXT NULL,
        account_number_hash VARCHAR(255) NULL,
        ifsc_code VARCHAR(11) NULL,
        bank_name VARCHAR(255) NULL,
        branch_name VARCHAR(255) NULL,
        
        -- UPI details
        upi_id VARCHAR(255) NULL,
        upi_provider VARCHAR(50) NULL,
        
        -- Verification
        verification_status ENUM('pending', 'verified', 'rejected') DEFAULT 'pending',
        verification_notes TEXT NULL,
        verified_by INT NULL,
        verified_at TIMESTAMP NULL,
        
        -- Supporting documents
        cancelled_cheque_path VARCHAR(500) NULL,
        bank_statement_path VARCHAR(500) NULL,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (verified_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        INDEX idx_vendor_payment_methods_vendor_id (vendor_id),
        INDEX idx_vendor_payment_methods_type (method_type),
        INDEX idx_vendor_payment_methods_status (verification_status)
      )
    `);

    // 2. Enhanced vendor_payouts table (comprehensive payout tracking)
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendor_payouts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        payment_method_id INT NULL,
        
        -- Amount details
        requested_amount DECIMAL(12, 2) NOT NULL,
        approved_amount DECIMAL(12, 2) NULL,
        final_amount DECIMAL(12, 2) NULL,
        processing_fee DECIMAL(10, 2) DEFAULT 0,
        tds_amount DECIMAL(10, 2) DEFAULT 0,
        gst_amount DECIMAL(10, 2) DEFAULT 0,
        
        -- Status and tracking
        status ENUM('pending', 'approved', 'processing', 'paid', 'rejected', 'failed') DEFAULT 'pending',
        payment_method ENUM('bank_transfer', 'upi') DEFAULT 'bank_transfer',
        
        -- Transaction details
        transaction_id VARCHAR(100) NULL,
        reference_number VARCHAR(100) NULL,
        gateway_response JSON NULL,
        
        -- Notes and reasons
        vendor_notes TEXT NULL,
        admin_notes TEXT NULL,
        rejection_reason TEXT NULL,
        failure_reason TEXT NULL,
        
        -- Timestamps
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approved_at TIMESTAMP NULL,
        processing_at TIMESTAMP NULL,
        paid_at TIMESTAMP NULL,
        rejected_at TIMESTAMP NULL,
        
        -- Admin tracking
        approved_by INT NULL,
        processed_by INT NULL,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (payment_method_id) REFERENCES vendor_payment_methods(id) ON DELETE SET NULL,
        FOREIGN KEY (approved_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        FOREIGN KEY (processed_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        
        INDEX idx_vendor_payouts_vendor_id (vendor_id),
        INDEX idx_vendor_payouts_status (status),
        INDEX idx_vendor_payouts_requested_at (requested_at),
        INDEX idx_vendor_payouts_payment_method (payment_method)
      )
    `);

    // 3. Vendor wallet/ledger system
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendor_wallet_balances (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        
        -- Balance tracking
        total_earnings DECIMAL(15, 2) DEFAULT 0,
        total_payouts DECIMAL(15, 2) DEFAULT 0,
        pending_balance DECIMAL(15, 2) DEFAULT 0,
        available_balance DECIMAL(15, 2) DEFAULT 0,
        
        -- Metadata
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        last_payout_at TIMESTAMP NULL,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        UNIQUE KEY unique_vendor_wallet (vendor_id),
        INDEX idx_vendor_wallet_vendor_id (vendor_id)
      )
    `);

    // 4. Wallet transactions (ledger entries)
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendor_wallet_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        
        -- Transaction details
        transaction_type ENUM('credit', 'debit') NOT NULL,
        amount DECIMAL(12, 2) NOT NULL,
        balance_after DECIMAL(15, 2) NOT NULL,
        
        -- Reference details
        reference_type ENUM('order_settlement', 'payout_request', 'payout_reversal', 'fee_deduction', 'adjustment') NOT NULL,
        reference_id INT NULL,
        order_id INT NULL,
        payout_id INT NULL,
        
        -- Description and metadata
        description TEXT NOT NULL,
        metadata JSON NULL,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
        FOREIGN KEY (payout_id) REFERENCES vendor_payouts(id) ON DELETE SET NULL,
        
        INDEX idx_wallet_transactions_vendor_id (vendor_id),
        INDEX idx_wallet_transactions_type (transaction_type),
        INDEX idx_wallet_transactions_reference (reference_type, reference_id),
        INDEX idx_wallet_transactions_created_at (created_at)
      )
    `);

    // 5. Payout configuration
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_configurations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        
        -- Limits
        min_payout_amount DECIMAL(10, 2) DEFAULT 100.00,
        max_payout_amount DECIMAL(10, 2) DEFAULT 100000.00,
        daily_payout_limit DECIMAL(12, 2) DEFAULT 50000.00,
        monthly_payout_limit DECIMAL(12, 2) DEFAULT 500000.00,
        
        -- Fees
        processing_fee_percentage DECIMAL(5, 4) DEFAULT 0.0050, -- 0.5%
        processing_fee_fixed DECIMAL(10, 2) DEFAULT 5.00,
        tds_percentage DECIMAL(5, 4) DEFAULT 0.0100, -- 1%
        
        -- Auto-approval
        auto_approval_limit DECIMAL(10, 2) DEFAULT 5000.00,
        
        -- Schedule
        payout_schedule ENUM('daily', 'weekly', 'monthly') DEFAULT 'weekly',
        payout_day INT DEFAULT 5, -- Friday
        
        -- Status
        is_active BOOLEAN DEFAULT TRUE,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // 6. Payout audit logs
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        payout_id INT NOT NULL,
        
        -- Action details
        action ENUM('created', 'approved', 'rejected', 'processing', 'paid', 'failed', 'cancelled') NOT NULL,
        old_status ENUM('pending', 'approved', 'processing', 'paid', 'rejected', 'failed') NULL,
        new_status ENUM('pending', 'approved', 'processing', 'paid', 'rejected', 'failed') NULL,
        
        -- User and metadata
        performed_by INT NULL,
        user_type ENUM('vendor', 'admin', 'system') NOT NULL,
        notes TEXT NULL,
        metadata JSON NULL,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (payout_id) REFERENCES vendor_payouts(id) ON DELETE CASCADE,
        FOREIGN KEY (performed_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        
        INDEX idx_payout_audit_payout_id (payout_id),
        INDEX idx_payout_audit_action (action),
        INDEX idx_payout_audit_created_at (created_at)
      )
    `);

    // 7. Payout notifications
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        payout_id INT NULL,
        
        -- Notification details
        notification_type ENUM('payout_requested', 'payout_approved', 'payout_rejected', 'payout_paid', 'payout_failed', 'payment_method_verified') NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        
        -- Status
        is_read BOOLEAN DEFAULT FALSE,
        is_email_sent BOOLEAN DEFAULT FALSE,
        
        -- Metadata
        metadata JSON NULL,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        read_at TIMESTAMP NULL,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (payout_id) REFERENCES vendor_payouts(id) ON DELETE SET NULL,
        
        INDEX idx_payout_notifications_vendor_id (vendor_id),
        INDEX idx_payout_notifications_type (notification_type),
        INDEX idx_payout_notifications_read (is_read),
        INDEX idx_payout_notifications_created_at (created_at)
      )
    `);

    // Insert default payout configuration
    await db.promise().query(`
      INSERT IGNORE INTO payout_configurations (
        min_payout_amount, max_payout_amount, daily_payout_limit, monthly_payout_limit,
        processing_fee_percentage, processing_fee_fixed, tds_percentage,
        auto_approval_limit, is_active
      ) VALUES (
        100.00, 100000.00, 50000.00, 500000.00,
        0.0050, 5.00, 0.0100,
        5000.00, TRUE
      )
    `);

    // Initialize wallet balances for existing vendors
    await db.promise().query(`
      INSERT IGNORE INTO vendor_wallet_balances (vendor_id, total_earnings, available_balance)
      SELECT id, 0, 0 FROM vendors
    `);

    // Update existing payouts table if it exists (backward compatibility)
    try {
      await db.promise().query(`
        ALTER TABLE payouts 
        ADD COLUMN IF NOT EXISTS payment_method_id INT NULL AFTER vendor_id,
        ADD COLUMN IF NOT EXISTS approved_amount DECIMAL(12, 2) NULL AFTER amount,
        ADD COLUMN IF NOT EXISTS final_amount DECIMAL(12, 2) NULL AFTER approved_amount,
        ADD COLUMN IF NOT EXISTS processing_fee DECIMAL(10, 2) DEFAULT 0 AFTER final_amount,
        ADD COLUMN IF NOT EXISTS tds_amount DECIMAL(10, 2) DEFAULT 0 AFTER processing_fee,
        ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100) NULL AFTER reference,
        ADD COLUMN IF NOT EXISTS vendor_notes TEXT NULL AFTER notes,
        ADD COLUMN IF NOT EXISTS admin_notes TEXT NULL AFTER vendor_notes,
        ADD COLUMN IF NOT EXISTS requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER created_at,
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP NULL AFTER requested_at,
        ADD COLUMN IF NOT EXISTS approved_by INT NULL AFTER approved_at
      `);
    } catch (error) {
      console.log('Note: Some columns may already exist in payouts table');
    }

    console.log('✅ Comprehensive payout system initialized successfully!');
    console.log('📊 Created/Updated tables:');
    console.log('   - vendor_payment_methods (multiple payment methods support)');
    console.log('   - vendor_payouts (enhanced payout tracking)');
    console.log('   - vendor_wallet_balances (wallet system)');
    console.log('   - vendor_wallet_transactions (ledger system)');
    console.log('   - payout_configurations (system settings)');
    console.log('   - payout_audit_logs (audit trail)');
    console.log('   - payout_notifications (notification system)');
    console.log('   - Updated existing payouts table for backward compatibility');

  } catch (error) {
    console.error('❌ Error initializing comprehensive payout system:', error);
    throw error;
  } finally {
    db.end();
  }
}

// Run the initialization
if (require.main === module) {
  initComprehensivePayoutSystem()
    .then(() => {
      console.log('🎉 Payout system initialization completed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Initialization failed:', error);
      process.exit(1);
    });
}

module.exports = { initComprehensivePayoutSystem };
