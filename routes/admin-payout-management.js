const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const db = require('../utils/db');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

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

// Encryption utilities
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

// ==================== PAYOUT DASHBOARD ====================

// Get dashboard summary statistics
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
        COALESCE(SUM(CASE WHEN status = 'approved' THEN approved_amount END), 0) as approved_amount,
        COALESCE(SUM(CASE WHEN status = 'processing' THEN approved_amount END), 0) as processing_amount,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN final_amount END), 0) as paid_amount
      FROM vendor_payouts
      WHERE requested_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    `);

    // Get trends data (last 7 days)
    const [trendsData] = await db.promise().query(`
      SELECT 
        DATE(requested_at) as date,
        COUNT(*) as payout_count,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN final_amount END), 0) as paid_amount,
        COUNT(CASE WHEN payment_method = 'bank_transfer' THEN 1 END) as bank_transfers,
        COUNT(CASE WHEN payment_method = 'upi' THEN 1 END) as upi_transfers
      FROM vendor_payouts
      WHERE requested_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(requested_at)
      ORDER BY date DESC
    `);

    // Get payment method distribution
    const [methodStats] = await db.promise().query(`
      SELECT 
        payment_method,
        COUNT(*) as count,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN final_amount END), 0) as total_amount
      FROM vendor_payouts
      WHERE requested_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY payment_method
    `);

    // Get top vendors by payout volume
    const [topVendors] = await db.promise().query(`
      SELECT 
        v.shop_name,
        v.owner_name,
        COUNT(vp.id) as payout_count,
        COALESCE(SUM(CASE WHEN vp.status = 'paid' THEN vp.final_amount END), 0) as total_paid
      FROM vendor_payouts vp
      JOIN vendors v ON vp.vendor_id = v.id
      WHERE vp.requested_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        AND vp.status = 'paid'
      GROUP BY v.id, v.shop_name, v.owner_name
      ORDER BY total_paid DESC
      LIMIT 10
    `);

    res.json({
      payout_stats: payoutStats[0],
      trends: trendsData,
      method_stats: methodStats,
      top_vendors: topVendors
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

// ==================== PAYOUT REQUESTS MANAGEMENT ====================

// Get all payout requests with filters
router.get('/payouts', [
  authenticateAdmin,
  checkAdminRole(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('status').optional().isIn(['pending', 'approved', 'processing', 'paid', 'rejected', 'failed']),
  query('payment_method').optional().isIn(['bank_transfer', 'upi', 'cheque']),
  query('vendor_search').optional().isLength({ min: 1 }),
  query('date_from').optional().isISO8601(),
  query('date_to').optional().isISO8601(),
  query('sort').optional().isIn(['amount_asc', 'amount_desc', 'date_asc', 'date_desc'])
], async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    const {
      status,
      payment_method,
      vendor_search,
      date_from,
      date_to,
      sort = 'date_desc'
    } = req.query;

    // Build WHERE clause
    let whereConditions = [];
    let queryParams = [];

    if (status) {
      whereConditions.push('vp.status = ?');
      queryParams.push(status);
    }

    if (payment_method) {
      whereConditions.push('vp.payment_method = ?');
      queryParams.push(payment_method);
    }

    if (vendor_search) {
      whereConditions.push('(v.shop_name LIKE ? OR v.owner_name LIKE ? OR v.owner_email LIKE ?)');
      const searchParam = `%${vendor_search}%`;
      queryParams.push(searchParam, searchParam, searchParam);
    }

    if (date_from) {
      whereConditions.push('vp.requested_at >= ?');
      queryParams.push(date_from);
    }

    if (date_to) {
      whereConditions.push('vp.requested_at <= ?');
      queryParams.push(date_to);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Build ORDER BY clause
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

    // Main query
    const [payouts] = await db.promise().query(`
      SELECT 
        vp.*,
        v.shop_name as vendor_name,
        v.owner_name,
        v.owner_email,
        v.owner_phone,
        vpm.method_type,
        vpm.account_holder_name,
        vpm.bank_name,
        vpm.upi_id,
        CASE 
          WHEN vpm.account_number_encrypted IS NOT NULL 
          THEN CONCAT('****', RIGHT(vpm.account_number_hash, 4))
          ELSE NULL
        END as masked_account_number,
        vwb.available_balance as vendor_balance,
        aa.username as approved_by_admin
      FROM vendor_payouts vp
      JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN vendor_payment_methods vpm ON vp.payment_method_id = vpm.id
      LEFT JOIN vendor_wallet_balances vwb ON vp.vendor_id = vwb.vendor_id
      LEFT JOIN admin_users aa ON vp.approved_by = aa.id
      ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `, [...queryParams, limit, offset]);

    // Get total count
    const [countResult] = await db.promise().query(`
      SELECT COUNT(*) as total 
      FROM vendor_payouts vp
      JOIN vendors v ON vp.vendor_id = v.id
      ${whereClause}
    `, queryParams);

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
    console.error('Error fetching payouts:', error);
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

// Get single payout details
router.get('/payouts/:id', [
  authenticateAdmin,
  checkAdminRole(),
  param('id').isInt()
], async (req, res) => {
  try {
    // Get payout details
    const [payout] = await db.promise().query(`
      SELECT 
        vp.*,
        v.shop_name as vendor_name,
        v.owner_name,
        v.owner_email,
        v.owner_phone,
        v.business_name,
        vpm.method_type,
        vpm.account_holder_name,
        vpm.bank_name,
        vpm.branch_name,
        vpm.upi_id,
        vpm.ifsc_code,
        vpm.account_number_encrypted,
        vpm.verification_status as payment_method_status,
        vwb.available_balance,
        vwb.total_earnings,
        vwb.total_payouts,
        aa.username as approved_by_admin,
        ap.username as processed_by_admin
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

    const payoutData = payout[0];

    // Decrypt account number for admin view
    if (payoutData.account_number_encrypted) {
      payoutData.account_number = decrypt(payoutData.account_number_encrypted);
    }

    // Get audit logs
    const [auditLogs] = await db.promise().query(`
      SELECT 
        pal.*,
        au.username as performed_by_username
      FROM payout_audit_logs pal
      LEFT JOIN admin_users au ON pal.performed_by = au.id
      WHERE pal.payout_id = ?
      ORDER BY pal.created_at DESC
    `, [req.params.id]);

    // Get vendor's recent transactions
    const [recentTransactions] = await db.promise().query(`
      SELECT * FROM vendor_wallet_transactions
      WHERE vendor_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `, [payoutData.vendor_id]);

    res.json({
      ...payoutData,
      audit_logs: auditLogs,
      recent_transactions: recentTransactions
    });
  } catch (error) {
    console.error('Error fetching payout details:', error);
    res.status(500).json({ error: 'Failed to fetch payout details' });
  }
});

