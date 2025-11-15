const mysql = require('mysql2');
require('dotenv').config();

const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'vendor_portal',
  multipleStatements: true
});

async function initAdminPayoutSystem() {
  try {
    console.log('🚀 Initializing Admin Payout Management System...');

    // 1. Enhanced vendor_payment_methods table
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

    // 3. Vendor wallet/ledger system
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendor_wallet_balances (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        available_balance DECIMAL(12, 2) DEFAULT 0,
        pending_balance DECIMAL(12, 2) DEFAULT 0,
        total_earnings DECIMAL(12, 2) DEFAULT 0,
        total_payouts DECIMAL(12, 2) DEFAULT 0,
        last_payout_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        UNIQUE KEY unique_vendor_wallet (vendor_id),
        INDEX idx_vendor_wallet_vendor_id (vendor_id)
      )
    `);

    // 4. Detailed wallet transactions
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendor_wallet_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        transaction_type ENUM('credit', 'debit') NOT NULL,
        amount DECIMAL(12, 2) NOT NULL,
        balance_after DECIMAL(12, 2) NOT NULL,
        reference_type ENUM('order_earning', 'payout_request', 'payout_reversal', 'adjustment', 'fee_deduction') NOT NULL,
        reference_id INT NULL,
        order_id INT NULL,
        payout_id INT NULL,
        description TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
        FOREIGN KEY (payout_id) REFERENCES vendor_payouts(id) ON DELETE SET NULL,
        INDEX idx_vendor_wallet_transactions_vendor_id (vendor_id),
        INDEX idx_vendor_wallet_transactions_type (transaction_type),
        INDEX idx_vendor_wallet_transactions_reference (reference_type, reference_id),
        INDEX idx_vendor_wallet_transactions_created_at (created_at)
      )
    `);

    // 5. Payout audit logs for compliance
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        payout_id INT NOT NULL,
        action ENUM('created', 'approved', 'rejected', 'processing', 'paid', 'failed', 'cancelled') NOT NULL,
        old_status ENUM('pending', 'approved', 'processing', 'paid', 'rejected', 'failed') NULL,
        new_status ENUM('pending', 'approved', 'processing', 'paid', 'rejected', 'failed') NOT NULL,
        performed_by INT NULL,
        user_type ENUM('vendor', 'admin', 'system') NOT NULL,
        notes TEXT NULL,
        metadata JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (payout_id) REFERENCES vendor_payouts(id) ON DELETE CASCADE,
        FOREIGN KEY (performed_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        INDEX idx_payout_audit_logs_payout_id (payout_id),
        INDEX idx_payout_audit_logs_action (action),
        INDEX idx_payout_audit_logs_created_at (created_at)
      )
    `);

    // 6. Payout notifications for vendors
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        payout_id INT NULL,
        notification_type ENUM('payout_approved', 'payout_rejected', 'payout_paid', 'payment_method_verified', 'payment_method_rejected', 'general') NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN DEFAULT FALSE,
        read_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (payout_id) REFERENCES vendor_payouts(id) ON DELETE CASCADE,
        INDEX idx_payout_notifications_vendor_id (vendor_id),
        INDEX idx_payout_notifications_type (notification_type),
        INDEX idx_payout_notifications_is_read (is_read),
        INDEX idx_payout_notifications_created_at (created_at)
      )
    `);

    // 7. Payout configurations for admin management
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_configurations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        min_payout_amount DECIMAL(10, 2) DEFAULT 100.00,
        max_payout_amount DECIMAL(12, 2) DEFAULT 100000.00,
        daily_payout_limit DECIMAL(12, 2) DEFAULT 500000.00,
        processing_fee_percentage DECIMAL(5, 4) DEFAULT 0.0050,
        processing_fee_fixed DECIMAL(10, 2) DEFAULT 5.00,
        tds_percentage DECIMAL(5, 4) DEFAULT 0.0100,
        auto_approval_limit DECIMAL(10, 2) DEFAULT 1000.00,
        approval_required_amount DECIMAL(10, 2) DEFAULT 5000.00,
        kyc_required_for_payouts BOOLEAN DEFAULT TRUE,
        bank_verification_required BOOLEAN DEFAULT TRUE,
        working_days_only BOOLEAN DEFAULT TRUE,
        holiday_processing BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        INDEX idx_payout_configurations_active (is_active)
      )
    `);

    // 8. Bulk payout operations for admin
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS bulk_payout_operations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        admin_id INT NOT NULL,
        operation_type ENUM('bulk_approve', 'bulk_reject', 'bulk_process', 'bulk_pay') NOT NULL,
        operation_name VARCHAR(255) NOT NULL,
        total_payouts INT DEFAULT 0,
        processed_payouts INT DEFAULT 0,
        failed_payouts INT DEFAULT 0,
        total_amount DECIMAL(15, 2) DEFAULT 0,
        status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
        filters JSON NULL,
        error_log TEXT NULL,
        started_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE CASCADE,
        INDEX idx_bulk_payout_operations_admin_id (admin_id),
        INDEX idx_bulk_payout_operations_status (status),
        INDEX idx_bulk_payout_operations_created_at (created_at)
      )
    `);

    // 9. Payout schedule management
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

    // 10. GST and TDS reports for compliance
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_tax_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        financial_year VARCHAR(9) NOT NULL,
        quarter INT NOT NULL,
        total_payouts DECIMAL(15, 2) DEFAULT 0,
        total_tds_deducted DECIMAL(15, 2) DEFAULT 0,
        total_gst_applicable DECIMAL(15, 2) DEFAULT 0,
        report_generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        report_file_path VARCHAR(500) NULL,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        UNIQUE KEY unique_vendor_quarter_report (vendor_id, financial_year, quarter),
        INDEX idx_payout_tax_reports_vendor_id (vendor_id),
        INDEX idx_payout_tax_reports_year_quarter (financial_year, quarter)
      )
    `);

    // Insert default payout configuration
    await db.promise().query(`
      INSERT INTO payout_configurations (
        min_payout_amount, max_payout_amount, daily_payout_limit,
        processing_fee_percentage, processing_fee_fixed, tds_percentage,
        auto_approval_limit
      ) VALUES (100.00, 100000.00, 500000.00, 0.0050, 5.00, 0.0100, 1000.00)
      ON DUPLICATE KEY UPDATE min_payout_amount = min_payout_amount
    `);

    // Create indexes for better performance
    try {
      await db.promise().query(`CREATE INDEX idx_vendor_payouts_status_amount ON vendor_payouts(status, requested_amount)`);
    } catch (e) { /* Index may already exist */ }
    
    try {
      await db.promise().query(`CREATE INDEX idx_vendor_payouts_payment_method_status ON vendor_payouts(payment_method, status)`);
    } catch (e) { /* Index may already exist */ }
    
    try {
      await db.promise().query(`CREATE INDEX idx_vendor_wallet_balances_available ON vendor_wallet_balances(available_balance)`);
    } catch (e) { /* Index may already exist */ }
    
    try {
      await db.promise().query(`CREATE INDEX idx_payout_audit_logs_datetime ON payout_audit_logs(created_at DESC)`);
    } catch (e) { /* Index may already exist */ }

    // Create views for reporting
    await db.promise().query(`
      CREATE OR REPLACE VIEW payout_summary_view AS
      SELECT 
        vp.id as payout_id,
        vp.vendor_id,
        v.shop_name as vendor_name,
        v.owner_name,
        v.owner_email as vendor_email,
        v.owner_phone as vendor_phone,
        vp.requested_amount,
        vp.approved_amount,
        vp.final_amount,
        vp.processing_fee,
        vp.tds_amount,
        vp.status,
        vp.payment_method,
        vp.transaction_id,
        vp.requested_at,
        vp.approved_at,
        vp.paid_at,
        vpm.method_type,
        vpm.account_holder_name,
        vpm.bank_name,
        vpm.upi_id,
        CASE 
          WHEN vpm.account_number_encrypted IS NOT NULL 
          THEN CONCAT('****', RIGHT(vpm.account_number_hash, 4))
          ELSE NULL
        END as masked_account_number,
        aa.username as approved_by_admin,
        ap.username as processed_by_admin
      FROM vendor_payouts vp
      JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN vendor_payment_methods vpm ON vp.payment_method_id = vpm.id
      LEFT JOIN admin_users aa ON vp.approved_by = aa.id
      LEFT JOIN admin_users ap ON vp.processed_by = ap.id
    `);

    await db.promise().query(`
      CREATE OR REPLACE VIEW vendor_payout_stats_view AS
      SELECT 
        v.id as vendor_id,
        v.shop_name as vendor_name,
        v.owner_email as vendor_email,
        vwb.available_balance,
        vwb.pending_balance,
        vwb.total_earnings,
        vwb.total_payouts,
        vwb.last_payout_at,
        COUNT(vp.id) as total_payout_requests,
        COUNT(CASE WHEN vp.status = 'pending' THEN 1 END) as pending_requests,
        COUNT(CASE WHEN vp.status = 'paid' THEN 1 END) as paid_requests,
        COALESCE(SUM(CASE WHEN vp.status = 'paid' THEN vp.final_amount END), 0) as total_paid_amount,
        COALESCE(SUM(CASE WHEN vp.status = 'pending' THEN vp.requested_amount END), 0) as pending_amount
      FROM vendors v
      LEFT JOIN vendor_wallet_balances vwb ON v.id = vwb.vendor_id
      LEFT JOIN vendor_payouts vp ON v.id = vp.vendor_id
      GROUP BY v.id, v.shop_name, v.owner_email, vwb.available_balance, vwb.pending_balance, 
               vwb.total_earnings, vwb.total_payouts, vwb.last_payout_at
    `);

    // Insert sample data for existing vendors
    await db.promise().query(`
      INSERT IGNORE INTO vendor_wallet_balances (vendor_id, available_balance, total_earnings)
      SELECT id, 2500.00, 5000.00 FROM vendors LIMIT 5
    `);

    // Insert sample payment methods
    await db.promise().query(`
      INSERT IGNORE INTO vendor_payment_methods (
        vendor_id, method_type, account_holder_name, bank_name, ifsc_code, 
        verification_status, is_default
      )
      SELECT 
        id, 
        'bank_account',
        owner_name,
        'State Bank of India',
        'SBIN0001234',
        'verified',
        TRUE
      FROM vendors 
      LIMIT 3
    `);

    // Insert sample payout requests
    await db.promise().query(`
      INSERT IGNORE INTO vendor_payouts (
        vendor_id, payment_method_id, requested_amount, status, payment_method,
        vendor_notes
      )
      SELECT 
        v.id,
        vpm.id,
        1500.00,
        'pending',
        'bank_transfer',
        'Regular weekly payout request'
      FROM vendors v
      JOIN vendor_payment_methods vpm ON v.id = vpm.vendor_id
      LIMIT 2
    `);

    console.log('✅ Admin Payout Management System initialized successfully!');
    console.log('📊 Created tables:');
    console.log('   - vendor_payment_methods');
    console.log('   - vendor_payouts');
    console.log('   - vendor_wallet_balances');
    console.log('   - vendor_wallet_transactions');
    console.log('   - payout_audit_logs');
    console.log('   - payout_notifications');
    console.log('   - payout_configurations');
    console.log('   - bulk_payout_operations');
    console.log('   - payout_schedules');
    console.log('   - payout_tax_reports');
    console.log('📈 Created views and indexes for optimal performance');

  } catch (error) {
    console.error('❌ Error initializing Admin Payout System:', error);
    throw error;
  }
}

if (require.main === module) {
  initAdminPayoutSystem()
    .then(() => {
      console.log('🎉 Admin Payout Management System setup completed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Setup failed:', error);
      process.exit(1);
    });
}

module.exports = { initAdminPayoutSystem };
