const mysql = require('mysql2');

// Database connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: 'vendor_portal',
  multipleStatements: true
});

async function initComprehensiveKYCSystem() {
  try {
    console.log('Initializing Comprehensive KYC System...');
    
    // Enhanced KYC Documents table with comprehensive tracking
    console.log('Enhancing existing kyc_documents table...');
    
    // Helper function to check if column exists
    const columnExists = async (tableName, columnName) => {
      try {
        const [rows] = await db.promise().query(`
          SELECT COLUMN_NAME 
          FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_SCHEMA = DATABASE() 
          AND TABLE_NAME = ? 
          AND COLUMN_NAME = ?
        `, [tableName, columnName]);
        return rows.length > 0;
      } catch (error) {
        return false;
      }
    };
    
    // Add new columns to existing table if they don't exist
    const columnsToAdd = [
      ['doc_status', "ENUM('UPLOADED','OCR_PROCESSING','OCR_COMPLETED','MANUAL_REVIEW','APPROVED','REJECTED','EXPIRED') DEFAULT 'UPLOADED'"],
      ['doc_status_notes', 'TEXT NULL'],
      ['doc_status_updated_at', 'TIMESTAMP NULL'],
      ['doc_status_updated_by', 'INT NULL'],
      ['document_number', 'VARCHAR(100) NULL'],
      ['expiry_date', 'DATE NULL'],
      ['issue_date', 'DATE NULL'],
      ['issuing_authority', 'VARCHAR(255) NULL'],
      ['checksum_sha256', 'CHAR(64) NULL'],
      ['retention_until', 'DATE NULL'],
      ['storage_class', "VARCHAR(50) DEFAULT 'standard'"],
      ['ocr_text', 'LONGTEXT NULL'],
      ['ocr_data', 'JSON NULL'],
      ['ocr_confidence', 'DECIMAL(5,2) NULL'],
      ['ocr_processed_at', 'TIMESTAMP NULL'],
      ['verification_status', "ENUM('PENDING','VERIFIED','REJECTED','REQUIRES_RESUBMISSION') DEFAULT 'PENDING'"],
      ['verification_notes', 'TEXT NULL'],
      ['verification_checked_at', 'TIMESTAMP NULL'],
      ['verified_by', 'INT NULL'],
      ['expiry_notification_sent', 'BOOLEAN DEFAULT FALSE'],
      ['expiry_notification_sent_at', 'TIMESTAMP NULL']
    ];
    
    for (const [columnName, columnDef] of columnsToAdd) {
      try {
        const exists = await columnExists('kyc_documents', columnName);
        if (!exists) {
          await db.promise().query(`
            ALTER TABLE kyc_documents 
            ADD COLUMN ${columnName} ${columnDef}
          `);
          console.log(`Added column: ${columnName}`);
        }
      } catch (error) {
        console.warn(`Warning adding column ${columnName}:`, error.message);
      }
    }
    
    // Add foreign key constraints if they don't exist
    try {
      const docStatusUpdatedByExists = await columnExists('kyc_documents', 'doc_status_updated_by');
      if (docStatusUpdatedByExists) {
        await db.promise().query(`
          ALTER TABLE kyc_documents 
          ADD CONSTRAINT fk_kyc_doc_status_updated_by 
          FOREIGN KEY (doc_status_updated_by) REFERENCES admin_users(id) ON DELETE SET NULL
        `);
      }
    } catch (error) {
      if (!error.message.includes('Duplicate foreign key constraint')) {
        console.warn('Warning adding foreign key constraint:', error.message);
      }
    }
    
    try {
      const verifiedByExists = await columnExists('kyc_documents', 'verified_by');
      if (verifiedByExists) {
        await db.promise().query(`
          ALTER TABLE kyc_documents 
          ADD CONSTRAINT fk_kyc_verified_by 
          FOREIGN KEY (verified_by) REFERENCES admin_users(id) ON DELETE SET NULL
        `);
      }
    } catch (error) {
      if (!error.message.includes('Duplicate foreign key constraint')) {
        console.warn('Warning adding foreign key constraint:', error.message);
      }
    }
    
    // Add indexes if they don't exist
    const indexesToAdd = [
      ['idx_kyc_documents_status', 'doc_status'],
      ['idx_kyc_documents_verification', 'verification_status'],
      ['idx_kyc_documents_expiry', 'expiry_date']
    ];
    
    for (const [indexName, columnName] of indexesToAdd) {
      try {
        const columnExistsForIndex = await columnExists('kyc_documents', columnName);
        if (columnExistsForIndex) {
          await db.promise().query(`
            CREATE INDEX ${indexName} ON kyc_documents (${columnName})
          `);
        }
      } catch (error) {
        if (!error.message.includes('Duplicate key name')) {
          console.warn(`Warning creating index ${indexName}:`, error.message);
        }
      }
    }

    // KYC Document History for audit trail
    console.log('Creating kyc_document_history table...');
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS kyc_document_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        document_id INT NOT NULL,
        vendor_id INT NOT NULL,
        action ENUM('UPLOADED','STATUS_CHANGED','VERIFIED','REJECTED','EXPIRED','REPLACED','DELETED') NOT NULL,
        old_status VARCHAR(50) NULL,
        new_status VARCHAR(50) NULL,
        notes TEXT NULL,
        performed_by INT NULL,
        performed_by_type ENUM('vendor','admin','system') DEFAULT 'system',
        ip_address VARCHAR(45) NULL,
        user_agent TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (document_id) REFERENCES kyc_documents(id) ON DELETE CASCADE,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (performed_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        INDEX idx_kyc_history_document (document_id),
        INDEX idx_kyc_history_vendor (vendor_id),
        INDEX idx_kyc_history_action (action),
        INDEX idx_kyc_history_created (created_at)
      )
    `);

    // KYC Notifications table
    console.log('Creating kyc_notifications table...');
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS kyc_notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        document_id INT NULL,
        notification_type ENUM('DOCUMENT_UPLOADED','DOCUMENT_APPROVED','DOCUMENT_REJECTED','DOCUMENT_EXPIRING','KYC_COMPLETED','RESUBMISSION_REQUIRED','REMINDER') NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        priority ENUM('LOW','MEDIUM','HIGH','URGENT') DEFAULT 'MEDIUM',
        
        -- Delivery channels
        email_sent BOOLEAN DEFAULT FALSE,
        email_sent_at TIMESTAMP NULL,
        sms_sent BOOLEAN DEFAULT FALSE,
        sms_sent_at TIMESTAMP NULL,
        push_sent BOOLEAN DEFAULT FALSE,
        push_sent_at TIMESTAMP NULL,
        
        -- Status tracking
        is_read BOOLEAN DEFAULT FALSE,
        read_at TIMESTAMP NULL,
        is_archived BOOLEAN DEFAULT FALSE,
        archived_at TIMESTAMP NULL,
        
        -- Scheduling
        scheduled_for TIMESTAMP NULL,
        expires_at TIMESTAMP NULL,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
        FOREIGN KEY (document_id) REFERENCES kyc_documents(id) ON DELETE SET NULL,
        INDEX idx_kyc_notifications_vendor (vendor_id),
        INDEX idx_kyc_notifications_type (notification_type),
        INDEX idx_kyc_notifications_read (is_read),
        INDEX idx_kyc_notifications_created (created_at),
        INDEX idx_kyc_notifications_scheduled (scheduled_for)
      )
    `);

    // KYC Templates for document requirements
    console.log('Creating kyc_document_templates table...');
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS kyc_document_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        document_type VARCHAR(50) NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        description TEXT NULL,
        is_required BOOLEAN DEFAULT TRUE,
        max_file_size_mb INT DEFAULT 5,
        allowed_formats JSON NOT NULL,
        validation_rules JSON NULL,
        ocr_enabled BOOLEAN DEFAULT TRUE,
        auto_verify BOOLEAN DEFAULT FALSE,
        expiry_tracking BOOLEAN DEFAULT FALSE,
        expiry_reminder_days INT DEFAULT 30,
        display_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        UNIQUE KEY unique_document_type (document_type),
        INDEX idx_kyc_templates_active (is_active),
        INDEX idx_kyc_templates_order (display_order)
      )
    `);

    // KYC Settings for system configuration
    console.log('Creating kyc_settings table...');
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS kyc_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        setting_key VARCHAR(100) NOT NULL UNIQUE,
        setting_value TEXT NOT NULL,
        setting_type ENUM('string','number','boolean','json') DEFAULT 'string',
        description TEXT NULL,
        is_system BOOLEAN DEFAULT FALSE,
        updated_by INT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        
        FOREIGN KEY (updated_by) REFERENCES admin_users(id) ON DELETE SET NULL,
        INDEX idx_kyc_settings_key (setting_key)
      )
    `);

    // Insert default document templates
    console.log('Inserting default document templates...');
    await db.promise().query(`
      INSERT INTO kyc_document_templates (document_type, display_name, description, is_required, max_file_size_mb, allowed_formats, validation_rules, ocr_enabled, expiry_tracking, expiry_reminder_days, display_order) VALUES
      ('pan', 'PAN Card', 'Permanent Account Number card issued by Income Tax Department', TRUE, 2, '["image/jpeg","image/png","application/pdf"]', '{"pan_format": "^[A-Z]{5}[0-9]{4}[A-Z]{1}$"}', TRUE, FALSE, 0, 1),
      ('aadhaar', 'Aadhaar Card', 'Unique identification document (ensure first 8 digits are masked)', TRUE, 2, '["image/jpeg","image/png","application/pdf"]', '{"masked_required": true}', TRUE, FALSE, 0, 2),
      ('gst', 'GST Certificate', 'Goods and Services Tax registration certificate', TRUE, 5, '["image/jpeg","image/png","application/pdf"]', '{"gstin_format": "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$"}', TRUE, TRUE, 30, 3),
      ('fssai', 'FSSAI License', 'Food Safety and Standards Authority of India license', FALSE, 5, '["image/jpeg","image/png","application/pdf"]', NULL, TRUE, TRUE, 30, 4),
      ('shopLicense', 'Shop/Trade License', 'Municipal corporation issued shop or trade license', TRUE, 5, '["image/jpeg","image/png","application/pdf"]', NULL, TRUE, TRUE, 30, 5),
      ('bankProof', 'Bank Account Proof', 'Bank statement or cancelled cheque for account verification', TRUE, 5, '["image/jpeg","image/png","application/pdf"]', NULL, TRUE, FALSE, 0, 6)
      ON DUPLICATE KEY UPDATE 
        display_name = VALUES(display_name),
        description = VALUES(description),
        updated_at = CURRENT_TIMESTAMP
    `);

    // Insert default KYC settings
    console.log('Inserting default KYC settings...');
    await db.promise().query(`
      INSERT INTO kyc_settings (setting_key, setting_value, setting_type, description, is_system) VALUES
      ('auto_approve_threshold', '0.95', 'number', 'OCR confidence threshold for auto-approval', FALSE),
      ('expiry_reminder_days', '30', 'number', 'Days before expiry to send reminder notifications', FALSE),
      ('max_resubmission_attempts', '3', 'number', 'Maximum number of resubmission attempts allowed', FALSE),
      ('ocr_enabled', 'true', 'boolean', 'Enable OCR processing for documents', FALSE),
      ('email_notifications', 'true', 'boolean', 'Enable email notifications', FALSE),
      ('sms_notifications', 'false', 'boolean', 'Enable SMS notifications', FALSE),
      ('push_notifications', 'true', 'boolean', 'Enable push notifications', FALSE),
      ('document_retention_years', '7', 'number', 'Document retention period in years', TRUE),
      ('supported_languages', '["en","hi"]', 'json', 'Supported languages for OCR', FALSE)
      ON DUPLICATE KEY UPDATE 
        setting_value = VALUES(setting_value),
        updated_at = CURRENT_TIMESTAMP
    `);

    // Create stored procedures for KYC operations
    console.log('Creating KYC stored procedures...');
    
    // Procedure to calculate KYC completion percentage
    await db.promise().query(`
      DROP PROCEDURE IF EXISTS CalculateKYCCompletion;
    `);
    
    await db.promise().query(`
      CREATE PROCEDURE CalculateKYCCompletion(IN vendor_id INT)
      BEGIN
        DECLARE total_required INT DEFAULT 0;
        DECLARE completed_docs INT DEFAULT 0;
        DECLARE completion_percentage DECIMAL(5,2) DEFAULT 0;
        
        -- Get total required documents
        SELECT COUNT(*) INTO total_required 
        FROM kyc_document_templates 
        WHERE is_required = TRUE AND is_active = TRUE;
        
        -- Get completed documents for vendor
        SELECT COUNT(*) INTO completed_docs
        FROM kyc_documents kd
        JOIN kyc_document_templates kdt ON kd.document_type = kdt.document_type
        WHERE kd.vendor_id = vendor_id 
        AND kdt.is_required = TRUE 
        AND kdt.is_active = TRUE
        AND kd.verification_status = 'VERIFIED';
        
        -- Calculate percentage
        IF total_required > 0 THEN
          SET completion_percentage = (completed_docs / total_required) * 100;
        END IF;
        
        SELECT 
          total_required,
          completed_docs,
          completion_percentage,
          CASE 
            WHEN completion_percentage = 100 THEN 'COMPLETED'
            WHEN completion_percentage >= 75 THEN 'MOSTLY_COMPLETE'
            WHEN completion_percentage >= 25 THEN 'IN_PROGRESS'
            ELSE 'NOT_STARTED'
          END as completion_status;
      END
    `);

    // Procedure to get KYC dashboard summary
    await db.promise().query(`
      DROP PROCEDURE IF EXISTS GetKYCDashboardSummary;
    `);
    
    await db.promise().query(`
      CREATE PROCEDURE GetKYCDashboardSummary(IN vendor_id INT)
      BEGIN
        SELECT 
          -- Document counts
          COUNT(*) as total_documents,
          COUNT(CASE WHEN verification_status = 'VERIFIED' THEN 1 END) as verified_documents,
          COUNT(CASE WHEN verification_status = 'PENDING' THEN 1 END) as pending_documents,
          COUNT(CASE WHEN verification_status = 'REJECTED' THEN 1 END) as rejected_documents,
          COUNT(CASE WHEN verification_status = 'REQUIRES_RESUBMISSION' THEN 1 END) as resubmission_required,
          
          -- Status summary
          COUNT(CASE WHEN doc_status = 'UPLOADED' THEN 1 END) as uploaded_count,
          COUNT(CASE WHEN doc_status = 'MANUAL_REVIEW' THEN 1 END) as under_review_count,
          COUNT(CASE WHEN doc_status = 'APPROVED' THEN 1 END) as approved_count,
          COUNT(CASE WHEN doc_status = 'REJECTED' THEN 1 END) as rejected_count,
          COUNT(CASE WHEN doc_status = 'EXPIRED' THEN 1 END) as expired_count,
          
          -- Expiry tracking
          COUNT(CASE WHEN expiry_date IS NOT NULL AND expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 1 END) as expiring_soon_count,
          COUNT(CASE WHEN expiry_date IS NOT NULL AND expiry_date < CURDATE() THEN 1 END) as expired_count_by_date,
          
          -- Recent activity
          MAX(uploaded_at) as last_upload_date,
          MAX(doc_status_updated_at) as last_status_update
          
        FROM kyc_documents 
        WHERE vendor_id = vendor_id;
      END
    `);

    // Create triggers for audit logging
    console.log('Creating audit triggers...');
    
    await db.promise().query(`
      DROP TRIGGER IF EXISTS kyc_document_status_change_audit;
    `);
    
    // Only create trigger if the required columns exist
    const docStatusExists = await columnExists('kyc_documents', 'doc_status');
    const verificationStatusExists = await columnExists('kyc_documents', 'verification_status');
    const docStatusNotesExists = await columnExists('kyc_documents', 'doc_status_notes');
    const docStatusUpdatedByExists = await columnExists('kyc_documents', 'doc_status_updated_by');
    
    if (docStatusExists && verificationStatusExists) {
      await db.promise().query(`
        CREATE TRIGGER kyc_document_status_change_audit
        AFTER UPDATE ON kyc_documents
        FOR EACH ROW
        BEGIN
          IF (OLD.doc_status IS NULL OR NEW.doc_status IS NULL OR OLD.doc_status != NEW.doc_status) 
             OR (OLD.verification_status IS NULL OR NEW.verification_status IS NULL OR OLD.verification_status != NEW.verification_status) THEN
            INSERT INTO kyc_document_history (
              document_id, vendor_id, action, old_status, new_status, 
              notes, performed_by, performed_by_type, created_at
            ) VALUES (
              NEW.id, NEW.vendor_id, 'STATUS_CHANGED', 
              CONCAT(IFNULL(OLD.doc_status, 'NULL'), '/', IFNULL(OLD.verification_status, 'NULL')),
              CONCAT(IFNULL(NEW.doc_status, 'NULL'), '/', IFNULL(NEW.verification_status, 'NULL')),
              ${docStatusNotesExists ? 'NEW.doc_status_notes' : 'NULL'}, 
              ${docStatusUpdatedByExists ? 'NEW.doc_status_updated_by' : 'NULL'}, 
              'admin', NOW()
            );
          END IF;
        END
      `);
      console.log('Created audit trigger successfully');
    } else {
      console.log('Skipping audit trigger creation - required columns not found');
    }

    // Create views for reporting
    console.log('Creating KYC reporting views...');
    
    // Check if vendors table exists and get its structure
    try {
      const [vendorColumns] = await db.promise().query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'vendors'
      `);
      
      if (vendorColumns.length > 0) {
        const hasEmail = vendorColumns.some(col => col.COLUMN_NAME === 'email');
        const hasShopName = vendorColumns.some(col => col.COLUMN_NAME === 'shop_name');
        const hasOwnerName = vendorColumns.some(col => col.COLUMN_NAME === 'owner_name');
        
        const emailField = hasEmail ? 'v.email' : "'unknown@example.com'";
        const shopNameField = hasShopName ? 'v.shop_name' : "'Unknown Shop'";
        const ownerNameField = hasOwnerName ? 'v.owner_name' : "'Unknown Owner'";
        
        await db.promise().query(`
          CREATE OR REPLACE VIEW kyc_dashboard_summary AS
          SELECT 
            v.id as vendor_id,
            ${shopNameField} as shop_name,
            ${ownerNameField} as owner_name,
            ${emailField} as email,
            v.status as vendor_status,
            v.kyc_submitted_at,
            v.kyc_reviewed_at,
            
            -- Document counts
            COUNT(kd.id) as total_documents_uploaded,
            COUNT(CASE WHEN kd.verification_status = 'VERIFIED' THEN 1 END) as verified_documents,
            COUNT(CASE WHEN kd.verification_status = 'PENDING' THEN 1 END) as pending_documents,
            COUNT(CASE WHEN kd.verification_status = 'REJECTED' THEN 1 END) as rejected_documents,
            
            -- Required documents completion
            (SELECT COUNT(*) FROM kyc_document_templates WHERE is_required = TRUE AND is_active = TRUE) as total_required_documents,
            COUNT(CASE WHEN kdt.is_required = TRUE AND kd.verification_status = 'VERIFIED' THEN 1 END) as completed_required_documents,
            
            -- Completion percentage
            ROUND(
              CASE 
                WHEN (SELECT COUNT(*) FROM kyc_document_templates WHERE is_required = TRUE AND is_active = TRUE) > 0 
                THEN (COUNT(CASE WHEN kdt.is_required = TRUE AND kd.verification_status = 'VERIFIED' THEN 1 END) / 
                     (SELECT COUNT(*) FROM kyc_document_templates WHERE is_required = TRUE AND is_active = TRUE)) * 100
                ELSE 0
              END, 2
            ) as completion_percentage,
            
            -- Overall KYC status
            CASE 
              WHEN COUNT(CASE WHEN kdt.is_required = TRUE AND kd.verification_status = 'VERIFIED' THEN 1 END) = 
                   (SELECT COUNT(*) FROM kyc_document_templates WHERE is_required = TRUE AND is_active = TRUE) 
                   AND (SELECT COUNT(*) FROM kyc_document_templates WHERE is_required = TRUE AND is_active = TRUE) > 0
              THEN 'COMPLETED'
              WHEN COUNT(CASE WHEN kdt.is_required = TRUE AND kd.verification_status = 'REJECTED' THEN 1 END) > 0 
              THEN 'REJECTED'
              WHEN COUNT(CASE WHEN kdt.is_required = TRUE AND kd.verification_status = 'PENDING' THEN 1 END) > 0 
              THEN 'UNDER_REVIEW'
              WHEN COUNT(kd.id) > 0 
              THEN 'SUBMITTED'
              ELSE 'NOT_STARTED'
            END as kyc_status,
            
            -- Expiry tracking
            COUNT(CASE WHEN kd.expiry_date IS NOT NULL AND kd.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 1 END) as documents_expiring_soon,
            
            -- Recent activity
            MAX(kd.uploaded_at) as last_document_upload,
            MAX(kd.doc_status_updated_at) as last_status_update
            
          FROM vendors v
          LEFT JOIN kyc_documents kd ON v.id = kd.vendor_id
          LEFT JOIN kyc_document_templates kdt ON kd.document_type = kdt.document_type
          GROUP BY v.id, ${shopNameField}, ${ownerNameField}, ${emailField}, v.status, v.kyc_submitted_at, v.kyc_reviewed_at
        `);
        console.log('Created KYC dashboard summary view successfully');
      } else {
        console.log('Vendors table not found, skipping view creation');
      }
    } catch (error) {
      console.warn('Warning creating KYC dashboard view:', error.message);
    }

    console.log('Comprehensive KYC System initialized successfully!');
    
    // Test the procedures
    console.log('Testing KYC procedures...');
    const [results] = await db.promise().query('CALL GetKYCDashboardSummary(1)');
    console.log('Sample KYC Dashboard Summary:', results[0]);

  } catch (error) {
    console.error('Error initializing Comprehensive KYC System:', error);
    throw error;
  }
}

// Run initialization if called directly
if (require.main === module) {
  initComprehensiveKYCSystem()
    .then(() => {
      console.log('KYC System initialization completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('KYC System initialization failed:', error);
      process.exit(1);
    });
}

module.exports = { initComprehensiveKYCSystem };
