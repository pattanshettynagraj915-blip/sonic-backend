const db = require('./db');
const crypto = require('crypto');

// Encryption utilities
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'your-32-character-secret-key-here!';
const ALGORITHM = 'aes-256-cbc';

/**
 * Encrypt sensitive data
 */
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipher(ALGORITHM, ENCRYPTION_KEY);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt sensitive data
 */
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
    console.error('Decryption error:', error);
    return null;
  }
}

/**
 * Hash account number for verification
 */
function hashAccountNumber(accountNumber) {
  return crypto.createHash('sha256').update(accountNumber).digest('hex');
}

/**
 * Validate IFSC code format
 */
function validateIFSCFormat(ifscCode) {
  const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  return ifscRegex.test(ifscCode);
}

/**
 * Validate UPI ID format
 */
function validateUPIFormat(upiId) {
  const upiRegex = /^[\w\.-]+@[\w\.-]+$/;
  return upiRegex.test(upiId);
}

/**
 * Validate account number (basic length check)
 */
function validateAccountNumber(accountNumber) {
  const cleanNumber = accountNumber.replace(/\s/g, '');
  return /^\d{9,18}$/.test(cleanNumber);
}

/**
 * Validate IFSC code via Razorpay API
 */
async function validateIFSCOnline(ifscCode) {
  try {
    const axios = require('axios');
    const response = await axios.get(`https://ifsc.razorpay.com/${ifscCode}`, {
      timeout: 5000
    });
    
    return {
      valid: true,
      bankName: response.data.BANK,
      branchName: response.data.BRANCH,
      city: response.data.CITY,
      state: response.data.STATE,
      address: response.data.ADDRESS
    };
  } catch (error) {
    return { 
      valid: false, 
      error: error.response?.status === 404 ? 'IFSC code not found' : 'Unable to verify IFSC code'
    };
  }
}

/**
 * Calculate payout fees based on configuration
 */
async function calculatePayoutFees(amount, vendorId = null) {
  try {
    const [config] = await db.promise().query(`
      SELECT * FROM payout_configurations WHERE is_active = TRUE LIMIT 1
    `);

    if (config.length === 0) {
      throw new Error('Payout configuration not found');
    }

    const payoutConfig = config[0];
    
    // Calculate processing fee (higher of percentage or fixed)
    const processingFee = Math.max(
      amount * payoutConfig.processing_fee_percentage,
      payoutConfig.processing_fee_fixed
    );
    
    // Calculate TDS
    const tdsAmount = amount * payoutConfig.tds_percentage;
    
    // Calculate final amount
    const finalAmount = amount - processingFee - tdsAmount;

    return {
      requestedAmount: amount,
      processingFee: Math.round(processingFee * 100) / 100,
      tdsAmount: Math.round(tdsAmount * 100) / 100,
      finalAmount: Math.round(finalAmount * 100) / 100,
      config: payoutConfig
    };
  } catch (error) {
    console.error('Error calculating payout fees:', error);
    throw error;
  }
}

/**
 * Check if vendor has sufficient balance
 */
async function checkVendorBalance(vendorId, amount) {
  try {
    const [balance] = await db.promise().query(`
      SELECT available_balance FROM vendor_wallet_balances WHERE vendor_id = ?
    `, [vendorId]);

    if (balance.length === 0) {
      return { sufficient: false, availableBalance: 0 };
    }

    const availableBalance = parseFloat(balance[0].available_balance);
    return {
      sufficient: availableBalance >= amount,
      availableBalance: availableBalance
    };
  } catch (error) {
    console.error('Error checking vendor balance:', error);
    throw error;
  }
}

/**
 * Check payout limits (daily, monthly)
 */
