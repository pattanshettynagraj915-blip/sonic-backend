const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'vendor_portal',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Security middleware for rate limiting
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: 'Too many login attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.vendorId = decoded.vendorId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Vendor profile endpoint
app.get('/api/vendor/profile', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT id, business_name as shopName, owner_name as ownerName, owner_email as email, 
              owner_phone as phone, address as shopAddress, status, logo_url, banner_url
       FROM vendors WHERE id = ?`,
      [req.vendorId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Get vendor profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Products endpoints
app.get('/api/products', verifyToken, async (req, res) => {
  try {
    const [products] = await db.promise().query(
      'SELECT * FROM products WHERE vendor_id = ? ORDER BY created_at DESC',
      [req.vendorId]
    );
    res.json({ products });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/products', verifyToken, async (req, res) => {
  try {
    const { name, description, price, category, stock_quantity, unit, sku } = req.body;
    
    const [result] = await db.promise().query(
      'INSERT INTO products (vendor_id, name, description, price, category, stock_quantity, unit, sku, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, "active", NOW())',
      [req.vendorId, name, description, price, category, stock_quantity, unit, sku]
    );
    
    res.json({ id: result.insertId, message: 'Product created successfully' });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Orders endpoints
app.get('/api/orders/vendor/:vendorId', verifyToken, async (req, res) => {
  try {
    const { vendorId } = req.params;
    
    if (parseInt(vendorId) !== req.vendorId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const [orders] = await db.promise().query(
      'SELECT * FROM orders WHERE vendor_id = ? ORDER BY created_at DESC',
      [vendorId]
    );
    
    res.json({ orders });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Inventory endpoints
app.get('/api/inventory/vendor/:vendorId', verifyToken, async (req, res) => {
  try {
    const { vendorId } = req.params;
    
    if (parseInt(vendorId) !== req.vendorId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const [inventory] = await db.promise().query(
      'SELECT p.*, i.stock_on_hand, i.stock_reserved, i.stock_available FROM products p LEFT JOIN inventory i ON p.id = i.product_id WHERE p.vendor_id = ?',
      [vendorId]
    );
    
    res.json({ inventory });
  } catch (error) {
    console.error('Get inventory error:', error);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// Payouts endpoints
app.get('/api/payouts/vendor/summary', verifyToken, async (req, res) => {
  try {
    // Mock payout data for testing
    res.json({
      summary: {
        total_earnings: 0,
        available_balance: 0,
        pending_payouts: { count: 0, amount: 0 },
        total_paid: 0
      },
      recent_transactions: [],
      payout_config: {}
    });
  } catch (error) {
    console.error('Get payouts error:', error);
    res.status(500).json({ error: 'Failed to fetch payout summary' });
  }
});

// KYC endpoints
app.get('/api/vendors/:id/kyc-status', async (req, res) => {
  try {
    const { id } = req.params;
    const [vendor] = await db.promise().query(
      'SELECT kyc_status, kyc_submitted_at, kyc_reviewed_at FROM vendors WHERE id = ?',
      [id]
    );
    
    if (vendor.length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    
    res.json(vendor[0]);
  } catch (error) {
    console.error('Get KYC status error:', error);
    res.status(500).json({ error: 'Failed to fetch KYC status' });
  }
});

// Shop status endpoints
app.get('/api/vendor/shop-status', verifyToken, async (req, res) => {
  try {
    const [vendor] = await db.promise().query(
      'SELECT is_open, last_opened_at FROM vendors WHERE id = ?',
      [req.vendorId]
    );
    
    if (vendor.length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    
    res.json(vendor[0]);
  } catch (error) {
    console.error('Get shop status error:', error);
    res.status(500).json({ error: 'Failed to fetch shop status' });
  }
});

app.put('/api/vendor/shop-status', verifyToken, async (req, res) => {
  try {
    const { is_open } = req.body;
    
    await db.promise().query(
      'UPDATE vendors SET is_open = ?, last_opened_at = NOW() WHERE id = ?',
      [is_open, req.vendorId]
    );
    
    res.json({ message: 'Shop status updated successfully' });
  } catch (error) {
    console.error('Update shop status error:', error);
    res.status(500).json({ error: 'Failed to update shop status' });
  }
});

// Profile update endpoint
app.put('/api/vendor/profile', verifyToken, async (req, res) => {
  try {
    const { shopName, ownerName, phone, shopAddress } = req.body;
    
    await db.promise().query(
      'UPDATE vendors SET business_name = ?, owner_name = ?, owner_phone = ?, address = ? WHERE id = ?',
      [shopName, ownerName, phone, shopAddress, req.vendorId]
    );
    
    res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Apply rate limiting to login endpoint
app.post('/api/vendors/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Input validation
    if (!/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Find vendor by email
    const [vendors] = await db.promise().query('SELECT * FROM vendors WHERE owner_email = ?', [email]);

    if (vendors.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const vendor = vendors[0];

    // Check password
    if (!vendor.password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, vendor.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if account is suspended
    if (vendor.is_suspended) {
      return res.status(403).json({ error: 'Account is suspended' });
    }

    // Check if vendor is approved for login
    const approvedStatuses = ['approved'];
    const currentStatus = (vendor.status || 'pending').toLowerCase();
    if (!approvedStatuses.includes(currentStatus)) {
      return res.status(403).json({ 
        error: 'Account not approved yet. Please wait for admin approval before logging in.',
        status: currentStatus
      });
    }

    // Generate JWT token
    const token = jwt.sign({ vendorId: vendor.id, email }, JWT_SECRET, { expiresIn: '24h' });

    res.json({
      message: 'Login successful',
      vendor: {
        id: vendor.id,
        shopName: vendor.shop_name || vendor.business_name,
        ownerName: vendor.owner_name,
        email: vendor.owner_email,
        status: vendor.status
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is working!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Enhanced vendor portal server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔐 Login endpoint: http://localhost:${PORT}/api/vendors/login`);
  console.log(`📦 Products: http://localhost:${PORT}/api/products`);
  console.log(`📋 Orders: http://localhost:${PORT}/api/orders/vendor/:id`);
  console.log(`💰 Payouts: http://localhost:${PORT}/api/payouts/vendor/summary`);
});
