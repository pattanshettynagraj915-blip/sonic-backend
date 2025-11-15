const jwt = require('jsonwebtoken');

class SocketService {
  constructor(io) {
    this.io = io;
    this.connectedUsers = new Map(); // Map to store user connections
    this.setupSocketHandlers();
  }

  setupSocketHandlers() {
    this.io.on('connection', (socket) => {
      console.log('New socket connection:', socket.id);

      // Handle user authentication
      socket.on('authenticate', (data) => {
        try {
          const token = data.token;
          const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
          
          // Store user connection
          const userKey = `${decoded.user_type}:${decoded.user_id}`;
          this.connectedUsers.set(userKey, {
            socketId: socket.id,
            userType: decoded.user_type,
            userId: decoded.user_id,
            email: decoded.email
          });

          // Join user to their personal room
          socket.join(userKey);
          
          console.log(`User authenticated: ${userKey}`);
          socket.emit('authenticated', { success: true });
        } catch (error) {
          console.error('Socket authentication error:', error);
          socket.emit('authentication_error', { error: 'Invalid token' });
        }
      });

      // Handle joining specific rooms (e.g., admin room)
      socket.on('join_room', (room) => {
        socket.join(room);
        console.log(`Socket ${socket.id} joined room: ${room}`);
      });

      // Handle leaving rooms
      socket.on('leave_room', (room) => {
        socket.leave(room);
        console.log(`Socket ${socket.id} left room: ${room}`);
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        console.log('Socket disconnected:', socket.id);
        
        // Remove user from connected users map
        for (const [userKey, userData] of this.connectedUsers.entries()) {
          if (userData.socketId === socket.id) {
            this.connectedUsers.delete(userKey);
            break;
          }
        }
      });
    });
  }

  // Send notification to specific user
  sendNotificationToUser(userType, userId, notification) {
    const userKey = `${userType}:${userId}`;
    const userData = this.connectedUsers.get(userKey);
    
    if (userData) {
      this.io.to(userData.socketId).emit('new_notification', notification);
      console.log(`Notification sent to user: ${userKey}`);
    } else {
      console.log(`User not connected: ${userKey}`);
    }
  }

  // Send notification to all users of a specific type
  sendNotificationToUserType(userType, notification) {
    for (const [userKey, userData] of this.connectedUsers.entries()) {
      if (userData.userType === userType) {
        this.io.to(userData.socketId).emit('new_notification', notification);
      }
    }
    console.log(`Notification sent to all ${userType}s`);
  }

  // Send notification to all admins
  sendNotificationToAdmins(notification) {
    this.sendNotificationToUserType('admin', notification);
  }

  // Send notification to all vendors
  sendNotificationToVendors(notification) {
    this.sendNotificationToUserType('vendor', notification);
  }

  // Send notification to specific room
  sendNotificationToRoom(room, notification) {
    this.io.to(room).emit('new_notification', notification);
    console.log(`Notification sent to room: ${room}`);
  }

  // Broadcast notification to all connected users
  broadcastNotification(notification) {
    this.io.emit('new_notification', notification);
    console.log('Notification broadcasted to all users');
  }

  // Get connected users count
  getConnectedUsersCount() {
    return this.connectedUsers.size;
  }

  // Get connected users by type
  getConnectedUsersByType(userType) {
    const users = [];
    for (const [userKey, userData] of this.connectedUsers.entries()) {
      if (userData.userType === userType) {
        users.push(userData);
      }
    }
    return users;
  }

  // Check if user is connected
  isUserConnected(userType, userId) {
    const userKey = `${userType}:${userId}`;
    return this.connectedUsers.has(userKey);
  }

  // Get user's socket ID
  getUserSocketId(userType, userId) {
    const userKey = `${userType}:${userId}`;
    const userData = this.connectedUsers.get(userKey);
    return userData ? userData.socketId : null;
  }
}

module.exports = SocketService;
