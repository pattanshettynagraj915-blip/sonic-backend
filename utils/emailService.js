require('dotenv').config();
const nodemailer = require('nodemailer');


// Lazily-created singleton transporter
let cachedTransporter = null;
const getTransporter = () => {
  if (cachedTransporter) return cachedTransporter;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' ? true : (port === 465);

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    // Give a clear diagnostic rather than Nodemailer's generic error
    const msg = 'SMTP credentials missing. Please set SMTP_USER and SMTP_PASS in your .env.';
    console.error(msg, { host: process.env.SMTP_HOST, port });
    throw new Error(msg);
  }

  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure,
    auth: { user, pass }
  });
  return cachedTransporter;
};

// Send password reset email
const sendPasswordResetEmail = async (email, resetLink, vendorName) => {
  try {
    const transporter = getTransporter();
    
    const mailOptions = {
      from: process.env.FROM_EMAIL || process.env.SMTP_USER || 'noreply@sonickart.com',
      to: email,
      subject: 'SonicKart - Password Reset Request',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 28px;">SonicKart</h1>
            <p style="color: #ffc727; margin: 10px 0 0 0; font-size: 16px;">From your store to every doorstep</p>
          </div>
          
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            <h2 style="color: #333; margin-top: 0;">Password Reset Request</h2>
            
            <p>Hello ${vendorName || 'Vendor'},</p>
            
            <p>We received a request to reset your password for your SonicKart vendor account. If you made this request, click the button below to reset your password:</p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" 
                 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        color: white; 
                        padding: 15px 30px; 
                        text-decoration: none; 
                        border-radius: 8px; 
                        font-weight: bold;
                        display: inline-block;">
                Reset Password
              </a>
            </div>
            
            <p style="color: #666; font-size: 14px;">
              This link will expire in 15 minutes for security reasons.
            </p>
            
            <p style="color: #666; font-size: 14px;">
              If you didn't request this password reset, please ignore this email. Your password will remain unchanged.
            </p>
            
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            
            <p style="color: #999; font-size: 12px; text-align: center;">
              This is an automated message from SonicKart. Please do not reply to this email.
            </p>
          </div>
        </div>
      `
    };

    const result = await transporter.sendMail(mailOptions);
    console.log('Password reset email sent:', result.messageId);
    return { success: true, messageId: result.messageId };
    
  } catch (error) {
    console.error('Error sending password reset email:', error);
    return { success: false, error: error.message };
  }
};

// Send password reset success email
const sendPasswordResetSuccessEmail = async (email, vendorName) => {
  try {
    const transporter = getTransporter();
    
    const mailOptions = {
      from: process.env.FROM_EMAIL || process.env.SMTP_USER || 'noreply@sonickart.com',
      to: email,
      subject: 'SonicKart - Password Successfully Reset',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 28px;">SonicKart</h1>
            <p style="color: #ffc727; margin: 10px 0 0 0; font-size: 16px;">From your store to every doorstep</p>
          </div>
          
          <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            <h2 style="color: #333; margin-top: 0;">Password Successfully Reset</h2>
            
            <p>Hello ${vendorName || 'Vendor'},</p>
            
            <p>Your password has been successfully reset. You can now log in to your SonicKart vendor account with your new password.</p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/#/vendor-login" 
                 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        color: white; 
                        padding: 15px 30px; 
                        text-decoration: none; 
                        border-radius: 8px; 
                        font-weight: bold;
                        display: inline-block;">
                Login to Your Account
              </a>
            </div>
            
            <p style="color: #666; font-size: 14px;">
              If you didn't make this change, please contact our support team immediately.
            </p>
            
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            
            <p style="color: #999; font-size: 12px; text-align: center;">
              This is an automated message from SonicKart. Please do not reply to this email.
            </p>
          </div>
        </div>
      `
    };

    const result = await transporter.sendMail(mailOptions);
    console.log('Password reset success email sent:', result.messageId);
    return { success: true, messageId: result.messageId };
    
  } catch (error) {
    console.error('Error sending password reset success email:', error);
    return { success: false, error: error.message };
  }
};

// Generic reusable email sender
const sendEmail = async ({ to, subject, html, text, from }) => {
  try {
    const transporter = getTransporter();
    const result = await transporter.sendMail({
      from: from || process.env.FROM_EMAIL || process.env.SMTP_USER || 'noreply@sonickart.com',
      to,
      subject,
      text,
      html
    });
    console.log('Email sent:', { to, subject, messageId: result.messageId });
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('Error sending email:', { to, subject, error: error.message });
    return { success: false, error: error.message };
  }
};

// Welcome email to vendor after successful registration
const sendVendorWelcomeEmail = async (email, vendorName, shopName) => {
  const appName = process.env.APP_NAME || 'SonicKart';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const subject = `${appName} – Welcome aboard${vendorName ? ', ' + vendorName : ''}!`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">${appName}</h1>
        <p style="color: #ffc727; margin: 10px 0 0 0; font-size: 14px;">From your store to every doorstep</p>
      </div>
      <div style="background: white; padding: 24px; border-radius: 0 0 10px 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.08);">
        <h2 style="color: #333; margin-top: 0;">Welcome to ${appName}</h2>
        <p>Hi ${vendorName || 'there'},</p>
        <p>Thanks for registering your store${shopName ? ' "' + shopName + '"' : ''}. Our team will review your details shortly. You’ll receive a notification once your account is approved.</p>
        <p>You can visit your dashboard anytime:</p>
        <div style="text-align:center; margin: 24px 0;">
          <a href="${frontendUrl}/#/vendor-login" style="background:#6b5df6;color:white;padding:12px 20px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">Go to Vendor Login</a>
        </div>
        <p style="color:#666;font-size:13px;">If you didn’t create this account, please ignore this message.</p>
      </div>
    </div>
  `;
  return sendEmail({ to: email, subject, html });
};

module.exports = {
  sendPasswordResetEmail,
  sendPasswordResetSuccessEmail,
  sendEmail,
  sendVendorWelcomeEmail
};
