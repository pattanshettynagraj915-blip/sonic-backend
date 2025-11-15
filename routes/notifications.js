const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

// Use the shared database pool from utils/db.js
const db = require('../utils/db');

// Authentication middleware
const authenticateUser = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies.vendor_token || req.cookies.admin_token;
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Get notifications for current user
router.get('/', authenticateUser, async (req, res) => {
  try {
    const { user_type, user_id } = req.user;
    const { limit = 50, offset = 0 } = req.query;

    const [notifications] = await db.promise().query(`
      SELECT id, event_type, title, message, status, metadata, created_at
      FROM notifications
      WHERE user_type = ? AND user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [user_type, user_id, parseInt(limit), parseInt(offset)]);

    // Format notifications for frontend
    const formattedNotifications = notifications.map(notification => ({
      id: notification.id,
      title: notification.title,
      message: notification.message,
      time: formatTimeAgo(notification.created_at),
      unread: notification.status === 'unread',
      eventType: notification.event_type,
      metadata: notification.metadata ? JSON.parse(notification.metadata) : null
    }));

    res.json({
      success: true,
      notifications: formattedNotifications
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Get unread count
router.get('/unread-count', authenticateUser, async (req, res) => {
  try {
    const { user_type, user_id } = req.user;

    const [result] = await db.promise().query(`
      SELECT COUNT(*) as count
      FROM notifications
      WHERE user_type = ? AND user_id = ? AND status = 'unread'
    `, [user_type, user_id]);

    res.json({
      success: true,
      unreadCount: result[0].count
    });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// Mark notification as read
router.put('/:id/read', authenticateUser, async (req, res) => {
  try {
    const { user_type, user_id } = req.user;
    const { id } = req.params;

    await db.promise().query(`
      UPDATE notifications
      SET status = 'read'
      WHERE id = ? AND user_type = ? AND user_id = ?
    `, [id, user_type, user_id]);

    res.json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

// Mark all notifications as read
router.put('/mark-all-read', authenticateUser, async (req, res) => {
  try {
    const { user_type, user_id } = req.user;

    await db.promise().query(`
      UPDATE notifications
      SET status = 'read'
      WHERE user_type = ? AND user_id = ? AND status = 'unread'
    `, [user_type, user_id]);

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

// Get notification settings
router.get('/settings', authenticateUser, async (req, res) => {
  try {
    const { user_type, user_id } = req.user;

    const [settings] = await db.promise().query(`
      SELECT * FROM notification_settings
      WHERE user_type = ? AND user_id = ?
    `, [user_type, user_id]);

    res.json({
      success: true,
      settings: settings[0] || {
        email_notifications: true,
        sms_notifications: false,
        push_notifications: true,
        kyc_notifications: true,
        order_notifications: true,
        inventory_notifications: true
      }
    });
  } catch (error) {
    console.error('Error fetching notification settings:', error);
    res.status(500).json({ error: 'Failed to fetch notification settings' });
  }
});

// Update notification settings
router.put('/settings', authenticateUser, async (req, res) => {
  try {
    const { user_type, user_id } = req.user;
    const {
      email_notifications,
      sms_notifications,
      push_notifications,
      kyc_notifications,
      order_notifications,
      inventory_notifications
    } = req.body;

    await db.promise().query(`
      INSERT INTO notification_settings (
        user_type, user_id, email_notifications, sms_notifications, 
        push_notifications, kyc_notifications, order_notifications, inventory_notifications
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        email_notifications = VALUES(email_notifications),
        sms_notifications = VALUES(sms_notifications),
        push_notifications = VALUES(push_notifications),
        kyc_notifications = VALUES(kyc_notifications),
        order_notifications = VALUES(order_notifications),
        inventory_notifications = VALUES(inventory_notifications)
    `, [
      user_type, user_id, email_notifications, sms_notifications,
      push_notifications, kyc_notifications, order_notifications, inventory_notifications
    ]);

    res.json({
      success: true,
      message: 'Notification settings updated successfully'
    });
  } catch (error) {
    console.error('Error updating notification settings:', error);
    res.status(500).json({ error: 'Failed to update notification settings' });
  }
});

// Helper function to format time ago
function formatTimeAgo(date) {
  const now = new Date();
  const notificationDate = new Date(date);
  const diffInSeconds = Math.floor((now - notificationDate) / 1000);

  if (diffInSeconds < 60) {
    return 'Just now';
  } else if (diffInSeconds < 3600) {
    const minutes = Math.floor(diffInSeconds / 60);
    return `${minutes} min ago`;
  } else if (diffInSeconds < 86400) {
    const hours = Math.floor(diffInSeconds / 3600);
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  } else if (diffInSeconds < 604800) {
    const days = Math.floor(diffInSeconds / 86400);
    return `${days} day${days > 1 ? 's' : ''} ago`;
  } else {
    return notificationDate.toLocaleDateString();
  }
}

module.exports = router;
