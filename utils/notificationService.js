const db = require('./db');
const nodemailer = require('nodemailer');

// Email configuration
const emailConfig = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
};

// Create email transporter
let emailTransporter = null;
try {
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    emailTransporter = nodemailer.createTransport(emailConfig);
  }
} catch (error) {
  console.warn('Email transporter not configured:', error.message);
}

/**
 * Create a payout notification
 */
async function createPayoutNotification(vendorId, payoutId, type, title, message, metadata = null) {
  try {
    const [result] = await db.promise().query(`
      INSERT INTO payout_notifications (
        vendor_id, payout_id, notification_type, title, message, metadata
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [vendorId, payoutId, type, title, message, JSON.stringify(metadata)]);

    return {
      success: true,
      notificationId: result.insertId
    };
  } catch (error) {
    console.error('Error creating payout notification:', error);
    throw error;
  }
}

/**
 * Send email notification
 */
async function sendEmailNotification(vendorId, subject, htmlContent, textContent = null) {
  if (!emailTransporter) {
    console.warn('Email transporter not configured, skipping email notification');
    return { success: false, reason: 'Email not configured' };
  }

  try {
    // Get vendor email/name with schema-aware selection
    const [columns] = await db.promise().query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vendors'`
    );
    const colNames = new Set(columns.map(c => c.COLUMN_NAME));
    const emailCol = colNames.has('email') ? 'email' : (colNames.has('owner_email') ? 'owner_email' : 'NULL');
    const nameCol = colNames.has('owner_name') ? 'owner_name' : (colNames.has('business_name') ? 'business_name' : (colNames.has('shop_name') ? 'shop_name' : 'NULL'));

    const [vendor] = await db.promise().query(
      `SELECT ${emailCol} AS email, ${nameCol} AS display_name FROM vendors WHERE id = ?`,
      [vendorId]
    );

    if (vendor.length === 0) {
      throw new Error('Vendor not found');
    }

    const vendorData = vendor[0];
    const vendorEmail = vendorData.email;
    const vendorName = vendorData.display_name || 'Vendor';

    // Send email
    const mailOptions = {
      from: `"Vendor Portal" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: vendorEmail,
      subject: subject,
      text: textContent || htmlContent.replace(/<[^>]*>/g, ''),
      html: htmlContent
    };

    const info = await emailTransporter.sendMail(mailOptions);

    return {
      success: true,
      messageId: info.messageId,
      vendorEmail: vendorEmail
    };
  } catch (error) {
    console.error('Error sending email notification:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Generate email templates
 */
function generateEmailTemplate(type, data) {
  const baseStyle = `
    <style>
      body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
      .container { max-width: 600px; margin: 0 auto; padding: 20px; }
      .header { background: #3b82f6; color: white; padding: 20px; text-align: center; }
      .content { padding: 20px; background: #f8fafc; }
      .footer { padding: 20px; text-align: center; color: #666; font-size: 14px; }
      .button { display: inline-block; padding: 12px 24px; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px; margin: 10px 0; }
      .amount { font-size: 24px; font-weight: bold; color: #10b981; }
      .status { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; text-transform: uppercase; }
      .status.approved { background: #dcfce7; color: #16a34a; }
      .status.rejected { background: #fecaca; color: #dc2626; }
      .status.paid { background: #dcfce7; color: #16a34a; }
    </style>
  `;

  const templates = {
    payout_requested: `
      ${baseStyle}
      <div class="container">
        <div class="header">
          <h1>Payout Request Submitted</h1>
        </div>
        <div class="content">
          <h2>Hello ${data.vendorName},</h2>
          <p>Your payout request has been successfully submitted and is now under review.</p>
          
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3>Payout Details:</h3>
            <p><strong>Payout ID:</strong> #${data.payoutId}</p>
            <p><strong>Requested Amount:</strong> <span class="amount">₹${data.requestedAmount}</span></p>
            <p><strong>Final Amount:</strong> ₹${data.finalAmount} (after fees)</p>
            <p><strong>Payment Method:</strong> ${data.paymentMethod}</p>
            <p><strong>Status:</strong> <span class="status ${data.status}">${data.status}</span></p>
          </div>
          
          <p>We will review your request and notify you once it's processed. This usually takes 1-2 business days.</p>
          
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/payouts" class="button">View Payout Status</a>
        </div>
        <div class="footer">
          <p>Thank you for using Vendor Portal</p>
        </div>
      </div>
    `,

    payout_approved: `
      ${baseStyle}
      <div class="container">
        <div class="header">
          <h1>Payout Approved! 🎉</h1>
        </div>
        <div class="content">
          <h2>Great news, ${data.vendorName}!</h2>
          <p>Your payout request has been approved and will be processed shortly.</p>
          
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3>Approved Payout Details:</h3>
            <p><strong>Payout ID:</strong> #${data.payoutId}</p>
            <p><strong>Approved Amount:</strong> <span class="amount">₹${data.approvedAmount}</span></p>
            <p><strong>Payment Method:</strong> ${data.paymentMethod}</p>
            <p><strong>Expected Processing:</strong> 1-3 business days</p>
            ${data.adminNotes ? `<p><strong>Admin Notes:</strong> ${data.adminNotes}</p>` : ''}
          </div>
          
          <p>Your payout will be processed and transferred to your registered payment method within 1-3 business days.</p>
          
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/payouts" class="button">Track Payout</a>
        </div>
        <div class="footer">
          <p>Thank you for using Vendor Portal</p>
        </div>
      </div>
    `,

    payout_rejected: `
      ${baseStyle}
      <div class="container">
        <div class="header" style="background: #ef4444;">
          <h1>Payout Request Rejected</h1>
        </div>
        <div class="content">
          <h2>Hello ${data.vendorName},</h2>
          <p>Unfortunately, your payout request has been rejected. Please see the details below:</p>
          
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3>Rejected Payout Details:</h3>
            <p><strong>Payout ID:</strong> #${data.payoutId}</p>
            <p><strong>Requested Amount:</strong> ₹${data.requestedAmount}</p>
            <p><strong>Status:</strong> <span class="status rejected">Rejected</span></p>
            <p><strong>Reason:</strong> ${data.rejectionReason}</p>
          </div>
          
          <p>The requested amount has been returned to your available balance. You can submit a new payout request after addressing the mentioned concerns.</p>
          
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/payouts" class="button">Submit New Request</a>
        </div>
        <div class="footer">
          <p>If you have questions, please contact our support team</p>
        </div>
      </div>
    `,

    payout_paid: `
      ${baseStyle}
      <div class="container">
        <div class="header" style="background: #10b981;">
          <h1>Payout Completed! 💰</h1>
        </div>
        <div class="content">
          <h2>Congratulations, ${data.vendorName}!</h2>
          <p>Your payout has been successfully processed and transferred to your account.</p>
          
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3>Payment Details:</h3>
            <p><strong>Payout ID:</strong> #${data.payoutId}</p>
            <p><strong>Amount Paid:</strong> <span class="amount">₹${data.finalAmount}</span></p>
            <p><strong>Transaction ID:</strong> ${data.transactionId}</p>
            <p><strong>Payment Method:</strong> ${data.paymentMethod}</p>
            <p><strong>Processed On:</strong> ${data.paidAt}</p>
          </div>
          
          <p>The amount should reflect in your account within a few hours. Please keep the transaction ID for your records.</p>
          
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/payouts" class="button">View Transaction History</a>
        </div>
        <div class="footer">
          <p>Thank you for using Vendor Portal</p>
        </div>
      </div>
    `,

    payment_method_verified: `
      ${baseStyle}
      <div class="container">
        <div class="header" style="background: #10b981;">
          <h1>Payment Method Verified ✅</h1>
        </div>
        <div class="content">
          <h2>Hello ${data.vendorName},</h2>
          <p>Your payment method has been successfully verified and is now ready for payouts.</p>
          
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3>Verified Payment Method:</h3>
            <p><strong>Type:</strong> ${data.methodType}</p>
            <p><strong>Details:</strong> ${data.methodDetails}</p>
            <p><strong>Status:</strong> <span class="status approved">Verified</span></p>
            ${data.verificationNotes ? `<p><strong>Notes:</strong> ${data.verificationNotes}</p>` : ''}
          </div>
          
          <p>You can now use this payment method to request payouts. Your earnings will be transferred to this account.</p>
          
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/payouts" class="button">Request Payout</a>
        </div>
        <div class="footer">
          <p>Thank you for using Vendor Portal</p>
        </div>
      </div>
    `,

    payment_method_rejected: `
      ${baseStyle}
      <div class="container">
        <div class="header" style="background: #ef4444;">
          <h1>Payment Method Verification Failed</h1>
        </div>
        <div class="content">
          <h2>Hello ${data.vendorName},</h2>
          <p>Unfortunately, we couldn't verify your payment method. Please see the details below:</p>
          
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3>Payment Method Details:</h3>
            <p><strong>Type:</strong> ${data.methodType}</p>
            <p><strong>Status:</strong> <span class="status rejected">Rejected</span></p>
            <p><strong>Reason:</strong> ${data.rejectionReason}</p>
          </div>
          
          <p>Please review the rejection reason and submit a new payment method with the correct information.</p>
          
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/payouts/payment-methods" class="button">Add New Method</a>
        </div>
        <div class="footer">
          <p>If you need help, please contact our support team</p>
        </div>
      </div>
    `
  };

  return templates[type] || templates.payout_requested;
}

/**
 * Send payout notification (in-app + email)
 */
async function sendPayoutNotification(vendorId, payoutId, type, data) {
  try {
    // Create in-app notification
    const title = getNotificationTitle(type);
    const message = getNotificationMessage(type, data);
    
    const notificationResult = await createPayoutNotification(
      vendorId, 
      payoutId, 
      type, 
      title, 
      message, 
      data
    );

    // Send email notification
    const emailSubject = getEmailSubject(type, data);
    const emailContent = generateEmailTemplate(type, data);
    
    const emailResult = await sendEmailNotification(
      vendorId,
      emailSubject,
      emailContent
    );

    // Update notification with email status
    if (emailResult.success) {
      await db.promise().query(`
        UPDATE payout_notifications 
        SET is_email_sent = TRUE 
        WHERE id = ?
      `, [notificationResult.notificationId]);
    }

    return {
      success: true,
      notificationId: notificationResult.notificationId,
      emailSent: emailResult.success,
      emailError: emailResult.error || null
    };
  } catch (error) {
    console.error('Error sending payout notification:', error);
    throw error;
  }
}

/**
 * Get notification title based on type
 */
function getNotificationTitle(type) {
  const titles = {
    payout_requested: 'Payout Request Submitted',
    payout_approved: 'Payout Approved',
    payout_rejected: 'Payout Rejected',
    payout_paid: 'Payout Completed',
    payout_failed: 'Payout Failed',
    payment_method_verified: 'Payment Method Verified',
    payment_method_rejected: 'Payment Method Rejected'
  };
  
  return titles[type] || 'Payout Update';
}

/**
 * Get notification message based on type
 */
function getNotificationMessage(type, data) {
  const messages = {
    payout_requested: `Your payout request for ₹${data.requestedAmount} has been submitted and is under review.`,
    payout_approved: `Your payout request for ₹${data.approvedAmount} has been approved and will be processed soon.`,
    payout_rejected: `Your payout request for ₹${data.requestedAmount} has been rejected. Reason: ${data.rejectionReason}`,
    payout_paid: `Your payout of ₹${data.finalAmount} has been successfully processed. Transaction ID: ${data.transactionId}`,
    payout_failed: `Your payout of ₹${data.requestedAmount} has failed. Please contact support.`,
    payment_method_verified: `Your ${data.methodType} payment method has been verified and is ready for payouts.`,
    payment_method_rejected: `Your ${data.methodType} payment method verification was rejected. Reason: ${data.rejectionReason}`
  };
  
  return messages[type] || 'Your payout status has been updated.';
}

/**
 * Get email subject based on type
 */
function getEmailSubject(type, data) {
  const subjects = {
    payout_requested: `Payout Request Submitted - ₹${data.requestedAmount}`,
    payout_approved: `Payout Approved - ₹${data.approvedAmount}`,
    payout_rejected: `Payout Rejected - ₹${data.requestedAmount}`,
    payout_paid: `Payout Completed - ₹${data.finalAmount}`,
    payout_failed: `Payout Failed - ₹${data.requestedAmount}`,
    payment_method_verified: `Payment Method Verified - ${data.methodType}`,
    payment_method_rejected: `Payment Method Rejected - ${data.methodType}`
  };
  
  return subjects[type] || 'Payout Update - Vendor Portal';
}

/**
 * Mark notification as read
 */
async function markNotificationAsRead(notificationId, vendorId) {
  try {
    await db.promise().query(`
      UPDATE payout_notifications 
      SET is_read = TRUE, read_at = CURRENT_TIMESTAMP
      WHERE id = ? AND vendor_id = ?
    `, [notificationId, vendorId]);
    
    return { success: true };
  } catch (error) {
    console.error('Error marking notification as read:', error);
    throw error;
  }
}

/**
 * Get vendor notifications
 */
async function getVendorNotifications(vendorId, options = {}) {
  try {
    const {
      unreadOnly = false,
      limit = 20,
      offset = 0,
      type = null
    } = options;

    let whereClause = 'WHERE vendor_id = ?';
    let queryParams = [vendorId];

    if (unreadOnly) {
      whereClause += ' AND is_read = FALSE';
    }

    if (type) {
      whereClause += ' AND notification_type = ?';
      queryParams.push(type);
    }

    const [notifications] = await db.promise().query(`
      SELECT * FROM payout_notifications 
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...queryParams, limit, offset]);

    return {
      success: true,
      notifications
    };
  } catch (error) {
    console.error('Error fetching vendor notifications:', error);
    throw error;
  }
}

/**
 * Clean up old notifications
 */
async function cleanupOldNotifications(daysToKeep = 30) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const [result] = await db.promise().query(`
      DELETE FROM payout_notifications 
      WHERE is_read = TRUE AND created_at < ?
    `, [cutoffDate.toISOString()]);

    console.log(`Cleaned up ${result.affectedRows} old notifications`);
    
    return {
      success: true,
      deletedCount: result.affectedRows
    };
  } catch (error) {
    console.error('Error cleaning up old notifications:', error);
    throw error;
  }
}

module.exports = {
  createPayoutNotification,
  sendEmailNotification,
  sendPayoutNotification,
  markNotificationAsRead,
  getVendorNotifications,
  cleanupOldNotifications,
  generateEmailTemplate
};
