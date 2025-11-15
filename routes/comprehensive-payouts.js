const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const db = require('../utils/db');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const { sendPayoutNotification } = require('../utils/notificationService');

// Middleware for vendor authentication
const authenticateVendor = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.vendorId = decoded.vendorId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

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

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and PDF files are allowed'));
    }
  }
});

// Encryption utilities
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'your-32-character-secret-key-here!';
const ALGORITHM = 'aes-256-cbc';

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipher(ALGORITHM, ENCRYPTION_KEY);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = textParts.join(':');
  const decipher = crypto.createDecipher(ALGORITHM, ENCRYPTION_KEY);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function hashAccountNumber(accountNumber) {
  return crypto.createHash('sha256').update(accountNumber).digest('hex');
}

// IFSC validation utility
async function validateIFSC(ifscCode) {
  try {
    const axios = require('axios');
    const response = await axios.get(`https://ifsc.razorpay.com/${ifscCode}`);
    return {
      valid: true,
      bankName: response.data.BANK,
      branchName: response.data.BRANCH,
      city: response.data.CITY,
      state: response.data.STATE
    };
  } catch (error) {
    return { valid: false };
  }
}

// ==================== VENDOR ENDPOINTS ====================

// Get payout summary/dashboard
router.get('/vendor/summary', authenticateVendor, async (req, res) => {
  try {
    // Get wallet balance
    const [balance] = await db.promise().query(`
      SELECT * FROM vendor_wallet_balances WHERE vendor_id = ?
    `, [req.vendorId]);

    // Get pending payouts
    const [pendingPayouts] = await db.promise().query(`
      SELECT COUNT(*) as count, COALESCE(SUM(requested_amount), 0) as total_amount
      FROM vendor_payouts 
      WHERE vendor_id = ? AND status IN ('pending', 'approved', 'processing')
    `, [req.vendorId]);

    // Get recent transactions (last 10)
    const [recentTransactions] = await db.promise().query(`
      SELECT * FROM vendor_wallet_transactions 
      WHERE vendor_id = ? 
      ORDER BY created_at DESC 
      LIMIT 10
    `, [req.vendorId]);

    // Get payout configuration
    const [config] = await db.promise().query(`
      SELECT * FROM payout_configurations WHERE is_active = TRUE LIMIT 1
    `);

    const walletBalance = balance[0] || {
      total_earnings: 0,
      total_payouts: 0,
      pending_balance: 0,
      available_balance: 0
    };

    res.json({
      summary: {
        total_earnings: parseFloat(walletBalance.total_earnings),
        available_balance: parseFloat(walletBalance.available_balance),
        pending_payouts: {
          count: pendingPayouts[0].count,
          amount: parseFloat(pendingPayouts[0].total_amount)
        },
        total_paid: parseFloat(walletBalance.total_payouts)
      },
      recent_transactions: recentTransactions,
      payout_config: config[0] || {}
    });
  } catch (error) {
    console.error('Error fetching payout summary:', error);
    res.status(500).json({ error: 'Failed to fetch payout summary' });
  }
});