async function checkPayoutLimits(vendorId, amount) {
  try {
    const [config] = await db.promise().query(`
      SELECT daily_payout_limit, monthly_payout_limit FROM payout_configurations WHERE is_active = TRUE LIMIT 1
    `);

    if (config.length === 0) {
      throw new Error('Payout configuration not found');
    }

    const { daily_payout_limit, monthly_payout_limit } = config[0];

    // Check daily limit
    const today = new Date().toISOString().split('T')[0];
    const [dailyTotal] = await db.promise().query(`
      SELECT COALESCE(SUM(requested_amount), 0) as daily_total
      FROM vendor_payouts 
      WHERE vendor_id = ? AND DATE(requested_at) = ? AND status NOT IN ('rejected', 'failed')
    `, [vendorId, today]);

    const dailyUsed = parseFloat(dailyTotal[0].daily_total);
    const dailyRemaining = daily_payout_limit - dailyUsed;

    // Check monthly limit
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    
    const [monthlyTotal] = await db.promise().query(`
      SELECT COALESCE(SUM(requested_amount), 0) as monthly_total
      FROM vendor_payouts 
      WHERE vendor_id = ? AND requested_at >= ? AND status NOT IN ('rejected', 'failed')
    `, [vendorId, monthStart.toISOString()]);

    const monthlyUsed = parseFloat(monthlyTotal[0].monthly_total);
    const monthlyRemaining = monthly_payout_limit - monthlyUsed;

    return {
      daily: {
        limit: daily_payout_limit,
        used: dailyUsed,
        remaining: dailyRemaining,
        canRequest: amount <= dailyRemaining
      },
      monthly: {
        limit: monthly_payout_limit,
        used: monthlyUsed,
        remaining: monthlyRemaining,
        canRequest: amount <= monthlyRemaining
      },
      canProceed: amount <= dailyRemaining && amount <= monthlyRemaining
    };
  } catch (error) {
    console.error('Error checking payout limits:', error);
    throw error;
  }
}

/**
 * Update vendor wallet balance
 */
