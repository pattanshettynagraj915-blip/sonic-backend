const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const crypto = require('crypto');
const { body, validationResult, param, query } = require('express-validator');

// Encryption utilities
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32);
const ALGORITHM = 'aes-256-gcm';

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipher(ALGORITHM, ENCRYPTION_KEY);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedData) {
  try {
    const parts = encryptedData.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipher(ALGORITHM, ENCRYPTION_KEY);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    return null;
  }
}

function hashAccountNumber(accountNumber) {
  return crypto.createHash('sha256').update(accountNumber).digest('hex');
}

// Middleware to check vendor authentication
const authenticateVendor = (req, res, next) => {
  const vendorId = req.headers['vendor-id'] || req.body.vendor_id || req.query.vendor_id;
  if (!vendorId) {
    return res.status(401).json({ error: 'Vendor authentication required' });
  }
  req.vendorId = parseInt(vendorId);
  next();
};

// Middleware to check admin authentication
const authenticateAdmin = (req, res, next) => {
  const adminId = req.headers['admin-id'] || req.body.admin_id;
  if (!adminId) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  req.adminId = parseInt(adminId);
  next();
};

// VENDOR ROUTES

// Get vendor payout summary
router.get('/vendor/summary', authenticateVendor, async (req, res) => {
  try {
    const [summary] = await db.promise().query(`
      SELECT * FROM vendor_payout_summary WHERE vendor_id = ?
    `, [req.vendorId]);

    if (summary.length === 0) {
      return res.json({
        vendor_id: req.vendorId,
        available_balance: 0,
        pending_balance: 0,
        total_earnings: 0,
        total_payouts: 0,
        total_payout_requests: 0,
        pending_requests: 0,
        paid_requests: 0,
        last_payout_date: null,
        pending_amount: 0
      });
    }

    res.json(summary[0]);
  } catch (error) {
    console.error('Error fetching payout summary:', error);
    res.status(500).json({ error: 'Failed to fetch payout summary' });
  }
});

