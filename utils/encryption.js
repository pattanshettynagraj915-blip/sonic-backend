const crypto = require('crypto');

// Encryption key - in production, this should be stored securely in environment variables
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'your-32-character-secret-key-here!';
const ALGORITHM = 'aes-256-cbc';

/**
 * Encrypt sensitive data like account numbers
 * @param {string} text - Text to encrypt
 * @returns {string} - Encrypted text
 */
function encrypt(text) {
  if (!text) return null;
  
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipher(ALGORITHM, ENCRYPTION_KEY);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt sensitive data
 * @param {string} encryptedText - Encrypted text
 * @returns {string} - Decrypted text
 */
function decrypt(encryptedText) {
  if (!encryptedText) return null;
  
  try {
    const textParts = encryptedText.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedData = textParts.join(':');
    const decipher = crypto.createDecipher(ALGORITHM, ENCRYPTION_KEY);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    return null;
  }
}

/**
 * Create a hash for account number verification
 * @param {string} accountNumber - Account number to hash
 * @returns {string} - Hash of the account number
 */
function createAccountHash(accountNumber) {
  if (!accountNumber) return null;
  return crypto.createHash('sha256').update(accountNumber).digest('hex');
}

/**
 * Verify account number against hash
 * @param {string} accountNumber - Account number to verify
 * @param {string} hash - Stored hash
 * @returns {boolean} - Whether the account number matches the hash
 */
function verifyAccountHash(accountNumber, hash) {
  if (!accountNumber || !hash) return false;
  const newHash = createAccountHash(accountNumber);
  return newHash === hash;
}

module.exports = {
  encrypt,
  decrypt,
  createAccountHash,
  verifyAccountHash
};