async function updateVendorWallet(vendorId, transaction, connection = null) {
  const db_connection = connection || db.promise();
  
  try {
    const { type, amount, description, referenceType, referenceId, payoutId, orderId } = transaction;

    // Get current balance
    const [currentBalance] = await db_connection.query(`
      SELECT * FROM vendor_wallet_balances WHERE vendor_id = ?
    `, [vendorId]);

    if (currentBalance.length === 0) {
      // Initialize wallet if doesn't exist
      await db_connection.query(`
        INSERT INTO vendor_wallet_balances (vendor_id, available_balance) VALUES (?, 0)
      `, [vendorId]);
    }

    // Update balance based on transaction type
    let updateQuery = '';
    let balanceAfter = 0;

    if (type === 'credit') {
      updateQuery = `
        UPDATE vendor_wallet_balances 
        SET available_balance = available_balance + ?,
            total_earnings = total_earnings + ?
        WHERE vendor_id = ?
      `;
      await db_connection.query(updateQuery, [amount, amount, vendorId]);
      
      // Get updated balance
      const [newBalance] = await db_connection.query(`
        SELECT available_balance FROM vendor_wallet_balances WHERE vendor_id = ?
      `, [vendorId]);
      balanceAfter = newBalance[0].available_balance;
      
    } else if (type === 'debit') {
      updateQuery = `
        UPDATE vendor_wallet_balances 
        SET available_balance = available_balance - ?,
            pending_balance = pending_balance + ?
        WHERE vendor_id = ?
      `;
      await db_connection.query(updateQuery, [amount, amount, vendorId]);
      
      // Get updated balance
      const [newBalance] = await db_connection.query(`
        SELECT available_balance FROM vendor_wallet_balances WHERE vendor_id = ?
      `, [vendorId]);
      balanceAfter = newBalance[0].available_balance;
    }

    // Record transaction
    await db_connection.query(`
      INSERT INTO vendor_wallet_transactions (
        vendor_id, transaction_type, amount, balance_after,
        reference_type, reference_id, payout_id, order_id, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      vendorId, type, amount, balanceAfter,
      referenceType, referenceId, payoutId, orderId, description
    ]);

    return { success: true, balanceAfter };
  } catch (error) {
    console.error('Error updating vendor wallet:', error);
    throw error;
  }
}

/**
 * Create payout notification
 */
async function createPayoutNotification(vendorId, payoutId, type, title, message, metadata = null) {
  try {
    await db.promise().query(`
      INSERT INTO payout_notifications (
        vendor_id, payout_id, notification_type, title, message, metadata
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [vendorId, payoutId, type, title, message, JSON.stringify(metadata)]);
    
    return { success: true };
  } catch (error) {
    console.error('Error creating payout notification:', error);
    throw error;
  }
}

/**
 * Log payout audit trail
 */
async function logPayoutAudit(payoutId, action, oldStatus, newStatus, performedBy, userType, notes, metadata = null) {
  try {
    await db.promise().query(`
      INSERT INTO payout_audit_logs (
        payout_id, action, old_status, new_status, performed_by, user_type, notes, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [payoutId, action, oldStatus, newStatus, performedBy, userType, notes, JSON.stringify(metadata)]);
    
    return { success: true };
  } catch (error) {
    console.error('Error logging payout audit:', error);
    throw error;
  }
}

/**
 * Generate payout reference number
 */
function generatePayoutReference(vendorId, payoutId) {
  const timestamp = Date.now().toString().slice(-6);
  const vendorPart = vendorId.toString().padStart(4, '0');
  const payoutPart = payoutId.toString().padStart(6, '0');
  return `PO${vendorPart}${payoutPart}${timestamp}`;
}

/**
 * Mask sensitive data for display
 */
function maskSensitiveData(data, type) {
  if (!data) return null;
  
  switch (type) {
    case 'account_number':
      return data.length > 4 ? 'XXXX' + data.slice(-4) : 'XXXX';
    case 'upi_id':
      const parts = data.split('@');
      if (parts.length === 2) {
        const username = parts[0];
        const domain = parts[1];
        const maskedUsername = username.length > 2 ? 
          username.charAt(0) + 'X'.repeat(username.length - 2) + username.slice(-1) : 
          'XX';
        return `${maskedUsername}@${domain}`;
      }
      return 'XXXX@XXXX';
    default:
      return data;
  }
}

/**
 * Format currency for display
 */
function formatCurrency(amount, currency = 'INR') {
  if (amount === null || amount === undefined) return '₹0.00';
  
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount)) return '₹0.00';
  
  return `₹${numAmount.toLocaleString('en-IN', { 
    minimumFractionDigits: 2, 
    maximumFractionDigits: 2 
  })}`;
}

/**
 * Validate payout request data
 */
function validatePayoutRequest(data) {
  const errors = [];
  
  if (!data.amount || data.amount <= 0) {
    errors.push('Amount must be greater than 0');
  }
  
  if (!data.payment_method_id) {
    errors.push('Payment method is required');
  }
  
  if (data.vendor_notes && data.vendor_notes.length > 500) {
    errors.push('Vendor notes cannot exceed 500 characters');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Get payout status display info
 */
function getPayoutStatusInfo(status) {
  const statusMap = {
    pending: { label: 'Pending Review', color: 'orange', icon: 'clock' },
    approved: { label: 'Approved', color: 'blue', icon: 'check-circle' },
    processing: { label: 'Processing', color: 'purple', icon: 'refresh' },
    paid: { label: 'Paid', color: 'green', icon: 'check' },
    rejected: { label: 'Rejected', color: 'red', icon: 'x-circle' },
    failed: { label: 'Failed', color: 'red', icon: 'alert-circle' }
  };
  
  return statusMap[status] || { label: status, color: 'gray', icon: 'help-circle' };
}

module.exports = {
  encrypt,
  decrypt,
  hashAccountNumber,
  validateIFSCFormat,
  validateUPIFormat,
  validateAccountNumber,
  validateIFSCOnline,
  calculatePayoutFees,
  checkVendorBalance,
  checkPayoutLimits,
  updateVendorWallet,
  createPayoutNotification,
  logPayoutAudit,
  generatePayoutReference,
  maskSensitiveData,
  formatCurrency,
  validatePayoutRequest,
  getPayoutStatusInfo
};