// Get vendor payment methods
router.get('/vendor/payment-methods', authenticateVendor, async (req, res) => {
  try {
    const [methods] = await db.promise().query(`
      SELECT 
        id, method_type, is_default, is_active, verification_status,
        account_holder_name, bank_name, branch_name, upi_id, upi_provider,
        CASE 
          WHEN account_number_encrypted IS NOT NULL 
          THEN CONCAT('****', RIGHT(account_number_hash, 4))
          ELSE NULL 
        END as masked_account_number,
        ifsc_code, created_at, updated_at
      FROM vendor_payment_methods 
      WHERE vendor_id = ? AND is_active = TRUE
      ORDER BY is_default DESC, created_at DESC
    `, [req.vendorId]);

    res.json(methods);
  } catch (error) {
    console.error('Error fetching payment methods:', error);
    res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

// Add new payment method
router.post('/vendor/payment-methods', [
  authenticateVendor,
  body('method_type').isIn(['bank_account', 'upi']),
  body('account_holder_name').optional().isLength({ min: 2, max: 255 }),
  body('account_number').optional().isLength({ min: 8, max: 20 }),
  body('ifsc_code').optional().matches(/^[A-Z]{4}0[A-Z0-9]{6}$/),
  body('bank_name').optional().isLength({ min: 2, max: 255 }),
  body('upi_id').optional().matches(/^[\w.-]+@[\w.-]+$/),
  body('is_default').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      method_type,
      account_holder_name,
      account_number,
      ifsc_code,
      bank_name,
      branch_name,
      upi_id,
      upi_provider,
      is_default = false
    } = req.body;

    // Validate required fields based on method type
    if (method_type === 'bank_account') {
      if (!account_holder_name || !account_number || !ifsc_code || !bank_name) {
        return res.status(400).json({ 
          error: 'Bank account requires: account_holder_name, account_number, ifsc_code, bank_name' 
        });
      }
    } else if (method_type === 'upi') {
      if (!upi_id) {
        return res.status(400).json({ error: 'UPI method requires: upi_id' });
      }
    }

    // If setting as default, unset other defaults
    if (is_default) {
      await db.promise().query(`
        UPDATE vendor_payment_methods 
        SET is_default = FALSE 
        WHERE vendor_id = ?
      `, [req.vendorId]);
    }

    // Encrypt account number if provided
    let encryptedAccountNumber = null;
    let accountNumberHash = null;
    if (account_number) {
      encryptedAccountNumber = encrypt(account_number);
      accountNumberHash = hashAccountNumber(account_number);
    }

    const [result] = await db.promise().query(`
      INSERT INTO vendor_payment_methods (
        vendor_id, method_type, account_holder_name, account_number_encrypted,
        account_number_hash, ifsc_code, bank_name, branch_name, upi_id, 
        upi_provider, is_default, verification_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `, [
      req.vendorId, method_type, account_holder_name, encryptedAccountNumber,
      accountNumberHash, ifsc_code, bank_name, branch_name, upi_id, 
      upi_provider, is_default
    ]);

    // Log audit trail
    await db.promise().query(`
      INSERT INTO payout_audit_logs (
        payout_id, action, performed_by, performed_by_type, notes
      ) VALUES (?, 'payment_method_added', ?, 'vendor', ?)
    `, [null, req.vendorId, `Added ${method_type} payment method`]);

    res.status(201).json({ 
      message: 'Payment method added successfully',
      id: result.insertId,
      verification_status: 'pending'
    });
  } catch (error) {
    console.error('Error adding payment method:', error);
    res.status(500).json({ error: 'Failed to add payment method' });
  }
});

// Update payment method
router.put('/vendor/payment-methods/:id', [
  authenticateVendor,
  param('id').isInt(),
  body('is_default').optional().isBoolean(),
  body('is_active').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const methodId = req.params.id;
    const { is_default, is_active } = req.body;

    // Verify ownership
    const [existing] = await db.promise().query(`
      SELECT id FROM vendor_payment_methods 
      WHERE id = ? AND vendor_id = ?
    `, [methodId, req.vendorId]);

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Payment method not found' });
    }

    // If setting as default, unset other defaults
    if (is_default) {
      await db.promise().query(`
        UPDATE vendor_payment_methods 
        SET is_default = FALSE 
        WHERE vendor_id = ? AND id != ?
      `, [req.vendorId, methodId]);
    }

    await db.promise().query(`
      UPDATE vendor_payment_methods 
      SET is_default = COALESCE(?, is_default),
          is_active = COALESCE(?, is_active),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND vendor_id = ?
    `, [is_default, is_active, methodId, req.vendorId]);

    res.json({ message: 'Payment method updated successfully' });
  } catch (error) {
    console.error('Error updating payment method:', error);
    res.status(500).json({ error: 'Failed to update payment method' });
  }
});

