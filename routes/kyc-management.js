const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const router = express.Router();

// Use the shared database pool from utils/db.js
const db = require('../utils/db');
const {
  uploadMulterFileToCloudinary,
  deleteCloudinaryAsset,
  extractPublicIdFromUrl,
  detectResourceTypeFromUrl
} = require('../utils/cloudinary');

// Helper: check if a column exists on a given table in the current DB
async function tableHasColumn(tableName, columnName) {
  try {
    const [rows] = await db.promise().query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [tableName, columnName]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('Schema check error:', err);
    return false;
  }
}

// Helper: check if a table exists in the current DB
async function tableExists(tableName) {
  try {
    const [rows] = await db.promise().query(
      `SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
      [tableName]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('Table existence check error:', err);
    return false;
  }
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/kyc');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG, PNG, and PDF files are allowed.'));
    }
  }
});

// Helper functions
const calculateFileChecksum = (file) => {
  if (!file) return null;
  const fileBuffer = file.buffer || fs.readFileSync(file.path);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
};

const logDocumentHistory = async (documentId, vendorId, action, oldStatus, newStatus, notes, performedBy, performedByType = 'vendor', ipAddress = null, userAgent = null) => {
  try {
    if (!(await tableExists('kyc_document_history'))) return; // Skip if history table is absent
    await db.promise().query(`
      INSERT INTO kyc_document_history (
        document_id, vendor_id, action, old_status, new_status, 
        notes, performed_by, performed_by_type, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [documentId, vendorId, action, oldStatus, newStatus, notes, performedBy, performedByType, ipAddress, userAgent]);
  } catch (error) {
    console.error('Error logging document history:', error);
  }
};

const createNotification = async (vendorId, documentId, type, title, message, priority = 'MEDIUM') => {
  try {
    if (!(await tableExists('kyc_notifications'))) return; // Skip if notifications table is absent
    await db.promise().query(`
      INSERT INTO kyc_notifications (
        vendor_id, document_id, notification_type, title, message, priority
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [vendorId, documentId, type, title, message, priority]);
  } catch (error) {
    console.error('Error creating notification:', error);
  }
};

const isRemoteFilePath = (filePath) => /^https?:\/\//i.test(filePath || '');

async function loadFileBuffer(filePath) {
  if (!filePath) return null;
  if (isRemoteFilePath(filePath)) {
    const response = await axios.get(filePath, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }
  const normalized = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath.replace(/^\/+/, ''));
  return fs.promises.readFile(normalized);
}

async function deleteStoredFile(filePath, mimeType = '') {
  if (!filePath) return;
  if (isRemoteFilePath(filePath)) {
    const publicId = extractPublicIdFromUrl(filePath);
    if (!publicId) return;
    const resourceType = detectResourceTypeFromUrl(filePath) || (mimeType.includes('pdf') ? 'raw' : 'image');
    try {
      await deleteCloudinaryAsset(publicId, resourceType);
    } catch (err) {
      console.warn('Failed to delete Cloudinary asset:', err?.message || err);
    }
    return;
  }
  const normalized = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath.replace(/^\/+/, ''));
  try {
    await fs.promises.unlink(normalized);
  } catch (_) {
    // ignore
  }
}

// Routes

// GET /api/kyc/dashboard/:vendorId - Get KYC dashboard summary
router.get('/dashboard/:vendorId', async (req, res) => {
  try {
    const { vendorId } = req.params;

    // Get dashboard summary using stored procedure
    const [dashboardSummary] = await db.promise().query('CALL GetKYCDashboardSummary(?)', [vendorId]);
    
    // Get completion percentage using stored procedure
    const [completionData] = await db.promise().query('CALL CalculateKYCCompletion(?)', [vendorId]);
    
    // Get recent notifications
    const [notifications] = await db.promise().query(`
      SELECT id, notification_type, title, message, priority, is_read, created_at
      FROM kyc_notifications 
      WHERE vendor_id = ? 
      ORDER BY created_at DESC 
      LIMIT 5
    `, [vendorId]);

    // Get document templates for requirements
    const [templates] = await db.promise().query(`
      SELECT document_type, display_name, description, is_required, max_file_size_mb, 
             allowed_formats, expiry_tracking, expiry_reminder_days
      FROM kyc_document_templates 
      WHERE is_active = TRUE 
      ORDER BY display_order
    `);

    res.json({
      success: true,
      data: {
        summary: dashboardSummary[0] || {},
        completion: completionData[0] || {},
        notifications: notifications,
        requirements: templates
      }
    });
  } catch (error) {
    console.error('Error fetching KYC dashboard:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/kyc/documents/:vendorId - Get all documents for a vendor
router.get('/documents/:vendorId', async (req, res) => {
  try {
    const { vendorId } = req.params;

    const [documents] = await db.promise().query(`
      SELECT 
        kd.*,
        kdt.display_name,
        kdt.description,
        kdt.is_required,
        kdt.expiry_tracking,
        kdt.expiry_reminder_days,
        CASE 
          WHEN kd.expiry_date IS NOT NULL AND kd.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) 
          THEN TRUE 
          ELSE FALSE 
        END as is_expiring_soon,
        CASE 
          WHEN kd.expiry_date IS NOT NULL AND kd.expiry_date < CURDATE() 
          THEN TRUE 
          ELSE FALSE 
        END as is_expired
      FROM kyc_documents kd
      LEFT JOIN kyc_document_templates kdt ON kd.document_type = kdt.document_type
      WHERE kd.vendor_id = ?
      ORDER BY kdt.display_order, kd.uploaded_at DESC
    `, [vendorId]);

    // Get document history for each document
    const documentsWithHistory = await Promise.all(documents.map(async (doc) => {
      let history = [];
      try {
        if (await tableExists('kyc_document_history')) {
          const [rows] = await db.promise().query(`
            SELECT action, old_status, new_status, notes, performed_by_type, created_at
            FROM kyc_document_history 
            WHERE document_id = ? 
            ORDER BY created_at DESC 
            LIMIT 5
          `, [doc.id]);
          history = rows;
        }
      } catch (_) {
        history = [];
      }

      return {
        ...doc,
        history: history
      };
    }));

    res.json({
      success: true,
      data: documentsWithHistory
    });
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/kyc/upload/:vendorId - Upload KYC documents
router.post('/upload/:vendorId', upload.fields([
  { name: 'gst', maxCount: 1 },
  { name: 'fssai', maxCount: 1 },
  { name: 'shopLicense', maxCount: 1 },
  { name: 'pan', maxCount: 1 },
  { name: 'aadhaar', maxCount: 1 },
  { name: 'bankProof', maxCount: 1 }
]), async (req, res) => {
  try {
    const { vendorId } = req.params;
    const files = req.files;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    if (!files || Object.keys(files).length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const uploadedDocuments = [];
    const errors = [];

    // Process each uploaded file
    for (const [docType, fileArray] of Object.entries(files)) {
      const file = fileArray[0];
      
      try {
        // Calculate file checksum
        const checksum = calculateFileChecksum(file);
        
        // Set retention date (7 years from now)
        const retentionDate = new Date();
        retentionDate.setFullYear(retentionDate.getFullYear() + 7);

        const resourceType = (file.mimetype || '').includes('pdf') ? 'raw' : 'image';
        const uploadResult = await uploadMulterFileToCloudinary(file, {
          folder: `kyc/${vendorId}/${docType}`,
          resourceType
        });
        const storedPath = uploadResult.secure_url;
        const storedFilename = uploadResult.public_id;

        // Check if document already exists for this vendor
        const [existingDoc] = await db.promise().query(`
          SELECT id FROM kyc_documents WHERE vendor_id = ? AND document_type = ?
        `, [vendorId, docType]);

        let documentId;

        if (existingDoc.length > 0) {
          // Update existing document
          documentId = existingDoc[0].id;
          
          const [[oldDoc]] = await db.promise().query(`
            SELECT file_path, mime_type FROM kyc_documents WHERE id = ?
          `, [documentId]);
          
          // Build a resilient UPDATE depending on available columns
          const hasChecksum = await tableHasColumn('kyc_documents', 'checksum_sha256');
          const hasRetention = await tableHasColumn('kyc_documents', 'retention_until');
          const hasDocStatus = await tableHasColumn('kyc_documents', 'doc_status');
          const hasVerification = await tableHasColumn('kyc_documents', 'verification_status');
          const hasDocStatusUpdatedAt = await tableHasColumn('kyc_documents', 'doc_status_updated_at');

          let updateSql = `UPDATE kyc_documents SET filename = ?, original_name = ?, file_path = ?, file_size = ?, mime_type = ?, uploaded_at = NOW()`;
          const params = [storedFilename, file.originalname, storedPath, file.size, file.mimetype];

          if (hasChecksum) { updateSql += `, checksum_sha256 = ?`; params.push(checksum); }
          if (hasRetention) { updateSql += `, retention_until = ?`; params.push(retentionDate.toISOString().slice(0, 10)); }
          if (hasDocStatus) { updateSql += `, doc_status = 'UPLOADED'`; }
          if (hasVerification) { updateSql += `, verification_status = 'PENDING'`; }
          if (hasDocStatusUpdatedAt) { updateSql += `, doc_status_updated_at = NOW()`; }

          updateSql += ` WHERE id = ?`;
          params.push(documentId);

          await db.promise().query(updateSql, params);

          if (oldDoc?.file_path) {
            await deleteStoredFile(oldDoc.file_path, oldDoc.mime_type || file.mimetype || '');
          }

          // Log replacement
          await logDocumentHistory(
            documentId, vendorId, 'REPLACED', 'EXISTING', 'UPLOADED',
            `Document replaced: ${file.originalname}`, null, 'vendor', ipAddress, userAgent
          );
        } else {
          // Insert new document
          // Build a resilient INSERT depending on available columns
          const hasChecksumI = await tableHasColumn('kyc_documents', 'checksum_sha256');
          const hasRetentionI = await tableHasColumn('kyc_documents', 'retention_until');
          const hasDocStatusI = await tableHasColumn('kyc_documents', 'doc_status');
          const hasVerificationI = await tableHasColumn('kyc_documents', 'verification_status');

          const cols = ['vendor_id','document_type','filename','original_name','file_path','file_size','mime_type'];
          const placeholders = ['?','?','?','?','?','?','?'];
          const values = [vendorId, docType, storedFilename, file.originalname, storedPath, file.size, file.mimetype];

          if (hasChecksumI) { cols.push('checksum_sha256'); placeholders.push('?'); values.push(checksum); }
          if (hasRetentionI) { cols.push('retention_until'); placeholders.push('?'); values.push(retentionDate.toISOString().slice(0, 10)); }
          if (hasDocStatusI) { cols.push('doc_status'); placeholders.push(`'UPLOADED'`); }
          if (hasVerificationI) { cols.push('verification_status'); placeholders.push(`'PENDING'`); }

          const insertSql = `INSERT INTO kyc_documents (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
          const [result] = await db.promise().query(insertSql, values);

          documentId = result.insertId;

          // Log upload
          await logDocumentHistory(
            documentId, vendorId, 'UPLOADED', null, 'UPLOADED',
            `Document uploaded: ${file.originalname}`, null, 'vendor', ipAddress, userAgent
          );
        }

        // Create notification
        await createNotification(
          vendorId, documentId, 'DOCUMENT_UPLOADED',
          'Document Uploaded Successfully',
          `Your ${docType.toUpperCase()} document has been uploaded and is pending verification.`,
          'MEDIUM'
        );

        uploadedDocuments.push({
          documentId,
          documentType: docType,
          filename: storedFilename,
          originalName: file.originalname,
          size: file.size,
          status: 'UPLOADED'
        });

      } catch (error) {
        console.error(`Error processing ${docType}:`, error);
        errors.push({
          documentType: docType,
          error: error.message
        });
      }
    }

    // Update vendor status if this is first submission
    if (uploadedDocuments.length > 0) {
      // Dynamically resolve column names to support different schemas
      const hasShopName = await tableHasColumn('vendors', 'shop_name');
      const hasBusinessName = await tableHasColumn('vendors', 'business_name');
      const hasFlatEmail = await tableHasColumn('vendors', 'email');
      const hasOwnerEmail = await tableHasColumn('vendors', 'owner_email');

      const nameCol = hasShopName ? 'shop_name' : (hasBusinessName ? 'business_name' : `NULL`);
      const emailCol = hasFlatEmail ? 'email' : (hasOwnerEmail ? 'owner_email' : `NULL`);

      const [vendorStatus] = await db.promise().query(`
        SELECT status, ${nameCol} AS shop_name, ${emailCol} AS email FROM vendors WHERE id = ?
      `, [vendorId]);

      if (vendorStatus.length > 0 && vendorStatus[0].status === 'DRAFT') {
        await db.promise().query(`
          UPDATE vendors SET status = 'SUBMITTED', kyc_submitted_at = NOW() WHERE id = ?
        `, [vendorId]);
        
        // Trigger KYC submitted notification
        if (global.notificationService) {
          global.notificationService.emit('kycSubmitted', {
            vendor_id: vendorId,
            vendor_name: vendorStatus[0].shop_name,
            vendor_email: vendorStatus[0].email,
            documents_count: uploadedDocuments.length
          });
        }
      }
    }

    res.json({
      success: true,
      data: {
        uploaded: uploadedDocuments,
        errors: errors
      }
    });

  } catch (error) {
    console.error('Error uploading documents:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/kyc/document/:documentId - Delete a document
router.delete('/document/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { vendorId } = req.query;

    // Get document info before deletion
    const [document] = await db.promise().query(`
      SELECT * FROM kyc_documents WHERE id = ? AND vendor_id = ?
    `, [documentId, vendorId]);

    if (document.length === 0) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    const doc = document[0];

    await deleteStoredFile(doc.file_path, doc.mime_type || '');

    // Delete from database
    await db.promise().query(`DELETE FROM kyc_documents WHERE id = ?`, [documentId]);

    // Log deletion
    await logDocumentHistory(
      documentId, vendorId, 'DELETED', doc.doc_status, null,
      `Document deleted: ${doc.original_name}`, null, 'vendor'
    );

    // Create notification
    await createNotification(
      vendorId, null, 'DOCUMENT_UPLOADED',
      'Document Deleted',
      `Your ${doc.document_type.toUpperCase()} document has been deleted.`,
      'LOW'
    );

    res.json({ success: true, message: 'Document deleted successfully' });

  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/kyc/document/:documentId/download - Download a document
router.get('/document/:documentId/download', async (req, res) => {
  try {
    const { documentId } = req.params;
    const { vendorId } = req.query;

    const [document] = await db.promise().query(`
      SELECT * FROM kyc_documents WHERE id = ? AND vendor_id = ?
    `, [documentId, vendorId]);

    if (document.length === 0) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    const doc = document[0];

    if (isRemoteFilePath(doc.file_path)) {
      return res.redirect(doc.file_path);
    }

    const absolute = path.isAbsolute(doc.file_path)
      ? doc.file_path
      : path.join(process.cwd(), doc.file_path.replace(/^\/+/, ''));

    if (!fs.existsSync(absolute)) {
      return res.status(404).json({ success: false, error: 'File not found on server' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${doc.original_name}"`);
    res.setHeader('Content-Type', doc.mime_type);
    
    const fileStream = fs.createReadStream(absolute);
    fileStream.pipe(res);

  } catch (error) {
    console.error('Error downloading document:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/kyc/notifications/:vendorId - Get notifications for vendor
router.get('/notifications/:vendorId', async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { page = 1, limit = 20, unreadOnly = false } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE vendor_id = ?';
    let queryParams = [vendorId];

    if (unreadOnly === 'true') {
      whereClause += ' AND is_read = FALSE';
    }

    const [notifications] = await db.promise().query(`
      SELECT id, notification_type, title, message, priority, is_read, 
             created_at, expires_at, document_id
      FROM kyc_notifications 
      ${whereClause}
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `, [...queryParams, parseInt(limit), parseInt(offset)]);

    // Get total count
    const [countResult] = await db.promise().query(`
      SELECT COUNT(*) as total FROM kyc_notifications ${whereClause}
    `, queryParams);

    res.json({
      success: true,
      data: {
        notifications,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: countResult[0].total,
          pages: Math.ceil(countResult[0].total / limit)
        }
      }
    });

  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PUT /api/kyc/notifications/:notificationId/read - Mark notification as read
router.put('/notifications/:notificationId/read', async (req, res) => {
  try {
    const { notificationId } = req.params;
    const { vendorId } = req.body;

    await db.promise().query(`
      UPDATE kyc_notifications 
      SET is_read = TRUE, read_at = NOW() 
      WHERE id = ? AND vendor_id = ?
    `, [notificationId, vendorId]);

    res.json({ success: true, message: 'Notification marked as read' });

  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/kyc/templates - Get document templates
router.get('/templates', async (req, res) => {
  try {
    const [templates] = await db.promise().query(`
      SELECT document_type, display_name, description, is_required, 
             max_file_size_mb, allowed_formats, validation_rules,
             expiry_tracking, expiry_reminder_days, display_order
      FROM kyc_document_templates 
      WHERE is_active = TRUE 
      ORDER BY display_order
    `);

    res.json({
      success: true,
      data: templates
    });

  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/kyc/status/:vendorId - Get overall KYC status
router.get('/status/:vendorId', async (req, res) => {
  try {
    const { vendorId } = req.params;

    // Get vendor status
    const [vendor] = await db.promise().query(`
      SELECT status, kyc_submitted_at, kyc_reviewed_at, review_notes
      FROM vendors WHERE id = ?
    `, [vendorId]);

    if (vendor.length === 0) {
      return res.status(404).json({ success: false, error: 'Vendor not found' });
    }

    // Get completion data
    const [completionData] = await db.promise().query('CALL CalculateKYCCompletion(?)', [vendorId]);

    // Get summary from view
    const [summary] = await db.promise().query(`
      SELECT * FROM kyc_dashboard_summary WHERE vendor_id = ?
    `, [vendorId]);

    res.json({
      success: true,
      data: {
        vendor: vendor[0],
        completion: completionData[0] || {},
        summary: summary[0] || {}
      }
    });

  } catch (error) {
    console.error('Error fetching KYC status:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
