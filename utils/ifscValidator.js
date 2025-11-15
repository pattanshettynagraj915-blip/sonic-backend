const axios = require('axios');

/**
 * Validate IFSC code format
 * @param {string} ifsc - IFSC code to validate
 * @returns {boolean} - Whether the IFSC format is valid
 */
function validateIFSCFormat(ifsc) {
  if (!ifsc || typeof ifsc !== 'string') return false;
  
  // IFSC format: 4 letters (bank code) + 7 characters (branch code)
  const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  return ifscRegex.test(ifsc.toUpperCase());
}

/**
 * Get bank details from IFSC code using Razorpay IFSC API
 * @param {string} ifsc - IFSC code
 * @returns {Promise<Object>} - Bank details or null if invalid
 */
async function getBankDetailsFromIFSC(ifsc) {
  if (!validateIFSCFormat(ifsc)) {
    return null;
  }

  try {
    // Using Razorpay's IFSC API (free tier)
    const response = await axios.get(`https://ifsc.razorpay.com/${ifsc.toUpperCase()}`);
    
    if (response.data && response.data.BANK) {
      return {
        bankName: response.data.BANK,
        branch: response.data.BRANCH,
        address: response.data.ADDRESS,
        city: response.data.CITY,
        district: response.data.DISTRICT,
        state: response.data.STATE,
        ifsc: response.data.IFSC,
        micr: response.data.MICR,
        contact: response.data.CONTACT
      };
    }
    return null;
  } catch (error) {
    console.error('IFSC API error:', error.message);
    return null;
  }
}

/**
 * Validate UPI ID format
 * @param {string} upiId - UPI ID to validate
 * @returns {boolean} - Whether the UPI ID format is valid
 */
function validateUPIFormat(upiId) {
  if (!upiId || typeof upiId !== 'string') return false;
  
  // UPI ID format: username@bankname or username@paytm, etc.
  const upiRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/;
  return upiRegex.test(upiId);
}

/**
 * Validate account number format (basic validation)
 * @param {string} accountNumber - Account number to validate
 * @returns {boolean} - Whether the account number format is valid
 */
function validateAccountNumber(accountNumber) {
  if (!accountNumber || typeof accountNumber !== 'string') return false;
  
  // Account number should be 9-18 digits
  const accountRegex = /^[0-9]{9,18}$/;
  return accountRegex.test(accountNumber);
}

/**
 * Validate account holder name format
 * @param {string} name - Account holder name to validate
 * @returns {boolean} - Whether the name format is valid
 */
function validateAccountHolderName(name) {
  if (!name || typeof name !== 'string') return false;
  
  // Name should be 2-50 characters, letters, spaces, dots, and hyphens only
  const nameRegex = /^[a-zA-Z\s.-]{2,50}$/;
  return nameRegex.test(name.trim());
}

module.exports = {
  validateIFSCFormat,
  getBankDetailsFromIFSC,
  validateUPIFormat,
  validateAccountNumber,
  validateAccountHolderName
};