// Request payout
router.post('/vendor/request', [
  authenticateVendor,
  body('amount').isFloat({ min: 1 }),
  body('payment_method_id').isInt(),
  body('vendor_notes').optional().isLength({ max: 500 })
], async (req, res) => {
  const connection = await db.promise().getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { amount, payment_method_id, vendor_notes } = req.body;

    // Get payout configuration
    const [config] = await connection.query(`
      SELECT * FROM payout_configurations WHERE is_active = TRUE LIMIT 1
    `);

    if (config.length === 0) {
      throw new Error('Payout configuration not found');
    }

    const payoutConfig = config[0];

    // Validate amount limits
    if (amount < payoutConfig.min_payout_amount) {
      return res.status(400).json({ 
        error: `Minimum payout amount is ₹${payoutConfig.min_payout_amount}` 
      });
    }

    if (amount > payoutConfig.max_payout_amount) {
      return res.status(400).json({ 
        error: `Maximum payout amount is ₹${payoutConfig.max_payout_amount}` 
      });
    }

    // Check vendor balance
    const [balance] = await connection.query(`
      SELECT available_balance FROM vendor_wallet_balances WHERE vendor_id = ?
    `, [req.vendorId]);

    if (balance.length === 0 || balance[0].available_balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Verify payment method ownership
    const [paymentMethod] = await connection.query(`
      SELECT * FROM vendor_payment_methods 
      WHERE id = ? AND vendor_id = ? AND is_active = TRUE
    `, [payment_method_id, req.vendorId]);

    if (paymentMethod.length === 0) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    if (paymentMethod[0].verification_status !== 'verified') {
      return res.status(400).json({ error: 'Payment method not verified' });
    }

    // Check daily/monthly limits (simplified)
    const today = new Date().toISOString().split('T')[0];
    const [dailyTotal] = await connection.query(`
      SELECT COALESCE(SUM(requested_amount), 0) as daily_total
      FROM vendor_payouts 
      WHERE vendor_id = ? AND DATE(requested_at) = ? AND status != 'rejected'
    `, [req.vendorId, today]);

    if (dailyTotal[0].daily_total + amount > payoutConfig.daily_payout_limit) {
      return res.status(400).json({ 
        error: `Daily payout limit of ₹${payoutConfig.daily_payout_limit} exceeded` 
      });
    }

    // Calculate fees
    const processingFee = Math.max(
      amount * payoutConfig.processing_fee_percentage,
      payoutConfig.processing_fee_fixed
    );
    const tdsAmount = amount * payoutConfig.tds_percentage;
    const finalAmount = amount - processingFee - tdsAmount;

    // Create payout request
    const [payoutResult] = await connection.query(`
      INSERT INTO vendor_payouts (
        vendor_id, payment_method_id, requested_amount, final_amount,
        processing_fee, tds_amount, payment_method, vendor_notes, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.vendorId, payment_method_id, amount, finalAmount,
      processingFee, tdsAmount, paymentMethod[0].method_type, 
      vendor_notes, amount <= payoutConfig.auto_approval_limit ? 'approved' : 'pending'
    ]);

    // Update vendor balance (reserve the amount)
    await connection.query(`
      UPDATE vendor_wallet_balances 
      SET pending_balance = pending_balance + ?,
          available_balance = available_balance - ?
      WHERE vendor_id = ?
    `, [amount, amount, req.vendorId]);

    // Add wallet transaction
    const [currentBalance] = await connection.query(`
      SELECT available_balance FROM vendor_wallet_balances WHERE vendor_id = ?
    `, [req.vendorId]);

    await connection.query(`
      INSERT INTO vendor_wallet_transactions (
        vendor_id, transaction_type, category, amount, balance_before, 
        balance_after, reference_type, reference_id, description
      ) VALUES (?, 'debit', 'payout', ?, ?, ?, 'payout', ?, ?)
    `, [
      req.vendorId, amount, currentBalance[0].available_balance + amount,
      currentBalance[0].available_balance, payoutResult.insertId,
      `Payout request for ₹${amount}`
    ]);

    // Log audit trail
    await connection.query(`
      INSERT INTO payout_audit_logs (
        payout_id, action, performed_by, performed_by_type, notes
      ) VALUES (?, 'created', ?, 'vendor', ?)
    `, [payoutResult.insertId, req.vendorId, `Payout request created for ₹${amount}`]);

    // Create notification
    await connection.query(`
      INSERT INTO payout_notifications (
        vendor_id, payout_id, notification_type, title, message
      ) VALUES (?, ?, 'payout_requested', 'Payout Request Submitted', ?)
    `, [
      req.vendorId, payoutResult.insertId,
      `Your payout request for ₹${amount} has been submitted and is under review.`
    ]);

    await connection.commit();

    res.status(201).json({
      message: 'Payout request submitted successfully',
      payout_id: payoutResult.insertId,
      requested_amount: amount,
      final_amount: finalAmount,
      processing_fee: processingFee,
      tds_amount: tdsAmount,
      status: amount <= payoutConfig.auto_approval_limit ? 'approved' : 'pending'
    });

  } catch (error) {
    await connection.rollback();
    console.error('Error creating payout request:', error);
    res.status(500).json({ error: 'Failed to create payout request' });
  } finally {
    connection.release();
  }
});

// Get payout history
router.get('/vendor/history', [
  authenticateVendor,
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('status').optional().isIn(['pending', 'approved', 'processing', 'paid', 'rejected', 'failed']),
  query('start_date').optional().isISO8601(),
  query('end_date').optional().isISO8601()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const { status, start_date, end_date } = req.query;

    let whereClause = 'WHERE vp.vendor_id = ?';
    let queryParams = [req.vendorId];

    if (status) {
      whereClause += ' AND vp.status = ?';
      queryParams.push(status);
    }

    if (start_date) {
      whereClause += ' AND vp.requested_at >= ?';
      queryParams.push(start_date);
    }

    if (end_date) {
      whereClause += ' AND vp.requested_at <= ?';
      queryParams.push(end_date);
    }

    const [payouts] = await db.promise().query(`
      SELECT 
        vp.id, vp.requested_amount, vp.approved_amount, vp.final_amount,
        vp.processing_fee, vp.tds_amount, vp.status, vp.payment_method,
        vp.transaction_id, vp.reference_number, vp.requested_at, vp.approved_at,
        vp.processing_at, vp.paid_at, vp.rejected_at, vp.rejection_reason,
        vp.vendor_notes, vp.admin_notes,
        vpm.method_type, vpm.account_holder_name, vpm.bank_name, vpm.upi_id
      FROM vendor_payouts vp
      LEFT JOIN vendor_payment_methods vpm ON vp.payment_method_id = vpm.id
      ${whereClause}
      ORDER BY vp.requested_at DESC
      LIMIT ? OFFSET ?
    `, [...queryParams, limit, offset]);

    // Get total count
    const [countResult] = await db.promise().query(`
      SELECT COUNT(*) as total FROM vendor_payouts vp ${whereClause}
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
    console.error('Error fetching payout history:', error);
    res.status(500).json({ error: 'Failed to fetch payout history' });
  }
});

// Get wallet transactions (ledger)
router.get('/vendor/wallet/transactions', [
  authenticateVendor,
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('type').optional().isIn(['credit', 'debit']),
  query('category').optional().isIn(['order_settlement', 'payout', 'adjustment', 'fee', 'refund', 'commission'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const { type, category } = req.query;

    let whereClause = 'WHERE vendor_id = ?';
    let queryParams = [req.vendorId];

    if (type) {
      whereClause += ' AND transaction_type = ?';
      queryParams.push(type);
    }

    if (category) {
      whereClause += ' AND category = ?';
      queryParams.push(category);
    }

    const [transactions] = await db.promise().query(`
      SELECT 
        id, transaction_type, category, amount, balance_before, balance_after,
        reference_type, reference_id, description, created_at
      FROM vendor_wallet_transactions
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...queryParams, limit, offset]);

    const [countResult] = await db.promise().query(`
      SELECT COUNT(*) as total FROM vendor_wallet_transactions ${whereClause}
    `, queryParams);

    res.json({
      transactions,
      pagination: {
        page,
        limit,
        total: countResult[0].total,
        pages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching wallet transactions:', error);
    res.status(500).json({ error: 'Failed to fetch wallet transactions' });
  }
});

// Get notifications
router.get('/vendor/notifications', authenticateVendor, async (req, res) => {
  try {
    const [notifications] = await db.promise().query(`
      SELECT 
        id, notification_type, title, message, is_read, created_at, read_at
      FROM payout_notifications
      WHERE vendor_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.vendorId]);

    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark notification as read
router.put('/vendor/notifications/:id/read', [
  authenticateVendor,
  param('id').isInt()
], async (req, res) => {
  try {
    await db.promise().query(`
      UPDATE payout_notifications 
      SET is_read = TRUE, read_at = CURRENT_TIMESTAMP
      WHERE id = ? AND vendor_id = ?
    `, [req.params.id, req.vendorId]);

    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

module.exports = router;
