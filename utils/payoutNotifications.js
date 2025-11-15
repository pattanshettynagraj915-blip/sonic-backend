const nodemailer = require('nodemailer');
const db = require('./db');

// Email configuration
const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

/**
 * Notification types and templates
 */
const NOTIFICATION_TYPES = {
  PAYOUT_REQUESTED: 'payout_requested',
  PAYOUT_APPROVED: 'payout_approved',
  PAYOUT_REJECTED: 'payout_rejected',
  PAYOUT_PROCESSING: 'payout_processing',
  PAYOUT_PAID: 'payout_paid',
  PAYOUT_FAILED: 'payout_failed',
  PAYMENT_METHOD_ADDED: 'payment_method_added',
  PAYMENT_METHOD_VERIFIED: 'payment_method_verified',
  PAYMENT_METHOD_REJECTED: 'payment_method_rejected',
  BALANCE_LOW: 'balance_low',
  SUSPICIOUS_ACTIVITY: 'suspicious_activity'
};

/**
 * Email templates
 */
const EMAIL_TEMPLATES = {
  [NOTIFICATION_TYPES.PAYOUT_REQUESTED]: {
    subject: 'Payout Request Submitted - #{payoutId}',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; color: white;">
          <h1 style="margin: 0; font-size: 24px;">Payout Request Submitted</h1>
        </div>
        <div style="padding: 30px; background: #f8f9fa;">
          <h2 style="color: #333; margin-top: 0;">Hello {vendorName},</h2>
          <p style="color: #666; line-height: 1.6;">
            Your payout request has been successfully submitted and is now under review.
          </p>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #333; margin-top: 0;">Payout Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #666;">Payout ID:</td>
                <td style="padding: 8px 0; font-weight: bold;">#{payoutId}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Requested Amount:</td>
                <td style="padding: 8px 0; font-weight: bold; color: #10b981;">₹{amount}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Payment Method:</td>
                <td style="padding: 8px 0;">{paymentMethod}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Status:</td>
                <td style="padding: 8px 0;"><span style="background: #fef3c7; color: #92400e; padding: 4px 8px; border-radius: 4px; font-size: 12px;">PENDING REVIEW</span></td>
              </tr>
            </table>
          </div>
          <p style="color: #666; line-height: 1.6;">
            We'll notify you once your payout request has been reviewed and approved. 
            Processing typically takes 1-2 business days.
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="{dashboardUrl}" style="background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Dashboard</a>
          </div>
        </div>
        <div style="background: #e5e7eb; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p>This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  },

  [NOTIFICATION_TYPES.PAYOUT_APPROVED]: {
    subject: 'Payout Approved - #{payoutId}',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center; color: white;">
          <h1 style="margin: 0; font-size: 24px;">✅ Payout Approved</h1>
        </div>
        <div style="padding: 30px; background: #f8f9fa;">
          <h2 style="color: #333; margin-top: 0;">Great news, {vendorName}!</h2>
          <p style="color: #666; line-height: 1.6;">
            Your payout request has been approved and will be processed shortly.
          </p>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #333; margin-top: 0;">Payout Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #666;">Payout ID:</td>
                <td style="padding: 8px 0; font-weight: bold;">#{payoutId}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Approved Amount:</td>
                <td style="padding: 8px 0; font-weight: bold; color: #10b981;">₹{approvedAmount}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Final Amount (after fees):</td>
                <td style="padding: 8px 0; font-weight: bold; color: #10b981;">₹{finalAmount}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Payment Method:</td>
                <td style="padding: 8px 0;">{paymentMethod}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Status:</td>
                <td style="padding: 8px 0;"><span style="background: #dcfce7; color: #166534; padding: 4px 8px; border-radius: 4px; font-size: 12px;">APPROVED</span></td>
              </tr>
            </table>
          </div>
          <p style="color: #666; line-height: 1.6;">
            Your funds will be transferred to your registered payment method within 1-2 business days.
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="{dashboardUrl}" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Dashboard</a>
          </div>
        </div>
        <div style="background: #e5e7eb; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p>This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  },

  [NOTIFICATION_TYPES.PAYOUT_REJECTED]: {
    subject: 'Payout Request Rejected - #{payoutId}',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 30px; text-align: center; color: white;">
          <h1 style="margin: 0; font-size: 24px;">❌ Payout Request Rejected</h1>
        </div>
        <div style="padding: 30px; background: #f8f9fa;">
          <h2 style="color: #333; margin-top: 0;">Hello {vendorName},</h2>
          <p style="color: #666; line-height: 1.6;">
            Unfortunately, your payout request has been rejected. The requested amount has been refunded to your available balance.
          </p>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #333; margin-top: 0;">Payout Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #666;">Payout ID:</td>
                <td style="padding: 8px 0; font-weight: bold;">#{payoutId}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Requested Amount:</td>
                <td style="padding: 8px 0; font-weight: bold;">₹{amount}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Status:</td>
                <td style="padding: 8px 0;"><span style="background: #fee2e2; color: #991b1b; padding: 4px 8px; border-radius: 4px; font-size: 12px;">REJECTED</span></td>
              </tr>
            </table>
          </div>
          {rejectionReason && `
            <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0;">
              <h4 style="color: #dc2626; margin-top: 0;">Rejection Reason:</h4>
              <p style="color: #666; margin-bottom: 0;">{rejectionReason}</p>
            </div>
          `}
          <p style="color: #666; line-height: 1.6;">
            You can submit a new payout request after addressing the issues mentioned above.
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="{dashboardUrl}" style="background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Dashboard</a>
          </div>
        </div>
        <div style="background: #e5e7eb; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p>This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  },

  [NOTIFICATION_TYPES.PAYOUT_PAID]: {
    subject: 'Payout Completed - #{payoutId}',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center; color: white;">
          <h1 style="margin: 0; font-size: 24px;">🎉 Payout Completed</h1>
        </div>
        <div style="padding: 30px; background: #f8f9fa;">
          <h2 style="color: #333; margin-top: 0;">Congratulations, {vendorName}!</h2>
          <p style="color: #666; line-height: 1.6;">
            Your payout has been successfully processed and the funds have been transferred to your account.
          </p>
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: #333; margin-top: 0;">Transaction Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #666;">Payout ID:</td>
                <td style="padding: 8px 0; font-weight: bold;">#{payoutId}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Amount Transferred:</td>
                <td style="padding: 8px 0; font-weight: bold; color: #10b981;">₹{finalAmount}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Transaction ID:</td>
                <td style="padding: 8px 0; font-family: monospace;">{transactionId}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Payment Method:</td>
                <td style="padding: 8px 0;">{paymentMethod}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Processed At:</td>
                <td style="padding: 8px 0;">{processedAt}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Status:</td>
                <td style="padding: 8px 0;"><span style="background: #dcfce7; color: #166534; padding: 4px 8px; border-radius: 4px; font-size: 12px;">COMPLETED</span></td>
              </tr>
            </table>
          </div>
          <p style="color: #666; line-height: 1.6;">
            Please allow 1-2 business days for the funds to reflect in your account. 
            Keep the transaction ID for your records.
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="{dashboardUrl}" style="background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View Dashboard</a>
          </div>
        </div>
        <div style="background: #e5e7eb; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p>This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `
  }
};

/**
 * Create in-app notification
 */
async function createNotification(vendorId, payoutId, type, title, message, metadata = {}) {
  try {
    await db.promise().query(`
      INSERT INTO payout_notifications (
        vendor_id, payout_id, notification_type, title, message, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [vendorId, payoutId, type, title, message, JSON.stringify(metadata)]);
    
    console.log(`Created notification for vendor ${vendorId}: ${type}`);
  } catch (error) {
    console.error('Error creating notification:', error);
  }
}

/**
 * Send email notification
 */
async function sendEmailNotification(vendorEmail, vendorName, type, data) {
  try {
    if (!process.env.SMTP_USER || !EMAIL_TEMPLATES[type]) {
      console.log('Email not configured or template not found:', type);
      return;
    }

    const template = EMAIL_TEMPLATES[type];
    let subject = template.subject;
    let html = template.html;

    // Replace placeholders
    const replacements = {
      vendorName,
      dashboardUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard`,
      ...data
    };

    Object.keys(replacements).forEach(key => {
      const value = replacements[key] || '';
      subject = subject.replace(new RegExp(`{${key}}`, 'g'), value);
      html = html.replace(new RegExp(`{${key}}`, 'g'), value);
    });

    await emailTransporter.sendMail({
      from: `"Vendor Portal" <${process.env.SMTP_USER}>`,
      to: vendorEmail,
      subject,
      html
    });

    console.log(`Email sent to ${vendorEmail}: ${type}`);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

/**
 * Send payout request notification
 */
async function notifyPayoutRequested(vendorId, payoutData) {
  try {
    // Get vendor details
    const [vendor] = await db.promise().query(`
      SELECT business_name, owner_name, owner_email 
      FROM vendors WHERE id = ?
    `, [vendorId]);

    if (vendor.length === 0) return;

    const vendorInfo = vendor[0];
    const title = 'Payout Request Submitted';
    const message = `Your payout request for ₹${payoutData.requested_amount} has been submitted and is under review.`;

    // Create in-app notification
    await createNotification(
      vendorId, 
      payoutData.id, 
      NOTIFICATION_TYPES.PAYOUT_REQUESTED, 
      title, 
      message,
      { amount: payoutData.requested_amount }
    );

    // Send email
    await sendEmailNotification(
      vendorInfo.owner_email,
      vendorInfo.owner_name || vendorInfo.business_name,
      NOTIFICATION_TYPES.PAYOUT_REQUESTED,
      {
        payoutId: payoutData.id,
        amount: payoutData.requested_amount,
        paymentMethod: payoutData.payment_method
      }
    );

    // Notify admins
    await notifyAdminsNewPayoutRequest(payoutData, vendorInfo);

  } catch (error) {
    console.error('Error sending payout request notification:', error);
  }
}

/**
 * Send payout approved notification
 */
async function notifyPayoutApproved(vendorId, payoutData) {
  try {
    const [vendor] = await db.promise().query(`
      SELECT business_name, owner_name, owner_email 
      FROM vendors WHERE id = ?
    `, [vendorId]);

    if (vendor.length === 0) return;

    const vendorInfo = vendor[0];
    const title = 'Payout Approved';
    const message = `Your payout request for ₹${payoutData.approved_amount || payoutData.requested_amount} has been approved.`;

    await createNotification(
      vendorId, 
      payoutData.id, 
      NOTIFICATION_TYPES.PAYOUT_APPROVED, 
      title, 
      message,
      { 
        approved_amount: payoutData.approved_amount,
        final_amount: payoutData.final_amount 
      }
    );

    await sendEmailNotification(
      vendorInfo.owner_email,
      vendorInfo.owner_name || vendorInfo.business_name,
      NOTIFICATION_TYPES.PAYOUT_APPROVED,
      {
        payoutId: payoutData.id,
        approvedAmount: payoutData.approved_amount || payoutData.requested_amount,
        finalAmount: payoutData.final_amount,
        paymentMethod: payoutData.payment_method
      }
    );

  } catch (error) {
    console.error('Error sending payout approved notification:', error);
  }
}

/**
 * Send payout rejected notification
 */
async function notifyPayoutRejected(vendorId, payoutData) {
  try {
    const [vendor] = await db.promise().query(`
      SELECT business_name, owner_name, owner_email 
      FROM vendors WHERE id = ?
    `, [vendorId]);

    if (vendor.length === 0) return;

    const vendorInfo = vendor[0];
    const title = 'Payout Request Rejected';
    const message = `Your payout request for ₹${payoutData.requested_amount} has been rejected. ${payoutData.rejection_reason || ''}`;

    await createNotification(
      vendorId, 
      payoutData.id, 
      NOTIFICATION_TYPES.PAYOUT_REJECTED, 
      title, 
      message,
      { 
        amount: payoutData.requested_amount,
        rejection_reason: payoutData.rejection_reason 
      }
    );

    await sendEmailNotification(
      vendorInfo.owner_email,
      vendorInfo.owner_name || vendorInfo.business_name,
      NOTIFICATION_TYPES.PAYOUT_REJECTED,
      {
        payoutId: payoutData.id,
        amount: payoutData.requested_amount,
        rejectionReason: payoutData.rejection_reason
      }
    );

  } catch (error) {
    console.error('Error sending payout rejected notification:', error);
  }
}

/**
 * Send payout completed notification
 */
async function notifyPayoutCompleted(vendorId, payoutData) {
  try {
    const [vendor] = await db.promise().query(`
      SELECT business_name, owner_name, owner_email 
      FROM vendors WHERE id = ?
    `, [vendorId]);

    if (vendor.length === 0) return;

    const vendorInfo = vendor[0];
    const title = 'Payout Completed';
    const message = `Your payout of ₹${payoutData.final_amount} has been successfully processed. Transaction ID: ${payoutData.transaction_id}`;

    await createNotification(
      vendorId, 
      payoutData.id, 
      NOTIFICATION_TYPES.PAYOUT_PAID, 
      title, 
      message,
      { 
        final_amount: payoutData.final_amount,
        transaction_id: payoutData.transaction_id 
      }
    );

    await sendEmailNotification(
      vendorInfo.owner_email,
      vendorInfo.owner_name || vendorInfo.business_name,
      NOTIFICATION_TYPES.PAYOUT_PAID,
      {
        payoutId: payoutData.id,
        finalAmount: payoutData.final_amount,
        transactionId: payoutData.transaction_id,
        paymentMethod: payoutData.payment_method,
        processedAt: new Date(payoutData.paid_at).toLocaleString('en-IN')
      }
    );

  } catch (error) {
    console.error('Error sending payout completed notification:', error);
  }
}

/**
 * Notify admins of new payout request
 */
async function notifyAdminsNewPayoutRequest(payoutData, vendorInfo) {
  try {
    // Get admin emails
    const [admins] = await db.promise().query(`
      SELECT email FROM admin_users WHERE role = 'admin'
    `);

    const adminEmails = admins.map(admin => admin.email);
    
    if (adminEmails.length === 0) return;

    const subject = `New Payout Request - ₹${payoutData.requested_amount} from ${vendorInfo.business_name}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1e293b; padding: 20px; color: white;">
          <h2>New Payout Request</h2>
        </div>
        <div style="padding: 20px;">
          <p><strong>Vendor:</strong> ${vendorInfo.business_name}</p>
          <p><strong>Owner:</strong> ${vendorInfo.owner_name}</p>
          <p><strong>Amount:</strong> ₹${payoutData.requested_amount}</p>
          <p><strong>Payout ID:</strong> #${payoutData.id}</p>
          <p><strong>Payment Method:</strong> ${payoutData.payment_method}</p>
          <div style="margin: 20px 0;">
            <a href="${process.env.ADMIN_URL || 'http://localhost:3000'}/admin/payouts" 
               style="background: #1e293b; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
              Review Request
            </a>
          </div>
        </div>
      </div>
    `;

    for (const email of adminEmails) {
      await emailTransporter.sendMail({
        from: `"Vendor Portal" <${process.env.SMTP_USER}>`,
        to: email,
        subject,
        html
      });
    }

    console.log(`Admin notification sent for payout ${payoutData.id}`);
  } catch (error) {
    console.error('Error notifying admins:', error);
  }
}

/**
 * Send low balance notification
 */
async function notifyLowBalance(vendorId, currentBalance, threshold = 100) {
  try {
    if (currentBalance > threshold) return;

    const [vendor] = await db.promise().query(`
      SELECT business_name, owner_name, owner_email 
      FROM vendors WHERE id = ?
    `, [vendorId]);

    if (vendor.length === 0) return;

    const vendorInfo = vendor[0];
    const title = 'Low Balance Alert';
    const message = `Your available balance is ₹${currentBalance}. Consider adding more funds or completing more orders.`;

    await createNotification(
      vendorId, 
      null, 
      NOTIFICATION_TYPES.BALANCE_LOW, 
      title, 
      message,
      { current_balance: currentBalance, threshold }
    );

  } catch (error) {
    console.error('Error sending low balance notification:', error);
  }
}

/**
 * Send suspicious activity alert
 */
async function notifySuspiciousActivity(vendorId, activityDetails) {
  try {
    const [vendor] = await db.promise().query(`
      SELECT business_name, owner_name, owner_email 
      FROM vendors WHERE id = ?
    `, [vendorId]);

    if (vendor.length === 0) return;

    const vendorInfo = vendor[0];
    const title = 'Security Alert';
    const message = `Suspicious activity detected on your account. Please review your recent transactions.`;

    await createNotification(
      vendorId, 
      null, 
      NOTIFICATION_TYPES.SUSPICIOUS_ACTIVITY, 
      title, 
      message,
      activityDetails
    );

    // Also notify admins
    const [admins] = await db.promise().query(`
      SELECT email FROM admin_users WHERE role = 'admin'
    `);

    for (const admin of admins) {
      await emailTransporter.sendMail({
        from: `"Vendor Portal Security" <${process.env.SMTP_USER}>`,
        to: admin.email,
        subject: `Security Alert - Suspicious Activity: ${vendorInfo.business_name}`,
        html: `
          <div style="font-family: Arial, sans-serif;">
            <h3 style="color: #dc2626;">Security Alert</h3>
            <p><strong>Vendor:</strong> ${vendorInfo.business_name}</p>
            <p><strong>Activity:</strong> ${JSON.stringify(activityDetails, null, 2)}</p>
            <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          </div>
        `
      });
    }

  } catch (error) {
    console.error('Error sending suspicious activity notification:', error);
  }
}

/**
 * Mark notifications as read
 */
async function markNotificationsAsRead(vendorId, notificationIds) {
  try {
    if (!Array.isArray(notificationIds)) {
      notificationIds = [notificationIds];
    }

    const placeholders = notificationIds.map(() => '?').join(',');
    await db.promise().query(`
      UPDATE payout_notifications 
      SET is_read = TRUE, read_at = NOW()
      WHERE vendor_id = ? AND id IN (${placeholders})
    `, [vendorId, ...notificationIds]);

  } catch (error) {
    console.error('Error marking notifications as read:', error);
  }
}

/**
 * Get unread notification count
 */
async function getUnreadNotificationCount(vendorId) {
  try {
    const [result] = await db.promise().query(`
      SELECT COUNT(*) as count
      FROM payout_notifications 
      WHERE vendor_id = ? AND is_read = FALSE
    `, [vendorId]);

    return result[0].count;
  } catch (error) {
    console.error('Error getting unread notification count:', error);
    return 0;
  }
}

/**
 * Clean up old notifications (keep last 100 per vendor)
 */
async function cleanupOldNotifications() {
  try {
    await db.promise().query(`
      DELETE pn1 FROM payout_notifications pn1
      INNER JOIN (
        SELECT vendor_id, 
               ROW_NUMBER() OVER (PARTITION BY vendor_id ORDER BY created_at DESC) as rn
        FROM payout_notifications
      ) pn2 ON pn1.vendor_id = pn2.vendor_id
      WHERE pn2.rn > 100
    `);

    console.log('Old notifications cleaned up');
  } catch (error) {
    console.error('Error cleaning up old notifications:', error);
  }
}

module.exports = {
  NOTIFICATION_TYPES,
  createNotification,
  sendEmailNotification,
  notifyPayoutRequested,
  notifyPayoutApproved,
  notifyPayoutRejected,
  notifyPayoutCompleted,
  notifyAdminsNewPayoutRequest,
  notifyLowBalance,
  notifySuspiciousActivity,
  markNotificationsAsRead,
  getUnreadNotificationCount,
  cleanupOldNotifications
};
