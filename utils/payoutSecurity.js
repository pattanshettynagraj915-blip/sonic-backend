const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// Encryption configuration
const ENCRYPTION_KEY = process.env.PAYOUT_ENCRYPTION_KEY || crypto.randomBytes(32);
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * Encrypt sensitive data like account numbers
 */
function encryptSensitiveData(text) {
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipherGCM(ALGORITHM, ENCRYPTION_KEY, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      encrypted: iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted,
      hash: crypto.createHash('sha256').update(text).digest('hex')
    };
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt sensitive data');
  }
}

/**
 * Decrypt sensitive data
 */
function decryptSensitiveData(encryptedData) {
  try {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    
    const decipher = crypto.createDecipherGCM(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    return null;
  }
}

/**
 * Hash account number for indexing and comparison
 */
function hashAccountNumber(accountNumber) {
  return crypto.createHash('sha256').update(accountNumber.toString()).digest('hex');
}

/**
 * Validate IFSC code format
 */
function validateIFSC(ifsc) {
  const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  return ifscRegex.test(ifsc);
}

/**
 * Validate UPI ID format
 */
function validateUPI(upiId) {
  const upiRegex = /^[\w.-]+@[\w.-]+$/;
  return upiRegex.test(upiId);
}

/**
 * Validate account number (basic length check)
 */
function validateAccountNumber(accountNumber) {
  const cleanNumber = accountNumber.toString().replace(/\s/g, '');
  return cleanNumber.length >= 8 && cleanNumber.length <= 20 && /^\d+$/.test(cleanNumber);
}

/**
 * Validate payout amount against limits
 */
function validatePayoutAmount(amount, config) {
  const numAmount = parseFloat(amount);
  
  if (isNaN(numAmount) || numAmount <= 0) {
    return { valid: false, error: 'Invalid amount' };
  }
  
  if (numAmount < config.min_payout_amount) {
    return { 
      valid: false, 
      error: `Minimum payout amount is ₹${config.min_payout_amount}` 
    };
  }
  
  if (numAmount > config.max_payout_amount) {
    return { 
      valid: false, 
      error: `Maximum payout amount is ₹${config.max_payout_amount}` 
    };
  }
  
  return { valid: true };
}

/**
 * Check daily payout limits
 */
async function checkDailyLimit(vendorId, amount, config, db) {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const [result] = await db.promise().query(`
      SELECT COALESCE(SUM(requested_amount), 0) as daily_total
      FROM vendor_payouts 
      WHERE vendor_id = ? AND DATE(requested_at) = ? AND status != 'rejected'
    `, [vendorId, today]);
    
    const dailyTotal = result[0].daily_total;
    const newTotal = dailyTotal + parseFloat(amount);
    
    if (newTotal > config.daily_payout_limit) {
      return {
        valid: false,
        error: `Daily payout limit of ₹${config.daily_payout_limit} exceeded. Current: ₹${dailyTotal}`
      };
    }
    
    return { valid: true, currentTotal: dailyTotal };
  } catch (error) {
    console.error('Error checking daily limit:', error);
    return { valid: false, error: 'Failed to check daily limit' };
  }
}

/**
 * Check monthly payout limits
 */
async function checkMonthlyLimit(vendorId, amount, config, db) {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    const [result] = await db.promise().query(`
      SELECT COALESCE(SUM(requested_amount), 0) as monthly_total
      FROM vendor_payouts 
      WHERE vendor_id = ? 
        AND requested_at >= ? 
        AND requested_at <= ? 
        AND status != 'rejected'
    `, [vendorId, monthStart, monthEnd]);
    
    const monthlyTotal = result[0].monthly_total;
    const newTotal = monthlyTotal + parseFloat(amount);
    
    if (newTotal > config.monthly_payout_limit) {
      return {
        valid: false,
        error: `Monthly payout limit of ₹${config.monthly_payout_limit} exceeded. Current: ₹${monthlyTotal}`
      };
    }
    
    return { valid: true, currentTotal: monthlyTotal };
  } catch (error) {
    console.error('Error checking monthly limit:', error);
    return { valid: false, error: 'Failed to check monthly limit' };
  }
}

/**
 * Rate limiting for payout requests
 */
const payoutRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each vendor to 5 payout requests per windowMs
  message: {
    error: 'Too many payout requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return `payout_${req.vendorId || req.headers['vendor-id'] || 'unknown'}`;
  }
});

/**
 * Rate limiting for payment method additions
 */
const paymentMethodLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // limit each vendor to 3 payment method additions per hour
  message: {
    error: 'Too many payment method additions. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return `payment_method_${req.vendorId || req.headers['vendor-id'] || 'unknown'}`;
  }
});

/**
 * Admin action rate limiting
 */
const adminActionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit admin to 30 actions per minute
  message: {
    error: 'Too many admin actions. Please slow down.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return `admin_${req.adminId || req.headers['admin-id'] || 'unknown'}`;
  }
});

/**
 * Sanitize input data
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  
  return input
    .trim()
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .substring(0, 1000); // Limit length
}

/**
 * Validate vendor ownership of payout
 */
