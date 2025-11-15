const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const db = require('../utils/db');
const crypto = require('crypto');
const { sendPayoutNotification } = require('../utils/notificationService');

// Middleware for admin authentication
const authenticateAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.adminId = decoded.adminId || decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Check admin role
const checkAdminRole = (allowedRoles = ['admin']) => {
  return async (req, res, next) => {
    try {
      const [admin] = await db.promise().query(
        'SELECT role FROM admin_users WHERE id = ?',
        [req.adminId]
      );
      
      if (admin.length === 0 || !allowedRoles.includes(admin[0].role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      
      req.adminRole = admin[0].role;
      next();
    } catch (error) {
      return res.status(500).json({ error: 'Failed to verify admin role' });
    }
  };
};

// Decryption utility
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'your-32-character-secret-key-here!';
const ALGORITHM = 'aes-256-cbc';

function decrypt(text) {
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = textParts.join(':');
    const decipher = crypto.createDecipher(ALGORITHM, ENCRYPTION_KEY);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    return null;
  }
}

// ==================== ADMIN DASHBOARD ====================

// Get payout dashboard stats
router.get('/dashboard/stats', [
  authenticateAdmin,
  checkAdminRole()
], async (req, res) => {
  try {
    // Get payout statistics
    const [payoutStats] = await db.promise().query(`
      SELECT 
        COUNT(*) as total_payouts,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_payouts,
        COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved_payouts,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_payouts,
        COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid_payouts,
        COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected_payouts,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN requested_amount END), 0) as pending_amount,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN final_amount END), 0) as paid_amount,
        COALESCE(SUM(CASE WHEN status IN ('pending', 'approved', 'processing') THEN requested_amount END), 0) as queue_amount
      FROM vendor_payouts
      WHERE requested_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    `);

    // Get payment method verification stats
    const [methodStats] = await db.promise().query(`
      SELECT 
        COUNT(*) as total_methods,
        COUNT(CASE WHEN verification_status = 'pending' THEN 1 END) as pending_verification,
        COUNT(CASE WHEN verification_status = 'verified' THEN 1 END) as verified_methods,
        COUNT(CASE WHEN verification_status = 'rejected' THEN 1 END) as rejected_methods
      FROM vendor_payment_methods
      WHERE is_active = TRUE
    `);

    // Get recent activity
    const [recentActivity] = await db.promise().query(`
      SELECT 
        'payout' as type,
        vp.id,
        vp.requested_amount as amount,
        vp.status,
        vp.requested_at as created_at,
        v.business_name as vendor_name
      FROM vendor_payouts vp
      JOIN vendors v ON vp.vendor_id = v.id
      WHERE vp.requested_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      
      UNION ALL
      
      SELECT 
        'payment_method' as type,
        vpm.id,
        NULL as amount,
        vpm.verification_status as status,
        vpm.created_at,
        v.business_name as vendor_name
      FROM vendor_payment_methods vpm
      JOIN vendors v ON vpm.vendor_id = v.id
      WHERE vpm.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      
      ORDER BY created_at DESC
      LIMIT 20
    `);

    res.json({
      payout_stats: payoutStats[0],
      method_stats: methodStats[0],
      recent_activity: recentActivity
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

// ==================== PAYOUT MANAGEMENT ====================

// Get payout queue (pending approvals)
router.get('/payouts/queue', [
  authenticateAdmin,
  checkAdminRole(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('status').optional().isIn(['pending', 'approved', 'processing']),
  query('sort').optional().isIn(['amount_asc', 'amount_desc', 'date_asc', 'date_desc'])
], async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const status = req.query.status || 'pending';
    const sort = req.query.sort || 'date_desc';

    let orderClause = 'ORDER BY vp.requested_at DESC';
    switch (sort) {
      case 'amount_asc':
        orderClause = 'ORDER BY vp.requested_amount ASC';
        break;
      case 'amount_desc':
        orderClause = 'ORDER BY vp.requested_amount DESC';
        break;
      case 'date_asc':
        orderClause = 'ORDER BY vp.requested_at ASC';
        break;
    }

    const [payouts] = await db.promise().query(`
      SELECT 
        vp.*,
        v.business_name, v.owner_name, v.owner_email, v.owner_phone,
        vpm.method_type, vpm.account_holder_name, vpm.bank_name, vpm.upi_id,
        vwb.available_balance, vwb.total_earnings
      FROM vendor_payouts vp
      JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN vendor_payment_methods vpm ON vp.payment_method_id = vpm.id
      LEFT JOIN vendor_wallet_balances vwb ON vp.vendor_id = vwb.vendor_id
      WHERE vp.status = ?
      ${orderClause}
      LIMIT ? OFFSET ?
    `, [status, limit, offset]);

    // Get total count
    const [countResult] = await db.promise().query(`
      SELECT COUNT(*) as total FROM vendor_payouts WHERE status = ?
    `, [status]);

    res.json({
      payouts,
      pagination: {
        page,
        limit,
        total: countResult[0].total,
        pages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching payout queue:', error);
    res.status(500).json({ error: 'Failed to fetch payout queue' });
  }
});

// Get single payout details
router.get('/payouts/:id', [
  authenticateAdmin,
  checkAdminRole(),
  param('id').isInt()
], async (req, res) => {
  try {
    const [payout] = await db.promise().query(`
      SELECT 
        vp.*,
        v.business_name, v.owner_name, v.owner_email, v.owner_phone,
        vpm.method_type, vpm.account_holder_name, vpm.bank_name, 
        vpm.branch_name, vpm.upi_id, vpm.ifsc_code,
        vpm.account_number_encrypted,
        vwb.available_balance, vwb.total_earnings,
        aa.username as approved_by_username,
        ap.username as processed_by_username
      FROM vendor_payouts vp
      JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN vendor_payment_methods vpm ON vp.payment_method_id = vpm.id
      LEFT JOIN vendor_wallet_balances vwb ON vp.vendor_id = vwb.vendor_id
      LEFT JOIN admin_users aa ON vp.approved_by = aa.id
      LEFT JOIN admin_users ap ON vp.processed_by = ap.id
      WHERE vp.id = ?
    `, [req.params.id]);

    if (payout.length === 0) {
      return res.status(404).json({ error: 'Payout not found' });
    }

    // Decrypt account number for admin view
    const payoutData = payout[0];
    if (payoutData.account_number_encrypted) {
      payoutData.account_number = decrypt(payoutData.account_number_encrypted);
    }

    // Get audit logs
    const [auditLogs] = await db.promise().query(`
      SELECT 
        pal.*, au.username as performed_by_username
      FROM payout_audit_logs pal
      LEFT JOIN admin_users au ON pal.performed_by = au.id
      WHERE pal.payout_id = ?
      ORDER BY pal.created_at DESC
    `, [req.params.id]);

    res.json({
      ...payoutData,
      audit_logs: auditLogs
    });
  } catch (error) {
    console.error('Error fetching payout details:', error);
    res.status(500).json({ error: 'Failed to fetch payout details' });
  }
});

// Approve payout
router.post('/payouts/:id/approve', [
  authenticateAdmin,
  checkAdminRole(),
  param('id').isInt(),
  body('approved_amount').optional().isFloat({ min: 1 }),
  body('admin_notes').optional().isLength({ max: 1000 })
], async (req, res) => {
  const connection = await db.promise().getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const payoutId = req.params.id;
    const { approved_amount, admin_notes } = req.body;

    // Get current payout
    const [payout] = await connection.query(`
      SELECT * FROM vendor_payouts WHERE id = ? AND status = 'pending'
    `, [payoutId]);

    if (payout.length === 0) {
      return res.status(404).json({ error: 'Payout not found or not in pending status' });
    }

    const currentPayout = payout[0];
    const finalApprovedAmount = approved_amount || currentPayout.requested_amount;

    // Recalculate fees if amount changed
    const [config] = await connection.query(`
      SELECT * FROM payout_configurations WHERE is_active = TRUE LIMIT 1
    `);
    
    const payoutConfig = config[0];
    const processingFee = Math.max(
      finalApprovedAmount * payoutConfig.processing_fee_percentage,
      payoutConfig.processing_fee_fixed
    );
    const tdsAmount = finalApprovedAmount * payoutConfig.tds_percentage;
    const finalAmount = finalApprovedAmount - processingFee - tdsAmount;

    // Update payout status
    await connection.query(`
      UPDATE vendor_payouts 
      SET status = 'approved',
          approved_amount = ?,
          final_amount = ?,
          processing_fee = ?,
          tds_amount = ?,
          approved_at = CURRENT_TIMESTAMP,
          approved_by = ?,
          admin_notes = COALESCE(?, admin_notes)
      WHERE id = ?
    `, [finalApprovedAmount, finalAmount, processingFee, tdsAmount, req.adminId, admin_notes, payoutId]);

    // Update vendor balance if amount changed
    if (finalApprovedAmount !== currentPayout.requested_amount) {
      const difference = currentPayout.requested_amount - finalApprovedAmount;
      await connection.query(`
        UPDATE vendor_wallet_balances 
        SET pending_balance = pending_balance - ?,
            available_balance = available_balance + ?
        WHERE vendor_id = ?
      `, [difference, difference, currentPayout.vendor_id]);

      // Add wallet transaction for the difference
      if (difference !== 0) {
        const [currentBalance] = await connection.query(`
          SELECT available_balance FROM vendor_wallet_balances WHERE vendor_id = ?
        `, [currentPayout.vendor_id]);

        await connection.query(`
          INSERT INTO vendor_wallet_transactions (
            vendor_id, transaction_type, amount, balance_after,
            reference_type, reference_id, payout_id, description
          ) VALUES (?, ?, ?, ?, 'payout_adjustment', ?, ?, ?)
        `, [
          currentPayout.vendor_id, 
          difference > 0 ? 'credit' : 'debit', 
          Math.abs(difference), 
          currentBalance[0].available_balance,
          payoutId, payoutId,
          `Payout amount adjustment: ${difference > 0 ? '+' : ''}₹${difference}`
        ]);
      }
    }

    // Log audit trail
    await connection.query(`
      INSERT INTO payout_audit_logs (
        payout_id, action, old_status, new_status, performed_by, user_type, notes
      ) VALUES (?, 'approved', 'pending', 'approved', ?, 'admin', ?)
    `, [payoutId, req.adminId, `Approved by admin. ${admin_notes || ''}`]);

    // Send notification
    try {
      await sendPayoutNotification(currentPayout.vendor_id, payoutId, 'payout_approved', {
        vendorName: 'Vendor',
        payoutId: payoutId,
        approvedAmount: finalApprovedAmount,
        paymentMethod: 'Bank Transfer', // You can get this from the payout data
        adminNotes: admin_notes
      });
    } catch (notificationError) {
      console.error('Error sending approval notification:', notificationError);
    }

    await connection.commit();

    res.json({
      message: 'Payout approved successfully',
      approved_amount: finalApprovedAmount,
      final_amount: finalAmount
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error approving payout:', error);
    res.status(500).json({ error: 'Failed to approve payout' });
  } finally {
    connection.release();
  }
});

// Reject payout
router.post('/payouts/:id/reject', [
  authenticateAdmin,
  checkAdminRole(),
  param('id').isInt(),
  body('rejection_reason').isLength({ min: 1, max: 1000 })
], async (req, res) => {
  const connection = await db.promise().getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const payoutId = req.params.id;
    const { rejection_reason } = req.body;

    // Get current payout
    const [payout] = await connection.query(`
      SELECT * FROM vendor_payouts WHERE id = ? AND status = 'pending'
    `, [payoutId]);

    if (payout.length === 0) {
      return res.status(404).json({ error: 'Payout not found or not in pending status' });
    }

    const currentPayout = payout[0];

    // Update payout status
    await connection.query(`
      UPDATE vendor_payouts 
      SET status = 'rejected',
          rejection_reason = ?,
          rejected_at = CURRENT_TIMESTAMP,
          approved_by = ?
      WHERE id = ?
    `, [rejection_reason, req.adminId, payoutId]);

    // Return amount to vendor balance
    await connection.query(`
      UPDATE vendor_wallet_balances 
      SET pending_balance = pending_balance - ?,
          available_balance = available_balance + ?
      WHERE vendor_id = ?
    `, [currentPayout.requested_amount, currentPayout.requested_amount, currentPayout.vendor_id]);

    // Add wallet transaction
    const [currentBalance] = await connection.query(`
      SELECT available_balance FROM vendor_wallet_balances WHERE vendor_id = ?
    `, [currentPayout.vendor_id]);

    await connection.query(`
      INSERT INTO vendor_wallet_transactions (
        vendor_id, transaction_type, amount, balance_after,
        reference_type, reference_id, payout_id, description
      ) VALUES (?, 'credit', ?, ?, 'payout_reversal', ?, ?, ?)
    `, [
      currentPayout.vendor_id, currentPayout.requested_amount, currentBalance[0].available_balance,
      payoutId, payoutId,
      `Payout request rejected and amount returned: ₹${currentPayout.requested_amount}`
    ]);

    // Log audit trail
    await connection.query(`
      INSERT INTO payout_audit_logs (
        payout_id, action, old_status, new_status, performed_by, user_type, notes
      ) VALUES (?, 'rejected', 'pending', 'rejected', ?, 'admin', ?)
    `, [payoutId, req.adminId, `Rejected: ${rejection_reason}`]);

    // Create notification
    await connection.query(`
      INSERT INTO payout_notifications (
        vendor_id, payout_id, notification_type, title, message
      ) VALUES (?, ?, 'payout_rejected', ?, ?)
    `, [
      currentPayout.vendor_id, payoutId,
      'Payout Rejected',
      `Your payout request for ₹${currentPayout.requested_amount} has been rejected. Reason: ${rejection_reason}`
    ]);

    await connection.commit();

    res.json({ message: 'Payout rejected successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error rejecting payout:', error);
    res.status(500).json({ error: 'Failed to reject payout' });
  } finally {
    connection.release();
  }
});

// Mark payout as processing
router.post('/payouts/:id/process', [
  authenticateAdmin,
  checkAdminRole(),
  param('id').isInt(),
  body('admin_notes').optional().isLength({ max: 1000 })
], async (req, res) => {
  const connection = await db.promise().getConnection();
  
  try {
    await connection.beginTransaction();
    
    const payoutId = req.params.id;
    const { admin_notes } = req.body;

    // Get current payout
    const [payout] = await connection.query(`
      SELECT * FROM vendor_payouts WHERE id = ? AND status = 'approved'
    `, [payoutId]);

    if (payout.length === 0) {
      return res.status(404).json({ error: 'Payout not found or not in approved status' });
    }

    // Update payout status
    await connection.query(`
      UPDATE vendor_payouts 
      SET status = 'processing',
          processing_at = CURRENT_TIMESTAMP,
          processed_by = ?,
          admin_notes = COALESCE(?, admin_notes)
      WHERE id = ?
    `, [req.adminId, admin_notes, payoutId]);

    // Log audit trail
    await connection.query(`
      INSERT INTO payout_audit_logs (
        payout_id, action, old_status, new_status, performed_by, user_type, notes
      ) VALUES (?, 'processing', 'approved', 'processing', ?, 'admin', ?)
    `, [payoutId, req.adminId, `Processing started. ${admin_notes || ''}`]);

    await connection.commit();

    res.json({ message: 'Payout marked as processing' });
  } catch (error) {
    await connection.rollback();
    console.error('Error processing payout:', error);
    res.status(500).json({ error: 'Failed to process payout' });
  } finally {
    connection.release();
  }
});

// Mark payout as paid
router.post('/payouts/:id/paid', [
  authenticateAdmin,
  checkAdminRole(),
  param('id').isInt(),
  body('transaction_id').isLength({ min: 1, max: 100 }),
  body('reference_number').optional().isLength({ max: 100 }),
  body('admin_notes').optional().isLength({ max: 1000 })
], async (req, res) => {
  const connection = await db.promise().getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const payoutId = req.params.id;
    const { transaction_id, reference_number, admin_notes } = req.body;

    // Get current payout
    const [payout] = await connection.query(`
      SELECT * FROM vendor_payouts WHERE id = ? AND status = 'processing'
    `, [payoutId]);

    if (payout.length === 0) {
      return res.status(404).json({ error: 'Payout not found or not in processing status' });
    }

    const currentPayout = payout[0];

    // Update payout status
    await connection.query(`
      UPDATE vendor_payouts 
      SET status = 'paid',
          transaction_id = ?,
          reference_number = ?,
          paid_at = CURRENT_TIMESTAMP,
          admin_notes = COALESCE(?, admin_notes)
      WHERE id = ?
    `, [transaction_id, reference_number, admin_notes, payoutId]);

    // Update vendor balance - move from pending to paid
    await connection.query(`
      UPDATE vendor_wallet_balances 
      SET pending_balance = pending_balance - ?,
          total_payouts = total_payouts + ?,
          last_payout_at = CURRENT_TIMESTAMP
      WHERE vendor_id = ?
    `, [currentPayout.requested_amount, currentPayout.final_amount, currentPayout.vendor_id]);

    // Log audit trail
    await connection.query(`
      INSERT INTO payout_audit_logs (
        payout_id, action, old_status, new_status, performed_by, user_type, notes
      ) VALUES (?, 'paid', 'processing', 'paid', ?, 'admin', ?)
    `, [payoutId, req.adminId, `Payment completed. Transaction ID: ${transaction_id}. ${admin_notes || ''}`]);

    // Create notification
    await connection.query(`
      INSERT INTO payout_notifications (
        vendor_id, payout_id, notification_type, title, message
      ) VALUES (?, ?, 'payout_paid', ?, ?)
    `, [
      currentPayout.vendor_id, payoutId,
      'Payout Completed',
      `Your payout of ₹${currentPayout.final_amount} has been successfully processed. Transaction ID: ${transaction_id}`
    ]);

    await connection.commit();

    res.json({ 
      message: 'Payout marked as paid successfully',
      transaction_id,
      reference_number
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error marking payout as paid:', error);
    res.status(500).json({ error: 'Failed to mark payout as paid' });
  } finally {
    connection.release();
  }
});

// ==================== PAYMENT METHOD MANAGEMENT ====================

// Get payment methods for verification
router.get('/payment-methods/pending', [
  authenticateAdmin,
  checkAdminRole(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const [methods] = await db.promise().query(`
      SELECT 
        vpm.*,
        v.business_name, v.owner_name, v.owner_email, v.owner_phone
      FROM vendor_payment_methods vpm
      JOIN vendors v ON vpm.vendor_id = v.id
      WHERE vpm.verification_status = 'pending' AND vpm.is_active = TRUE
      ORDER BY vpm.created_at ASC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    // Decrypt account numbers for admin view
    const methodsWithDecrypted = methods.map(method => ({
      ...method,
      account_number: method.account_number_encrypted ? decrypt(method.account_number_encrypted) : null
    }));

    // Get total count
    const [countResult] = await db.promise().query(`
      SELECT COUNT(*) as total FROM vendor_payment_methods 
      WHERE verification_status = 'pending' AND is_active = TRUE
    `);

    res.json({
      methods: methodsWithDecrypted,
      pagination: {
        page,
        limit,
        total: countResult[0].total,
        pages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching pending payment methods:', error);
    res.status(500).json({ error: 'Failed to fetch pending payment methods' });
  }
});

// Verify payment method
router.post('/payment-methods/:id/verify', [
  authenticateAdmin,
  checkAdminRole(),
  param('id').isInt(),
  body('verification_status').isIn(['verified', 'rejected']),
  body('verification_notes').optional().isLength({ max: 1000 })
], async (req, res) => {
  const connection = await db.promise().getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const methodId = req.params.id;
    const { verification_status, verification_notes } = req.body;

    // Get payment method
    const [method] = await connection.query(`
      SELECT * FROM vendor_payment_methods WHERE id = ?
    `, [methodId]);

    if (method.length === 0) {
      return res.status(404).json({ error: 'Payment method not found' });
    }

    const currentMethod = method[0];

    // Update verification status
    await connection.query(`
      UPDATE vendor_payment_methods 
      SET verification_status = ?,
          verification_notes = ?,
          verified_by = ?,
          verified_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [verification_status, verification_notes, req.adminId, methodId]);

    // Create notification
    const notificationType = verification_status === 'verified' ? 'payment_method_verified' : 'payment_method_rejected';
    const title = verification_status === 'verified' ? 'Payment Method Verified' : 'Payment Method Rejected';
    const message = verification_status === 'verified' 
      ? 'Your payment method has been verified and is now available for payouts.'
      : `Your payment method verification was rejected. Reason: ${verification_notes}`;

    await connection.query(`
      INSERT INTO payout_notifications (
        vendor_id, notification_type, title, message
      ) VALUES (?, ?, ?, ?)
    `, [currentMethod.vendor_id, notificationType, title, message]);

    await connection.commit();

    res.json({ 
      message: `Payment method ${verification_status} successfully` 
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error verifying payment method:', error);
    res.status(500).json({ error: 'Failed to verify payment method' });
  } finally {
    connection.release();
  }
});

// ==================== REPORTS AND ANALYTICS ====================

// Get payout reports
router.get('/reports/payouts', [
  authenticateAdmin,
  checkAdminRole(),
  query('start_date').isISO8601(),
  query('end_date').isISO8601(),
  query('status').optional().isIn(['pending', 'approved', 'processing', 'paid', 'rejected', 'failed']),
  query('export').optional().isIn(['csv', 'excel'])
], async (req, res) => {
  try {
    const { start_date, end_date, status, export: exportFormat } = req.query;

    let whereClause = 'WHERE vp.requested_at BETWEEN ? AND ?';
    let queryParams = [start_date, end_date];

    if (status) {
      whereClause += ' AND vp.status = ?';
      queryParams.push(status);
    }

    const [payouts] = await db.promise().query(`
      SELECT 
        vp.*,
        v.business_name, v.owner_name, v.owner_email,
        vpm.method_type, vpm.account_holder_name, vpm.bank_name, vpm.upi_id
      FROM vendor_payouts vp
      JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN vendor_payment_methods vpm ON vp.payment_method_id = vpm.id
      ${whereClause}
      ORDER BY vp.requested_at DESC
    `, queryParams);

    if (exportFormat) {
      // Handle CSV/Excel export
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Payout Report');

      // Add headers
      worksheet.columns = [
        { header: 'Payout ID', key: 'id', width: 10 },
        { header: 'Vendor', key: 'business_name', width: 20 },
        { header: 'Requested Amount', key: 'requested_amount', width: 15 },
        { header: 'Final Amount', key: 'final_amount', width: 15 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Payment Method', key: 'method_type', width: 15 },
        { header: 'Transaction ID', key: 'transaction_id', width: 20 },
        { header: 'Requested At', key: 'requested_at', width: 20 },
        { header: 'Paid At', key: 'paid_at', width: 20 }
      ];

      // Add data
      payouts.forEach(payout => {
        worksheet.addRow(payout);
      });

      // Set response headers
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=payout-report-${start_date}-${end_date}.xlsx`);

      // Write to response
      await workbook.xlsx.write(res);
      res.end();
    } else {
      // Return JSON data
      const summary = {
        total_payouts: payouts.length,
        total_requested: payouts.reduce((sum, p) => sum + parseFloat(p.requested_amount || 0), 0),
        total_paid: payouts.filter(p => p.status === 'paid').reduce((sum, p) => sum + parseFloat(p.final_amount || 0), 0),
        status_breakdown: {}
      };

      // Calculate status breakdown
      payouts.forEach(payout => {
        summary.status_breakdown[payout.status] = (summary.status_breakdown[payout.status] || 0) + 1;
      });

      res.json({
        summary,
        payouts
      });
    }
  } catch (error) {
    console.error('Error generating payout report:', error);
    res.status(500).json({ error: 'Failed to generate payout report' });
  }
});

// ==================== CONFIGURATION ====================

// Get payout configuration
router.get('/config', [
  authenticateAdmin,
  checkAdminRole(['admin'])
], async (req, res) => {
  try {
    const [config] = await db.promise().query(`
      SELECT * FROM payout_configurations WHERE is_active = TRUE LIMIT 1
    `);

    res.json(config[0] || {});
  } catch (error) {
    console.error('Error fetching payout config:', error);
    res.status(500).json({ error: 'Failed to fetch payout config' });
  }
});

// Update payout configuration
router.put('/config', [
  authenticateAdmin,
  checkAdminRole(['admin']),
  body('min_payout_amount').optional().isFloat({ min: 1 }),
  body('max_payout_amount').optional().isFloat({ min: 1 }),
  body('daily_payout_limit').optional().isFloat({ min: 1 }),
  body('processing_fee_percentage').optional().isFloat({ min: 0, max: 1 }),
  body('processing_fee_fixed').optional().isFloat({ min: 0 }),
  body('tds_percentage').optional().isFloat({ min: 0, max: 1 }),
  body('auto_approval_limit').optional().isFloat({ min: 0 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const updates = req.body;
    const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updates);

    await db.promise().query(`
      UPDATE payout_configurations 
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP
      WHERE is_active = TRUE
    `, values);

    res.json({ message: 'Payout configuration updated successfully' });
  } catch (error) {
    console.error('Error updating payout config:', error);
    res.status(500).json({ error: 'Failed to update payout config' });
  }
});

module.exports = router;