// Get payment methods
router.get('/vendor/payment-methods', authenticateVendor, async (req, res) => {
  try {
    const [methods] = await db.promise().query(`
      SELECT 
        id, method_type, is_default, is_active, verification_status,
        account_holder_name, bank_name, branch_name, upi_id, upi_provider,
        verification_notes, verified_at, created_at, updated_at
      FROM vendor_payment_methods 
      WHERE vendor_id = ? AND is_active = TRUE
      ORDER BY is_default DESC, created_at DESC
    `, [req.vendorId]);

    // Mask sensitive data
    const maskedMethods = methods.map(method => ({
      ...method,
      account_number_masked: method.account_number_encrypted ? 
        'XXXX' + method.account_number_encrypted.slice(-4) : null
    }));

    res.json(maskedMethods);
  } catch (error) {
    console.error('Error fetching payment methods:', error);
    res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

// Add payment method
router.post('/vendor/payment-methods', [
  authenticateVendor,
  upload.fields([
    { name: 'cancelled_cheque', maxCount: 1 },
    { name: 'bank_statement', maxCount: 1 }
  ]),
  body('method_type').isIn(['bank_account', 'upi']),
  body('account_holder_name').optional().isLength({ min: 2, max: 255 }),
  body('account_number').optional().isLength({ min: 9, max: 18 }),
  body('ifsc_code').optional().matches(/^[A-Z]{4}0[A-Z0-9]{6}$/),
  body('upi_id').optional().matches(/^[\w\.-]+@[\w\.-]+$/),
  body('is_default').optional().isBoolean()
], async (req, res) => {
  const connection = await db.promise().getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      method_type, account_holder_name, account_number, ifsc_code,
      upi_id, upi_provider, is_default
    } = req.body;

    let bankName = null;
    let branchName = null;
    let encryptedAccountNumber = null;
    let accountNumberHash = null;

    // Validate based on method type
    if (method_type === 'bank_account') {
      if (!account_holder_name || !account_number || !ifsc_code) {
        return res.status(400).json({ 
          error: 'Account holder name, account number, and IFSC code are required for bank accounts' 
        });
      }

      // Validate IFSC
      const ifscValidation = await validateIFSC(ifsc_code);
      if (!ifscValidation.valid) {
        return res.status(400).json({ error: 'Invalid IFSC code' });
      }

      bankName = ifscValidation.bankName;
      branchName = ifscValidation.branchName;

      // Encrypt account number
      encryptedAccountNumber = encrypt(account_number);
      accountNumberHash = hashAccountNumber(account_number);

    } else if (method_type === 'upi') {
      if (!upi_id) {
        return res.status(400).json({ error: 'UPI ID is required for UPI payments' });
      }
    }

    // Handle default payment method
    if (is_default) {
      await connection.query(`
        UPDATE vendor_payment_methods 
        SET is_default = FALSE 
        WHERE vendor_id = ?
      `, [req.vendorId]);
    }

    // Handle file uploads
    let cancelledChequePath = null;
    let bankStatementPath = null;

    if (req.files?.cancelled_cheque?.[0]) {
      cancelledChequePath = req.files.cancelled_cheque[0].path;
    }
    if (req.files?.bank_statement?.[0]) {
      bankStatementPath = req.files.bank_statement[0].path;
    }

    // Insert payment method
    const [result] = await connection.query(`
      INSERT INTO vendor_payment_methods (
        vendor_id, method_type, is_default, account_holder_name,
        account_number_encrypted, account_number_hash, ifsc_code,
        bank_name, branch_name, upi_id, upi_provider,
        cancelled_cheque_path, bank_statement_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.vendorId, method_type, is_default || false, account_holder_name,
      encryptedAccountNumber, accountNumberHash, ifsc_code,
      bankName, branchName, upi_id, upi_provider,
      cancelledChequePath, bankStatementPath
    ]);

    await connection.commit();

    res.json({
      message: 'Payment method added successfully',
      payment_method_id: result.insertId
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error adding payment method:', error);
    res.status(500).json({ error: 'Failed to add payment method' });
  } finally {
    connection.release();
  }
});

// Update payment method
router.put('/vendor/payment-methods/:id', [
  authenticateVendor,
  param('id').isInt(),
  body('is_default').optional().isBoolean(),
  body('is_active').optional().isBoolean()
], async (req, res) => {
  const connection = await db.promise().getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const methodId = req.params.id;
    const { is_default, is_active } = req.body;

    // Verify ownership
    const [method] = await connection.query(`
      SELECT * FROM vendor_payment_methods 
      WHERE id = ? AND vendor_id = ?
    `, [methodId, req.vendorId]);

    if (method.length === 0) {
      return res.status(404).json({ error: 'Payment method not found' });
    }

    // Handle default payment method
    if (is_default) {
      await connection.query(`
        UPDATE vendor_payment_methods 
        SET is_default = FALSE 
        WHERE vendor_id = ? AND id != ?
      `, [req.vendorId, methodId]);
    }

    // Update payment method
    await connection.query(`
      UPDATE vendor_payment_methods 
      SET is_default = COALESCE(?, is_default),
          is_active = COALESCE(?, is_active),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND vendor_id = ?
    `, [is_default, is_active, methodId, req.vendorId]);

    await connection.commit();

    res.json({ message: 'Payment method updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Error updating payment method:', error);
    res.status(500).json({ error: 'Failed to update payment method' });
  } finally {
    connection.release();
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

    // Check daily/monthly limits
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
        vendor_id, transaction_type, amount, balance_after,
        reference_type, reference_id, payout_id, description
      ) VALUES (?, 'debit', ?, ?, 'payout_request', ?, ?, ?)
    `, [
      req.vendorId, amount, currentBalance[0].available_balance,
      payoutResult.insertId, payoutResult.insertId,
      `Payout request for ₹${amount}`
    ]);

    // Create audit log
    await connection.query(`
      INSERT INTO payout_audit_logs (
        payout_id, action, new_status, user_type, notes
      ) VALUES (?, 'created', ?, 'vendor', ?)
    `, [
      payoutResult.insertId, 
      amount <= payoutConfig.auto_approval_limit ? 'approved' : 'pending',
      `Payout request created for ₹${amount}`
    ]);

    // Send notification
    try {
      await sendPayoutNotification(req.vendorId, payoutResult.insertId, 'payout_requested', {
        vendorName: 'Vendor', // You can fetch this from the database if needed
        payoutId: payoutResult.insertId,
        requestedAmount: amount,
        finalAmount: finalAmount,
        paymentMethod: paymentMethod[0].method_type === 'bank_account' ? 'Bank Transfer' : 'UPI',
        status: amount <= payoutConfig.auto_approval_limit ? 'approved' : 'pending'
      });
    } catch (notificationError) {
      console.error('Error sending payout notification:', notificationError);
      // Don't fail the payout request if notification fails
    }

    await connection.commit();

    res.json({
      message: 'Payout request submitted successfully',
      payout_id: payoutResult.insertId,
      status: amount <= payoutConfig.auto_approval_limit ? 'approved' : 'pending',
      final_amount: finalAmount,
      processing_fee: processingFee,
      tds_amount: tdsAmount
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error requesting payout:', error);
    res.status(500).json({ error: 'Failed to request payout' });
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

// Get wallet transactions (ledger view)
router.get('/vendor/transactions', [
  authenticateVendor,
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('type').optional().isIn(['credit', 'debit']),
  query('start_date').optional().isISO8601(),
  query('end_date').optional().isISO8601()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const { type, start_date, end_date } = req.query;

    let whereClause = 'WHERE vendor_id = ?';
    let queryParams = [req.vendorId];

    if (type) {
      whereClause += ' AND transaction_type = ?';
      queryParams.push(type);
    }

    if (start_date) {
      whereClause += ' AND created_at >= ?';
      queryParams.push(start_date);
    }

    if (end_date) {
      whereClause += ' AND created_at <= ?';
      queryParams.push(end_date);
    }

    const [transactions] = await db.promise().query(`
      SELECT * FROM vendor_wallet_transactions 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...queryParams, limit, offset]);

    // Get total count
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
router.get('/vendor/notifications', [
  authenticateVendor,
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('unread_only').optional().isBoolean()
], async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const unreadOnly = req.query.unread_only === 'true';

    let whereClause = 'WHERE vendor_id = ?';
    let queryParams = [req.vendorId];

    if (unreadOnly) {
      whereClause += ' AND is_read = FALSE';
    }

    const [notifications] = await db.promise().query(`
      SELECT * FROM payout_notifications 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...queryParams, limit, offset]);

    res.json({ notifications });
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