async function validatePayoutOwnership(payoutId, vendorId, db) {
  try {
    const [result] = await db.promise().query(`
      SELECT vendor_id FROM vendor_payouts WHERE id = ?
    `, [payoutId]);
    
    if (result.length === 0) {
      return { valid: false, error: 'Payout not found' };
    }
    
    if (result[0].vendor_id !== parseInt(vendorId)) {
      return { valid: false, error: 'Unauthorized access to payout' };
    }
    
    return { valid: true };
  } catch (error) {
    console.error('Error validating payout ownership:', error);
    return { valid: false, error: 'Failed to validate ownership' };
  }
}

/**
 * Validate payment method ownership
 */
async function validatePaymentMethodOwnership(methodId, vendorId, db) {
  try {
    const [result] = await db.promise().query(`
      SELECT vendor_id FROM vendor_payment_methods WHERE id = ? AND is_active = TRUE
    `, [methodId]);
    
    if (result.length === 0) {
      return { valid: false, error: 'Payment method not found' };
    }
    
    if (result[0].vendor_id !== parseInt(vendorId)) {
      return { valid: false, error: 'Unauthorized access to payment method' };
    }
    
    return { valid: true };
  } catch (error) {
    console.error('Error validating payment method ownership:', error);
    return { valid: false, error: 'Failed to validate ownership' };
  }
}

/**
 * Log security events
 */
async function logSecurityEvent(eventType, details, db) {
  try {
    await db.promise().query(`
      INSERT INTO security_logs (event_type, details, ip_address, user_agent, created_at)
      VALUES (?, ?, ?, ?, NOW())
    `, [
      eventType,
      JSON.stringify(details),
      details.ip_address || null,
      details.user_agent || null
    ]);
  } catch (error) {
    console.error('Error logging security event:', error);
  }
}

/**
 * Detect suspicious payout patterns
 */
async function detectSuspiciousActivity(vendorId, amount, db) {
  try {
    const suspiciousPatterns = [];
    
    // Check for rapid successive requests
    const [recentRequests] = await db.promise().query(`
      SELECT COUNT(*) as count
      FROM vendor_payouts 
      WHERE vendor_id = ? AND requested_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
    `, [vendorId]);
    
    if (recentRequests[0].count >= 3) {
      suspiciousPatterns.push('rapid_requests');
    }
    
    // Check for unusually large amounts
    const [avgAmount] = await db.promise().query(`
      SELECT AVG(requested_amount) as avg_amount
      FROM vendor_payouts 
      WHERE vendor_id = ? AND status = 'paid'
      LIMIT 10
    `, [vendorId]);
    
    if (avgAmount[0].avg_amount && amount > (avgAmount[0].avg_amount * 5)) {
      suspiciousPatterns.push('unusual_amount');
    }
    
    // Check for off-hours requests (outside 9 AM - 9 PM)
    const currentHour = new Date().getHours();
    if (currentHour < 9 || currentHour > 21) {
      suspiciousPatterns.push('off_hours');
    }
    
    return {
      suspicious: suspiciousPatterns.length > 0,
      patterns: suspiciousPatterns,
      riskLevel: suspiciousPatterns.length >= 2 ? 'high' : 
                 suspiciousPatterns.length === 1 ? 'medium' : 'low'
    };
  } catch (error) {
    console.error('Error detecting suspicious activity:', error);
    return { suspicious: false, patterns: [], riskLevel: 'low' };
  }
}

/**
 * Generate secure transaction reference
 */
function generateTransactionReference(prefix = 'TXN') {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Mask sensitive data for display
 */
function maskSensitiveData(data, type) {
  if (!data) return data;
  
  switch (type) {
    case 'account_number':
      return data.length > 4 ? 
        '*'.repeat(data.length - 4) + data.slice(-4) : 
        '*'.repeat(data.length);
    
    case 'upi_id':
      const [username, domain] = data.split('@');
      if (username && domain) {
        const maskedUsername = username.length > 2 ? 
          username.slice(0, 2) + '*'.repeat(username.length - 2) : 
          '*'.repeat(username.length);
        return `${maskedUsername}@${domain}`;
      }
      return data;
    
    case 'phone':
      return data.length > 4 ? 
        '*'.repeat(data.length - 4) + data.slice(-4) : 
        '*'.repeat(data.length);
    
    case 'email':
      const [emailUser, emailDomain] = data.split('@');
      if (emailUser && emailDomain) {
        const maskedUser = emailUser.length > 2 ? 
          emailUser.slice(0, 2) + '*'.repeat(emailUser.length - 2) : 
          '*'.repeat(emailUser.length);
        return `${maskedUser}@${emailDomain}`;
      }
      return data;
    
    default:
      return data;
  }
}

module.exports = {
  encryptSensitiveData,
  decryptSensitiveData,
  hashAccountNumber,
  validateIFSC,
  validateUPI,
  validateAccountNumber,
  validatePayoutAmount,
  checkDailyLimit,
  checkMonthlyLimit,
  payoutRequestLimiter,
  paymentMethodLimiter,
  adminActionLimiter,
  sanitizeInput,
  validatePayoutOwnership,
  validatePaymentMethodOwnership,
  logSecurityEvent,
  detectSuspiciousActivity,
  generateTransactionReference,
  maskSensitiveData
};
