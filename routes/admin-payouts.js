const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const crypto = require('crypto');
const { body, validationResult, param, query } = require('express-validator');

// Middleware to check admin authentication
const authenticateAdmin = (req, res, next) => {
  const adminId = req.headers['admin-id'] || req.body.admin_id;
  if (!adminId) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  req.adminId = parseInt(adminId);
  next();
};

// Middleware to check admin role permissions
const checkAdminRole = (requiredRoles = ['admin']) => {
  return async (req, res, next) => {
    try {
      const [admin] = await db.promise().query(`
        SELECT role FROM admin_users WHERE id = ?
      `, [req.adminId]);

      if (admin.length === 0 || !requiredRoles.includes(admin[0].role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      req.adminRole = admin[0].role;
      next();
    } catch (error) {
      console.error('Error checking admin role:', error);
      res.status(500).json({ error: 'Failed to verify permissions' });
    }
  };
};

// ADMIN DASHBOARD ROUTES

// Get payout dashboard statistics
router.get('/dashboard/stats', [
  authenticateAdmin,
  checkAdminRole()
], async (req, res) => {
  try {
    const [stats] = await db.promise().query(`
      SELECT 
        COUNT(*) as total_requests,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_requests,
        COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved_requests,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_requests,
        COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid_requests,
        COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected_requests,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_requests,
        SUM(CASE WHEN status = 'pending' THEN requested_amount ELSE 0 END) as pending_amount,
        SUM(CASE WHEN status = 'approved' THEN requested_amount ELSE 0 END) as approved_amount,
        SUM(CASE WHEN status = 'processing' THEN requested_amount ELSE 0 END) as processing_amount,
        SUM(CASE WHEN status = 'paid' THEN final_amount ELSE 0 END) as paid_amount,
        SUM(CASE WHEN DATE(requested_at) = CURDATE() THEN requested_amount ELSE 0 END) as today_requests,
        COUNT(CASE WHEN DATE(requested_at) = CURDATE() THEN 1 END) as today_count
      FROM vendor_payouts
      WHERE requested_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    `);

    const [urgentRequests] = await db.promise().query(`
      SELECT COUNT(*) as urgent_count
      FROM vendor_payouts
      WHERE status IN ('pending', 'approved') AND priority = 'urgent'
    `);

    const [recentActivity] = await db.promise().query(`
      SELECT 
        pal.action, pal.created_at, au.username,
        vp.id as payout_id, vp.requested_amount, v.business_name
      FROM payout_audit_logs pal
      JOIN vendor_payouts vp ON pal.payout_id = vp.id
      JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN admin_users au ON pal.performed_by = au.id
      WHERE pal.performed_by_type = 'admin'
      ORDER BY pal.created_at DESC
      LIMIT 10
    `);

    res.json({
      ...stats[0],
      urgent_count: urgentRequests[0].urgent_count,
      recent_activity: recentActivity
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
  }
});

// Get payout requests queue
router.get('/queue', [
  authenticateAdmin,
  checkAdminRole(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('status').optional().isIn(['pending', 'approved', 'processing', 'paid', 'rejected', 'failed']),
  query('priority').optional().isIn(['low', 'normal', 'high', 'urgent']),
  query('search').optional().isLength({ min: 1, max: 100 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const { status, priority, search } = req.query;

    let whereClause = 'WHERE 1=1';
    let queryParams = [];

    if (status) {
      whereClause += ' AND vp.status = ?';
      queryParams.push(status);
    }

    if (priority) {
      whereClause += ' AND vp.priority = ?';
      queryParams.push(priority);
    }

    if (search) {
      whereClause += ' AND (v.business_name LIKE ? OR v.owner_name LIKE ? OR vp.id = ?)';
      queryParams.push(`%${search}%`, `%${search}%`, search);
    }

    const [payouts] = await db.promise().query(`
      SELECT * FROM admin_payout_queue
      ${whereClause}
      LIMIT ? OFFSET ?
    `, [...queryParams, limit, offset]);

    const [countResult] = await db.promise().query(`
      SELECT COUNT(*) as total FROM vendor_payouts vp
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
    console.error('Error fetching payout queue:', error);
    res.status(500).json({ error: 'Failed to fetch payout queue' });
  }
});

// Get single payout details
router.get('/payout/:id', [
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
      ...payout[0],
      audit_logs: auditLogs
    });
  } catch (error) {
    console.error('Error fetching payout details:', error);
    res.status(500).json({ error: 'Failed to fetch payout details' });
  }
});

// Approve payout
router.post('/payout/:id/approve', [
  authenticateAdmin,
  checkAdminRole(),
  param('id').isInt(),
  body('approved_amount').optional().isFloat({ min: 0 }),
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
    let finalAmount = finalApprovedAmount;
    let processingFee = currentPayout.processing_fee;
    let tdsAmount = currentPayout.tds_amount;

    if (approved_amount && approved_amount !== currentPayout.requested_amount) {
      const [config] = await connection.query(`
        SELECT * FROM payout_configurations WHERE is_active = TRUE LIMIT 1
      `);
      
      if (config.length > 0) {
        processingFee = Math.max(
          finalApprovedAmount * config[0].processing_fee_percentage,
          config[0].processing_fee_fixed
        );
        tdsAmount = finalApprovedAmount * config[0].tds_percentage;
        finalAmount = finalApprovedAmount - processingFee - tdsAmount;
      }
    }

    // Update payout status
    await connection.query(`
      UPDATE vendor_payouts 
      SET status = 'approved', 
          approved_amount = ?,
          final_amount = ?,
          processing_fee = ?,
          tds_amount = ?,
          approved_by = ?,
          approved_at = CURRENT_TIMESTAMP,
          admin_notes = ?
      WHERE id = ?
    `, [finalApprovedAmount, finalAmount, processingFee, tdsAmount, req.adminId, admin_notes, payoutId]);

    // Log audit trail
    await connection.query(`
      INSERT INTO payout_audit_logs (
        payout_id, action, old_status, new_status, performed_by, 
        performed_by_type, notes
      ) VALUES (?, 'approved', 'pending', 'approved', ?, 'admin', ?)
    `, [payoutId, req.adminId, `Approved by admin. Amount: ₹${finalApprovedAmount}`]);

    // Create notification
    await connection.query(`
      INSERT INTO payout_notifications (
        vendor_id, payout_id, notification_type, title, message
      ) VALUES (?, ?, 'payout_approved', 'Payout Approved', ?)
    `, [
      currentPayout.vendor_id, payoutId,
      `Your payout request for ₹${finalApprovedAmount} has been approved and will be processed soon.`
    ]);

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
router.post('/payout/:id/reject', [
  authenticateAdmin,
  checkAdminRole(),
  param('id').isInt(),
  body('rejection_reason').isLength({ min: 10, max: 1000 })
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
      SELECT * FROM vendor_payouts WHERE id = ? AND status IN ('pending', 'approved')
    `, [payoutId]);

    if (payout.length === 0) {
      return res.status(404).json({ error: 'Payout not found or cannot be rejected' });
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

    // Restore vendor balance
    await connection.query(`
      UPDATE vendor_wallet_balances 
      SET available_balance = available_balance + ?,
          pending_balance = pending_balance - ?
      WHERE vendor_id = ?
    `, [currentPayout.requested_amount, currentPayout.requested_amount, currentPayout.vendor_id]);

    // Add wallet transaction for refund
    const [currentBalance] = await connection.query(`
      SELECT available_balance FROM vendor_wallet_balances WHERE vendor_id = ?
    `, [currentPayout.vendor_id]);

    await connection.query(`
      INSERT INTO vendor_wallet_transactions (
        vendor_id, transaction_type, category, amount, balance_before, 
        balance_after, reference_type, reference_id, description
      ) VALUES (?, 'credit', 'refund', ?, ?, ?, 'payout', ?, ?)
    `, [
      currentPayout.vendor_id, currentPayout.requested_amount, 
      currentBalance[0].available_balance - currentPayout.requested_amount,
      currentBalance[0].available_balance, payoutId,
      `Payout rejected - amount refunded: ₹${currentPayout.requested_amount}`
    ]);

    // Log audit trail
    await connection.query(`
      INSERT INTO payout_audit_logs (
        payout_id, action, old_status, new_status, performed_by, 
        performed_by_type, notes
      ) VALUES (?, 'rejected', ?, 'rejected', ?, 'admin', ?)
    `, [payoutId, currentPayout.status, req.adminId, `Rejected: ${rejection_reason}`]);

    // Create notification
    await connection.query(`
      INSERT INTO payout_notifications (
        vendor_id, payout_id, notification_type, title, message
      ) VALUES (?, ?, 'payout_rejected', 'Payout Rejected', ?)
    `, [
      currentPayout.vendor_id, payoutId,
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
router.post('/payout/:id/processing', [
  authenticateAdmin,
  checkAdminRole(),
  param('id').isInt(),
  body('admin_notes').optional().isLength({ max: 1000 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const payoutId = req.params.id;
    const { admin_notes } = req.body;

    const [result] = await db.promise().query(`
      UPDATE vendor_payouts 
      SET status = 'processing',
          processed_by = ?,
          processing_at = CURRENT_TIMESTAMP,
          admin_notes = COALESCE(?, admin_notes)
      WHERE id = ? AND status = 'approved'
    `, [req.adminId, admin_notes, payoutId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Payout not found or not in approved status' });
    }

    // Log audit trail
    await db.promise().query(`
      INSERT INTO payout_audit_logs (
        payout_id, action, old_status, new_status, performed_by, 
        performed_by_type, notes
      ) VALUES (?, 'processing', 'approved', 'processing', ?, 'admin', ?)
    `, [payoutId, req.adminId, 'Marked as processing']);

    res.json({ message: 'Payout marked as processing' });
  } catch (error) {
    console.error('Error marking payout as processing:', error);
    res.status(500).json({ error: 'Failed to mark payout as processing' });
  }
});

// Mark payout as paid
router.post('/payout/:id/paid', [
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
        payout_id, action, old_status, new_status, performed_by, 
        performed_by_type, notes
      ) VALUES (?, 'paid', 'processing', 'paid', ?, 'admin', ?)
    `, [payoutId, req.adminId, `Paid with transaction ID: ${transaction_id}`]);

    // Create notification
    await connection.query(`
      INSERT INTO payout_notifications (
        vendor_id, payout_id, notification_type, title, message
      ) VALUES (?, ?, 'payout_paid', 'Payout Completed', ?)
    `, [
      currentPayout.vendor_id, payoutId,
      `Your payout of ₹${currentPayout.final_amount} has been successfully processed. Transaction ID: ${transaction_id}`
    ]);

    await connection.commit();

    res.json({
      message: 'Payout marked as paid successfully',
      transaction_id,
      final_amount: currentPayout.final_amount
    });

  } catch (error) {
    await connection.rollback();
    console.error('Error marking payout as paid:', error);
    res.status(500).json({ error: 'Failed to mark payout as paid' });
  } finally {
    connection.release();
  }
});

// Bulk approve payouts
router.post('/bulk/approve', [
  authenticateAdmin,
  checkAdminRole(['admin']),
  body('payout_ids').isArray({ min: 1, max: 50 }),
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
    const results = { approved: 0, failed: 0, errors: [] };

    for (const payoutId of payout_ids) {
      try {
        const [payout] = await connection.query(`
          SELECT * FROM vendor_payouts WHERE id = ? AND status = 'pending'
        `, [payoutId]);

        if (payout.length === 0) {
          results.errors.push({ payout_id: payoutId, error: 'Not found or not pending' });
          results.failed++;
          continue;
        }

        // Update payout status
        await connection.query(`
          UPDATE vendor_payouts 
          SET status = 'approved',
              approved_by = ?,
              approved_at = CURRENT_TIMESTAMP,
              admin_notes = ?
          WHERE id = ?
        `, [req.adminId, admin_notes, payoutId]);

        // Log audit trail
        await connection.query(`
          INSERT INTO payout_audit_logs (
            payout_id, action, old_status, new_status, performed_by, 
            performed_by_type, notes
          ) VALUES (?, 'approved', 'pending', 'approved', ?, 'admin', ?)
        `, [payoutId, req.adminId, 'Bulk approved']);

        // Create notification
        await connection.query(`
          INSERT INTO payout_notifications (
            vendor_id, payout_id, notification_type, title, message
          ) VALUES (?, ?, 'payout_approved', 'Payout Approved', ?)
        `, [
          payout[0].vendor_id, payoutId,
          `Your payout request has been approved and will be processed soon.`
        ]);

        results.approved++;
      } catch (error) {
        results.errors.push({ payout_id: payoutId, error: error.message });
        results.failed++;
      }
    }

    await connection.commit();

    res.json({
      message: `Bulk approval completed. ${results.approved} approved, ${results.failed} failed.`,
      results
    });

  } catch (error) {
    await connection.rollback();
    console.error('Error in bulk approve:', error);
    res.status(500).json({ error: 'Failed to bulk approve payouts' });
  } finally {
    connection.release();
  }
});

// Get payout configuration
router.get('/configuration', [
  authenticateAdmin,
  checkAdminRole()
], async (req, res) => {
  try {
    const [config] = await db.promise().query(`
      SELECT * FROM payout_configurations WHERE is_active = TRUE LIMIT 1
    `);

    if (config.length === 0) {
      return res.status(404).json({ error: 'Payout configuration not found' });
    }

    res.json(config[0]);
  } catch (error) {
    console.error('Error fetching payout configuration:', error);
    res.status(500).json({ error: 'Failed to fetch payout configuration' });
  }
});

// Update payout configuration
router.put('/configuration', [
  authenticateAdmin,
  checkAdminRole(['admin']),
  body('min_payout_amount').optional().isFloat({ min: 1 }),
  body('max_payout_amount').optional().isFloat({ min: 100 }),
  body('processing_fee_percentage').optional().isFloat({ min: 0, max: 0.1 }),
  body('processing_fee_fixed').optional().isFloat({ min: 0 }),
  body('tds_percentage').optional().isFloat({ min: 0, max: 0.1 }),
  body('auto_approval_limit').optional().isFloat({ min: 0 }),
  body('daily_payout_limit').optional().isFloat({ min: 100 }),
  body('monthly_payout_limit').optional().isFloat({ min: 1000 })
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
    console.error('Error updating payout configuration:', error);
    res.status(500).json({ error: 'Failed to update payout configuration' });
  }
});

// Export payout data
router.get('/export', [
  authenticateAdmin,
  checkAdminRole(),
  query('start_date').isISO8601(),
  query('end_date').isISO8601(),
  query('status').optional().isIn(['pending', 'approved', 'processing', 'paid', 'rejected', 'failed']),
  query('format').optional().isIn(['csv', 'excel'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { start_date, end_date, status, format = 'csv' } = req.query;

    let whereClause = 'WHERE vp.requested_at BETWEEN ? AND ?';
    let queryParams = [start_date, end_date];

    if (status) {
      whereClause += ' AND vp.status = ?';
      queryParams.push(status);
    }

    const [payouts] = await db.promise().query(`
      SELECT 
        vp.id, vp.requested_amount, vp.approved_amount, vp.final_amount,
        vp.processing_fee, vp.tds_amount, vp.status, vp.payment_method,
        vp.transaction_id, vp.reference_number, vp.requested_at, vp.paid_at,
        v.business_name, v.owner_name, v.owner_email, v.owner_phone,
        vpm.account_holder_name, vpm.bank_name, vpm.upi_id
      FROM vendor_payouts vp
      JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN vendor_payment_methods vpm ON vp.payment_method_id = vpm.id
      ${whereClause}
      ORDER BY vp.requested_at DESC
    `, queryParams);

    if (format === 'csv') {
      const csvWriter = require('csv-writer').createObjectCsvWriter({
        path: `/tmp/payouts_${Date.now()}.csv`,
        header: [
          { id: 'id', title: 'Payout ID' },
          { id: 'business_name', title: 'Business Name' },
          { id: 'owner_name', title: 'Owner Name' },
          { id: 'requested_amount', title: 'Requested Amount' },
          { id: 'final_amount', title: 'Final Amount' },
          { id: 'status', title: 'Status' },
          { id: 'payment_method', title: 'Payment Method' },
          { id: 'transaction_id', title: 'Transaction ID' },
          { id: 'requested_at', title: 'Requested At' },
          { id: 'paid_at', title: 'Paid At' }
        ]
      });

      await csvWriter.writeRecords(payouts);
      res.download(csvWriter.path);
    } else {
      // For now, return JSON data
      res.json({ payouts, total: payouts.length });
    }
  } catch (error) {
    console.error('Error exporting payout data:', error);
    res.status(500).json({ error: 'Failed to export payout data' });
  }
});

module.exports = router;