// ==================== PAYOUT ACTIONS ====================

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

    // Get payout configuration for fee calculation
    const [config] = await connection.query(`
      SELECT * FROM payout_configurations WHERE is_active = TRUE LIMIT 1
    `);
    
    const payoutConfig = config[0] || {};
    const processingFee = Math.max(
      finalApprovedAmount * (payoutConfig.processing_fee_percentage || 0.005),
      payoutConfig.processing_fee_fixed || 5.00
    );
    const tdsAmount = finalApprovedAmount * (payoutConfig.tds_percentage || 0.01);
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

    await connection.commit();

    res.json({
      message: 'Payout approved successfully',
      approved_amount: finalApprovedAmount,
      final_amount: finalAmount,
      processing_fee: processingFee,
      tds_amount: tdsAmount
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

// ==================== BULK OPERATIONS ====================

// Bulk approve payouts
router.post('/payouts/bulk/approve', [
  authenticateAdmin,
  checkAdminRole(),
  body('payout_ids').isArray({ min: 1 }),
  body('payout_ids.*').isInt(),
  body('admin_notes').optional().isLength({ max: 1000 })
], async (req, res) => {
  const connection = await db.promise().getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { payout_ids, admin_notes } = req.body;
    let processed = 0;
    let failed = 0;

    for (const payoutId of payout_ids) {
      try {
        // Get payout configuration for fee calculation
        const [config] = await connection.query(`
          SELECT * FROM payout_configurations WHERE is_active = TRUE LIMIT 1
        `);
        
        const payoutConfig = config[0] || {};

        // Get current payout
        const [payout] = await connection.query(`
          SELECT * FROM vendor_payouts WHERE id = ? AND status = 'pending'
        `, [payoutId]);

        if (payout.length === 0) {
          failed++;
          continue;
        }

        const currentPayout = payout[0];
        const approvedAmount = currentPayout.requested_amount;
        const processingFee = Math.max(
          approvedAmount * (payoutConfig.processing_fee_percentage || 0.005),
          payoutConfig.processing_fee_fixed || 5.00
        );
        const tdsAmount = approvedAmount * (payoutConfig.tds_percentage || 0.01);
        const finalAmount = approvedAmount - processingFee - tdsAmount;

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
              admin_notes = ?
          WHERE id = ?
        `, [approvedAmount, finalAmount, processingFee, tdsAmount, req.adminId, admin_notes, payoutId]);

        // Log audit trail
        await connection.query(`
          INSERT INTO payout_audit_logs (
            payout_id, action, old_status, new_status, performed_by, user_type, notes
          ) VALUES (?, 'approved', 'pending', 'approved', ?, 'admin', ?)
        `, [payoutId, req.adminId, `Bulk approved. ${admin_notes || ''}`]);

        processed++;
      } catch (error) {
        console.error(`Error processing payout ${payoutId}:`, error);
        failed++;
      }
    }

    await connection.commit();

    res.json({
      message: 'Bulk approval completed',
      processed,
      failed,
      total: payout_ids.length
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error in bulk approval:', error);
    res.status(500).json({ error: 'Failed to process bulk approval' });
  } finally {
    connection.release();
  }
});

// ==================== REPORTS AND EXPORTS ====================

// Export payouts report
router.get('/payouts/export', [
  authenticateAdmin,
  checkAdminRole(),
  query('format').isIn(['csv', 'excel']),
  query('status').optional().isIn(['pending', 'approved', 'processing', 'paid', 'rejected', 'failed']),
  query('date_from').optional().isISO8601(),
  query('date_to').optional().isISO8601()
], async (req, res) => {
  try {
    const { format, status, date_from, date_to } = req.query;

    // Build WHERE clause
    let whereConditions = [];
    let queryParams = [];

    if (status) {
      whereConditions.push('vp.status = ?');
      queryParams.push(status);
    }

    if (date_from) {
      whereConditions.push('vp.requested_at >= ?');
      queryParams.push(date_from);
    }

    if (date_to) {
      whereConditions.push('vp.requested_at <= ?');
      queryParams.push(date_to);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const [payouts] = await db.promise().query(`
      SELECT 
        vp.id,
        v.shop_name as vendor_name,
        v.owner_name,
        v.owner_email,
        vp.requested_amount,
        vp.approved_amount,
        vp.final_amount,
        vp.processing_fee,
        vp.tds_amount,
        vp.status,
        vp.payment_method,
        vp.transaction_id,
        vp.reference_number,
        vp.requested_at,
        vp.approved_at,
        vp.paid_at,
        vpm.method_type,
        vpm.bank_name,
        vpm.upi_id
      FROM vendor_payouts vp
      JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN vendor_payment_methods vpm ON vp.payment_method_id = vpm.id
      ${whereClause}
      ORDER BY vp.requested_at DESC
    `, queryParams);

    if (format === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Payout Report');

      // Add headers
      worksheet.columns = [
        { header: 'Payout ID', key: 'id', width: 10 },
        { header: 'Vendor Name', key: 'vendor_name', width: 20 },
        { header: 'Owner Name', key: 'owner_name', width: 20 },
        { header: 'Email', key: 'owner_email', width: 25 },
        { header: 'Requested Amount', key: 'requested_amount', width: 15 },
        { header: 'Approved Amount', key: 'approved_amount', width: 15 },
        { header: 'Final Amount', key: 'final_amount', width: 15 },
        { header: 'Processing Fee', key: 'processing_fee', width: 15 },
        { header: 'TDS Amount', key: 'tds_amount', width: 15 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Payment Method', key: 'payment_method', width: 15 },
        { header: 'Transaction ID', key: 'transaction_id', width: 20 },
        { header: 'Reference Number', key: 'reference_number', width: 20 },
        { header: 'Requested At', key: 'requested_at', width: 20 },
        { header: 'Approved At', key: 'approved_at', width: 20 },
        { header: 'Paid At', key: 'paid_at', width: 20 }
      ];

      // Add data
      payouts.forEach(payout => {
        worksheet.addRow(payout);
      });

      // Set response headers
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=payout-report-${Date.now()}.xlsx`);

      // Write to response
      await workbook.xlsx.write(res);
      res.end();
    } else {
      // CSV format
      const csvHeaders = [
        'Payout ID', 'Vendor Name', 'Owner Name', 'Email', 'Requested Amount',
        'Approved Amount', 'Final Amount', 'Processing Fee', 'TDS Amount',
        'Status', 'Payment Method', 'Transaction ID', 'Reference Number',
        'Requested At', 'Approved At', 'Paid At'
      ];

      let csvContent = csvHeaders.join(',') + '\n';
      
      payouts.forEach(payout => {
        const row = [
          payout.id,
          `"${payout.vendor_name || ''}"`,
          `"${payout.owner_name || ''}"`,
          `"${payout.owner_email || ''}"`,
          payout.requested_amount || 0,
          payout.approved_amount || 0,
          payout.final_amount || 0,
          payout.processing_fee || 0,
          payout.tds_amount || 0,
          payout.status,
          payout.payment_method,
          `"${payout.transaction_id || ''}"`,
          `"${payout.reference_number || ''}"`,
          payout.requested_at,
          payout.approved_at || '',
          payout.paid_at || ''
        ];
        csvContent += row.join(',') + '\n';
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=payout-report-${Date.now()}.csv`);
      res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting payouts:', error);
    res.status(500).json({ error: 'Failed to export payouts' });
  }
});

module.exports = router;
