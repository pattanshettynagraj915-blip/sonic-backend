const mysql = require('mysql2');
const EventEmitter = require('events');
const { sendEmail } = require('../utils/emailService');

class NotificationService extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Listen for KYC events
    this.on('kycSubmitted', this.handleKycSubmitted.bind(this));
    this.on('vendorApproved', this.handleVendorApproved.bind(this));
    this.on('vendorRejected', this.handleVendorRejected.bind(this));
    
    // Listen for inventory events
    this.on('lowStockAlert', this.handleLowStockAlert.bind(this));
    
    // Listen for order events
    this.on('newOrder', this.handleNewOrder.bind(this));
    this.on('orderAssigned', this.handleOrderAssigned.bind(this));
    this.on('orderReassigned', this.handleOrderReassigned.bind(this));
  }

  async createNotification(userType, userId, eventType, title, message, metadata = null) {
    try {
      const [result] = await this.db.promise().query(`
        INSERT INTO notifications (user_type, user_id, event_type, title, message, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [userType, userId, eventType, title, message, JSON.stringify(metadata)]);

      return result.insertId;
    } catch (error) {
      console.error('Error creating notification:', error);
      throw error;
    }
  }

  async getNotifications(userType, userId, limit = 50, offset = 0) {
    try {
      const [notifications] = await this.db.promise().query(`
        SELECT id, event_type, title, message, status, metadata, created_at
        FROM notifications
        WHERE user_type = ? AND user_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `, [userType, userId, limit, offset]);

      return notifications;
    } catch (error) {
      console.error('Error fetching notifications:', error);
      throw error;
    }
  }

  async markAsRead(notificationId, userType, userId) {
    try {
      await this.db.promise().query(`
        UPDATE notifications
        SET status = 'read'
        WHERE id = ? AND user_type = ? AND user_id = ?
      `, [notificationId, userType, userId]);

      return true;
    } catch (error) {
      console.error('Error marking notification as read:', error);
      throw error;
    }
  }

  async markAllAsRead(userType, userId) {
    try {
      await this.db.promise().query(`
        UPDATE notifications
        SET status = 'read'
        WHERE user_type = ? AND user_id = ? AND status = 'unread'
      `, [userType, userId]);

      return true;
    } catch (error) {
      console.error('Error marking all notifications as read:', error);
      throw error;
    }
  }

  async getUnreadCount(userType, userId) {
    try {
      const [result] = await this.db.promise().query(`
        SELECT COUNT(*) as count
        FROM notifications
        WHERE user_type = ? AND user_id = ? AND status = 'unread'
      `, [userType, userId]);

      return result[0].count;
    } catch (error) {
      console.error('Error getting unread count:', error);
      throw error;
    }
  }

  async getNotificationTemplate(eventType) {
    try {
      const [templates] = await this.db.promise().query(`
        SELECT * FROM notification_templates
        WHERE event_type = ? AND is_active = TRUE
      `, [eventType]);

      return templates[0] || null;
    } catch (error) {
      console.error('Error getting notification template:', error);
      throw error;
    }
  }

  async getUserNotificationSettings(userType, userId) {
    try {
      const [settings] = await this.db.promise().query(`
        SELECT * FROM notification_settings
        WHERE user_type = ? AND user_id = ?
      `, [userType, userId]);

      return settings[0] || null;
    } catch (error) {
      console.error('Error getting notification settings:', error);
      throw error;
    }
  }

  async sendNotification(userType, userId, eventType, data = {}) {
    try {
      // Get notification template
      const template = await this.getNotificationTemplate(eventType);
      if (!template) {
        console.warn(`No template found for event type: ${eventType}`);
        return;
      }

      // Get user notification settings
      const settings = await this.getUserNotificationSettings(userType, userId);
      if (!settings) {
        console.warn(`No notification settings found for user: ${userType}:${userId}`);
        return;
      }

      // Replace placeholders in templates
      const title = this.replacePlaceholders(template.title_template, data);
      const message = this.replacePlaceholders(template.message_template, data);

      // Create notification in database
      const notificationId = await this.createNotification(
        userType, 
        userId, 
        eventType, 
        title, 
        message, 
        data
      );

      // Send email if enabled
      if (settings.email_notifications && template.email_template) {
        await this.sendEmailNotification(userType, userId, template.email_template, data);
      }

      // Send SMS if enabled
      if (settings.sms_notifications && template.sms_template) {
        await this.sendSmsNotification(userType, userId, template.sms_template, data);
      }

      // Emit real-time notification event
      this.emit('notificationCreated', {
        notificationId,
        userType,
        userId,
        eventType,
        title,
        message,
        data
      });

      return notificationId;
    } catch (error) {
      console.error('Error sending notification:', error);
      throw error;
    }
  }

  async sendEmailNotification(userType, userId, template, data) {
    try {
      const emailContent = this.replacePlaceholders(template, data);
      const userEmail = await this.getUserEmail(userType, userId);
      
      if (userEmail) {
        await sendEmail(userEmail, 'Notification from Vendor Portal', emailContent);
      }
    } catch (error) {
      console.error('Error sending email notification:', error);
    }
  }

  async sendSmsNotification(userType, userId, template, data) {
    try {
      const smsContent = this.replacePlaceholders(template, data);
      const userPhone = await this.getUserPhone(userType, userId);
      
      if (userPhone) {
        // TODO: Implement SMS service
        console.log(`SMS to ${userPhone}: ${smsContent}`);
      }
    } catch (error) {
      console.error('Error sending SMS notification:', error);
    }
  }

  async getUserEmail(userType, userId) {
    try {
      const table = userType === 'admin' ? 'admin_users' : 'vendors';
      const [users] = await this.db.promise().query(`
        SELECT email FROM ${table} WHERE id = ?
      `, [userId]);

      return users[0]?.email || null;
    } catch (error) {
      console.error('Error getting user email:', error);
      return null;
    }
  }

  async getUserPhone(userType, userId) {
    try {
      if (userType === 'vendor') {
        const [vendors] = await this.db.promise().query(`
          SELECT phone FROM vendors WHERE id = ?
        `, [userId]);

        return vendors[0]?.phone || null;
      }
      return null;
    } catch (error) {
      console.error('Error getting user phone:', error);
      return null;
    }
  }

  replacePlaceholders(template, data) {
    let result = template;
    
    // Replace common placeholders
    const placeholders = {
      '{{vendor_name}}': data.vendor_name || 'Vendor',
      '{{vendor_email}}': data.vendor_email || '',
      '{{product_name}}': data.product_name || 'Product',
      '{{current_stock}}': data.current_stock || '0',
      '{{threshold}}': data.threshold || '10',
      '{{order_id}}': data.order_id || '',
      '{{total_amount}}': data.total_amount || '0',
      '{{customer_name}}': data.customer_name || 'Customer',
      '{{rejection_reason}}': data.rejection_reason || 'Please check your documents',
      '{{admin_name}}': data.admin_name || 'Admin'
    };

    for (const [placeholder, value] of Object.entries(placeholders)) {
      result = result.replace(new RegExp(placeholder, 'g'), value);
    }

    return result;
  }

  // Event handlers
  async handleKycSubmitted(data) {
    try {
      // Notify all admins
      const [admins] = await this.db.promise().query(`
        SELECT id FROM admin_users
      `);

      for (const admin of admins) {
        await this.sendNotification('admin', admin.id, 'KYC_SUBMITTED', data);
      }
    } catch (error) {
      console.error('Error handling KYC submitted event:', error);
    }
  }

  async handleVendorApproved(data) {
    try {
      await this.sendNotification('vendor', data.vendor_id, 'VENDOR_APPROVED', data);
    } catch (error) {
      console.error('Error handling vendor approved event:', error);
    }
  }

  async handleVendorRejected(data) {
    try {
      await this.sendNotification('vendor', data.vendor_id, 'VENDOR_REJECTED', data);
    } catch (error) {
      console.error('Error handling vendor rejected event:', error);
    }
  }

  async handleLowStockAlert(data) {
    try {
      // Notify vendor
      await this.sendNotification('vendor', data.vendor_id, 'LOW_STOCK_ALERT', data);
      
      // Notify all admins
      const [admins] = await this.db.promise().query(`
        SELECT id FROM admin_users
      `);

      for (const admin of admins) {
        await this.sendNotification('admin', admin.id, 'LOW_STOCK_ALERT', data);
      }
    } catch (error) {
      console.error('Error handling low stock alert event:', error);
    }
  }

  async handleNewOrder(data) {
    try {
      await this.sendNotification('vendor', data.vendor_id, 'NEW_ORDER', data);
    } catch (error) {
      console.error('Error handling new order event:', error);
    }
  }

  async handleOrderAssigned(data) {
    try {
      await this.sendNotification('vendor', data.vendor_id, 'ORDER_ASSIGNED', data);
    } catch (error) {
      console.error('Error handling order assigned event:', error);
    }
  }

  async handleOrderReassigned(data) {
    try {
      await this.sendNotification('vendor', data.vendor_id, 'ORDER_REASSIGNED', data);
    } catch (error) {
      console.error('Error handling order reassigned event:', error);
    }
  }
}

module.exports = NotificationService;
