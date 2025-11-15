const mysql = require('mysql2');
require('dotenv').config();

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal'
});

async function initComprehensivePayouts() {
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
        
        -- Amount breakdown
        requested_amount DECIMAL(12, 2) NOT NULL,
        approved_amount DECIMAL(12, 2) NULL,
        final_amount DECIMAL(12, 2) NULL,
        
        -- Fees and deductions
        processing_fee DECIMAL(10, 2) DEFAULT 0,
        tds_amount DECIMAL(10, 2) DEFAULT 0,
        other_deductions DECIMAL(10, 2) DEFAULT 0,
        
        -- Status tracking
        status ENUM('pending', 'approved', 'processing', 'paid', 'rejected', 'failed') DEFAULT 'pending',
        priority ENUM('low', 'normal', 'high', 'urgent') DEFAULT 'normal',
        
        -- Payment details
        payment_method ENUM('bank_transfer', 'upi', 'cheque') NOT NULL,
        transaction_id VARCHAR(100) NULL,
        reference_number VARCHAR(100) NULL,
        
        -- Timestamps
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approved_at TIMESTAMP NULL,
        processing_at TIMESTAMP NULL,
        paid_at TIMESTAMP NULL,
        rejected_at TIMESTAMP NULL,
        
        -- Admin actions
        approved_by INT NULL,
        processed_by INT NULL,
        rejection_reason TEXT NULL,
        admin_notes TEXT NULL,
        vendor_notes TEXT NULL,
        
        -- Reconciliation
        bank_reference VARCHAR(100) NULL,
        reconciled_at TIMESTAMP NULL,
        reconciled_by INT NULL,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (payment_method_id) REFERENCES vendor_payment_methods(id) ON DELETE SET NULL,
        FOREIGN KEY (approved_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        FOREIGN KEY (processed_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        FOREIGN KEY (reconciled_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        
        INDEX idx_vendor_payouts_vendor_id (vendor_id),
        INDEX idx_vendor_payouts_status (status),
        INDEX idx_vendor_payouts_requested_at (requested_at),
        INDEX idx_vendor_payouts_payment_method (payment_method),
        INDEX idx_vendor_payouts_transaction_id (transaction_id)
      )
    `);

    // 3. Vendor wallet/ledger table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendor_wallet_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        transaction_type ENUM('credit', 'debit') NOT NULL,
        category ENUM('order_settlement', 'payout', 'adjustment', 'fee', 'refund', 'commission') NOT NULL,
        
        amount DECIMAL(12, 2) NOT NULL,
        balance_before DECIMAL(12, 2) NOT NULL,
        balance_after DECIMAL(12, 2) NOT NULL,
        
        -- Reference details
        reference_type ENUM('order', 'payout', 'manual_adjustment', 'commission', 'fee') NULL,
        reference_id INT NULL,
        
        description TEXT NOT NULL,
        admin_notes TEXT NULL,
        
        -- Admin tracking
        created_by INT NULL,
        created_by_type ENUM('system', 'admin', 'vendor') DEFAULT 'system',
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        
        INDEX idx_wallet_transactions_vendor_id (vendor_id),
        INDEX idx_wallet_transactions_type (transaction_type),
        INDEX idx_wallet_transactions_category (category),
        INDEX idx_wallet_transactions_created_at (created_at),
        INDEX idx_wallet_transactions_reference (reference_type, reference_id)
      )
    `);

    // 4. Vendor wallet balance table (current balance tracking)
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendor_wallet_balances (
        vendor_id INT PRIMARY KEY,
        available_balance DECIMAL(12, 2) DEFAULT 0,
        pending_balance DECIMAL(12, 2) DEFAULT 0,
        total_earnings DECIMAL(12, 2) DEFAULT 0,
        total_payouts DECIMAL(12, 2) DEFAULT 0,
        last_payout_at TIMESTAMP NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
      )
    `);

    // 5. Payout configuration table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_configurations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        min_payout_amount DECIMAL(10, 2) DEFAULT 100.00,
        max_payout_amount DECIMAL(10, 2) DEFAULT 50000.00,
        processing_fee_percentage DECIMAL(5, 4) DEFAULT 0.0050,
        processing_fee_fixed DECIMAL(10, 2) DEFAULT 5.00,
        tds_percentage DECIMAL(5, 4) DEFAULT 0.0100,
        auto_approval_limit DECIMAL(10, 2) DEFAULT 1000.00,
        daily_payout_limit DECIMAL(10, 2) DEFAULT 10000.00,
        monthly_payout_limit DECIMAL(10, 2) DEFAULT 100000.00,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // 6. Payout audit log table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        payout_id INT NOT NULL,
        action ENUM('created', 'approved', 'rejected', 'processing', 'paid', 'failed', 'reconciled') NOT NULL,
        old_status VARCHAR(50) NULL,
        new_status VARCHAR(50) NULL,
        performed_by INT NULL,
        performed_by_type ENUM('system', 'admin', 'vendor') DEFAULT 'system',
        notes TEXT NULL,
        ip_address VARCHAR(45) NULL,
        user_agent TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (payout_id) REFERENCES vendor_payouts(id) ON DELETE CASCADE,
        FOREIGN KEY (performed_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        
        INDEX idx_payout_audit_payout_id (payout_id),
        INDEX idx_payout_audit_action (action),
        INDEX idx_payout_audit_created_at (created_at)
      )
    `);

    // 7. Payout notifications table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        payout_id INT NULL,
        notification_type ENUM('payout_requested', 'payout_approved', 'payout_rejected', 'payout_paid', 'payout_failed', 'balance_low') NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        sent_via_email BOOLEAN DEFAULT FALSE,
        sent_via_sms BOOLEAN DEFAULT FALSE,
        email_sent_at TIMESTAMP NULL,
        sms_sent_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        read_at TIMESTAMP NULL,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (payout_id) REFERENCES vendor_payouts(id) ON DELETE SET NULL,
        
        INDEX idx_payout_notifications_vendor_id (vendor_id),
        INDEX idx_payout_notifications_type (notification_type),
        INDEX idx_payout_notifications_created_at (created_at),
        INDEX idx_payout_notifications_is_read (is_read)
      )
    `);

    // 8. Bank reconciliation table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS bank_reconciliation (
        id INT AUTO_INCREMENT PRIMARY KEY,
        payout_id INT NULL,
        bank_reference VARCHAR(100) NOT NULL,
        bank_transaction_id VARCHAR(100) NULL,
        amount DECIMAL(12, 2) NOT NULL,
        transaction_date DATE NOT NULL,
        status ENUM('matched', 'unmatched', 'disputed') DEFAULT 'unmatched',
        reconciled_by INT NULL,
        reconciled_at TIMESTAMP NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (payout_id) REFERENCES vendor_payouts(id) ON DELETE SET NULL,
        FOREIGN KEY (reconciled_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        
        INDEX idx_bank_reconciliation_payout_id (payout_id),
        INDEX idx_bank_reconciliation_bank_ref (bank_reference),
        INDEX idx_bank_reconciliation_status (status),
        INDEX idx_bank_reconciliation_date (transaction_date)
      )
    `);

    // Insert default payout configuration
    await db.promise().query(`
      INSERT INTO payout_configurations (
        min_payout_amount, max_payout_amount, processing_fee_percentage, 
        processing_fee_fixed, tds_percentage, auto_approval_limit,
        daily_payout_limit, monthly_payout_limit
      ) VALUES (100.00, 50000.00, 0.0050, 5.00, 0.0100, 1000.00, 10000.00, 100000.00)
      ON DUPLICATE KEY UPDATE id = id
    `);

    // Initialize wallet balances for existing vendors
    await db.promise().query(`
      INSERT INTO vendor_wallet_balances (vendor_id, available_balance, pending_balance, total_earnings, total_payouts)
      SELECT id, 0, 0, 0, 0 FROM vendors
      ON DUPLICATE KEY UPDATE vendor_id = vendor_id
    `);

    // Create useful views
    await db.promise().query(`
      CREATE OR REPLACE VIEW vendor_payout_summary AS
      SELECT 
        v.id as vendor_id,
        v.business_name,
        v.owner_name,
        vwb.available_balance,
        vwb.pending_balance,
        vwb.total_earnings,
        vwb.total_payouts,
        COUNT(vp.id) as total_payout_requests,
        COUNT(CASE WHEN vp.status = 'pending' THEN 1 END) as pending_requests,
        COUNT(CASE WHEN vp.status = 'paid' THEN 1 END) as paid_requests,
        MAX(vp.paid_at) as last_payout_date,
        SUM(CASE WHEN vp.status = 'pending' THEN vp.requested_amount ELSE 0 END) as pending_amount
      FROM vendors v
      LEFT JOIN vendor_wallet_balances vwb ON v.id = vwb.vendor_id
      LEFT JOIN vendor_payouts vp ON v.id = vp.vendor_id
      WHERE v.status = 'approved'
      GROUP BY v.id, v.business_name, v.owner_name, vwb.available_balance, vwb.pending_balance, vwb.total_earnings, vwb.total_payouts
    `);

    await db.promise().query(`
      CREATE OR REPLACE VIEW admin_payout_queue AS
      SELECT 
        vp.*,
        v.business_name,
        v.owner_name,
        v.owner_email,
        v.owner_phone,
        vpm.method_type,
        vpm.account_holder_name,
        vpm.bank_name,
        vpm.upi_id,
        vwb.available_balance,
        aa.username as approved_by_username
      FROM vendor_payouts vp
      JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN vendor_payment_methods vpm ON vp.payment_method_id = vpm.id
      LEFT JOIN vendor_wallet_balances vwb ON vp.vendor_id = vwb.vendor_id
      LEFT JOIN admin_users aa ON vp.approved_by = aa.id
      WHERE vp.status IN ('pending', 'approved', 'processing')
      ORDER BY 
        CASE vp.priority 
          WHEN 'urgent' THEN 1 
          WHEN 'high' THEN 2 
          WHEN 'normal' THEN 3 
          WHEN 'low' THEN 4 
        END,
        vp.requested_at ASC
    `);

    console.log('✅ Comprehensive payout management system initialized successfully!');
    console.log('📊 Created tables:');
    console.log('   - vendor_payment_methods (multiple payment methods per vendor)');
    console.log('   - vendor_payouts (comprehensive payout tracking)');
    console.log('   - vendor_wallet_transactions (ledger/wallet system)');
    console.log('   - vendor_wallet_balances (current balance tracking)');
    console.log('   - payout_configurations (system settings)');
    console.log('   - payout_audit_logs (audit trail)');
    console.log('   - payout_notifications (notification system)');
    console.log('   - bank_reconciliation (reconciliation support)');
    console.log('📈 Created views:');
    console.log('   - vendor_payout_summary (vendor dashboard data)');
    console.log('   - admin_payout_queue (admin approval queue)');

  } catch (error) {
    console.error('❌ Error initializing comprehensive payout system:', error);
    throw error;
  } finally {
    db.end();
  }
}

// Run the initialization
if (require.main === module) {
  initComprehensivePayouts().catch(console.error);
}

module.exports = initComprehensivePayouts;
