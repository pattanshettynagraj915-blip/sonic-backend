// Load environment variables FIRST before any other requires
const path = require('path');
require("dotenv").config({ path: path.resolve(__dirname, '.env') });

const nodemailer = require('nodemailer');
const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const csv = require('csv-parser');
const csvWriter = require('csv-writer');
const http = require('http');
const socketIo = require('socket.io');
const { sendPasswordResetEmail, sendPasswordResetSuccessEmail, sendVendorWelcomeEmail, sendEmail: sendEmailService } = require('./utils/emailService');
const db = require("./utils/db");
// Import notification services
const NotificationService = require('./services/NotificationService');
const SocketService = require('./services/SocketService');

// Import inventory routes
const inventoryRoutes = require('./routes/inventory');
// Admin authentication routes
// const adminAuthRoutes = require('./routes/admin-auth');
// Import authentication middleware
// const { authenticateAdmin, authenticateVendor, preventCrossRoleAccess } = require('./middleware/auth');
// Payments routes
let paymentsRoutes = null;
try {
  paymentsRoutes = require('./routes/payments');
} catch (e) {
  console.warn('Payments router failed to load:', e?.message || e);
}
// Orders routes
let ordersRoutes = null;
try {
  ordersRoutes = require('./routes/orders');
} catch (e) {
  console.warn('Orders router failed to load:', e?.message || e);
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  }
});
const PORT = process.env.PORT || 5000;


// Middleware
app.use(cors({ 
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true 
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Safe JSON parse helper to avoid throwing on already-object values or invalid JSON
function parseJsonSafely(possibleJson, fallback = null) {
  if (possibleJson === null || possibleJson === undefined) return fallback;
  if (typeof possibleJson === 'object') return possibleJson; // already parsed
  if (typeof possibleJson !== 'string') return fallback;
  const trimmed = possibleJson.trim();
  if (trimmed === '') return fallback;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return fallback;
  }
}

// Promote secure vendor cookie to Authorization header for downstream route auth
app.use((req, res, next) => {
  // If Authorization header missing but we have vendor_token cookie, synthesize it
  if (!req.headers['authorization'] && req.cookies && req.cookies.vendor_token) {
    req.headers['authorization'] = `Bearer ${req.cookies.vendor_token}`;
  }
  next();
});
// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Use inventory routes
app.use('/api/inventory', inventoryRoutes);

// Products routes (vendor-side products CRUD and listing)
try {
  const productsRoutes = require('./routes/products');
  app.use('/api/products', productsRoutes);
} catch (e) {
  console.warn('Products routes failed to mount:', e?.message || e);
}
// Vendor profile routes
try {
  const vendorsRoutes = require('./routes/vendors');
  app.use('/api/vendors', vendorsRoutes);
} catch (e) {
  console.warn('Vendors routes failed to mount:', e?.message || e);
}
// Use admin authentication routes
// app.use('/api/admin', adminAuthRoutes);
// Use payments routes
if (paymentsRoutes) {
  app.use('/api/payments', paymentsRoutes);
}
// Use orders routes
if (ordersRoutes) {
  app.use('/api/orders', ordersRoutes);
}
// Admin Reports Router
try {
  const adminReportsRouter = require('./routes/adminReports');
  app.use('/api/admin/reports', adminReportsRouter);
} catch (e) {
  console.warn('Admin reports router failed to mount:', e?.message || e);
}

// Admin Payments Router
try {
  const adminPaymentsRouter = require('./routes/payments');
  app.use('/api/admin/payments', adminPaymentsRouter);
} catch (e) {
  console.warn('Admin payments router failed to mount:', e?.message || e);
}

// Payout Routes
try {
  const payoutRoutes = require('./routes/payouts');
  app.use('/api/payouts', payoutRoutes);
} catch (e) {
  console.warn('Payout routes failed to mount:', e?.message || e);
}

// Comprehensive Payout Routes
try {
  const comprehensivePayoutRoutes = require('./routes/comprehensive-payouts');
  app.use('/api/payouts', comprehensivePayoutRoutes);
} catch (e) {
  console.warn('Comprehensive payout routes failed to mount:', e?.message || e);
}

// Admin Payout Routes
try {
  const adminPayoutRoutes = require('./routes/admin-payouts');
  app.use('/api/admin/payouts', adminPayoutRoutes);
} catch (e) {
  console.warn('Admin payout routes failed to mount:', e?.message || e);
}

// Admin Comprehensive Payout Routes
try {
  const adminComprehensivePayoutRoutes = require('./routes/admin-comprehensive-payouts');
  app.use('/api/admin/payouts', adminComprehensivePayoutRoutes);
} catch (e) {
  console.warn('Admin comprehensive payout routes failed to mount:', e?.message || e);
}

// Admin Payout Management Routes (New Complete System)
try {
  const adminPayoutManagementRoutes = require('./routes/admin-payout-management');
  app.use('/api/admin/payout-management', adminPayoutManagementRoutes);
} catch (e) {
  console.warn('Admin payout management routes failed to mount:', e?.message || e);
}

// KYC Management Routes
try {
  const kycManagementRoutes = require('./routes/kyc-management');
  app.use('/api/kyc', kycManagementRoutes);
} catch (e) {
  console.warn('KYC management routes failed to mount:', e?.message || e);
}

// Notifications routes
try {
  const notificationsRoutes = require('./routes/notifications');
  app.use('/api/notifications', notificationsRoutes);
} catch (e) {
  console.warn('Notifications routes failed to mount:', e?.message || e);
}

// Minimal compatibility handler for /api/kyc/vendor/:id (if not provided by kyc-management)
app.get('/api/kyc/vendor/:id', async (req, res, next) => {
  // If kyc-management already handled, skip
  // This compatibility route returns a simple placeholder indicating no KYC data
  try {
    return res.json({ vendor_id: parseInt(req.params.id, 10) || null, status: 'not_available' });
  } catch (_) {
    return res.json({ vendor_id: null, status: 'not_available' });
  }
});

// Health check for backend availability
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Create uploads directory if it doesn't exist
const uploadsDir = 'uploads';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit for CSV files
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf|csv/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype) || file.mimetype === 'text/csv';
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, PDF, and CSV files are allowed'));
    }
  }
});

// // Database connection (use pool to support getConnection in transactions)
// const db = mysql.createPool({
//   host: process.env.DB_HOST || 'localhost',
//   user: process.env.DB_USER || 'root',
//   password: process.env.DB_PASSWORD || '', // Empty password for local MySQL
//   database: process.env.DB_NAME || 'vendor_portal',
//   waitForConnections: true,
//   connectionLimit: 10,
//   queueLimit: 0
// });

// db.getConnection((err, conn) => {
//   if (err) {
//     console.error('Database connection failed:', err);
//   } else {
//     console.log('Connected to MySQL database');
//     conn.release();
//   }
// });

// Initialize notification services after database connection
const notificationService = new NotificationService(db);
const socketService = new SocketService(io);

// Make services available globally
global.notificationService = notificationService;
global.socketService = socketService;

// Set up real-time notification handling
notificationService.on('notificationCreated', (notification) => {
  // Send real-time notification via Socket.io
  socketService.sendNotificationToUser(
    notification.userType,
    notification.userId,
    {
      id: notification.notificationId,
      title: notification.title,
      message: notification.message,
      eventType: notification.eventType,
      time: 'Just now',
      unread: true,
      metadata: notification.data
    }
  );
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Map internal vendor status to human-friendly label
function getVendorStatusLabel(status) {
  switch (status) {
    case 'DRAFT': return 'Draft';
    case 'SUBMITTED': return 'Submitted';
    case 'UNDER_REVIEW':
    case 'IN_REVIEW': return 'In Review';
    case 'APPROVED': return 'Approved';
    case 'ACTIVE': return 'Active';
    case 'REJECTED': return 'Rejected';
    case 'SUSPENDED': return 'Suspended';
    default: return String(status || 'Draft');
  }
}

// Notification stubs (email/SMS)
async function sendEmail(to, subject, body) {
  try {
    // Convert plain text body to HTML
    const htmlBody = body.replace(/\n/g, '<br>');
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 28px;">${process.env.APP_NAME || 'SonicKart'}</h1>
          <p style="color: #ffc727; margin: 10px 0 0 0; font-size: 16px;">From your store to every doorstep</p>
        </div>
        <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <div style="color: #333; line-height: 1.6;">
            ${htmlBody}
          </div>
        </div>
      </div>
    `;
    
    const result = await sendEmailService({ to, subject, html });
    if (result && result.success) {
      console.log(`[EMAIL] Sent successfully to ${to}: ${subject}`);
    } else {
      console.log(`[EMAIL] Failed to send to ${to}: ${subject}`);
    }
  } catch (e) {
    console.error('Email send error:', e);
  }
}

async function sendSMS(toPhone, body) {
  try {
    console.log(`[SMS] to=${toPhone} body=${body}`);
  } catch (e) {
    console.error('SMS send stub error:', e);
  }
}

async function notifyKycStatusChange(vendorId, status, reviewNotes = null, softLaunch = null) {
  try {
    // Load vendor contact details
    const hasFlatEmail = await tableHasColumn('vendors','email');
    const hasOwnerEmail = await tableHasColumn('vendors','owner_email');
    const hasFlatPhone = await tableHasColumn('vendors','phone');
    const hasOwnerPhone = await tableHasColumn('vendors','owner_phone');
    const hasShopName = await tableHasColumn('vendors','shop_name');
    const hasBusinessName = await tableHasColumn('vendors','business_name');

    const emailExpr = `${hasFlatEmail ? 'email' : (hasOwnerEmail ? 'owner_email' : 'NULL')} AS email`;
    const phoneExpr = `${hasFlatPhone ? 'phone' : (hasOwnerPhone ? 'owner_phone' : 'NULL')} AS phone`;
    const shopNameExpr = `${hasShopName ? 'shop_name' : (hasBusinessName ? 'business_name' : 'NULL')} AS shop_name`;

    const sql = `SELECT ${emailExpr}, ${phoneExpr}, owner_name, ${shopNameExpr} FROM vendors WHERE id = ? LIMIT 1`;
    const [rows] = await db.promise().query(sql, [vendorId]);
    if (!rows || rows.length === 0) return;
    const vendor = rows[0];
    const owner = vendor.owner_name || 'Vendor';

    let subject = `KYC Status Updated: ${status}`;
    let message = `Hello ${owner}, your KYC status is now ${status}.`;

    if (status === 'APPROVED') {
      subject = 'Your Vendor Account is Activated';
      if (softLaunch && (softLaunch.goLiveAt || softLaunch.mode || softLaunch.notes)) {
        const goLiveText = softLaunch.goLiveAt ? `Go-live: ${new Date(softLaunch.goLiveAt).toLocaleString()}. ` : '';
        const modeText = softLaunch.mode ? `Mode: ${softLaunch.mode}. ` : '';
        const notesText = softLaunch.notes ? `Notes: ${softLaunch.notes}` : '';
        message = `Hello ${owner}, your vendor account has been approved. ${goLiveText}${modeText}${notesText}`.trim();
      } else {
        message = `Hello ${owner}, your vendor account has been approved and activated. You can accept orders immediately.`;
      }
    } else if (status === 'REJECTED') {
      subject = 'KYC Rejected — Action Required';
      message = `Hello ${owner}, unfortunately your KYC was rejected.${reviewNotes ? ` Reason: ${reviewNotes}.` : ''} Please correct and re-upload the required documents.`;
    } else if (status === 'UNDER_REVIEW' || status === 'IN_REVIEW') {
      subject = 'KYC Under Review';
      message = `Hello ${owner}, your KYC documents are under review. We will notify you once a decision is made.`;
    } else if (status === 'SUBMITTED') {
      subject = 'KYC Submitted — Await Verification';
      message = `Hello ${owner}, your KYC documents have been submitted successfully and are awaiting verification.`;
    }

    if (vendor.email) await sendEmail(vendor.email, subject, message);
    if (vendor.phone) await sendSMS(vendor.phone, message);
  } catch (err) {
    console.error('notifyKycStatusChange error:', err);
  }
}

// Helper: check if a column exists on a given table in the current DB
async function tableHasColumn(tableName, columnName) {
  try {
    const [rows] = await db.promise().query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      [tableName, columnName]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('Schema check error:', err);
    return false;
  }
}

async function tableExists(tableName) {
  try {
    const [rows] = await db.promise().query(
      `SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
      [tableName]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('Table existence check error:', err);
    return false;
  }
}
// Import the new admin authentication middleware
const { adminAuth, optionalAdminAuth } = require('./middleware/adminAuth');

// Admin auth guard: supports either x-admin-key or JWT Bearer with admin role
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key';
// Use the new comprehensive admin authentication middleware
const verifyAdmin = adminAuth;

// Admin: Inventory summary across all vendors
app.get('/api/admin/inventory/summary', verifyAdmin, async (req, res) => {
  try {
    // Check if tables exist
    const productsTableExists = await tableExists('products');
    const inventoryTableExists = await tableExists('inventory');
    
    if (!productsTableExists) {
      return res.json({
        totalProducts: 0,
        totalStockOnHand: 0,
        totalReservedStock: 0,
        availableStock: 0,
        generatedAt: new Date().toISOString()
      });
    }

    // Check if status column exists
    const hasProductStatus = await tableHasColumn('products', 'status');
    
    // Aggregate across all vendors/products
    const statusFilter = hasProductStatus ? "WHERE p.status = 'active'" : '';
    const query = inventoryTableExists
      ? `SELECT 
          COALESCE(COUNT(DISTINCT p.id), 0) AS total_products,
          COALESCE(SUM(i.stock_on_hand), 0) AS total_stock_on_hand,
          COALESCE(SUM(i.stock_reserved), 0) AS total_reserved_stock,
          COALESCE(SUM(GREATEST(i.stock_on_hand - COALESCE(i.stock_reserved, 0), 0)), 0) AS available_stock
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.id
        ${statusFilter}`
      : `SELECT 
          COUNT(DISTINCT p.id) AS total_products,
          0 AS total_stock_on_hand,
          0 AS total_reserved_stock,
          0 AS available_stock
        FROM products p
        ${statusFilter}`;

    const [rows] = await db.promise().query(query);

    const r = rows && rows[0] ? rows[0] : {};
    res.json({
      totalProducts: Number(r.total_products) || 0,
      totalStockOnHand: Number(r.total_stock_on_hand) || 0,
      totalReservedStock: Number(r.total_reserved_stock) || 0,
      availableStock: Number(r.available_stock) || 0,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Admin inventory summary error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to get admin inventory summary', 
      message: error.message || String(error),
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Admin: Dashboard summary (vendors, products, stock, price, payouts)
app.get('/api/admin/dashboard/summary', verifyAdmin, async (req, res) => {
  try {
    const {
      vendorId = '',
      category = '',
      product_status = '', // 'active' | 'inactive' or empty
      vendor_status = '',  // 'ACTIVE' | 'SUSPENDED' | etc. or empty
      low_stock_threshold = ''
    } = req.query || {};

    // Check if tables exist
    const vendorsTableExists = await tableExists('vendors');
    const productsTableExists = await tableExists('products');
    const inventoryTableExists = await tableExists('inventory');
    
    // Check if product columns exist
    const hasProductVendorId = await tableHasColumn('products', 'vendor_id');
    const hasProductStatus = await tableHasColumn('products', 'status');
    const hasCategory = await tableHasColumn('products', 'category');

    const productWhere = [];
    const productParams = [];
    if (vendorId && hasProductVendorId) { productWhere.push('p.vendor_id = ?'); productParams.push(vendorId); }
    if (category && hasCategory) { productWhere.push('p.category = ?'); productParams.push(category); }
    if (product_status && hasProductStatus) { productWhere.push('p.status = ?'); productParams.push(product_status); }
    const productWhereSql = productWhere.length ? `WHERE ${productWhere.join(' AND ')}` : '';

    const vendorWhere = [];
    const vendorParams = [];
    if (vendor_status) { vendorWhere.push('v.status = ?'); vendorParams.push(vendor_status); }
    const vendorWhereSql = vendorWhere.length ? `WHERE ${vendorWhere.join(' AND ')}` : '';

    // Vendors: active/inactive breakdown
    let vendorsActive = { active: 0, inactive: 0, total: 0 };
    if (vendorsTableExists) {
      try {
        const [[result]] = await db.promise().query(
          `SELECT 
             COALESCE(SUM(CASE WHEN v.status = 'ACTIVE' AND COALESCE(v.is_suspended,0) = 0 THEN 1 ELSE 0 END), 0) AS active,
             COALESCE(SUM(CASE WHEN v.status <> 'ACTIVE' OR COALESCE(v.is_suspended,0) = 1 THEN 1 ELSE 0 END), 0) AS inactive,
             COUNT(*) AS total
           FROM vendors v ${vendorWhereSql}`,
          vendorParams
        );
        vendorsActive = result || vendorsActive;
      } catch (error) {
        console.warn('Vendors query failed:', error.message);
      }
    }

    // Products: total (with filters)
    let productsTotals = { total_products: 0 };
    if (productsTableExists) {
      try {
        const [[result]] = await db.promise().query(
          `SELECT COUNT(DISTINCT p.id) AS total_products FROM products p ${productWhereSql}`,
          productParams
        );
        productsTotals = result || productsTotals;
      } catch (error) {
        console.warn('Products query failed:', error.message);
      }
    }

    // Stock aggregates (respect product filters)
    let stockAgg = { stock_on_hand: 0, stock_reserved: 0, stock_available: 0 };
    if (productsTableExists && inventoryTableExists) {
      try {
        const [[result]] = await db.promise().query(
          `SELECT 
             COALESCE(SUM(i.stock_on_hand), 0) AS stock_on_hand,
             COALESCE(SUM(i.stock_reserved), 0) AS stock_reserved,
             COALESCE(SUM(GREATEST(i.stock_on_hand - COALESCE(i.stock_reserved, 0), 0)), 0) AS stock_available
           FROM products p
           LEFT JOIN inventory i ON i.product_id = p.id
           ${productWhereSql}`,
          productParams
        );
        stockAgg = result || stockAgg;
      } catch (error) {
        console.warn('Stock query failed:', error.message);
      }
    }

    // Low stock alerts
    let lowStockRows = [];
    if (productsTableExists && inventoryTableExists) {
      try {
        const threshold = String(low_stock_threshold).trim() !== '' ? Number(low_stock_threshold) : null;
        const lowStockWhere = [];
        const lowStockParams = [];
        if (vendorId && hasProductVendorId) { lowStockWhere.push('p.vendor_id = ?'); lowStockParams.push(vendorId); }
        if (category && hasCategory) { lowStockWhere.push('p.category = ?'); lowStockParams.push(category); }
        if (product_status && hasProductStatus) { lowStockWhere.push('p.status = ?'); lowStockParams.push(product_status); }
        // Compute available and compare with threshold or min_stock_level
        const lowStockCondition = threshold != null
          ? 'GREATEST(COALESCE(i.stock_on_hand,0) - COALESCE(i.stock_reserved,0), 0) <= ?'
          : 'GREATEST(COALESCE(i.stock_on_hand,0) - COALESCE(i.stock_reserved,0), 0) <= COALESCE(i.min_stock_level, 0)';
        if (threshold != null) lowStockParams.push(threshold);
        const lowStockWhereSql = lowStockWhere.length ? `AND ${lowStockWhere.join(' AND ')}` : '';
        
        // Build SELECT columns dynamically
        const lowStockSelectCols = ['p.id', 'p.name'];
        if (hasCategory) lowStockSelectCols.push('p.category');
        if (hasProductVendorId) lowStockSelectCols.push('p.vendor_id');
        
        const [rows] = await db.promise().query(
          `SELECT 
             ${lowStockSelectCols.join(', ')},
             COALESCE(i.stock_on_hand,0) AS stock_on_hand,
             COALESCE(i.stock_reserved,0) AS stock_reserved,
             GREATEST(COALESCE(i.stock_on_hand,0) - COALESCE(i.stock_reserved,0), 0) AS stock_available,
             COALESCE(i.min_stock_level,0) AS min_stock_level
           FROM products p
           LEFT JOIN inventory i ON i.product_id = p.id
           WHERE ${lowStockCondition} ${lowStockWhereSql}
           ORDER BY stock_available ASC
           LIMIT 50`,
          lowStockParams
        );
        lowStockRows = rows || [];
      } catch (error) {
        console.warn('Low stock query failed:', error.message);
      }
    }

    // Price summary (respect product filters)
    let priceSummary = { avg_price: 0, min_price: 0, max_price: 0 };
    if (productsTableExists) {
      try {
        const [[result]] = await db.promise().query(
          `SELECT 
             COALESCE(AVG(p.price), 0) AS avg_price,
             COALESCE(MIN(p.price), 0) AS min_price,
             COALESCE(MAX(p.price), 0) AS max_price
           FROM products p
           ${productWhereSql}`,
          productParams
        );
        priceSummary = result || priceSummary;
      } catch (error) {
        console.warn('Price summary query failed:', error.message);
      }
    }

    // Payouts totals by status (handle missing table gracefully)
    let payoutsTotals = { pending: 0, completed: 0, failed: 0 };
    try {
      const payoutsTableExists = await tableExists('payouts');
      if (payoutsTableExists) {
        const [[result]] = await db.promise().query(
          `SELECT 
            COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS completed,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN amount ELSE 0 END), 0) AS failed
          FROM payouts`
        );
        payoutsTotals = result || payoutsTotals;
      }
    } catch (error) {
      console.warn('Payouts query failed (table may not exist):', error.message);
    }

    res.json({
      vendors: {
        active: Number(vendorsActive.active || 0),
        inactive: Number(vendorsActive.inactive || 0),
        total: Number(vendorsActive.total || 0)
      },
      products: {
        total: Number(productsTotals.total_products || 0)
      },
      stock: {
        stock_on_hand: Number(stockAgg.stock_on_hand || 0),
        stock_reserved: Number(stockAgg.stock_reserved || 0),
        stock_available: Number(stockAgg.stock_available || 0)
      },
      lowStock: lowStockRows,
      prices: {
        average: Number(priceSummary.avg_price || 0),
        min: Number(priceSummary.min_price || 0),
        max: Number(priceSummary.max_price || 0)
      },
      payouts: {
        pending: Number(payoutsTotals.pending || 0),
        completed: Number(payoutsTotals.completed || 0),
        failed: Number(payoutsTotals.failed || 0)
      },
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Admin dashboard summary error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to get admin dashboard summary', 
      message: error.message || String(error),
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Middleware to verify JWT token (moved up to avoid temporal dead zone)
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

// GST validation helpers
// Categories that require HSN codes (based on GST rules)
const CATEGORIES_REQUIRING_HSN = [
  'Food & Beverages', 'Dairy', 'Bakery', 'Pantry', 'Beverages', 'Cold Drinks',
  'Dry Fruits', 'Frozen', 'Grocery', 'Instant', 'Snacks', 'Sweets',
  'Accessories', 'Bath', 'Beauty', 'Cleaning', 'Electronics', 'Gaming',
  'Home', 'Jewellery', 'Men Accessories', 'Men Fashion', 'Men Footwear',
  'Plumbing', 'Stationery', 'Toys', 'Wellness', 'Women Fashion', 'Women Footwear'
];

// Categories that don't require HSN codes (typically fresh produce)
const CATEGORIES_NO_HSN = [
  'Fresh Produce', 'Fruits', 'Vegetables'
];

function validateGSTCategory(category, hsn) {
  // Check if category exists in our known categories
  const allCategories = [...CATEGORIES_REQUIRING_HSN, ...CATEGORIES_NO_HSN];
  if (!allCategories.includes(category)) {
    // If category is not in our list, be more permissive but still validate HSN format
    if (hsn && !/^\d{3,5}$/.test(hsn)) {
      return { ok: false, message: 'HSN code must be 3-5 digits' };
    }
    return { ok: true };
  }
  
  // Check if HSN is required for this category
  const requiresHsn = CATEGORIES_REQUIRING_HSN.includes(category);
  if (requiresHsn && !hsn) {
    return { ok: false, message: 'HSN code required for this category' };
  }
  
  // Validate HSN format if provided
  if (hsn && !/^\d{3,5}$/.test(hsn)) {
    return { ok: false, message: 'HSN code must be 3-5 digits' };
  }
  
  return { ok: true };
}

// GST slab mapping by category (auto-apply if not provided)
const CATEGORY_GST_SLABS = {
  // 0% GST categories
  'Fresh Produce': 0.0,
  'Fruits': 0.0,
  'Vegetables': 0.0,
  
  // 3% GST categories
  'Jewellery': 3.0,
  
  // 5% GST categories
  'Food & Beverages': 5.0,
  'Dairy': 5.0,
  'Dry Fruits': 5.0,
  'Grocery': 5.0,
  'Sweets': 5.0,
  
  // 12% GST categories
  'Bakery': 12.0,
  'Pantry': 12.0,
  'Beverages': 12.0,
  'Instant': 12.0,
  'Snacks': 12.0,
  'Home': 12.0,
  'Men Accessories': 12.0,
  'Men Fashion': 12.0,
  'Men Footwear': 12.0,
  'Stationery': 12.0,
  'Toys': 12.0,
  'Women Fashion': 12.0,
  'Women Footwear': 12.0,
  
  // 18% GST categories
  'Accessories': 18.0,
  'Bath': 18.0,
  'Beauty': 18.0,
  'Cleaning': 18.0,
  'Cold Drinks': 18.0,
  'Electronics': 18.0,
  'Frozen': 18.0,
  'Gaming': 18.0,
  'Plumbing': 18.0,
  'Wellness': 18.0
};

function deriveGstSlab(category, providedSlab) {
  const auto = CATEGORY_GST_SLABS[category];
  if (typeof auto === 'number') {
    if (typeof providedSlab === 'number' && !isNaN(providedSlab)) {
      if (Number(providedSlab) !== Number(auto)) {
        return { ok: false, message: `GST slab ${providedSlab}% doesn't match category rule ${auto}%` };
      }
    }
    return { ok: true, value: auto };
  }
  
  // If category is not in our mapping, be more permissive
  if (typeof providedSlab === 'number' && !isNaN(providedSlab) && providedSlab >= 0 && providedSlab <= 28) {
    return { ok: true, value: providedSlab };
  }
  
  // Default to 18% for unknown categories if no slab provided
  return { ok: true, value: 18.0 };
}

// WebSocket connection management
const connectedVendors = new Map();
const connectedAdmins = new Set();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('join-vendor', (vendorId) => {
    connectedVendors.set(socket.id, vendorId);
    socket.join(`vendor-${vendorId}`);
    console.log(`Vendor ${vendorId} joined room`);
  });
  
  socket.on('join-admin', () => {
    connectedAdmins.add(socket.id);
    socket.join('admin');
    console.log('Admin joined room');
  });
  
  socket.on('disconnect', () => {
    const vendorId = connectedVendors.get(socket.id);
    if (vendorId) {
      connectedVendors.delete(socket.id);
      console.log(`Vendor ${vendorId} disconnected`);
    }
    if (connectedAdmins.has(socket.id)) {
      connectedAdmins.delete(socket.id);
      console.log('Admin disconnected');
    }
  });
});

// Helper function to emit order updates
const emitOrderUpdate = (vendorId, orderData) => {
  io.to(`vendor-${vendorId}`).emit('order-update', orderData);
};

// Helper function to emit admin order updates
const emitAdminOrderUpdate = (orderData) => {
  io.to('admin').emit('order-update', orderData);
};

// Vendor shop status routes
app.get('/api/vendor/shop-status', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      'SELECT is_open, last_opened_at, last_first_order_at FROM vendors WHERE id = ? LIMIT 1',
      [req.vendorId]
    );
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    res.json({
      is_open: rows[0].is_open === 1 || rows[0].is_open === true,
      last_opened_at: rows[0].last_opened_at,
      last_first_order_at: rows[0].last_first_order_at
    });
  } catch (e) {
    console.error('Get shop status error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/vendor/shop-status', verifyToken, async (req, res) => {
  try {
    const { is_open } = req.body || {};
    if (typeof is_open !== 'boolean') {
      return res.status(400).json({ error: 'is_open boolean is required' });
    }

    if (is_open) {
      // Opening: set is_open=1 and last_opened_at=NOW(), reset last_first_order_at to NULL
      await db.promise().query(
        'UPDATE vendors SET is_open = 1, last_opened_at = NOW(), last_first_order_at = NULL, updated_at = NOW() WHERE id = ?',
        [req.vendorId]
      );
    } else {
      // Closing: set is_open=0 (keep timestamps as history)
      await db.promise().query(
        'UPDATE vendors SET is_open = 0, updated_at = NOW() WHERE id = ?',
        [req.vendorId]
      );
    }

    // Broadcast status update to the vendor channel (could be used for UI badges)
    io.to(`vendor-${req.vendorId}`).emit('shop-status', { is_open });

    res.json({ message: 'Shop status updated', is_open });
  } catch (e) {
    console.error('Update shop status error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ensure payout-related tables
const ensurePayoutTables = async () => {
  try {
    // Always create table without FK first to avoid startup failures
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS vendor_payout_settings (
        vendor_id INT PRIMARY KEY,
        mode ENUM('auto','manual') DEFAULT 'auto',
        day_of_week TINYINT DEFAULT 5,
        min_payout_amount DECIMAL(10,2) DEFAULT 0,
        bank_account_holder VARCHAR(255),
        bank_account_number VARCHAR(64),
        bank_ifsc VARCHAR(32),
        is_bank_verified TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);

    // Try to add FK only if both tables exist and FK not already present
    const [[{ fk_exists } = {}]] = await db.promise().query(`
      SELECT COUNT(*) AS fk_exists
      FROM information_schema.table_constraints tc
      WHERE tc.table_schema = DATABASE()
        AND tc.table_name = 'vendor_payout_settings'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND tc.constraint_name = 'fk_vendor_ps'
    `);
    if (Number(fk_exists || 0) === 0) {
      const [vendorsTable] = await db.promise().query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'vendors'`
      );
      if (vendorsTable.length > 0) {
        try {
          await db.promise().query(
            `ALTER TABLE vendor_payout_settings
             ADD CONSTRAINT fk_vendor_ps FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE`
          );
        } catch (_) {
          // ignore if still failing due to order; will retry on next start
        }
      }
    }

    // Create payout audit logs table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payout_audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        payout_id INT NULL,
        vendor_id INT NULL,
        admin_identifier VARCHAR(255) NULL,
        action ENUM('create','initiate','approve','mark_paid','reject','fail','refund','export') NOT NULL,
        amount DECIMAL(10,2) NULL,
        method ENUM('bank_transfer','upi','wallet') NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_payout_audit_payout_id (payout_id),
        INDEX idx_payout_audit_vendor_id (vendor_id)
      ) ENGINE=InnoDB;
    `);
  } catch (e) {
    console.error('ensurePayoutTables error:', e);
  }
};

// Helper to record payout audit actions
const logPayoutAudit = async (opts = {}) => {
  try {
    const { payoutId = null, vendorId = null, adminIdentifier = 'admin', action, amount = null, method = null, notes = null } = opts;
    if (!action) return;
    await db.promise().query(
      `INSERT INTO payout_audit_logs (payout_id, vendor_id, admin_identifier, action, amount, method, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [payoutId, vendorId, adminIdentifier, action, amount, method, notes]
    );
  } catch (_) { /* ignore audit failures */ }
};
// Ensure users table exists and vendor core columns exist
const ensureUsersAndVendorColumns = async () => {
  try {
    // Create users table if not exists
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(20),
        password VARCHAR(255) NOT NULL,
        role ENUM('vendor','admin','staff') DEFAULT 'vendor',
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);

    // Add vendor columns used by code if vendors table exists
    const [vendorsTable] = await db.promise().query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'vendors'`
    );
    if (vendorsTable.length > 0) {
      const addCol = async (colSql) => {
        try { await db.promise().query(colSql); } catch (_) { /* ignore */ }
      };
      await addCol(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS user_id INT NULL`);
      await addCol(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS business_name VARCHAR(255) NULL`);
      await addCol(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS owner_email VARCHAR(255) NULL`);
      await addCol(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS owner_phone VARCHAR(20) NULL`);
      await addCol(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS address TEXT NULL`);
      await addCol(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS city VARCHAR(100) NULL`);
      await addCol(`CREATE INDEX IF NOT EXISTS idx_vendors_user_id ON vendors(user_id)`);
      // Best-effort FK from vendors.user_id to users.id
      try {
        const [[{ fk_exists } = {}]] = await db.promise().query(`
          SELECT COUNT(*) AS fk_exists
          FROM information_schema.table_constraints tc
          WHERE tc.table_schema = DATABASE()
            AND tc.table_name = 'vendors'
            AND tc.constraint_type = 'FOREIGN KEY'
            AND tc.constraint_name = 'fk_vendors_user'
        `);
        if (Number(fk_exists || 0) === 0) {
          await db.promise().query(`
            ALTER TABLE vendors ADD CONSTRAINT fk_vendors_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
          `);
        }
      } catch (_) { /* ignore */ }
    }
  } catch (e) {
    console.error('ensureUsersAndVendorColumns error:', e);
  }
};

ensureUsersAndVendorColumns();

ensurePayoutTables();

// Ensure KYC OCR columns and audit logs table
const ensureKycOcrAndAudit = async () => {
  try {
    // Ensure vendors KYC meta columns exist for admin listing
    try { await db.promise().query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMP NULL`); } catch (_) {}
    try { await db.promise().query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS kyc_reviewed_at TIMESTAMP NULL`); } catch (_) {}
    try { await db.promise().query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS review_notes TEXT NULL`); } catch (_) {}

    // Add OCR-related columns to kyc_documents
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS ocr_text LONGTEXT NULL`); } catch (_) {
      try { await db.promise().query(`SELECT ocr_text FROM kyc_documents LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN ocr_text LONGTEXT NULL`); } catch (err) { console.error('ocr_text add error:', err); }
      }
    }
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS ocr_boxes JSON NULL`); } catch (_) {
      try { await db.promise().query(`SELECT ocr_boxes FROM kyc_documents LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN ocr_boxes JSON NULL`); } catch (err) { console.error('ocr_boxes add error:', err); }
      }
    }

    // Ensure standard document metadata columns exist (for legacy tables)
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS filename VARCHAR(255) NULL`); } catch (_) {}
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS original_name VARCHAR(255) NULL`); } catch (_) {}
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS file_path VARCHAR(500) NULL`); } catch (_) {}
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS file_size INT NULL`); } catch (_) {}
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100) NULL`); } catch (_) {}
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMP NULL`); } catch (_) {}

    // Retention and compliance metadata
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS checksum_sha256 VARCHAR(64) NULL`); } catch (_) {}
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS retention_until DATE NULL`); } catch (_) {}
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS storage_class VARCHAR(50) NULL`); } catch (_) {}

    // Create audit log table
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS kyc_audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        document_id INT NULL,
        admin_identifier VARCHAR(255) NULL,
        action ENUM('approve','reject','flag') NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_kal_vendor (vendor_id),
        INDEX idx_kal_doc (document_id)
      ) ENGINE=InnoDB;
    `);
  } catch (e) {
    console.error('ensureKycOcrAndAudit error:', e);
  }
};

ensureKycOcrAndAudit();

// Simple daily retention task to tag near-expiry or move class (placeholder)
setInterval(async () => {
  try {
    // Tag documents within 30 days of retention expiry
    await db.promise().query(
      `UPDATE kyc_documents SET storage_class = 'archive_soon'
       WHERE retention_until IS NOT NULL AND DATEDIFF(retention_until, CURDATE()) BETWEEN 0 AND 30`
    );
  } catch (_) {}
}, 24 * 60 * 60 * 1000);

// Ensure vendor profile meta columns
const ensureVendorProfileMeta = async () => {
  try {
    const [vendorsTable] = await db.promise().query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'vendors'`
    );
    if (vendorsTable.length === 0) {
      // Vendors table not present yet; skip silently
      return;
    }
  } catch (_) {
    return;
  }

  try {
    await db.promise().query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS hours_json JSON NULL`);
  } catch (e) {
    try { await db.promise().query(`SELECT hours_json FROM vendors LIMIT 1`); } catch (_) {
      try { await db.promise().query(`ALTER TABLE vendors ADD COLUMN hours_json JSON NULL`); } catch (err) { console.error('hours_json add error:', err); }
    }
  }
  try {
    await db.promise().query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS social_json JSON NULL`);
  } catch (e) {
    try { await db.promise().query(`SELECT social_json FROM vendors LIMIT 1`); } catch (_) {
      try { await db.promise().query(`ALTER TABLE vendors ADD COLUMN social_json JSON NULL`); } catch (err) { console.error('social_json add error:', err); }
    }
  }
  try {
    await db.promise().query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS logo_url VARCHAR(512) NULL`);
  } catch (_) {}
  try {
    await db.promise().query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS banner_url VARCHAR(512) NULL`);
  } catch (_) {}
};

ensureVendorProfileMeta();

// Ensure document status and audit columns
const ensureKycDocumentStatus = async () => {
  try {
    const [docsTable] = await db.promise().query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'kyc_documents'`
    );
    if (docsTable.length === 0) return;
  } catch (_) { return; }

  const robustAdd = async (col, defn) => {
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS ${col} ${defn}`); return; } catch (_) {}
    try { await db.promise().query(`SELECT ${col} FROM kyc_documents LIMIT 1`); return; } catch (_) {}
    try { await db.promise().query(`ALTER TABLE kyc_documents ADD COLUMN ${col} ${defn}`); } catch (e) { console.error('ensureKycDocumentStatus add error:', e); }
  };

  await robustAdd('doc_status', "ENUM('UPLOADED','OCR_CHECK','FLAGGED','MANUAL_REVIEW','APPROVED','REJECTED') DEFAULT 'UPLOADED'");
  await robustAdd('doc_status_notes', 'TEXT NULL');
  await robustAdd('doc_status_updated_at', 'TIMESTAMP NULL');
};

ensureKycDocumentStatus();

// Admin: Vendor account status transitions with guard rules
// More flexible transitions for admin management
const VENDOR_ALLOWED_NEXT = {
  'DRAFT': ['SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED'],
  'SUBMITTED': ['IN_REVIEW', 'APPROVED', 'REJECTED', 'DRAFT'],
  'IN_REVIEW': ['APPROVED', 'REJECTED', 'SUBMITTED'],
  'APPROVED': ['ACTIVE', 'SUSPENDED', 'IN_REVIEW', 'REJECTED'],
  'ACTIVE': ['SUSPENDED', 'APPROVED'],
  'REJECTED': ['DRAFT', 'SUBMITTED', 'IN_REVIEW'],
  'SUSPENDED': ['ACTIVE', 'APPROVED'],
  // Map database enum values
  'PENDING': ['APPROVED', 'REJECTED', 'SUSPENDED'],
  'APPROVED': ['SUSPENDED'],
  'REJECTED': ['APPROVED'],
  'SUSPENDED': ['APPROVED']
};

app.put('/api/admin/vendors/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body || {};
    const upper = String(status || '').toUpperCase();
    if (!upper) return res.status(400).json({ error: 'status is required' });

    const [[curr]] = await db.promise().query('SELECT status FROM vendors WHERE id = ? LIMIT 1', [id]);
    if (!curr) return res.status(404).json({ error: 'Vendor not found' });
    let current = String(curr.status || 'DRAFT').toUpperCase();
    
    // Map legacy status values to new ones
    if (current === 'PENDING') current = 'SUBMITTED';
    if (current === 'UNDER_REVIEW') current = 'IN_REVIEW';
    // Admin override: allow changing to any status from the UI dropdown

    // Apply status and ancillary timestamps
    const updates = ['status = ?'];
    let saveStatus = upper === 'IN_REVIEW' ? 'UNDER_REVIEW' : upper; // align to DB ENUM
    const params = [saveStatus];
    if (upper === 'SUSPENDED') { 
      updates.push('is_suspended = 1', 'suspended_at = NOW()'); 
    }
    if (upper === 'ACTIVE') { 
      updates.push('is_suspended = 0'); 
    }
    if (['APPROVED','REJECTED'].includes(upper)) {
      updates.push('kyc_reviewed_at = NOW()');
    }
    if (notes !== undefined) { 
      updates.push('review_notes = ?'); 
      params.push(notes || null); 
    }
    updates.push('updated_at = NOW()');
    await db.promise().query(`UPDATE vendors SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);

    // Emit realtime and send notifications to vendor
    try {
      const payload = { status: upper, reviewNotes: notes || null, reviewedAt: (['APPROVED','REJECTED'].includes(upper)) ? new Date().toISOString() : null };
      io.to(`vendor-${id}`).emit('kyc-status-changed', payload);
      await notifyKycStatusChange(id, upper, notes || null, null);
    } catch (e) {
      console.error('Post-status-update notify error:', e);
    }

    return res.json({ message: 'Vendor status updated', from: current, to: upper });
  } catch (e) {
    console.error('Admin vendor status update error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Bulk vendor status update
app.put('/api/admin/vendors/bulk-status', verifyAdmin, async (req, res) => {
  try {
    const { vendorIds, status, notes } = req.body || {};
    if (!Array.isArray(vendorIds) || vendorIds.length === 0) {
      return res.status(400).json({ error: 'vendorIds array is required' });
    }
    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    const upper = String(status).toUpperCase();
    const results = [];
    const errors = [];

    for (const vendorId of vendorIds) {
      try {
        const [[curr]] = await db.promise().query('SELECT status FROM vendors WHERE id = ? LIMIT 1', [vendorId]);
        if (!curr) {
          errors.push({ vendorId, error: 'Vendor not found' });
          continue;
        }

        let current = String(curr.status || 'DRAFT').toUpperCase();
        
        // Map legacy status values to new ones
        if (current === 'PENDING') current = 'SUBMITTED';
        if (current === 'UNDER_REVIEW') current = 'IN_REVIEW';
        
        // Admin override: allow changing to any status from the UI dropdown

        // Apply status and ancillary timestamps
        const updates = ['status = ?'];
        const saveStatus = upper === 'IN_REVIEW' ? 'UNDER_REVIEW' : upper; // align to DB ENUM
        const params = [saveStatus];
        if (upper === 'SUSPENDED') { 
          updates.push('is_suspended = 1', 'suspended_at = NOW()'); 
        }
        if (upper === 'ACTIVE') { 
          updates.push('is_suspended = 0'); 
        }
        if (['APPROVED','REJECTED'].includes(upper)) {
          updates.push('kyc_reviewed_at = NOW()');
        }
        if (notes !== undefined) { 
          updates.push('review_notes = ?'); 
          params.push(notes || null); 
        }
        updates.push('updated_at = NOW()');
        
        await db.promise().query(`UPDATE vendors SET ${updates.join(', ')} WHERE id = ?`, [...params, vendorId]);

        // Emit realtime and send notifications to vendor for each update
        try {
          const payload = { status: upper, reviewNotes: notes || null, reviewedAt: (['APPROVED','REJECTED'].includes(upper)) ? new Date().toISOString() : null };
          io.to(`vendor-${vendorId}`).emit('kyc-status-changed', payload);
          await notifyKycStatusChange(vendorId, upper, notes || null, null);
        } catch (e) {
          console.error('Bulk post-status-update notify error:', e);
        }

        results.push({ vendorId, from: current, to: upper });
      } catch (e) {
        errors.push({ vendorId, error: e.message });
      }
    }

    return res.json({ 
      message: `Bulk status update completed`, 
      results, 
      errors,
      successCount: results.length,
      errorCount: errors.length
    });
  } catch (e) {
    console.error('Admin bulk vendor status update error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Document status transitions with guard rules
// UPLOADED -> OCR_CHECK -> (FLAGGED | MANUAL_REVIEW) -> APPROVED | REJECTED
// Admin can also directly APPROVE/REJECT from UPLOADED state for faster workflow
const DOC_ALLOWED_NEXT = {
  'UPLOADED': ['OCR_CHECK', 'MANUAL_REVIEW', 'APPROVED', 'REJECTED'], // Allow admin to approve/reject directly
  'OCR_CHECK': ['FLAGGED', 'MANUAL_REVIEW', 'APPROVED', 'REJECTED'],
  'FLAGGED': ['MANUAL_REVIEW', 'APPROVED', 'REJECTED'],
  'MANUAL_REVIEW': ['APPROVED', 'REJECTED'],
  'APPROVED': ['REJECTED'], // Allow re-rejecting approved documents
  'REJECTED': ['APPROVED', 'MANUAL_REVIEW'] // Allow re-approving rejected documents
};

app.put('/api/admin/vendors/:vendorId/documents/:docId/status', verifyAdmin, async (req, res) => {
  try {
    const { vendorId, docId } = req.params;
    const { status, notes } = req.body || {};
    const upper = String(status || '').toUpperCase();
    if (!upper) return res.status(400).json({ error: 'status is required' });

    const [[doc]] = await db.promise().query(
      'SELECT id, doc_status FROM kyc_documents WHERE id = ? AND vendor_id = ? LIMIT 1',
      [docId, vendorId]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const current = String(doc.doc_status || 'UPLOADED').toUpperCase();
    const allowed = DOC_ALLOWED_NEXT[current] || [];
    if (!allowed.includes(upper)) {
      return res.status(400).json({ error: `Invalid transition from ${current} to ${upper}` });
    }

    await db.promise().query(
      'UPDATE kyc_documents SET doc_status = ?, doc_status_notes = ?, doc_status_updated_at = NOW() WHERE id = ? AND vendor_id = ?',
      [upper, notes || null, docId, vendorId]
    );

    return res.json({ message: 'Document status updated', from: current, to: upper });
  } catch (e) {
    console.error('Admin document status update error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Ensure vendor shop status columns (robust across MySQL versions)
const ensureVendorShopStatus = async () => {
  try {
    const [vendorsTable] = await db.promise().query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'vendors'`
    );
    if (vendorsTable.length === 0) return;
  } catch (_) { return; }

  const robustAdd = async (col, defn) => {
    // Try IF NOT EXISTS (MySQL 8.0.29+)
    try { await db.promise().query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS ${col} ${defn}`); return; } catch (_) {}
    // Fallback: probe column existence
    try {
      await db.promise().query(`SELECT ${col} FROM vendors LIMIT 1`);
      return; // column exists
    } catch (probeErr) {
      try { await db.promise().query(`ALTER TABLE vendors ADD COLUMN ${col} ${defn}`); } catch (finalErr) {
        console.error(`Failed ensuring column ${col}:`, finalErr);
      }
    }
  };

  await robustAdd('is_open', 'TINYINT(1) NOT NULL DEFAULT 0');
  await robustAdd('last_opened_at', 'TIMESTAMP NULL');
  await robustAdd('last_first_order_at', 'TIMESTAMP NULL');
};

ensureVendorShopStatus();

// Ensure core tables exist if schema wasn't fully initialized
const ensureCoreTables = async () => {
  try {
    // Pricing: platform-managed
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS pricing_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        scope ENUM('global','category','product') NOT NULL DEFAULT 'global',
        category VARCHAR(100) NULL,
        product_id INT NULL,
        floor_price DECIMAL(10,2) NULL,
        ceiling_price DECIMAL(10,2) NULL,
        surge_percentage DECIMAL(5,2) NULL,
        promo_percentage DECIMAL(5,2) NULL,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_pr_scope (scope),
        INDEX idx_pr_product (product_id),
        INDEX idx_pr_category (category)
      ) ENGINE=InnoDB;
    `);

    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS price_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        old_price DECIMAL(10,2) NULL,
        new_price DECIMAL(10,2) NOT NULL,
        reason VARCHAR(255) NULL,
        changed_by ENUM('system','admin') DEFAULT 'system',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ph_product (product_id)
      ) ENGINE=InnoDB;
    `);

    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS price_change_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        vendor_id INT NOT NULL,
        requested_price DECIMAL(10,2) NOT NULL,
        reason TEXT NULL,
        status ENUM('pending','approved','rejected') DEFAULT 'pending',
        admin_notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reviewed_at TIMESTAMP NULL,
        INDEX idx_pcr_vendor (vendor_id),
        INDEX idx_pcr_product (product_id),
        INDEX idx_pcr_status (status)
      ) ENGINE=InnoDB;
    `);

    // Products
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        sku VARCHAR(100) UNIQUE NOT NULL,
        category VARCHAR(100) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        mrp DECIMAL(10,2) NULL,
        cost_price DECIMAL(10,2),
        image_url VARCHAR(512),
        unit VARCHAR(50) DEFAULT 'piece',
        weight DECIMAL(8,2),
        dimensions VARCHAR(100),
        barcode VARCHAR(100),
        gst_slab DECIMAL(4,2) NULL,
        status ENUM('active','inactive','discontinued') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    // Ensure hsn_code column exists
    try { await db.promise().query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(50) NULL`); } catch (_) {
      try { await db.promise().query(`SELECT hsn_code FROM products LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE products ADD COLUMN hsn_code VARCHAR(50) NULL`); } catch (err) { console.error('add hsn_code error:', err); }
      }
    }
    // Ensure mrp & gst_slab columns exist
    try { await db.promise().query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS mrp DECIMAL(10,2) NULL`); } catch (_) {
      try { await db.promise().query(`SELECT mrp FROM products LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE products ADD COLUMN mrp DECIMAL(10,2) NULL`); } catch (err) { console.error('add mrp error:', err); }
      }
    }
    try { await db.promise().query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_slab DECIMAL(4,2) NULL`); } catch (_) {
      try { await db.promise().query(`SELECT gst_slab FROM products LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE products ADD COLUMN gst_slab DECIMAL(4,2) NULL`); } catch (err) { console.error('add gst_slab error:', err); }
      }
    }
    // Ensure product_id column exists
    try { await db.promise().query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_id VARCHAR(20) UNIQUE NULL`); } catch (_) {
      try { await db.promise().query(`SELECT product_id FROM products LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE products ADD COLUMN product_id VARCHAR(20) UNIQUE NULL`); } catch (err) { 
          if (err.code !== 'ER_DUP_FIELDNAME') console.error('add product_id error:', err); 
        }
      }
    }
    // Create index for product_id if it doesn't exist
    try { await db.promise().query(`CREATE INDEX IF NOT EXISTS idx_products_product_id ON products(product_id)`); } catch (_) {
      try { await db.promise().query(`SHOW INDEX FROM products WHERE Key_name = 'idx_products_product_id'`); } catch (e) {
        try { await db.promise().query(`CREATE INDEX idx_products_product_id ON products(product_id)`); } catch (err) { 
          if (err.code !== 'ER_DUP_KEYNAME') console.error('create product_id index error:', err); 
        }
      }
    }
    // Ensure product_images column exists
    try { await db.promise().query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_images JSON NULL`); } catch (_) {
      try { await db.promise().query(`SELECT product_images FROM products LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE products ADD COLUMN product_images JSON NULL`); } catch (err) { 
          if (err.code !== 'ER_DUP_FIELDNAME') console.error('add product_images error:', err); 
        }
      }
    }
    // Inventory
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS inventory (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        stock_on_hand INT DEFAULT 0,
        stock_reserved INT DEFAULT 0,
        stock_available INT GENERATED ALWAYS AS (stock_on_hand - stock_reserved) STORED,
        min_stock_level INT DEFAULT 0,
        max_stock_level INT,
        reorder_point INT DEFAULT 0,
        reorder_quantity INT DEFAULT 0,
        last_restocked_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_product_inventory (product_id)
      ) ENGINE=InnoDB;
    `);
    // Robust backfill for legacy inventory schemas (no IF NOT EXISTS support)
    try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS stock_on_hand INT DEFAULT 0`); } catch (_) {
      try { await db.promise().query(`SELECT stock_on_hand FROM inventory LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN stock_on_hand INT DEFAULT 0`); } catch (_) {}
      }
    }
    try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS stock_reserved INT DEFAULT 0`); } catch (_) {
      try { await db.promise().query(`SELECT stock_reserved FROM inventory LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN stock_reserved INT DEFAULT 0`); } catch (_) {}
      }
    }
    try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS stock_available INT GENERATED ALWAYS AS (stock_on_hand - stock_reserved) STORED`); } catch (_) {
      try { await db.promise().query(`SELECT stock_available FROM inventory LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN stock_available INT GENERATED ALWAYS AS (stock_on_hand - stock_reserved) STORED`); } catch (_) {}
      }
    }
    try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS min_stock_level INT DEFAULT 0`); } catch (_) {
      try { await db.promise().query(`SELECT min_stock_level FROM inventory LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN min_stock_level INT DEFAULT 0`); } catch (_) {}
      }
    }
    try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS max_stock_level INT NULL`); } catch (_) {
      try { await db.promise().query(`SELECT max_stock_level FROM inventory LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN max_stock_level INT NULL`); } catch (_) {}
      }
    }
    try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS reorder_point INT DEFAULT 0`); } catch (_) {
      try { await db.promise().query(`SELECT reorder_point FROM inventory LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN reorder_point INT DEFAULT 0`); } catch (_) {}
      }
    }
    try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS reorder_quantity INT DEFAULT 0`); } catch (_) {
      try { await db.promise().query(`SELECT reorder_quantity FROM inventory LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE inventory ADD COLUMN reorder_quantity INT DEFAULT 0`); } catch (_) {}
      }
    }
    // Stock movements
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        movement_type ENUM('in','out','adjustment','reservation','commit','release') NOT NULL,
        quantity INT NOT NULL,
        reference_type ENUM('purchase','sale','adjustment','reservation','order') NOT NULL,
        reference_id INT,
        notes TEXT,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    // Orders
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        customer_id INT,
        order_number VARCHAR(64) UNIQUE NOT NULL,
        status ENUM('placed','confirmed','packing','ready','out_for_delivery','delivered','cancelled','rejected') DEFAULT 'placed',
        total_amount DECIMAL(10,2) NOT NULL,
        payment_status ENUM('pending','paid','failed','refunded') DEFAULT 'pending',
        shipping_address TEXT,
        notes TEXT,
        sla_deadline TIMESTAMP NULL,
        accepted_at TIMESTAMP NULL,
        confirmed_at TIMESTAMP NULL,
        packing_at TIMESTAMP NULL,
        ready_at TIMESTAMP NULL,
        out_for_delivery_at TIMESTAMP NULL,
        delivered_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    // Order action logs (admin/vendor/system actions with reasons)
    // Create table first without FK; add FK later if orders table exists
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS order_action_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        action ENUM('status_update','cancel','refund','reassign') NOT NULL,
        from_value VARCHAR(64) NULL,
        to_value VARCHAR(64) NULL,
        reason TEXT NULL,
        created_by ENUM('system','admin','vendor') DEFAULT 'system',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_oal_order (order_id)
      ) ENGINE=InnoDB;
    `);
    try {
      const [ordersTbl] = await db.promise().query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'orders'`
      );
      if (ordersTbl.length > 0) {
        await db.promise().query(`
          ALTER TABLE order_action_logs
          ADD CONSTRAINT IF NOT EXISTS fk_oal_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        `);
      }
    } catch (_) { /* defer FK if missing */ }
    // Order items
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL,
        unit_price DECIMAL(10,2) NOT NULL,
        total_price DECIMAL(10,2) NOT NULL,
        reserved_quantity INT DEFAULT 0,
        committed_quantity INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    // Stock alerts
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS stock_alerts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        alert_type ENUM('low_stock','out_of_stock','reorder_point','expiry_warning') NOT NULL,
        current_stock INT NOT NULL,
        threshold_value INT NOT NULL,
        message TEXT,
        is_resolved BOOLEAN DEFAULT FALSE,
        resolved_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    // CSV upload logs
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS csv_upload_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        filename VARCHAR(255) NOT NULL,
        total_rows INT NOT NULL,
        successful_rows INT DEFAULT 0,
        failed_rows INT DEFAULT 0,
        error_log TEXT,
        status ENUM('processing','completed','failed') DEFAULT 'processing',
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    // Payouts
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS payouts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vendor_id INT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        status ENUM('pending','paid','failed') DEFAULT 'pending',
        method ENUM('bank_transfer','upi','wallet') DEFAULT 'bank_transfer',
        reference VARCHAR(100),
        notes TEXT,
        paid_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    // Robust backfill for legacy payouts schema
    try { await db.promise().query(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS amount DECIMAL(10,2) NOT NULL DEFAULT 0`); } catch (_) {
      try { await db.promise().query(`SELECT amount FROM payouts LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE payouts ADD COLUMN amount DECIMAL(10,2) NOT NULL DEFAULT 0`); } catch (_) {}
      }
    }
    try { await db.promise().query(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP NULL`); } catch (_) {
      try { await db.promise().query(`SELECT paid_at FROM payouts LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE payouts ADD COLUMN paid_at TIMESTAMP NULL`); } catch (_) {}
      }
    }
    try { await db.promise().query(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS method ENUM('bank_transfer','upi','wallet') DEFAULT 'bank_transfer'`); } catch (_) {
      try { await db.promise().query(`SELECT method FROM payouts LIMIT 1`); } catch (e) {
        try { await db.promise().query(`ALTER TABLE payouts ADD COLUMN method ENUM('bank_transfer','upi','wallet') DEFAULT 'bank_transfer'`); } catch (_) {}
      }
    }
    // Order reassignments
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS order_reassignments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        from_vendor_id INT,
        to_vendor_id INT,
        reason ENUM('sla_breach','vendor_rejection','manual_reassignment','vendor_unavailable','admin_reassignment') NOT NULL,
        notes TEXT,
        created_by ENUM('system','admin','vendor') DEFAULT 'system',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
  } catch (e) {
    console.error('ensureCoreTables error:', e);
  }
};
ensureCoreTables();

// Ensure required stored procedures exist
const ensureStoredProcedures = async () => {
  const tryCreate = async (sql) => {
    try { await db.promise().query(sql); } catch (_) { /* ignore if exists */ }
  };
  try {
    await tryCreate(`
      CREATE PROCEDURE CheckStockAlerts(IN vendor_id INT)
      BEGIN
        UPDATE stock_alerts sa
        JOIN inventory i ON sa.product_id = i.product_id
        JOIN products p ON i.product_id = p.id
        SET sa.is_resolved = TRUE, sa.resolved_at = NOW()
        WHERE p.vendor_id = vendor_id 
          AND sa.is_resolved = FALSE
          AND sa.alert_type = 'low_stock'
          AND i.stock_available > sa.threshold_value;

        INSERT INTO stock_alerts (product_id, alert_type, current_stock, threshold_value, message)
        SELECT 
            p.id,
            'low_stock',
            i.stock_available,
            i.min_stock_level,
            CONCAT('Low stock alert: ', p.name, ' has only ', i.stock_available, ' units remaining (minimum: ', i.min_stock_level, ')')
        FROM products p
        JOIN inventory i ON p.id = i.product_id
        WHERE p.vendor_id = vendor_id
          AND p.status = 'active'
          AND i.stock_available <= i.min_stock_level
          AND i.stock_available > 0
          AND NOT EXISTS (
              SELECT 1 FROM stock_alerts sa 
              WHERE sa.product_id = p.id 
                AND sa.alert_type = 'low_stock' 
                AND sa.is_resolved = FALSE
          );

        INSERT INTO stock_alerts (product_id, alert_type, current_stock, threshold_value, message)
        SELECT 
            p.id,
            'out_of_stock',
            i.stock_available,
            0,
            CONCAT('Out of stock: ', p.name, ' is completely out of stock')
        FROM products p
        JOIN inventory i ON p.id = i.product_id
        WHERE p.vendor_id = vendor_id
          AND p.status = 'active'
          AND i.stock_available <= 0
          AND NOT EXISTS (
              SELECT 1 FROM stock_alerts sa 
              WHERE sa.product_id = p.id 
                AND sa.alert_type = 'out_of_stock' 
                AND sa.is_resolved = FALSE
          );
      END
    `);

    await tryCreate(`
      CREATE PROCEDURE ReserveStock(IN p_product_id INT, IN p_quantity INT, IN p_reference_type VARCHAR(50), IN p_reference_id INT, IN p_created_by INT)
      BEGIN
        DECLARE current_available INT DEFAULT 0;
        DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
        START TRANSACTION;
        SELECT stock_available INTO current_available FROM inventory WHERE product_id = p_product_id FOR UPDATE;
        IF current_available < p_quantity THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Insufficient stock available for reservation';
        END IF;
        UPDATE inventory SET stock_reserved = stock_reserved + p_quantity WHERE product_id = p_product_id;
        INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, reference_id, created_by)
        VALUES (p_product_id, 'reservation', p_quantity, p_reference_type, p_reference_id, p_created_by);
        COMMIT;
      END
    `);

    await tryCreate(`
      CREATE PROCEDURE CommitStock(IN p_product_id INT, IN p_quantity INT, IN p_reference_type VARCHAR(50), IN p_reference_id INT, IN p_created_by INT)
      BEGIN
        DECLARE current_reserved INT DEFAULT 0;
        DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
        START TRANSACTION;
        SELECT stock_reserved INTO current_reserved FROM inventory WHERE product_id = p_product_id FOR UPDATE;
        IF current_reserved < p_quantity THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Insufficient reserved stock for commitment';
        END IF;
        UPDATE inventory 
          SET stock_on_hand = stock_on_hand - p_quantity,
              stock_reserved = stock_reserved - p_quantity
        WHERE product_id = p_product_id;
        INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, reference_id, created_by)
        VALUES (p_product_id, 'commit', p_quantity, p_reference_type, p_reference_id, p_created_by);
        COMMIT;
      END
    `);

    await tryCreate(`
      CREATE PROCEDURE ReleaseStock(IN p_product_id INT, IN p_quantity INT, IN p_reference_type VARCHAR(50), IN p_reference_id INT, IN p_created_by INT)
      BEGIN
        DECLARE current_reserved INT DEFAULT 0;
        DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
        START TRANSACTION;
        SELECT stock_reserved INTO current_reserved FROM inventory WHERE product_id = p_product_id FOR UPDATE;
        IF current_reserved < p_quantity THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Insufficient reserved stock for release';
        END IF;
        UPDATE inventory SET stock_reserved = stock_reserved - p_quantity WHERE product_id = p_product_id;
        INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, reference_id, created_by)
        VALUES (p_product_id, 'release', p_quantity, p_reference_type, p_reference_id, p_created_by);
        COMMIT;
      END
    `);
  } catch (e) {
    console.error('ensureStoredProcedures error:', e);
  }
};

ensureStoredProcedures();

// Auto-reassignment logic for SLA compliance
const checkSLAAndReassign = async () => {
  try {
    // Find orders that have exceeded SLA and are still in 'placed' status
    const expiredOrders = await db.promise().query(
      `SELECT o.*, COALESCE(v.business_name, v.owner_name, v.owner_email) as vendor_name 
       FROM orders o 
       JOIN vendors v ON o.vendor_id = v.id 
       WHERE o.status = 'placed' 
       AND o.sla_deadline < NOW() 
       AND o.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      []
    );

    for (const order of expiredOrders[0]) {
      // Find alternative vendors for reassignment
      const alternativeVendors = await db.promise().query(
        `SELECT v.id, COALESCE(v.business_name, v.owner_name, v.owner_email) as shop_name, v.owner_email as email, v.owner_phone as phone
         FROM vendors v 
         WHERE v.id != ? 
         AND v.status = 'APPROVED'
         AND v.id NOT IN (
           SELECT DISTINCT vendor_id 
           FROM orders 
           WHERE status = 'placed' 
           AND sla_deadline < NOW() 
           AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
         )
         ORDER BY RAND()
         LIMIT 3`,
        [order.vendor_id]
      );

      if (alternativeVendors[0].length > 0) {
        const newVendor = alternativeVendors[0][0];
        
        // Create reassignment record
        await db.promise().query(
          'INSERT INTO order_reassignments (order_id, from_vendor_id, to_vendor_id, reason, notes) VALUES (?, ?, ?, ?, ?)',
          [order.id, order.vendor_id, newVendor.id, 'sla_breach', `Auto-reassigned due to SLA breach. Original vendor: ${order.vendor_name}`]
        );

        // Update order to new vendor
        await db.promise().query(
          'UPDATE orders SET vendor_id = ?, sla_deadline = DATE_ADD(NOW(), INTERVAL 30 MINUTE), updated_at = NOW() WHERE id = ?',
          [newVendor.id, order.id]
        );

        // Release stock from original vendor
        const orderItems = await db.promise().query(
          'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
          [order.id]
        );

        for (const item of orderItems[0]) {
          await db.promise().query('CALL ReleaseStock(?, ?, ?, ?, ?)', [
            item.product_id, item.quantity, 'order', order.id, order.vendor_id
          ]);
        }

        // Reserve stock for new vendor
        for (const item of orderItems[0]) {
          await db.promise().query('CALL ReserveStock(?, ?, ?, ?, ?)', [
            item.product_id, item.quantity, 'order', order.id, newVendor.id
          ]);
        }

        // Emit reassignment notification
        const reassignmentData = {
          id: order.id,
          order_number: order.order_number,
          status: 'reassigned',
          action: 'reassigned',
          from_vendor: order.vendor_name,
          to_vendor: newVendor.shop_name,
          reason: 'SLA breach'
        };

        // Notify both vendors
        emitOrderUpdate(order.vendor_id, {
          ...reassignmentData,
          message: `Order ${order.order_number} reassigned due to SLA breach`
        });
        emitOrderUpdate(newVendor.id, {
          ...reassignmentData,
          message: `New order ${order.order_number} assigned to you`
        });

        console.log(`Order ${order.order_number} reassigned from ${order.vendor_name} to ${newVendor.shop_name} due to SLA breach`);
      } else {
        // No alternative vendors available, mark for manual review
        await db.promise().query(
          'INSERT INTO order_reassignments (order_id, from_vendor_id, to_vendor_id, reason, notes) VALUES (?, ?, ?, ?, ?)',
          [order.id, order.vendor_id, null, 'sla_breach', `SLA breached but no alternative vendors available. Requires manual intervention.`]
        );
        
        console.log(`Order ${order.order_number} SLA breached but no alternative vendors available for reassignment`);
      }
    }
  } catch (error) {
    console.error('SLA check and reassignment error:', error);
  }
};

// Run SLA check every 5 minutes
setInterval(checkSLAAndReassign, 5 * 60 * 1000);

// Routes

// Vendor Registration
app.post('/api/vendors/register', async (req, res) => {
  try {
    // Accept both camelCase and snake_case inputs
    const shopName = req.body.shopName || req.body.shop_name;
    const ownerName = req.body.ownerName || req.body.owner_name;
    const email = req.body.email || req.body.owner_email;
    const phone = req.body.phone || req.body.owner_phone;
    const shopAddress = req.body.shopAddress || req.body.address || req.body.shop_address;
    const city = req.body.city || req.body.town || 'Unknown';
    const password = req.body.password;

    // Validate required fields (city optional with default)
    const missing = [];
    if (!shopName) missing.push('shopName');
    if (!ownerName) missing.push('ownerName');
    if (!email) missing.push('email');
    if (!phone) missing.push('phone');
    if (!shopAddress) missing.push('shopAddress');
    if (!password) missing.push('password');
    if (missing.length) {
      console.warn('Registration missing fields:', { received: { shopName, ownerName, email, phone, shopAddress: !!shopAddress, city, password: !!password }, missing });
      return res.status(400).json({ error: 'All fields are required', missing });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if vendor already exists by email
    const existingVendorByEmail = await db.promise().query(
      'SELECT id FROM vendors WHERE owner_email = ?',
      [email]
    );
    if (existingVendorByEmail[0].length > 0) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    // Check if vendor already exists by phone number
    const existingVendorByPhone = await db.promise().query(
      'SELECT id FROM vendors WHERE owner_phone = ?',
      [phone]
    );
    if (existingVendorByPhone[0].length > 0) {
      return res.status(400).json({ error: 'Contact number already exists' });
    }

    // Generate unique vendor ID
    const getNextVendorId = async () => {
      try {
        const [result] = await db.promise().query(`
          SELECT vendor_id FROM vendors 
          WHERE vendor_id LIKE 'VDR%' 
          ORDER BY CAST(SUBSTRING(vendor_id, 4) AS UNSIGNED) DESC 
          LIMIT 1
        `);
        
        if (result.length === 0) {
          return 'VDR001';
        }
        
        const lastVendorId = result[0].vendor_id;
        const lastNumber = parseInt(lastVendorId.substring(3));
        const nextNumber = lastNumber + 1;
        
        return `VDR${String(nextNumber).padStart(3, '0')}`;
      } catch (error) {
        console.error('Error generating next vendor ID:', error);
        throw error;
      }
    };

    const generatedVendorId = await getNextVendorId();

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert vendor with generated vendor_id
    const insertResult = await db.promise().query(
      'INSERT INTO vendors (vendor_id, business_name, owner_name, owner_email, owner_phone, address, city, password, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [generatedVendorId, shopName, ownerName, email, phone, shopAddress, city, passwordHash, 'SUBMITTED']
    );

    const vendorId = insertResult[0].insertId;

    // If coordinates provided, persist them
    const lat = typeof req.body.latitude !== 'undefined' ? req.body.latitude : null;
    const lng = typeof req.body.longitude !== 'undefined' ? req.body.longitude : null;
    if (lat !== null || lng !== null) {
      await db.promise().query(
        'UPDATE vendors SET latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude), location_updated_at = NOW() WHERE id = ?',
        [lat, lng, vendorId]
      );
    }

    // Generate JWT token
    const token = jwt.sign({ vendorId, email }, JWT_SECRET, { expiresIn: '24h' });

    res.status(201).json({
      message: 'Vendor registered successfully',
      vendorId: generatedVendorId,
      internalId: vendorId,
      token,
      status: 'SUBMITTED'
    });

    // Fire-and-forget welcome email (do not block registration)
    Promise.resolve()
      .then(() => sendVendorWelcomeEmail(email, ownerName, shopName))
      .then((result) => {
        if (!result?.success) {
          console.error('Welcome email failed:', { email, error: result?.error });
        }
      })
      .catch((err) => {
        console.error('Welcome email error:', { email, error: err?.message || err });
      });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor Login
app.post('/api/vendors/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
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
    // Note: Database schema only supports: 'pending','approved','rejected','suspended'
    const approvedStatuses = ['approved']; // Only 'approved' status allows login
    const currentStatus = (vendor.status || 'pending').toLowerCase(); // Handle null/empty status and normalize case
    if (!approvedStatuses.includes(currentStatus)) {
      return res.status(403).json({ 
        error: 'Account not approved yet. Please wait for admin approval before logging in.',
        status: currentStatus,
        statusLabel: getVendorStatusLabel(currentStatus)
      });
    }

    // Generate JWT token
    const token = jwt.sign({ vendorId: vendor.id, email }, JWT_SECRET, { expiresIn: '24h' });

    // Set secure cookie for browser sessions
    res.cookie('vendor_token', token, {
      httpOnly: true,
      secure: !!(process.env.COOKIE_SECURE === 'true'),
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.json({
      message: 'Login successful',
      vendor: {
        id: vendor.id,
        shopName: vendor.business_name || vendor.shop_name,
        ownerName: vendor.owner_name,
        email: vendor.owner_email,
        phone: vendor.owner_phone,
        shopAddress: vendor.address,
        status: vendor.status,
        statusLabel: getVendorStatusLabel(vendor.status)
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor Forgot Password
app.post('/api/vendor/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if email exists in vendors table
    const [vendors] = await db.promise().query('SELECT id, owner_name FROM vendors WHERE owner_email = ?', [email]);

    if (vendors.length === 0) {
      // For security, don't reveal if email exists or not
      return res.status(200).json({ 
        message: 'If this email is registered, a password reset link has been sent.' 
      });
    }

    const vendor = vendors[0];

    // Generate secure token
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    
    // Set expiry time to 15 minutes from now
    const expiryTime = new Date(Date.now() + 15 * 60 * 1000);

    // Store token in database
    await db.promise().query(
      'INSERT INTO password_reset_tokens (vendor_id, token, expiry_time) VALUES (?, ?, ?)',
      [vendor.id, token, expiryTime]
    );

    // Generate reset link
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetLink = `${frontendUrl}/#/reset-password?token=${token}`;

    // Try to send email
    const emailResult = await sendPasswordResetEmail(email, resetLink, vendor.owner_name);
    
    if (emailResult.success) {
      console.log(`Password reset email sent to ${email}`);
    } else {
      console.log(`Failed to send email to ${email}:`, emailResult.error);
      // For development, log the reset link
      console.log(`Password reset link for ${email}: ${resetLink}`);
    }

    res.status(200).json({ 
      message: 'If this email is registered, a password reset link has been sent.',
      // For development only - include reset link in response
      resetLink: process.env.NODE_ENV === 'development' ? resetLink : undefined
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor Reset Password
app.post('/api/vendor/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Find valid token
    const [tokens] = await db.promise().query(
      'SELECT * FROM password_reset_tokens WHERE token = ? AND used = FALSE AND expiry_time > NOW()',
      [token]
    );

    if (tokens.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const resetToken = tokens[0];

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update vendor password
    await db.promise().query(
      'UPDATE vendors SET password = ? WHERE id = ?',
      [passwordHash, resetToken.vendor_id]
    );

    // Mark token as used
    await db.promise().query(
      'UPDATE password_reset_tokens SET used = TRUE WHERE id = ?',
      [resetToken.id]
    );

    // Get vendor details for email
    const [vendors] = await db.promise().query(
      'SELECT owner_name, owner_email FROM vendors WHERE id = ?',
      [resetToken.vendor_id]
    );

    if (vendors.length > 0) {
      const vendor = vendors[0];
      // Send success email
      const emailResult = await sendPasswordResetSuccessEmail(vendor.owner_email, vendor.owner_name);
      
      if (emailResult.success) {
        console.log(`Password reset success email sent to ${vendor.owner_email}`);
      } else {
        console.log(`Failed to send success email to ${vendor.owner_email}:`, emailResult.error);
      }
    }

    res.status(200).json({ 
      message: 'Password has been successfully reset' 
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor Logout
app.post('/api/vendors/logout', (req, res) => {
  try {
    // Clear the httpOnly vendor token cookie if present
    res.clearCookie('vendor_token', {
      httpOnly: true,
      secure: !!(process.env.COOKIE_SECURE === 'true'),
      sameSite: 'lax'
    });

    res.json({ 
      message: 'Logout successful',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Logout
app.post('/api/admin/logout', (req, res) => {
  try {
    // Clear the httpOnly admin token cookie if present
    res.clearCookie('admin_token', {
      httpOnly: true,
      secure: !!(process.env.COOKIE_SECURE === 'true'),
      sameSite: 'lax'
    });

    // Optional: Validate JWT token if provided in Authorization header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        console.log('Admin logout for user:', decoded.email || decoded.adminId);
      } catch (error) {
        console.log('Invalid token during logout:', error.message);
      }
    }

    // In a stateless JWT system, logout is also handled client-side by removing any stored tokens
    res.json({ 
      message: 'Admin logout successful',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Admin logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check if admin_users table exists
    const adminTableExists = await tableExists('admin_users');
    if (!adminTableExists) {
      return res.status(500).json({ error: 'Admin system not initialized' });
    }

    // Find admin user by email
    const [adminRows] = await db.promise().query(
      'SELECT * FROM admin_users WHERE email = ?',
      [email]
    );

    if (adminRows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = adminRows[0];

    // Check password
    const isValidPassword = await bcrypt.compare(password, admin.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

  // Generate JWT token with admin role
    const token = jwt.sign(
      { 
        adminId: admin.id, 
        email: admin.email, 
        role: admin.role,
        username: admin.username
      }, 
      JWT_SECRET, 
      { expiresIn: '8h' }
    );

  // Set secure httpOnly cookie so browser stores admin token safely
  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: !!(process.env.COOKIE_SECURE === 'true'),
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  });

  res.json({
      message: 'Admin login successful',
      admin: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        role: admin.role
      },
      token
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update Location
app.put('/api/vendors/:id/location', async (req, res) => {
  try {
    const { id } = req.params;
    const { address, coordinates } = req.body;
    
    await db.promise().query(
      'UPDATE vendors SET shop_address = ?, latitude = ?, longitude = ?, location_updated_at = NOW() WHERE id = ?',
      [address, coordinates.lat, coordinates.lng, id]
    );
    
    res.json({ message: 'Location updated successfully' });
  } catch (error) {
    console.error('Location update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload KYC Documents
app.post('/api/vendors/:id/kyc', upload.fields([
  { name: 'gst', maxCount: 1 },
  { name: 'fssai', maxCount: 1 },
  { name: 'shopLicense', maxCount: 1 },
  { name: 'pan', maxCount: 1 },
  { name: 'aadhaar', maxCount: 1 },
  { name: 'bankProof', maxCount: 1 }
]), async (req, res) => {
  try {
    const { id } = req.params;
    const files = req.files;
    
    // Update vendor status to SUBMITTED
    await db.promise().query(
      'UPDATE vendors SET status = ?, kyc_submitted_at = NOW() WHERE id = ?',
      ['SUBMITTED', id]
    );
    
    // Save document information
    const documentData = {};
    Object.keys(files).forEach(docType => {
      const file = files[docType][0];
      const crypto = require('crypto');
      const fs = require('fs');
      const fileBuffer = fs.readFileSync(file.path);
      const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const sevenYears = new Date(); sevenYears.setFullYear(sevenYears.getFullYear() + 7);
      documentData[docType] = {
        filename: file.filename,
        originalName: file.originalname,
        path: file.path,
        size: file.size,
        mimetype: file.mimetype,
        checksum,
        retentionUntil: sevenYears.toISOString().slice(0,10),
        storageClass: 'standard'
      };
    });
    
    // Insert or update KYC documents
    for (const [docType, docData] of Object.entries(documentData)) {
      await db.promise().query(
        `INSERT INTO kyc_documents (
           vendor_id, document_type, filename, original_name, file_path, file_size, mime_type, uploaded_at,
           checksum_sha256, retention_until, storage_class
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           filename = VALUES(filename),
           file_path = VALUES(file_path),
           file_size = VALUES(file_size),
           checksum_sha256 = VALUES(checksum_sha256),
           retention_until = VALUES(retention_until),
           storage_class = VALUES(storage_class),
           uploaded_at = NOW()`,
        [id, docType, docData.filename, docData.originalName, docData.path, docData.size, docData.mimetype,
         docData.checksum, docData.retentionUntil, docData.storageClass]
      );
      // audit: document uploaded
      await db.promise().query(
        `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes)
         SELECT ?, id, NULL, 'flag', CONCAT('Uploaded ', ?) FROM kyc_documents WHERE vendor_id = ? AND document_type = ?
         ORDER BY uploaded_at DESC LIMIT 1`,
        [id, docType, id, docType]
      );
    }
    
    // Realtime notify vendor on submission
    io.to(`vendor-${id}`).emit('kyc-status-changed', { status: 'SUBMITTED', reviewedAt: null, reviewNotes: null });

    // Email/SMS notify
    notifyKycStatusChange(id, 'SUBMITTED', null);

    res.json({ message: 'KYC documents uploaded successfully', status: 'SUBMITTED' });
  } catch (error) {
    console.error('KYC upload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor: list uploaded KYC documents
app.get('/api/vendors/:id/kyc-docs', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.promise().query(
      `SELECT id, vendor_id, document_type, original_name, file_path, file_size, mime_type, uploaded_at
       FROM kyc_documents
       WHERE vendor_id = ?
       ORDER BY uploaded_at DESC`,
      [id]
    );
    const documents = rows.map(r => ({
      id: r.id,
      documentType: r.document_type,
      originalName: r.original_name,
      url: r.file_path?.startsWith('http') ? r.file_path : `/${r.file_path}`,
      size: r.file_size,
      mimeType: r.mime_type,
      uploadedAt: r.uploaded_at
    }));
    res.json({ documents });
  } catch (e) {
    console.error('List vendor kyc docs error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor: delete a specific KYC document (must own the document)
app.delete('/api/vendors/:vendorId/kyc-docs/:docId', async (req, res) => {
  try {
    const { vendorId, docId } = req.params;

    // Ensure the requester is the same vendor
    const requester = req.user || {};
    if (String(requester.id || requester.vendorId || '') !== String(vendorId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const [[doc]] = await db.promise().query(
      'SELECT id, vendor_id, file_path FROM kyc_documents WHERE id = ? AND vendor_id = ? LIMIT 1',
      [docId, vendorId]
    );
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Delete DB record
    await db.promise().query('DELETE FROM kyc_documents WHERE id = ? AND vendor_id = ? LIMIT 1', [docId, vendorId]);

    // Best-effort filesystem cleanup for local storage paths
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = doc.file_path || '';
      if (filePath && !/^https?:\/\//i.test(filePath)) {
        const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath.replace(/^\/+/, ''));
        if (fs.existsSync(abs)) {
          fs.unlink(abs, () => {});
        }
      }
    } catch (e) {
      // ignore file delete errors
    }

    return res.json({ message: 'Document deleted' });
  } catch (e) {
    console.error('Delete vendor kyc doc error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor profile: get
app.get('/api/vendor/profile', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT id, business_name as shopName, owner_name as ownerName, owner_email as email, owner_phone as phone, address as shopAddress, status, logo_url, banner_url, hours_json, social_json
       FROM vendors WHERE id = ?`,
      [req.vendorId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
    const r = rows[0];
    res.json({
      ...r,
      statusLabel: getVendorStatusLabel(r.status),
      hours: parseJsonSafely(r.hours_json, null),
      social: parseJsonSafely(r.social_json, null)
    });
  } catch (e) {
    console.error('Get vendor profile error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor profile: update text fields
app.put('/api/vendor/profile', verifyToken, async (req, res) => {
  try {
    const { shopName, ownerName, email, phone, shopAddress } = req.body;
    await db.promise().query(
      `UPDATE vendors SET business_name = ?, owner_name = ?, owner_email = ?, owner_phone = ?, address = ?, updated_at = NOW() WHERE id = ?`,
      [shopName, ownerName, email, phone, shopAddress, req.vendorId]
    );
    res.json({ message: 'Profile updated' });
  } catch (e) {
    console.error('Update vendor profile error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor media upload (logo/banner)
const mediaUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) return cb(null, true);
    cb(new Error('Only JPG/PNG images allowed'));
  }
});

app.post('/api/vendor/profile/media', verifyToken, mediaUpload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'banner', maxCount: 1 }
]), async (req, res) => {
  try {
    const logo = req.files?.logo?.[0];
    const banner = req.files?.banner?.[0];
    if (!logo && !banner) return res.status(400).json({ error: 'No files uploaded' });
    const updates = [];
    const params = [];
    if (logo) { updates.push('logo_url = ?'); params.push('/' + logo.path.replace(/\\/g, '/')); }
    if (banner) { updates.push('banner_url = ?'); params.push('/' + banner.path.replace(/\\/g, '/')); }
    params.push(req.vendorId);
    await db.promise().query(
      `UPDATE vendors SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
      params
    );
    res.json({ message: 'Media uploaded', logo_url: logo ? '/' + logo.path.replace(/\\/g, '/') : undefined, banner_url: banner ? '/' + banner.path.replace(/\\/g, '/') : undefined });
  } catch (e) {
    console.error('Vendor media upload error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor media remove
app.delete('/api/vendor/profile/media', verifyToken, async (req, res) => {
  try {
    const { type } = req.query; // 'logo' | 'banner'
    if (!['logo','banner'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const column = type === 'logo' ? 'logo_url' : 'banner_url';
    const [[row]] = await db.promise().query(`SELECT ${column} FROM vendors WHERE id = ?`, [req.vendorId]);
    const url = row?.[column];
    if (url && url.startsWith('/uploads/')) {
      const p = url.startsWith('/') ? url.slice(1) : url;
      try { fs.unlinkSync(p); } catch (_) {}
    }
    await db.promise().query(`UPDATE vendors SET ${column} = NULL, updated_at = NOW() WHERE id = ?`, [req.vendorId]);
    res.json({ message: `${type} removed` });
  } catch (e) {
    console.error('Vendor media remove error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor profile meta (hours, social)
app.put('/api/vendor/profile/meta', verifyToken, async (req, res) => {
  try {
    const { hours, social } = req.body;
    await db.promise().query(
      `UPDATE vendors SET hours_json = ?, social_json = ?, updated_at = NOW() WHERE id = ?`,
      [hours ? JSON.stringify(hours) : null, social ? JSON.stringify(social) : null, req.vendorId]
    );
    res.json({ message: 'Profile meta updated' });
  } catch (e) {
    console.error('Update vendor profile meta error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Vendor KYC Status
app.get('/api/vendors/:id/kyc-status', async (req, res) => {
  try {
    const { id } = req.params;
    
    const vendors = await db.promise().query(
      'SELECT status, kyc_submitted_at, kyc_reviewed_at, review_notes FROM vendors WHERE id = ?',
      [id]
    );
    
    if (vendors[0].length === 0) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    
    const vendor = vendors[0][0];
    
    const rawStatus = vendor.status || 'DRAFT';
    const normalized = rawStatus === 'UNDER_REVIEW' ? 'IN_REVIEW' : rawStatus;
    res.json({
      status: normalized,
      statusLabel: getVendorStatusLabel(rawStatus),
      submittedAt: vendor.kyc_submitted_at,
      reviewedAt: vendor.kyc_reviewed_at,
      reviewNotes: vendor.review_notes || null
    });
  } catch (error) {
    console.error('KYC status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Update KYC Status
app.put('/api/admin/vendors/:id/kyc-status', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes, softLaunch } = req.body;
    
    await db.promise().query(
      'UPDATE vendors SET status = ?, kyc_reviewed_at = NOW(), review_notes = ? WHERE id = ?',
      [status, reviewNotes, id]
    );
    
    // Realtime notification for vendor via WebSocket
    const payload = { status, reviewNotes: reviewNotes || null, reviewedAt: new Date().toISOString(), softLaunch: softLaunch || null };
    io.to(`vendor-${id}`).emit('kyc-status-changed', payload);

    // Email/SMS notification
    notifyKycStatusChange(id, status, reviewNotes || null, softLaunch || null);

    res.json({ message: 'KYC status updated successfully' });
  } catch (error) {
    console.error('Admin KYC status update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: List vendor KYC documents
app.get('/api/admin/vendors/:id/kyc-docs', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.promise().query(
      `SELECT id, document_type, filename, original_name, file_path, file_size, mime_type, uploaded_at, ocr_text, ocr_boxes,
              checksum_sha256, retention_until, storage_class
       FROM kyc_documents WHERE vendor_id = ? ORDER BY uploaded_at DESC`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    console.error('Admin list KYC docs error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: List vendor KYC audit logs
app.get('/api/admin/vendors/:id/kyc-audit-logs', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.promise().query(
      `SELECT kal.id, kal.vendor_id, kal.document_id, kal.admin_identifier, kal.action, kal.notes, kal.created_at,
              kd.document_type, kd.original_name
       FROM kyc_audit_logs kal
       LEFT JOIN kyc_documents kd ON kd.id = kal.document_id
       WHERE kal.vendor_id = ?
       ORDER BY kal.created_at DESC`
      , [id]
    );
    res.json(rows);
  } catch (e) {
    console.error('Admin list KYC audit logs error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Admin: OCR process - extracts text from PDF or image, stores fields
app.post('/api/admin/kyc/:docId/ocr', verifyAdmin, async (req, res) => {
  try {
    const { docId } = req.params;
    const [[doc]] = await db.promise().query(`SELECT id, vendor_id, file_path, mime_type, document_type FROM kyc_documents WHERE id = ?`, [docId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const fs = require('fs');
    const path = require('path');
    let extractedText = '';
    let boxes = [];

    try {
      if ((doc.mime_type || '').includes('pdf') || (doc.file_path || '').toLowerCase().endsWith('.pdf')) {
        const pdfParse = require('pdf-parse');
        const dataBuffer = fs.readFileSync(path.resolve(doc.file_path));
        const parsed = await pdfParse(dataBuffer);
        extractedText = parsed.text || '';
      }
    } catch (_) {}

    if (!extractedText) {
      // lightweight fallback: store filename and path only
      extractedText = `File: ${doc.file_path}`;
    }

    await db.promise().query(`UPDATE kyc_documents SET ocr_text = ?, ocr_boxes = ?, doc_status = IF(doc_status = 'UPLOADED','OCR_CHECK', doc_status), doc_status_updated_at = NOW() WHERE id = ?`, [extractedText, JSON.stringify(boxes), docId]);

    // Write an audit entry for OCR
    await db.promise().query(
      `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes)
       VALUES (?, ?, 'admin-api-key', 'ocr', 'OCR processed')`,
      [doc.vendor_id, docId]
    );

    res.json({ message: 'OCR completed', ocr_text: extractedText, ocr_boxes: boxes });
  } catch (e) {
    console.error('Admin OCR error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Review action (approve/reject/flag) with audit log
app.post('/api/admin/vendors/:id/kyc-review', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, notes, document_id, expected_fields } = req.body || {};
    if (!['approve','reject','flag'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    // Optional OCR vs expected fields simple compare
    if (expected_fields && document_id) {
      try {
        const [[doc]] = await db.promise().query('SELECT ocr_text FROM kyc_documents WHERE id = ? AND vendor_id = ?', [document_id, id]);
        if (doc && doc.ocr_text) {
          const lower = String(doc.ocr_text).toLowerCase();
          const mismatches = [];
          Object.entries(expected_fields || {}).forEach(([key, val]) => {
            if (val && !lower.includes(String(val).toLowerCase())) {
              mismatches.push(key);
            }
          });
          if (mismatches.length && action === 'approve') {
            return res.status(400).json({ error: 'OCR data mismatch', mismatches });
          }
        }
      } catch (_) {}
    }
    // Update vendor status for approve/reject
    if (action === 'approve') {
      await db.promise().query(`UPDATE vendors SET status='APPROVED', kyc_reviewed_at = NOW(), review_notes = ? WHERE id = ?`, [notes || null, id]);
      
      // Trigger vendor approved notification
      if (global.notificationService) {
        // Resolve name/email columns dynamically across schemas
        const hasShopName = await tableHasColumn('vendors','shop_name');
        const hasBusinessName = await tableHasColumn('vendors','business_name');
        const hasFlatEmail = await tableHasColumn('vendors','email');
        const hasOwnerEmail = await tableHasColumn('vendors','owner_email');
        const nameCol = hasShopName ? 'shop_name' : (hasBusinessName ? 'business_name' : 'NULL');
        const emailCol = hasFlatEmail ? 'email' : (hasOwnerEmail ? 'owner_email' : 'NULL');
        const [vendor] = await db.promise().query(`SELECT ${nameCol} AS shop_name, ${emailCol} AS email FROM vendors WHERE id = ?`, [id]);
        if (vendor.length > 0) {
          global.notificationService.emit('vendorApproved', {
            vendor_id: id,
            vendor_name: vendor[0].shop_name,
            vendor_email: vendor[0].email,
            admin_name: 'Admin',
            approval_notes: notes
          });
        }
      }
    } else if (action === 'reject') {
      await db.promise().query(`UPDATE vendors SET status='REJECTED', kyc_reviewed_at = NOW(), review_notes = ? WHERE id = ?`, [notes || null, id]);
      
      // Trigger vendor rejected notification
      if (global.notificationService) {
        // Resolve name/email columns dynamically across schemas
        const hasShopName = await tableHasColumn('vendors','shop_name');
        const hasBusinessName = await tableHasColumn('vendors','business_name');
        const hasFlatEmail = await tableHasColumn('vendors','email');
        const hasOwnerEmail = await tableHasColumn('vendors','owner_email');
        const nameCol = hasShopName ? 'shop_name' : (hasBusinessName ? 'business_name' : 'NULL');
        const emailCol = hasFlatEmail ? 'email' : (hasOwnerEmail ? 'owner_email' : 'NULL');
        const [vendor] = await db.promise().query(`SELECT ${nameCol} AS shop_name, ${emailCol} AS email FROM vendors WHERE id = ?`, [id]);
        if (vendor.length > 0) {
          global.notificationService.emit('vendorRejected', {
            vendor_id: id,
            vendor_name: vendor[0].shop_name,
            vendor_email: vendor[0].email,
            admin_name: 'Admin',
            rejection_reason: notes
          });
        }
      }
    } else if (action === 'flag') {
      await db.promise().query(`UPDATE vendors SET flagged = 1, review_notes = CONCAT(IFNULL(review_notes,''), '\nFLAGGED: ', ?) WHERE id = ?`, [notes || '', id]);
    }
    // Insert audit log (use api key as admin identifier in dev)
    await db.promise().query(
      `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes) VALUES (?, ?, ?, ?, ?)`,
      [id, document_id || null, 'admin-api-key', action, notes || null]
    );
    // Mark vendor reviewed timestamp if not set
    await db.promise().query(`UPDATE vendors SET kyc_reviewed_at = IFNULL(kyc_reviewed_at, NOW()) WHERE id = ?`, [id]);
    res.json({ message: 'Review recorded' });
  } catch (e) {
    console.error('Admin KYC review error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// === Convenience REST APIs for KYC Review ===
// GET /api/admin/vendors (submitted docs only)
app.get('/api/admin/vendors-submitted', verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query || {};
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [rows] = await db.promise().query(
      `SELECT v.id, v.shop_name, v.owner_name, v.status, v.kyc_submitted_at, v.kyc_reviewed_at, COUNT(kd.id) AS documents_count
       FROM vendors v
       LEFT JOIN kyc_documents kd ON kd.vendor_id = v.id
       GROUP BY v.id
       HAVING documents_count > 0 OR v.kyc_submitted_at IS NOT NULL
       ORDER BY COALESCE(v.kyc_submitted_at, v.updated_at) DESC
       LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );
    const [[{ total } = {}]] = await db.promise().query(
      `SELECT COUNT(*) AS total FROM (
         SELECT v.id
         FROM vendors v
         LEFT JOIN kyc_documents kd ON kd.vendor_id = v.id
         GROUP BY v.id
         HAVING COUNT(kd.id) > 0 OR v.kyc_submitted_at IS NOT NULL
       ) t`
    );
    res.json({ items: rows, total: Number(total || 0) });
  } catch (e) {
    console.error('Admin vendors-submitted error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/vendors/:id/documents → alias for vendor KYC docs
app.get('/api/admin/vendors/:id/documents', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.promise().query(
      `SELECT id, document_type, filename, original_name, file_path, file_size, mime_type, uploaded_at, ocr_text, ocr_boxes,
              checksum_sha256, retention_until, storage_class
       FROM kyc_documents WHERE vendor_id = ? ORDER BY uploaded_at DESC`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    console.error('Admin vendor documents error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/documents/:id/approve → mark as VERIFIED
app.post('/api/admin/documents/:id/approve', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const notes = (req.body && req.body.notes) || 'Approved by admin';
    const [[doc]] = await db.promise().query('SELECT id, vendor_id FROM kyc_documents WHERE id = ? LIMIT 1', [id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    await db.promise().query(
      `UPDATE kyc_documents
       SET doc_status = 'APPROVED', verification_status = 'VERIFIED',
           doc_status_updated_at = NOW(), verification_checked_at = NOW()
       WHERE id = ?`,
      [id]
    );

    await db.promise().query(
      `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes)
       VALUES (?, ?, 'admin-api-key', 'approve', ?)` ,
      [doc.vendor_id, id, notes]
    );

    res.json({ message: 'Document approved' });
  } catch (e) {
    console.error('Approve document error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/documents/:id/reject → mark as REJECTED with reason
app.post('/api/admin/documents/:id/reject', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body || {};
    const [[doc]] = await db.promise().query('SELECT id, vendor_id FROM kyc_documents WHERE id = ? LIMIT 1', [id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    await db.promise().query(
      `UPDATE kyc_documents
       SET doc_status = 'REJECTED', verification_status = 'REJECTED', doc_status_notes = ?,
           doc_status_updated_at = NOW(), verification_checked_at = NOW()
       WHERE id = ?`,
      [reason || null, id]
    );

    await db.promise().query(
      `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes)
       VALUES (?, ?, 'admin-api-key', 'reject', ?)` ,
      [doc.vendor_id, id, reason || null]
    );

    res.json({ message: 'Document rejected' });
  } catch (e) {
    console.error('Reject document error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/admin/documents/:id/delete → delete KYC document
app.delete('/api/admin/documents/:id/delete', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get document info before deletion
    const [[doc]] = await db.promise().query('SELECT id, vendor_id, file_path, original_name, document_type FROM kyc_documents WHERE id = ? LIMIT 1', [id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Delete file from filesystem
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = doc.file_path || '';
      if (filePath && !/^https?:\/\//i.test(filePath)) {
        const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath.replace(/^\/+/, ''));
        if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
        }
      }
    } catch (e) {
      console.error('File deletion error:', e);
      // Continue with database deletion even if file deletion fails
    }

    // Delete from database
    await db.promise().query('DELETE FROM kyc_documents WHERE id = ? LIMIT 1', [id]);

    // Log deletion in audit
    await db.promise().query(
      `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes)
       VALUES (?, ?, 'admin-api-key', 'delete', ?)`,
      [doc.vendor_id, id, `Document deleted: ${doc.original_name || doc.document_type}`]
    );

    res.json({ message: 'Document deleted successfully' });
  } catch (e) {
    console.error('Delete document error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/documents/:id/verify → check expected fields against OCR text
app.post('/api/admin/documents/:id/verify', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { expected = {} } = req.body || {};
    const [[doc]] = await db.promise().query('SELECT id, vendor_id, ocr_text FROM kyc_documents WHERE id = ? LIMIT 1', [id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const mismatches = [];
    const text = String(doc.ocr_text || '').toLowerCase();
    Object.entries(expected || {}).forEach(([k, v]) => {
      if (v && !text.includes(String(v).toLowerCase())) mismatches.push(k);
    });

    const status = mismatches.length ? 'REJECTED' : 'VERIFIED';
    // Also reflect final status in doc_status for admin workflows
    await db.promise().query(
      `UPDATE kyc_documents 
       SET verification_status = ?, verification_mismatches = ?, verification_checked_at = NOW(),
           doc_status = CASE WHEN ? = 'VERIFIED' THEN 'APPROVED' ELSE 'REJECTED' END,
           doc_status_updated_at = NOW()
       WHERE id = ?`,
      [status, status, id]
    );

    await db.promise().query(
      `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes)
       VALUES (?, ?, ?, 'verify', ?)` ,
      [doc.vendor_id, id, (req.adminId || 'admin-api-key'), status]
    );

    res.json({ message: 'Verification complete', status, mismatches });
  } catch (e) {
    console.error('Verify document error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/documents/:id/ocr → run OCR and store results
app.post('/api/admin/documents/:id/ocr', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [[doc]] = await db.promise().query('SELECT id, vendor_id, file_path, mime_type FROM kyc_documents WHERE id = ? LIMIT 1', [id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Basic OCR pipeline (same as existing /api/admin/kyc/:docId/ocr)
    const fs = require('fs');
    const path = require('path');
    let ocrText = '';
    let ocrBoxes = [];
    
    // First try PDF parsing for PDF files
    try {
      if ((doc.mime_type || '').includes('pdf') || (doc.file_path || '').toLowerCase().endsWith('.pdf')) {
        const pdfParse = require('pdf-parse');
        const dataBuffer = fs.readFileSync(path.resolve(doc.file_path));
        const parsed = await pdfParse(dataBuffer);
        ocrText = parsed.text || '';
      } else {
        // Use Tesseract.js for image files only
        const Tesseract = require('tesseract.js');
        const resolved = path.resolve(String(doc.file_path));
        const { data } = await Tesseract.recognize(resolved, 'eng');
        ocrText = data?.text || '';
        ocrBoxes = (data?.words || []).slice(0, 200).map(w => ({ x: w.bbox?.x0 || 0, y: w.bbox?.y0 || 0, w: (w.bbox?.x1 || 0) - (w.bbox?.x0 || 0), h: (w.bbox?.y1 || 0) - (w.bbox?.y0 || 0), label: w.text || '' }));
      }
    } catch (_) {
      // Fallback: no OCR library available or file processing failed
      ocrText = '';
      ocrBoxes = [];
    }
    
    // If no text was extracted, use fallback
    if (!ocrText) {
      ocrText = `File: ${doc.file_path}`;
    }

    // Simple extraction of document number patterns
    let documentNumber = null;
    try {
      const text = String(ocrText || '').toUpperCase();
      const panMatch = text.match(/[A-Z]{5}[0-9]{4}[A-Z]{1}/);
      const gstMatch = text.match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}/);
      const aadhaarMatch = text.match(/\b\d{4}\s\d{4}\s\d{4}\b/);
      documentNumber = (panMatch && panMatch[0]) || (gstMatch && gstMatch[0]) || (aadhaarMatch && aadhaarMatch[0]) || null;
    } catch (_) {}

    await db.promise().query(
      `UPDATE kyc_documents SET ocr_text = ?, ocr_boxes = ?, document_number = COALESCE(?, document_number) WHERE id = ?`,
      [ocrText || '', JSON.stringify(ocrBoxes || []), documentNumber, id]
    );

    await db.promise().query(
      `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes)
       VALUES (?, ?, ?, 'ocr', 'OCR processed')`,
      [doc.vendor_id, id, (req.adminId || 'admin-api-key')]
    );

    res.json({ message: 'OCR completed', text: ocrText, boxes: ocrBoxes });
  } catch (e) {
    console.error('OCR document error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Alias: Secure download using unified documents path
app.get('/api/admin/documents/:id/download', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [[doc]] = await db.promise().query(
      `SELECT kd.id, kd.vendor_id, kd.file_path, kd.mime_type, kd.original_name
       FROM kyc_documents kd WHERE kd.id = ?`,
      [id]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    await db.promise().query(
      `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes)
       VALUES (?, ?, ?, 'download', 'Admin downloaded document')`,
      [doc.vendor_id, id, (req.adminId || 'admin-api-key')]
    );

    const path = require('path');
    const fs = require('fs');
    const absolute = path.resolve(doc.file_path);
    if (!fs.existsSync(absolute)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.original_name || 'document')}"`);
    fs.createReadStream(absolute).pipe(res);
  } catch (e) {
    console.error('Admin documents download error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/documents/expiry-alerts → documents nearing retention expiry
app.get('/api/admin/documents/expiry-alerts', verifyAdmin, async (req, res) => {
  try {
    const windows = [30, 60, 90];
    const counts = {};
    for (const days of windows) {
      const [[{ c } = { c: 0 }]] = await db.promise().query(
        `SELECT COUNT(*) as c FROM kyc_documents kd
         WHERE kd.retention_until IS NOT NULL
           AND DATEDIFF(kd.retention_until, NOW()) BETWEEN 0 AND ?`,
        [days]
      );
      counts[`days${days}`] = Number(c || 0);
    }
    res.json({ expiring: counts });
  } catch (e) {
    console.error('Expiry alerts error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/audit-logs → global audit (approve/reject/verify/ocr)
app.get('/api/admin/audit-logs', verifyAdmin, async (req, res) => {
  try {
    const { vendor = '', action = '', admin = '', page = 1, limit = 20 } = req.query || {};
    const where = [];
    const params = [];
    if (vendor) { where.push('(v.shop_name LIKE ? OR CAST(l.vendor_id AS CHAR) LIKE ?)'); params.push(`%${vendor}%`, `%${vendor}%`); }
    if (action) { where.push('l.action = ?'); params.push(action); }
    if (admin) { where.push('l.admin_identifier = ?'); params.push(admin); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [rows] = await db.promise().query(
      `SELECT l.id, l.vendor_id, v.shop_name as vendor_name, l.document_id, kd.document_type, kd.original_name,
              l.action, l.admin_identifier, l.notes, l.created_at
       FROM kyc_audit_logs l
       LEFT JOIN vendors v ON v.id = l.vendor_id
       LEFT JOIN kyc_documents kd ON kd.id = l.document_id
       ${whereSql}
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    const [[{ total } = {}]] = await db.promise().query(
      `SELECT COUNT(*) as total
       FROM kyc_audit_logs l
       LEFT JOIN vendors v ON v.id = l.vendor_id
       LEFT JOIN kyc_documents kd ON kd.id = l.document_id
       ${whereSql}`,
      params
    );
    res.json({ items: rows, total: Number(total || 0) });
  } catch (e) {
    console.error('Global audit logs error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Admin: Approve vendor (helper endpoint)
app.put('/api/admin/vendors/:id/approve', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    await db.promise().query(
      `UPDATE vendors SET status='APPROVED', kyc_reviewed_at = NOW(), review_notes = ? WHERE id = ?`,
      [reason || null, id]
    );
    
    // Send email notification to vendor
    try {
      const hasFlatEmail = await tableHasColumn('vendors','email');
      const hasOwnerEmail = await tableHasColumn('vendors','owner_email');
      const hasShopName = await tableHasColumn('vendors','shop_name');
      const hasBusinessName = await tableHasColumn('vendors','business_name');
      
      const emailExpr = `${hasFlatEmail ? 'email' : (hasOwnerEmail ? 'owner_email' : 'NULL')} AS email`;
      const shopNameExpr = `${hasShopName ? 'shop_name' : (hasBusinessName ? 'business_name' : 'NULL')} AS shop_name`;
      
      const sql = `SELECT ${emailExpr}, owner_name, ${shopNameExpr} FROM vendors WHERE id = ? LIMIT 1`;
      const [rows] = await db.promise().query(sql, [id]);
      
      if (rows && rows.length > 0 && rows[0].email) {
        const vendor = rows[0];
        const vendorName = vendor.owner_name || 'Vendor';
        const shopName = vendor.shop_name || vendor.business_name || '';
        const appName = process.env.APP_NAME || 'SonicKart';
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        
        const subject = `${appName} – Your Vendor Account Has Been Approved!`;
        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 28px;">${appName}</h1>
              <p style="color: #ffc727; margin: 10px 0 0 0; font-size: 16px;">From your store to every doorstep</p>
            </div>
            
            <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
              <h2 style="color: #333; margin-top: 0;">🎉 Congratulations! Your Vendor Account Has Been Approved</h2>
              
              <p>Hello ${vendorName},</p>
              
              <p>Great news! Your vendor account${shopName ? ' for <strong>' + shopName + '</strong>' : ''} has been reviewed and <strong style="color: #10b981;">approved</strong> by our team.</p>
              
              <p>You can now:</p>
              <ul style="color: #555; line-height: 1.8;">
                <li>Log in to your vendor dashboard</li>
                <li>Add and manage your products</li>
                <li>Start accepting orders from customers</li>
                <li>Manage your inventory and track sales</li>
              </ul>
              
              ${reason ? `<div style="background: #f0f9ff; padding: 15px; border-left: 4px solid #3b82f6; margin: 20px 0; border-radius: 4px;">
                <p style="margin: 0; color: #1e40af;"><strong>Admin Notes:</strong> ${reason}</p>
              </div>` : ''}
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${frontendUrl}/#/vendor-login" 
                   style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                          color: white; 
                          padding: 15px 30px; 
                          text-decoration: none; 
                          border-radius: 8px; 
                          font-weight: bold;
                          display: inline-block;">
                  Access Your Dashboard
                </a>
              </div>
              
              <p style="color: #666; font-size: 14px;">
                If you have any questions or need assistance, please don't hesitate to contact our support team.
              </p>
              
              <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
              
              <p style="color: #999; font-size: 12px; text-align: center;">
                This is an automated message from ${appName}. Please do not reply to this email.
              </p>
            </div>
          </div>
        `;
        
        await sendEmailService({ 
          to: vendor.email, 
          subject, 
          html 
        });
        
        console.log(`Vendor approval email sent to ${vendor.email} for vendor ID ${id}`);
      }
    } catch (emailError) {
      console.error('Error sending vendor approval email:', emailError);
      // Don't fail the request if email fails
    }
    
    res.json({ message: 'Vendor approved' });
  } catch (e) {
    console.error('Approve vendor error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Reject vendor with reason
app.put('/api/admin/vendors/:id/reject', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!reason) return res.status(400).json({ error: 'Reason is required' });
    await db.promise().query(
      `UPDATE vendors SET status='REJECTED', kyc_reviewed_at = NOW(), review_notes = ? WHERE id = ?`,
      [reason, id]
    );
    res.json({ message: 'Vendor rejected' });
  } catch (e) {
    console.error('Reject vendor error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Suspend vendor
app.put('/api/admin/vendors/:id/suspend', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    await db.promise().query(
      `UPDATE vendors SET is_suspended = 1, suspended_at = NOW(), review_notes = CONCAT(IFNULL(review_notes,''), '\nSUSPENDED: ', ?) WHERE id = ?`,
      [reason || '', id]
    );
    res.json({ message: 'Vendor suspended' });
  } catch (e) {
    console.error('Suspend vendor error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Activate vendor
app.put('/api/admin/vendors/:id/activate', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.promise().query(
      `UPDATE vendors SET is_suspended = 0 WHERE id = ?`,
      [id]
    );
    res.json({ message: 'Vendor activated' });
  } catch (e) {
    console.error('Activate vendor error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Flag vendor
app.put('/api/admin/vendors/:id/flag', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    await db.promise().query(
      `UPDATE vendors SET flagged = 1, review_notes = CONCAT(IFNULL(review_notes,''), '\nFLAGGED: ', ?) WHERE id = ?`,
      [reason || '', id]
    );
    res.json({ message: 'Vendor flagged' });
  } catch (e) {
    console.error('Flag vendor error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Unflag vendor
app.put('/api/admin/vendors/:id/unflag', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.promise().query(
      `UPDATE vendors SET flagged = 0 WHERE id = ?`,
      [id]
    );
    res.json({ message: 'Vendor unflagged' });
  } catch (e) {
    console.error('Unflag vendor error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin profile endpoints
app.get('/api/admin/profile', verifyAdmin, async (req, res) => {
  try {
    const apiKey = req.headers['x-admin-key'];
    // For now, we'll return a default admin profile
    // In a real implementation, you'd get the admin user from the database based on the API key
    // Load from database to ensure admin exists and no super_admin leakage
    const [rows] = await db.promise().query(`SELECT id, username, email, role, created_at FROM admin_users ORDER BY id ASC LIMIT 1`);
    const admin = rows && rows[0] ? rows[0] : { id: 1, username: 'admin', email: 'admin@vendorportal.com', role: 'admin', created_at: new Date().toISOString() };
    // Force role to 'admin' for safety
    admin.role = 'admin';
    res.json(admin);
  } catch (e) {
    console.error('Get admin profile error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/admin/profile', verifyAdmin, async (req, res) => {
  try {
    const { username, email } = req.body;
    
    // For now, we'll just return success
    // In a real implementation, you'd update the admin user in the database
    // Persist to database (fetch existing password first to avoid self-select in upsert)
    const newUsername = username || 'admin';
    const newEmail = email || 'admin@vendorportal.com';
    const [pwRows] = await db.promise().query(`SELECT password FROM admin_users WHERE id = 1 LIMIT 1`);
    const existingPassword = (Array.isArray(pwRows) && pwRows[0] && pwRows[0].password) ? pwRows[0].password : '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi';
    await db.promise().query(
      `INSERT INTO admin_users (id, username, email, password, role)
       VALUES (1, ?, ?, ?, 'admin')
       ON DUPLICATE KEY UPDATE username = VALUES(username), email = VALUES(email), role = 'admin'`,
      [newUsername, newEmail, existingPassword]
    );
    res.json({ 
      message: 'Admin profile updated successfully',
      profile: {
        id: 1,
        username: newUsername,
        email: newEmail,
        role: 'admin'
      }
    });
  } catch (e) {
    console.error('Update admin profile error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get All Vendors (Admin)
app.get('/api/admin/vendors', verifyAdmin, async (req, res) => {
  try {
    const {
      status = '',
      approval_status = '',
      activity_status = '',
      city = '',
      search = '',
      flagged = '',
      sort = 'date_desc',
      date_from = '',
      date_to = '',
      page = 1,
      limit = 20
    } = req.query;

    const where = [];
    const params = [];
    if (status) {
      let st = String(status || '').toUpperCase();
      if (st === 'PENDING') st = 'SUBMITTED';
      if (st === 'UNDER_REVIEW') st = 'IN_REVIEW';
      where.push('v.status = ?');
      params.push(st);
    }
    if (approval_status) {
      let ap = String(approval_status || '').toUpperCase();
      if (ap === 'PENDING') ap = 'SUBMITTED';
      if (ap === 'UNDER_REVIEW') ap = 'IN_REVIEW';
      if (['SUBMITTED','IN_REVIEW','APPROVED','REJECTED','DRAFT'].includes(ap)) {
        where.push('v.status = ?');
        params.push(ap);
      }
    }
    if (activity_status) {
      const active = String(activity_status || '').toUpperCase() === 'ACTIVE';
      if (await tableHasColumn('vendors','is_suspended')) {
        where.push(active ? 'v.is_suspended = 0' : 'v.is_suspended = 1');
      }
    }
    if (city) { where.push('v.city = ?'); params.push(city); }
    if (flagged !== '') {
      where.push('v.flagged = ?');
      params.push(String(flagged) === 'true' ? 1 : 0);
    }
    if (search) {
      where.push('(COALESCE(v.shop_name, v.business_name) LIKE ? OR v.owner_name LIKE ? OR v.owner_email LIKE ? OR v.owner_phone LIKE ? OR v.city LIKE ? OR v.vendor_id LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    // Date filters on created_at
    if (date_from) { where.push('DATE(v.created_at) >= DATE(?)'); params.push(date_from); }
    if (date_to) { where.push('DATE(v.created_at) <= DATE(?)'); params.push(date_to); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Sort handling (only by created_at for now)
    const orderClause = String(sort) === 'date_asc' ? 'ORDER BY v.created_at ASC' : 'ORDER BY v.created_at DESC';

    const [rows] = await db.promise().query(
      `SELECT 
         v.id,
         v.vendor_id,
         COALESCE(v.shop_name, v.business_name) as shop_name,
         v.owner_name,
         v.owner_email as email,
         v.owner_phone as phone,
         v.address as shop_address,
         v.city,
         v.status,
         v.flagged,
         v.is_suspended,
         v.created_at,
         v.kyc_submitted_at,
         v.kyc_reviewed_at,
         v.review_notes
       FROM vendors v
       ${whereSql}
       ${orderClause}
       LIMIT ? OFFSET ?`,
       [...params, parseInt(limit), offset]
    );
    const [[{ total } = {}]] = await db.promise().query(
      `SELECT COUNT(*) as total FROM vendors v ${whereSql}`,
      params
    );
    // Attach statusLabel for each vendor row
    const items = rows.map(v => ({
      ...v,
      statusLabel: getVendorStatusLabel(v.status),
      approval_status: (String(v.status || '').toUpperCase() === 'SUBMITTED' || String(v.status || '').toUpperCase() === 'IN_REVIEW') ? 'PENDING' : String(v.status || '').toUpperCase(),
      activity_status: Number(v.is_suspended || 0) === 1 ? 'INACTIVE' : 'ACTIVE'
    }));
    res.json({ items, total: Number(total || 0) });
  } catch (error) {
    console.error('Get vendors error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create Vendor (Admin)
app.post('/api/admin/vendors', verifyAdmin, async (req, res) => {
  try {
    const {
      shopName,
      ownerName,
      email,
      phone,
      shopAddress,
      city = null,
      password,
      autoGeneratePassword = false,
      latitude = null,
      longitude = null
    } = req.body || {};

  if (!shopName || !ownerName || !email || !phone || !shopAddress) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Uniqueness check across schema variants
    let exists = false;
    try {
      if (await tableHasColumn('vendors', 'email')) {
        const [[row]] = await db.promise().query('SELECT id FROM vendors WHERE email = ? LIMIT 1', [email]);
        exists = !!row;
      } else if (await tableHasColumn('vendors', 'owner_email')) {
        const [[row]] = await db.promise().query('SELECT id FROM vendors WHERE owner_email = ? LIMIT 1', [email]);
        exists = !!row;
      }
    } catch (_) {}
    if (exists) {
      return res.status(400).json({ error: 'Vendor with this email already exists' });
    }

    const hasPasswordCol = await tableHasColumn('vendors', 'password');
    let plainPassword = password || '';
    if (hasPasswordCol) {
      if (autoGeneratePassword && !plainPassword) {
        plainPassword = Math.random().toString(36).slice(-10) + '!A1';
      }
      if (!plainPassword || String(plainPassword).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters or enable auto-generate' });
      }
    }

    let passwordHash = null;
    if (hasPasswordCol) {
      passwordHash = await bcrypt.hash(plainPassword, 10);
    }

    // Column variants support
    const hasBusinessName = await tableHasColumn('vendors', 'business_name');
    const hasShopName = await tableHasColumn('vendors', 'shop_name');
    const nameCol = hasBusinessName ? 'business_name' : (hasShopName ? 'shop_name' : 'shop_name');

    const hasAddressCol = await tableHasColumn('vendors', 'address');
    const hasShopAddressCol = await tableHasColumn('vendors', 'shop_address');
    const addressCol = hasAddressCol ? 'address' : (hasShopAddressCol ? 'shop_address' : 'shop_address');

    const hasFlatEmail = await tableHasColumn('vendors', 'email');
    const hasOwnerEmail = await tableHasColumn('vendors', 'owner_email');
    const emailCol = hasFlatEmail ? 'email' : (hasOwnerEmail ? 'owner_email' : 'email');

    const hasFlatPhone = await tableHasColumn('vendors', 'phone');
    const hasOwnerPhone = await tableHasColumn('vendors', 'owner_phone');
    const phoneCol = hasFlatPhone ? 'phone' : (hasOwnerPhone ? 'owner_phone' : 'phone');

    const cols = [nameCol,'owner_name',emailCol,phoneCol,addressCol,'status'];
    const vals = [shopName, ownerName, email, phone, shopAddress, 'ACTIVE'];
    const placeholders = ['?','?','?','?','?','?'];
    if (await tableHasColumn('vendors', 'city')) { cols.push('city'); vals.push(city); placeholders.push('?'); }
    if (await tableHasColumn('vendors', 'latitude')) { cols.push('latitude'); vals.push(latitude); placeholders.push('?'); }
    if (await tableHasColumn('vendors', 'longitude')) { cols.push('longitude'); vals.push(longitude); placeholders.push('?'); }
    if (hasPasswordCol) { cols.push('password'); vals.push(passwordHash); placeholders.push('?'); }

    const [result] = await db.promise().query(
      `INSERT INTO vendors (${cols.join(',')}) VALUES (${placeholders.join(',')})`,
      vals
    );

    const vendorId = result.insertId;

    // Fetch the created vendor to return complete data
    const [[createdVendor]] = await db.promise().query(
      `SELECT * FROM vendors WHERE id = ? LIMIT 1`,
      [vendorId]
    );

    // Optional: send credentials via webhook/email integration if configured
    // If MAIL_WEBHOOK_URL is set, post minimal payload. Failures should not block creation.
    try {
      if (process.env.MAIL_WEBHOOK_URL && hasPasswordCol) {
        await fetch(process.env.MAIL_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'VENDOR_CREDENTIALS',
            to: email,
            payload: { shopName, ownerName, email, password: plainPassword }
          })
        });
      }
    } catch (_) {}

    res.status(201).json({
      message: 'Vendor created',
      vendor: createdVendor,
      vendorId,
      password: hasPasswordCol ? plainPassword : undefined
    });
  } catch (e) {
    console.error('Admin create vendor error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update Vendor (Admin)
app.put('/api/admin/vendors/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { shopName, ownerName, email, phone, shopAddress, city, latitude, longitude, status } = req.body || {};
    const fields = [];
    const params = [];
    if (shopName !== undefined) { fields.push('shop_name = ?'); params.push(shopName); }
    if (ownerName !== undefined) { fields.push('owner_name = ?'); params.push(ownerName); }
    if (email !== undefined) { fields.push('email = ?'); params.push(email); }
    if (phone !== undefined) { fields.push('phone = ?'); params.push(phone); }
    if (shopAddress !== undefined) { fields.push('shop_address = ?'); params.push(shopAddress); }
    if (city !== undefined && await tableHasColumn('vendors','city')) { fields.push('city = ?'); params.push(city); }
    if (latitude !== undefined && await tableHasColumn('vendors','latitude')) { fields.push('latitude = ?'); params.push(latitude); }
    if (longitude !== undefined && await tableHasColumn('vendors','longitude')) { fields.push('longitude = ?'); params.push(longitude); }
    if (status !== undefined && await tableHasColumn('vendors','status')) { fields.push('status = ?'); params.push(status); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    params.push(id);
    const [r] = await db.promise().query(`UPDATE vendors SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ message: 'Vendor updated' });
  } catch (e) {
    console.error('Admin update vendor error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Delete Vendor (Admin)
app.delete('/api/admin/vendors/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [r] = await db.promise().query('DELETE FROM vendors WHERE id = ?', [id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ message: 'Vendor deleted' });
  } catch (e) {
    console.error('Admin delete vendor error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk Status Update (Admin)
app.post('/api/admin/vendors/bulk-status', verifyAdmin, async (req, res) => {
  try {
    const { ids, status, type = 'approval' } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
    if (!status) return res.status(400).json({ error: 'status required' });
    const upper = String(status).toUpperCase();
    let sql;
    let params = [];
    if (type === 'activity') {
      const makeActive = upper === 'ACTIVE';
      if (!(await tableHasColumn('vendors','is_suspended'))) return res.status(400).json({ error: 'activity not supported' });
      sql = `UPDATE vendors SET is_suspended = ${makeActive ? 0 : 1}${makeActive ? '' : ', suspended_at = NOW()'} WHERE id IN (${ids.map(() => '?').join(',')})`;
      params = ids;
    } else {
      let save = upper;
      if (save === 'PENDING') save = 'SUBMITTED';
      if (save === 'IN_REVIEW') save = 'UNDER_REVIEW';
      sql = `UPDATE vendors SET status = ? WHERE id IN (${ids.map(() => '?').join(',')})`;
      params = [save, ...ids];
    }
    const [r] = await db.promise().query(sql, params);
    res.json({ message: 'Vendors updated', affected: r.affectedRows });
  } catch (e) {
    console.error('Admin bulk status error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle activity status for a vendor (Admin)
app.put('/api/admin/vendors/:id/activity', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status required' });
    if (!(await tableHasColumn('vendors','is_suspended'))) return res.status(400).json({ error: 'activity not supported' });
    const makeActive = String(status).toUpperCase() === 'ACTIVE';
    const [r] = await db.promise().query(
      `UPDATE vendors SET is_suspended = ?, ${makeActive ? '' : 'suspended_at = NOW(), '}updated_at = NOW() WHERE id = ?`.replace(', updated_at', ' updated_at'),
      [makeActive ? 0 : 1, id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ message: 'Activity status updated' });
  } catch (e) {
    console.error('Admin toggle activity error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor Details (Admin)
app.get('/api/admin/vendors/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [[vendor]] = await db.promise().query(
      `SELECT v.* FROM vendors v WHERE v.id = ? LIMIT 1`,
      [id]
    );
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    let productsCount = 0;
    try {
      const [[{ c } = { c: 0 }]] = await db.promise().query('SELECT COUNT(*) as c FROM products WHERE vendor_id = ?', [id]);
      productsCount = Number(c || 0);
    } catch (_) {}

    let inventoryStats = { totalSkus: 0, totalStock: 0 };
    try {
      const [[{ skus = 0 } = {}]] = await db.promise().query('SELECT COUNT(DISTINCT product_id) as skus FROM inventory WHERE vendor_id = ?', [id]);
      const [[{ qty = 0 } = {}]] = await db.promise().query('SELECT SUM(quantity) as qty FROM inventory WHERE vendor_id = ?', [id]);
      inventoryStats = { totalSkus: Number(skus || 0), totalStock: Number(qty || 0) };
    } catch (_) {}

    let recentOrders = [];
    try {
      const [rows] = await db.promise().query('SELECT id, status, total_amount, created_at FROM orders WHERE vendor_id = ? ORDER BY created_at DESC LIMIT 10', [id]);
      recentOrders = rows || [];
    } catch (_) {}

    let documents = [];
    try {
      const [docs] = await db.promise().query('SELECT id, document_type, original_name, file_path, uploaded_at, mime_type, file_size FROM kyc_documents WHERE vendor_id = ?', [id]);
      documents = docs || [];
    } catch (_) {}

    const approval_status = (String(vendor.status || '').toUpperCase() === 'SUBMITTED' || String(vendor.status || '').toUpperCase() === 'IN_REVIEW') ? 'PENDING' : String(vendor.status || '').toUpperCase();
    const activity_status = Number(vendor.is_suspended || 0) === 1 ? 'INACTIVE' : 'ACTIVE';
    res.json({ vendor: { ...vendor, approval_status, activity_status }, stats: { productsCount, inventoryStats }, recentOrders, documents });
  } catch (e) {
    console.error('Admin vendor details error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// (verifyToken defined earlier)

// PRODUCT MANAGEMENT ROUTES

// Get all products for a vendor
app.get('/api/products', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', category = '', status = '' } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT p.*, i.stock_on_hand, i.stock_reserved, i.stock_available, i.min_stock_level, i.reorder_point
      FROM products p
      LEFT JOIN inventory i ON p.id = i.product_id
      WHERE p.vendor_id = ?
    `;
    let params = [req.vendorId];
    
    if (search) {
      query += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    
    if (category && category !== 'all') {
      query += ' AND p.category = ?';
      params.push(category);
    }
    
    if (status && status !== 'all') {
      query += ' AND p.status = ?';
      params.push(status);
    } else {
      // Default: hide inactive/discontinued from vendor
      query += ' AND p.status = "active"';
    }
    
    query += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const products = await db.promise().query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM products WHERE vendor_id = ?';
    let countParams = [req.vendorId];
    
    if (search) {
      countQuery += ' AND (name LIKE ? OR sku LIKE ? OR description LIKE ?)';
      countParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    
    if (category) {
      countQuery += ' AND category = ?';
      countParams.push(category);
    }
    
    if (status) {
      countQuery += ' AND status = ?';
      countParams.push(status);
    } else {
      countQuery += ' AND status = "active"';
    }
    
    const countResult = await db.promise().query(countQuery, countParams);
    
    res.json({
      products: products[0],
      total: countResult[0][0].total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(countResult[0][0].total / limit)
    });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single product
app.get('/api/products/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const products = await db.promise().query(
      `SELECT p.*, i.stock_on_hand, i.stock_reserved, i.stock_available, i.min_stock_level, i.reorder_point, i.max_stock_level
       FROM products p
       LEFT JOIN inventory i ON p.id = i.product_id
       WHERE p.id = ? AND p.vendor_id = ?`,
      [id, req.vendorId]
    );
    
    if (products[0].length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    res.json(products[0][0]);
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new product
app.post('/api/products', verifyToken, async (req, res) => {
  try {
    const {
      name, description, sku, category, price, mrp, cost_price, image_url, product_images, unit, weight, dimensions, barcode,
      stock_on_hand, min_stock_level, max_stock_level, reorder_point, reorder_quantity, hsn_code, gst_slab
    } = req.body;
    const gstCheck = validateGSTCategory(category, hsn_code);
    if (!gstCheck.ok) return res.status(400).json({ error: gstCheck.message });
    const slabCheck = deriveGstSlab(category, typeof gst_slab !== 'undefined' ? Number(gst_slab) : undefined);
    if (!slabCheck.ok) return res.status(400).json({ error: slabCheck.message });
    const finalGstSlab = slabCheck.value;
    // Compute final price if not provided (UI disables price input)
    let finalPrice = Number(price);
    const mrpNum = Number(mrp);
    const costNum = Number(cost_price);
    if (isNaN(finalPrice) || finalPrice <= 0) {
      if (!isNaN(mrpNum) && mrpNum > 0) finalPrice = mrpNum;
      else if (!isNaN(costNum) && costNum > 0) finalPrice = costNum;
    }
    if (isNaN(finalPrice) || finalPrice <= 0) {
      return res.status(400).json({ error: 'Provide a valid MRP or Cost Price to initialize selling price' });
    }
    if (!isNaN(mrpNum) && mrpNum > 0 && finalPrice > mrpNum) {
      finalPrice = mrpNum; // clamp to MRP
    }
    
    // Check if Product already exists in the database
    const existingSku = await db.promise().query(
      'SELECT id FROM products WHERE sku = ?',
      [sku]
    );
    
    if (existingSku[0].length > 0) {
      return res.status(400).json({ error: 'Product already exists in the database' });
    }
    
    // Insert product (price may be overridden by active rules)
    // Build INSERT dynamically based on existing columns (compat with older schemas)
    const hasMrpCol = await tableHasColumn('products', 'mrp');
    const hasGstSlabCol = await tableHasColumn('products', 'gst_slab');
    const hasProductImagesCol = await tableHasColumn('products', 'product_images');
    const columns = ['vendor_id','name','description','sku','category','price','cost_price','image_url','unit','weight','status','hsn_code'];
    const values = [req.vendorId, name, description, sku, category, Number(finalPrice).toFixed(2), isNaN(costNum) ? null : Number(costNum).toFixed(2), image_url, unit, weight, 'active', hsn_code];
    if (hasMrpCol) {
      columns.splice(6, 0, 'mrp');
      values.splice(6, 0, isNaN(mrpNum) ? null : Number(mrpNum).toFixed(2));
    }
    if (hasGstSlabCol) {
      columns.splice(hasMrpCol ? 13 : 12, 0, 'gst_slab');
      values.splice(hasMrpCol ? 13 : 12, 0, finalGstSlab);
    }
    if (hasProductImagesCol) {
      columns.push('product_images');
      values.push(product_images ? JSON.stringify(product_images) : null);
    }
    const placeholders = columns.map(() => '?').join(', ');
    const productResult = await db.promise().query(
      `INSERT INTO products (${columns.join(', ')}) VALUES (${placeholders})`,
      values
    );
    
    const productId = productResult[0].insertId;
    
    // Create inventory record
    await db.promise().query(
      `INSERT INTO inventory (product_id, stock_on_hand, min_stock_level, reorder_point, reorder_quantity)
       VALUES (?, ?, ?, ?, ?)`,
      [productId, stock_on_hand || 0, min_stock_level || 0, reorder_point || 0, reorder_quantity || 0]
    );
    
    // Record initial stock movement
    if (stock_on_hand > 0) {
      await db.promise().query(
        'INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, created_by) VALUES (?, ?, ?, ?, ?)',
        [productId, 'in', stock_on_hand, 'adjustment', req.vendorId]
      );
    }
    
    // Apply enhanced pricing rules after creation
    try {
      // Only apply pricing rules if we have a valid price
      if (price && !isNaN(parseFloat(price)) && parseFloat(price) > 0) {
        const priceCalculation = await calculateFinalPrice(productId, price);
        if (priceCalculation.finalPrice !== Number(price)) {
          await db.promise().query(`UPDATE products SET price = ?, updated_at = NOW() WHERE id = ?`, [priceCalculation.finalPrice, productId]);
          await db.promise().query(
            `INSERT INTO price_history (product_id, old_price, new_price, reason, changed_by) VALUES (?, ?, ?, ?, 'system')`,
            [productId, price, priceCalculation.finalPrice, 'Applied enhanced pricing rules on create']
          );
        }
      }
    } catch (_) { /* non-fatal */ }

    res.status(201).json({ message: 'Product created successfully', productId });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update product
app.put('/api/products/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, description, sku, category, /* price ignored - platform managed */ mrp, cost_price, image_url, unit, weight, status,
      stock_on_hand, min_stock_level, reorder_point, reorder_quantity, hsn_code, gst_slab
    } = req.body;
    const gstCheck = validateGSTCategory(category, hsn_code);
    if (!gstCheck.ok) return res.status(400).json({ error: gstCheck.message });
    const slabCheck = deriveGstSlab(category, typeof gst_slab !== 'undefined' ? Number(gst_slab) : undefined);
    if (!slabCheck.ok) return res.status(400).json({ error: slabCheck.message });
    const finalGstSlab = slabCheck.value;
    
    // Check if product exists and belongs to vendor
    const existingProduct = await db.promise().query(
      'SELECT id FROM products WHERE id = ? AND vendor_id = ?',
      [id, req.vendorId]
    );
    
    if (existingProduct[0].length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Check if Product already exists in the database for different product
    const existingSku = await db.promise().query(
      'SELECT id FROM products WHERE sku = ? AND id != ?',
      [sku, id]
    );
    
    if (existingSku[0].length > 0) {
      return res.status(400).json({ error: 'Product already exists in the database' });
    }
    
    // Block vendor price updates (platform-managed)
    if (Object.prototype.hasOwnProperty.call(req.body, 'price')) {
      return res.status(400).json({ error: 'Price is platform-managed. Submit a price change request instead.' });
    }

    // Update product (excluding price) with PARTIAL updates only
    const hasMrpColU = await tableHasColumn('products', 'mrp');
    const hasGstSlabColU = await tableHasColumn('products', 'gst_slab');
    const productSets = [];
    const productParams = [];
    if (name !== undefined) { productSets.push('name = ?'); productParams.push(name); }
    if (description !== undefined) { productSets.push('description = ?'); productParams.push(description); }
    if (sku !== undefined) { productSets.push('sku = ?'); productParams.push(sku); }
    if (category !== undefined) { productSets.push('category = ?'); productParams.push(category); }
    if (cost_price !== undefined) { productSets.push('cost_price = ?'); productParams.push(cost_price); }
    if (image_url !== undefined) { productSets.push('image_url = ?'); productParams.push(image_url); }
    if (unit !== undefined) { productSets.push('unit = ?'); productParams.push(unit); }
    if (weight !== undefined) { productSets.push('weight = ?'); productParams.push(weight); }
    if (status !== undefined) { productSets.push('status = ?'); productParams.push(status); }
    if (hsn_code !== undefined) { productSets.push('hsn_code = ?'); productParams.push(hsn_code); }
    if (hasMrpColU && mrp !== undefined) { productSets.push('mrp = ?'); productParams.push(mrp); }
    if (hasGstSlabColU && (gst_slab !== undefined || category !== undefined)) { productSets.push('gst_slab = ?'); productParams.push(finalGstSlab); }

    if (productSets.length > 0) {
      productParams.push(id, req.vendorId);
      await db.promise().query(
        `UPDATE products SET ${productSets.join(', ')}, updated_at = NOW() WHERE id = ? AND vendor_id = ?`,
        productParams
      );
    }
    
    // Update inventory with partial updates
    if ([min_stock_level, reorder_point, reorder_quantity].some(v => v !== undefined)) {
      await db.promise().query(
        `UPDATE inventory SET 
           min_stock_level = COALESCE(?, min_stock_level),
           reorder_point = COALESCE(?, reorder_point),
           reorder_quantity = COALESCE(?, reorder_quantity),
           updated_at = NOW()
         WHERE product_id = ?`,
        [min_stock_level, reorder_point, reorder_quantity, id]
      );
    }
    
    // If stock_on_hand is provided, adjust stock
    if (stock_on_hand !== undefined) {
      const currentStock = await db.promise().query(
        'SELECT stock_on_hand FROM inventory WHERE product_id = ?',
        [id]
      );
      
      const currentStockValue = currentStock[0][0]?.stock_on_hand || 0;
      const stockDifference = stock_on_hand - currentStockValue;
      
      if (stockDifference !== 0) {
        await db.promise().query(
          'UPDATE inventory SET stock_on_hand = ? WHERE product_id = ?',
          [stock_on_hand, id]
        );
        
        await db.promise().query(
          'INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, created_by) VALUES (?, ?, ?, ?, ?)',
          [id, stockDifference > 0 ? 'in' : 'out', Math.abs(stockDifference), 'adjustment', req.vendorId]
        );
      }
    }
    
    res.json({ message: 'Product updated successfully' });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete product
app.delete('/api/products/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if product exists and belongs to vendor
    const existingProduct = await db.promise().query(
      'SELECT id FROM products WHERE id = ? AND vendor_id = ?',
      [id, req.vendorId]
    );
    
    if (existingProduct[0].length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Check if product has any orders
    const orderItems = await db.promise().query(
      'SELECT id FROM order_items WHERE product_id = ?',
      [id]
    );
    
    if (orderItems[0].length > 0) {
      return res.status(400).json({ error: 'Cannot delete product with existing orders' });
    }
    
    // Delete product (cascade will handle inventory and stock_movements)
    await db.promise().query(
      'DELETE FROM products WHERE id = ? AND vendor_id = ?',
      [id, req.vendorId]
    );
    
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PRODUCT IMAGE UPLOAD ROUTES

// Upload product image
app.post('/api/upload/product-image', verifyToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Image file is required' });
    }
    
    // Generate public URL for the uploaded image
    const imageUrl = `/uploads/${req.file.filename}`;
    
    res.json({ 
      success: true, 
      imageUrl: imageUrl,
      filename: req.file.filename 
    });
  } catch (error) {
    console.error('Product image upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Admin product image upload
app.post('/api/admin/upload/product-image', verifyAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Image file is required' });
    }
    
    // Generate public URL for the uploaded image
    const imageUrl = `/uploads/${req.file.filename}`;
    
    res.json({ 
      success: true, 
      imageUrl: imageUrl,
      filename: req.file.filename 
    });
  } catch (error) {
    console.error('Admin product image upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// CSV BULK UPLOAD ROUTES

// Upload CSV file for bulk product import
app.post('/api/products/upload-csv', verifyToken, upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'CSV file is required' });
    }
    
    const filePath = req.file.path;
    const results = [];
    const errors = [];
    let rowNumber = 0;
    
    // Log upload start
    const logResult = await db.promise().query(
      'INSERT INTO csv_upload_logs (vendor_id, filename, total_rows, status) VALUES (?, ?, 0, ?)',
      [req.vendorId, req.file.originalname, 'processing']
    );
    const logId = logResult[0].insertId;
    
    // Parse CSV file
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => {
        rowNumber++;
        results.push({ rowNumber, data });
      })
      .on('end', async () => {
        try {
          let successfulRows = 0;
          let failedRows = 0;
          const errorLog = [];
          
          // Process each row
          for (const { rowNumber, data } of results) {
            try {
              const {
                name, description, sku, category, price, mrp, cost_price, image_url, unit, weight, dimensions, barcode,
                hsn_code, gst_slab, stock_on_hand, min_stock_level, max_stock_level, reorder_point, reorder_quantity
              } = data;
              
              // Validate required fields
              if (!name || !sku || !category || !price) {
                throw new Error('Missing required fields: name, sku, category, price');
              }

              // GST validation per category
              const gstCheck = validateGSTCategory(category, hsn_code);
              if (!gstCheck.ok) {
                throw new Error(`GST validation failed: ${gstCheck.message}`);
              }
              const slabCheck = deriveGstSlab(category, typeof gst_slab !== 'undefined' ? Number(gst_slab) : undefined);
              if (!slabCheck.ok) {
                throw new Error(`GST slab validation failed: ${slabCheck.message}`);
              }
              const finalGstSlab = slabCheck.value;
              if (mrp && price && Number(price) > Number(mrp)) {
                throw new Error('Selling price cannot exceed MRP');
              }
              
              // Check if Product already exists in the database
              const existingSku = await db.promise().query(
                'SELECT id FROM products WHERE sku = ?',
                [sku]
              );
              
              if (existingSku[0].length > 0) {
                throw new Error('Product already exists in the database');
              }
              
              // Insert product
              // Compute price if missing
              let finalPrice = Number(price);
              const mrpNum = Number(mrp);
              const costNum = Number(cost_price);
              if (isNaN(finalPrice) || finalPrice <= 0) {
                if (!isNaN(mrpNum) && mrpNum > 0) finalPrice = mrpNum;
                else if (!isNaN(costNum) && costNum > 0) finalPrice = costNum;
              }
              if (isNaN(finalPrice) || finalPrice <= 0) {
                throw new Error('Provide valid MRP or Cost Price to initialize selling price');
              }
              if (!isNaN(mrpNum) && mrpNum > 0 && finalPrice > mrpNum) {
                finalPrice = mrpNum;
              }

              const hasMrpCol = await tableHasColumn('products', 'mrp');
              const hasGstSlabCol = await tableHasColumn('products', 'gst_slab');
              const columns = ['vendor_id','name','description','sku','category','price','cost_price','image_url','unit','weight','dimensions','barcode','status','hsn_code'];
              const values = [req.vendorId, name, description, sku, category, Number(finalPrice).toFixed(2), isNaN(costNum) ? null : Number(costNum).toFixed(2), image_url, unit, weight, dimensions, barcode, 'active', hsn_code];
              if (hasMrpCol) { columns.splice(6, 0, 'mrp'); values.splice(6, 0, isNaN(mrpNum) ? null : Number(mrpNum).toFixed(2)); }
              if (hasGstSlabCol) { columns.splice(hasMrpCol ? 13 : 12, 0, 'gst_slab'); values.splice(hasMrpCol ? 13 : 12, 0, finalGstSlab); }
              const placeholders = columns.map(() => '?').join(', ');
              const productResult = await db.promise().query(
                `INSERT INTO products (${columns.join(', ')}) VALUES (${placeholders})`,
                values
              );
              
              const productId = productResult[0].insertId;
              
              // Create inventory record
              await db.promise().query(
                `INSERT INTO inventory (product_id, stock_on_hand, min_stock_level, max_stock_level, reorder_point, reorder_quantity)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [productId, parseInt(stock_on_hand) || 0, parseInt(min_stock_level) || 0, parseInt(max_stock_level), parseInt(reorder_point) || 0, parseInt(reorder_quantity) || 0]
              );
              
              // Record initial stock movement
              if (parseInt(stock_on_hand) > 0) {
                await db.promise().query(
                  'INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, created_by) VALUES (?, ?, ?, ?, ?)',
                  [productId, 'in', parseInt(stock_on_hand), 'adjustment', req.vendorId]
                );
              }
              
              successfulRows++;
            } catch (error) {
              failedRows++;
              errorLog.push(`Row ${rowNumber}: ${error.message}`);
            }
          }
          
          // Update upload log
          await db.promise().query(
            'UPDATE csv_upload_logs SET successful_rows = ?, failed_rows = ?, error_log = ?, status = ? WHERE id = ?',
            [successfulRows, failedRows, errorLog.join('\n'), 'completed', logId]
          );
          
          // Clean up file
          fs.unlinkSync(filePath);
          
          res.json({
            message: 'CSV upload completed',
            totalRows: results.length,
            successfulRows,
            failedRows,
            errors: errorLog
          });
        } catch (error) {
          // Update upload log with error
          await db.promise().query(
            'UPDATE csv_upload_logs SET status = ?, error_log = ? WHERE id = ?',
            ['failed', error.message, logId]
          );
          
          // Clean up file
          fs.unlinkSync(filePath);
          
          res.status(500).json({ error: 'CSV processing failed', details: error.message });
        }
      })
      .on('error', async (error) => {
        // Update upload log with error
        await db.promise().query(
          'UPDATE csv_upload_logs SET status = ?, error_log = ? WHERE id = ?',
          ['failed', error.message, logId]
        );
        
        // Clean up file
        fs.unlinkSync(filePath);
        
        res.status(500).json({ error: 'CSV parsing failed', details: error.message });
      });
  } catch (error) {
    console.error('CSV upload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Download CSV template
app.get('/api/products/csv-template', (req, res) => {
  try {
    const template = [
      {
        name: 'Product Name',
        description: 'Product Description',
        sku: 'SKU-001',
        category: 'Food & Beverages',
        price: '10.99',
        mrp: '12.99',
        cost_price: '8.50',
        image_url: 'https://example.com/image.jpg',
        unit: 'piece',
        weight: '0.5',
        dimensions: '10x10x5',
        barcode: '1234567890123',
        hsn_code: '0402',
        gst_slab: '5.0',
        stock_on_hand: '100',
        min_stock_level: '10',
        max_stock_level: '500',
        reorder_point: '20',
        reorder_quantity: '50'
      }
    ];
    
    const csv = require('csv-writer').createObjectCsvWriter({
      path: 'product_template.csv',
      header: [
        { id: 'name', title: 'Name' },
        { id: 'description', title: 'Description' },
        { id: 'sku', title: 'SKU' },
        { id: 'category', title: 'Category' },
        { id: 'price', title: 'Price' },
        { id: 'mrp', title: 'MRP' },
        { id: 'cost_price', title: 'Cost Price' },
        { id: 'image_url', title: 'Image URL' },
        { id: 'unit', title: 'Unit' },
        { id: 'weight', title: 'Weight' },
        { id: 'dimensions', title: 'Dimensions' },
        { id: 'barcode', title: 'Barcode' },
        { id: 'hsn_code', title: 'HSN Code' },
        { id: 'gst_slab', title: 'GST Slab (%)' },
        { id: 'stock_on_hand', title: 'Stock On Hand' },
        { id: 'min_stock_level', title: 'Min Stock Level' },
        { id: 'max_stock_level', title: 'Max Stock Level' },
        { id: 'reorder_point', title: 'Reorder Point' },
        { id: 'reorder_quantity', title: 'Reorder Quantity' }
      ]
    });
    
    csv.writeRecords(template).then(() => {
      res.download('product_template.csv', 'product_template.csv', (err) => {
        if (err) {
          console.error('Download error:', err);
        }
        // Clean up file
        fs.unlinkSync('product_template.csv');
      });
    });
  } catch (error) {
    console.error('Template download error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Seed 3–5 basic test products for the logged-in vendor
app.post('/api/products/seed-basic', verifyToken, async (req, res) => {
  try {
    const samples = [
      { name: 'Amul Taaza Milk 1L', sku: `MILK-1L-${Date.now()}`.slice(0, 20), category: 'Dairy', mrp: 68.00, price: 65.00, stock: 40, unit: 'l', hsn: '0401' },
      { name: 'Brown Bread 400g', sku: `BREAD-400-${Date.now()}`.slice(0, 20), category: 'Bakery', mrp: 45.00, price: 42.00, stock: 30, unit: 'pack', hsn: '1905' },
      { name: 'Basmati Rice 5kg', sku: `RICE-5KG-${Date.now()}`.slice(0, 20), category: 'Pantry', mrp: 520.00, price: 499.00, stock: 25, unit: 'kg', hsn: '1006' },
      { name: 'Banana (Dozen)', sku: `BANANA-${Date.now()}`.slice(0, 20), category: 'Fresh Produce', mrp: 60.00, price: 55.00, stock: 50, unit: 'piece', hsn: '0803' },
      { name: 'Cola Drink 1.25L', sku: `COLA-1250-${Date.now()}`.slice(0, 20), category: 'Food & Beverages', mrp: 75.00, price: 70.00, stock: 35, unit: 'l', hsn: '2202' }
    ];
    let created = 0;
    for (const s of samples) {
      const slab = deriveGstSlab(s.category).value;
      const [ins] = await db.promise().query(
        `INSERT INTO products (vendor_id, name, description, sku, category, price, mrp, cost_price, unit, barcode, gst_slab, status, hsn_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 'active', ?)`,
        [req.vendorId, s.name, null, s.sku, s.category, s.price, s.mrp, s.unit, slab, s.hsn]
      );
      const pid = ins.insertId;
      await db.promise().query(
        `INSERT INTO inventory (product_id, stock_on_hand, min_stock_level, max_stock_level, reorder_point, reorder_quantity)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [pid, s.stock, 5, null, 10, 20]
      );
      created++;
    }
    res.json({ message: 'Sample products created', created });
  } catch (e) {
    console.error('Seed products error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// ADMIN PRODUCT MANAGEMENT ROUTES

// Get all products for admin (all vendors)
app.get('/api/admin/products', verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', category = '', status = '', vendor_id = '', vendor_code = '', date_from = '', date_to = '', product_id = '' } = req.query;
    const offset = (page - 1) * limit;
    
    // Check if tables exist
    const productsTableExists = await tableExists('products');
    if (!productsTableExists) {
      return res.status(500).json({ error: 'Products table does not exist' });
    }
    const vendorsTableExists = await tableExists('vendors');
    
    // Check for all optional product columns
    const hasDescription = await tableHasColumn('products', 'description');
    const hasSku = await tableHasColumn('products', 'sku');
    const hasCategory = await tableHasColumn('products', 'category');
    const hasMrp = await tableHasColumn('products', 'mrp');
    const hasCostPrice = await tableHasColumn('products', 'cost_price');
    const hasImageUrl = await tableHasColumn('products', 'image_url');
    const hasUnit = await tableHasColumn('products', 'unit');
    const hasWeight = await tableHasColumn('products', 'weight');
    const hasDimensions = await tableHasColumn('products', 'dimensions');
    const hasBarcode = await tableHasColumn('products', 'barcode');
    const hasGstSlab = await tableHasColumn('products', 'gst_slab');
    const hasHsnCode = await tableHasColumn('products', 'hsn_code');
    const hasProductImagesCol = await tableHasColumn('products', 'product_images');
    const hasProductIdCol = await tableHasColumn('products', 'product_id');
    const hasProductVendorId = await tableHasColumn('products', 'vendor_id');
    const hasProductStatus = await tableHasColumn('products', 'status');
    
    // Check if inventory table exists
    const inventoryTableExists = await tableExists('inventory');
    
    // Check which inventory columns exist
    let hasStockOnHand = false, hasStockReserved = false, hasStockAvailable = false, hasMinStockLevel = false, hasReorderPoint = false;
    if (inventoryTableExists) {
      hasStockOnHand = await tableHasColumn('inventory', 'stock_on_hand');
      hasStockReserved = await tableHasColumn('inventory', 'stock_reserved');
      hasStockAvailable = await tableHasColumn('inventory', 'stock_available');
      hasMinStockLevel = await tableHasColumn('inventory', 'min_stock_level');
      hasReorderPoint = await tableHasColumn('inventory', 'reorder_point');
    }
    
    // Check which vendor columns exist
    let hasShopName = false, hasBusinessName = false, hasVendorId = false, hasOwnerName = false;
    if (vendorsTableExists) {
      hasShopName = await tableHasColumn('vendors', 'shop_name');
      hasBusinessName = await tableHasColumn('vendors', 'business_name');
      hasVendorId = await tableHasColumn('vendors', 'vendor_id');
      hasOwnerName = await tableHasColumn('vendors', 'owner_name');
    }
    
    // Build vendor name selection based on available columns
    let vendorNameSelect = '';
    if (vendorsTableExists && hasOwnerName) {
      if (hasShopName) {
        vendorNameSelect = 'COALESCE(v.shop_name, v.business_name, v.owner_name) as vendor_name';
      } else if (hasBusinessName) {
        vendorNameSelect = 'COALESCE(v.business_name, v.owner_name) as vendor_name';
      } else {
        vendorNameSelect = 'v.owner_name as vendor_name';
      }
    } else {
      vendorNameSelect = 'NULL as vendor_name';
    }
    
    // Build vendor code selection
    const vendorCodeSelect = (vendorsTableExists && hasVendorId) ? 'v.vendor_id as vendor_code' : 'NULL as vendor_code';
    
    // Build owner name selection
    const ownerNameSelect = (vendorsTableExists && hasOwnerName) ? 'v.owner_name' : 'NULL as owner_name';
    
    // Build product columns selection dynamically
    const productCols = ['p.id', 'p.name', 'p.price', 'p.created_at', 'p.updated_at'];
    if (hasDescription) productCols.push('p.description');
    if (hasSku) productCols.push('p.sku');
    if (hasCategory) productCols.push('p.category');
    if (hasProductVendorId) productCols.push('p.vendor_id');
    if (hasProductStatus) productCols.push('p.status');
    if (hasMrp) productCols.push('p.mrp');
    if (hasCostPrice) productCols.push('p.cost_price');
    if (hasImageUrl) productCols.push('p.image_url');
    if (hasUnit) productCols.push('p.unit');
    if (hasWeight) productCols.push('p.weight');
    if (hasDimensions) productCols.push('p.dimensions');
    if (hasBarcode) productCols.push('p.barcode');
    if (hasGstSlab) productCols.push('p.gst_slab');
    if (hasHsnCode) productCols.push('p.hsn_code');
    if (hasProductImagesCol) productCols.push('p.product_images');
    if (hasProductIdCol) {
      productCols.push('p.product_id');
    } else {
      productCols.push('p.id as product_id');
    }
    
    // Build inventory columns selection
    let inventorySelectParts = [];
    if (inventoryTableExists) {
      if (hasStockOnHand) {
        inventorySelectParts.push('COALESCE(i.stock_on_hand, 0) as stock_on_hand');
      } else {
        inventorySelectParts.push('0 as stock_on_hand');
      }
      if (hasStockReserved) {
        inventorySelectParts.push('COALESCE(i.stock_reserved, 0) as stock_reserved');
      } else {
        inventorySelectParts.push('0 as stock_reserved');
      }
      if (hasStockAvailable) {
        inventorySelectParts.push('COALESCE(i.stock_available, 0) as stock_available');
      } else if (hasStockOnHand && hasStockReserved) {
        inventorySelectParts.push('GREATEST(COALESCE(i.stock_on_hand, 0) - COALESCE(i.stock_reserved, 0), 0) as stock_available');
      } else {
        inventorySelectParts.push('0 as stock_available');
      }
      if (hasMinStockLevel) {
        inventorySelectParts.push('COALESCE(i.min_stock_level, 0) as min_stock_level');
      } else {
        inventorySelectParts.push('0 as min_stock_level');
      }
      if (hasReorderPoint) {
        inventorySelectParts.push('COALESCE(i.reorder_point, 0) as reorder_point');
      } else {
        inventorySelectParts.push('0 as reorder_point');
      }
    } else {
      inventorySelectParts = ['0 as stock_on_hand', '0 as stock_reserved', '0 as stock_available', '0 as min_stock_level', '0 as reorder_point'];
    }
    const inventorySelect = inventorySelectParts.join(', ');
    
    // Build JOIN clauses
    const inventoryJoin = inventoryTableExists ? 'LEFT JOIN inventory i ON p.id = i.product_id' : '';
    const vendorJoin = (vendorsTableExists && hasProductVendorId) ? 'LEFT JOIN vendors v ON p.vendor_id = v.id' : '';
    const joins = [inventoryJoin, vendorJoin].filter(j => j).join(' ');
    
    // Only include vendor columns if the vendor JOIN is actually happening
    const vendorColumns = vendorJoin ? `${vendorNameSelect}, ${ownerNameSelect}, ${vendorCodeSelect}` : 'NULL as vendor_name, NULL as owner_name, NULL as vendor_code';
    
    let query = `
      SELECT ${productCols.join(', ')},
             ${inventorySelect},
             ${vendorColumns}
      FROM products p
      ${joins}
      WHERE 1=1
    `;
    let params = [];
    
    if (search) {
      const searchConditions = ['p.name LIKE ?'];
      const searchParams = [`%${search}%`];
      
      if (hasSku) {
        searchConditions.push('p.sku LIKE ?');
        searchParams.push(`%${search}%`);
      }
      if (hasDescription) {
        searchConditions.push('p.description LIKE ?');
        searchParams.push(`%${search}%`);
      }
      if (hasProductIdCol) {
        searchConditions.push('p.product_id LIKE ?');
        searchParams.push(`%${search}%`);
      }
      // Only include vendor search conditions if the vendor JOIN is happening
      if (vendorJoin && vendorsTableExists) {
        if (hasOwnerName) {
          searchConditions.push('v.owner_name LIKE ?');
          searchParams.push(`%${search}%`);
        }
        if (hasShopName) {
          searchConditions.push('v.shop_name LIKE ?');
          searchParams.push(`%${search}%`);
        }
        if (hasBusinessName) {
          searchConditions.push('v.business_name LIKE ?');
          searchParams.push(`%${search}%`);
        }
        if (hasVendorId) {
          searchConditions.push('v.vendor_id LIKE ?');
          searchParams.push(`%${search}%`);
        }
      }
      
      query += ` AND (${searchConditions.join(' OR ')})`;
      params.push(...searchParams);
    }
    if (product_id) {
      if (hasProductIdCol) {
        query += ' AND p.product_id = ?';
      } else {
        query += ' AND p.id = ?';
      }
      params.push(product_id);
    }
    
    if (category && category !== 'all' && hasCategory) {
      query += ' AND p.category = ?';
      params.push(category);
    }
    
    if (status && status !== 'all' && hasProductStatus) {
      query += ' AND p.status = ?';
      params.push(status);
    }
    
    if (vendor_id && vendor_id !== 'all' && hasProductVendorId) {
      query += ' AND p.vendor_id = ?';
      params.push(vendor_id);
    }

    if (vendor_code && vendorJoin && vendorsTableExists && hasVendorId) {
      query += ' AND v.vendor_id = ?';
      params.push(vendor_code);
    }

    if (date_from) {
      query += ' AND DATE(p.created_at) >= ?';
      params.push(date_from);
    }

    if (date_to) {
      query += ' AND DATE(p.created_at) <= ?';
      params.push(date_to);
    }
    
    query += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    // Log query for debugging in development
    if (process.env.NODE_ENV === 'development') {
      console.log('Admin products query:', query);
      console.log('Admin products params:', params);
    }
    
    const products = await db.promise().query(query, params);
    
    // Get total count
    const countVendorJoin = (vendorsTableExists && hasProductVendorId) ? 'LEFT JOIN vendors v ON p.vendor_id = v.id' : '';
    let countQuery = `SELECT COUNT(*) as total FROM products p ${countVendorJoin} WHERE 1=1`;
    let countParams = [];
    
    if (search) {
      const searchConditions = ['p.name LIKE ?'];
      const searchParams = [`%${search}%`];
      
      if (hasSku) {
        searchConditions.push('p.sku LIKE ?');
        searchParams.push(`%${search}%`);
      }
      if (hasDescription) {
        searchConditions.push('p.description LIKE ?');
        searchParams.push(`%${search}%`);
      }
      if (hasProductIdCol) {
        searchConditions.push('p.product_id LIKE ?');
        searchParams.push(`%${search}%`);
      }
      // Only include vendor search conditions if the vendor JOIN is happening
      if (countVendorJoin && vendorsTableExists) {
        if (hasOwnerName) {
          searchConditions.push('v.owner_name LIKE ?');
          searchParams.push(`%${search}%`);
        }
        if (hasShopName) {
          searchConditions.push('v.shop_name LIKE ?');
          searchParams.push(`%${search}%`);
        }
        if (hasBusinessName) {
          searchConditions.push('v.business_name LIKE ?');
          searchParams.push(`%${search}%`);
        }
        if (hasVendorId) {
          searchConditions.push('v.vendor_id LIKE ?');
          searchParams.push(`%${search}%`);
        }
      }
      
      countQuery += ` AND (${searchConditions.join(' OR ')})`;
      countParams.push(...searchParams);
    }
    if (product_id) {
      if (hasProductIdCol) {
        countQuery += ' AND p.product_id = ?';
      } else {
        countQuery += ' AND p.id = ?';
      }
      countParams.push(product_id);
    }
    
    if (category && category !== 'all' && hasCategory) {
      countQuery += ' AND p.category = ?';
      countParams.push(category);
    }
    
    if (status && status !== 'all') {
      countQuery += ' AND p.status = ?';
      countParams.push(status);
    }
    
    if (vendor_id && vendor_id !== 'all') {
      countQuery += ' AND p.vendor_id = ?';
      countParams.push(vendor_id);
    }

    if (vendor_code && countVendorJoin && vendorsTableExists && hasVendorId) {
      countQuery += ' AND v.vendor_id = ?';
      countParams.push(vendor_code);
    }

    if (date_from) {
      countQuery += ' AND DATE(p.created_at) >= ?';
      countParams.push(date_from);
    }

    if (date_to) {
      countQuery += ' AND DATE(p.created_at) <= ?';
      countParams.push(date_to);
    }
    
    const countResult = await db.promise().query(countQuery, countParams);
    
    // Parse product_images from JSON strings to arrays
    const parsedProducts = products[0].map(product => {
      if (product.product_images) {
        try {
          if (typeof product.product_images === 'string') {
            product.product_images = JSON.parse(product.product_images);
          }
          // Ensure it's an array
          if (!Array.isArray(product.product_images)) {
            product.product_images = [];
          }
        } catch (e) {
          console.error('Error parsing product_images for product', product.id, e);
          product.product_images = [];
        }
      } else {
        product.product_images = [];
      }
      return product;
    });
    
    res.json({
      products: parsedProducts,
      items: parsedProducts, // Also include items for consistency with other endpoints
      total: countResult[0][0].total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(countResult[0][0].total / limit)
    });
  } catch (error) {
    console.error('Get admin products error:', error);
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('Error sql:', error.sql);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      sqlError: error.sql ? error.sql.substring(0, 200) : undefined,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Create new product for admin (can specify vendor_id)
app.post('/api/admin/products', verifyAdmin, async (req, res) => {
  try {
    const {
      name, description, sku, category, price, mrp, cost_price, image_url, product_images, unit, weight, dimensions, barcode,
      stock_on_hand, min_stock_level, max_stock_level, reorder_point, reorder_quantity, hsn_code, gst_slab, vendor_id
    } = req.body;
    
    if (!vendor_id) {
      return res.status(400).json({ error: 'Vendor ID is required for admin product creation' });
    }
    
    const gstCheck = validateGSTCategory(category, hsn_code);
    if (!gstCheck.ok) {
      return res.status(400).json({ error: gstCheck.message });
    }
    
    // Check if Product already exists in the database
    const existingSku = await db.promise().query(
      'SELECT id FROM products WHERE sku = ?',
      [sku]
    );
    
    if (existingSku[0].length > 0) {
      return res.status(400).json({ error: 'Product already exists in the database' });
    }
    
    // Check if vendor exists
    const vendorCheck = await db.promise().query(
      'SELECT id FROM vendors WHERE id = ?',
      [vendor_id]
    );
    
    if (vendorCheck[0].length === 0) {
      return res.status(400).json({ error: 'Vendor not found' });
    }
    
    const hasMrpCol = await tableHasColumn('products', 'mrp');
    const hasCostPriceCol = await tableHasColumn('products', 'cost_price');
    const hasGstSlabCol = await tableHasColumn('products', 'gst_slab');
    const hasProductImagesCol = await tableHasColumn('products', 'product_images');
    
    // Generate Product ID
    const [productIdResult] = await db.promise().query(`
      SELECT COALESCE(MAX(CAST(SUBSTRING(product_id, 5) AS UNSIGNED)), 0) + 1 as next_num
      FROM products 
      WHERE product_id REGEXP '^PRDT[0-9]+$'
    `);
    const nextNumber = productIdResult[0]?.next_num || 1;
    const productId = `PRDT${nextNumber.toString().padStart(3, '0')}`;
    
    const columns = ['product_id', 'vendor_id', 'name', 'description', 'sku', 'category', 'price', 'image_url', 'unit', 'weight', 'status'];
    const priceValue = price ? Number(price).toFixed(2) : '0.00';
    const values = [productId, vendor_id, name, description, sku, category, priceValue, image_url, unit, weight, 'active'];
    const placeholders = ['?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?'];
    
    // Add cost_price if column exists
    if (hasCostPriceCol) {
      // Insert cost_price after price
      const priceIndex = columns.indexOf('price');
      columns.splice(priceIndex + 1, 0, 'cost_price');
      const costPriceValue = cost_price ? Number(cost_price).toFixed(2) : null;
      values.splice(priceIndex + 1, 0, costPriceValue);
      placeholders.splice(priceIndex + 1, 0, '?');
    }
    
    if (hasMrpCol) {
      columns.push('mrp');
      const mrpValue = mrp ? Number(mrp).toFixed(2) : null;
      values.push(mrpValue);
      placeholders.push('?');
    }
    
    if (hasGstSlabCol) {
      columns.push('gst_slab');
      const slabCheck = deriveGstSlab(category, gst_slab);
      values.push(slabCheck.ok ? slabCheck.value : gst_slab);
      placeholders.push('?');
    }
    
    if (hasProductImagesCol) {
      columns.push('product_images');
      values.push(product_images ? JSON.stringify(product_images) : null);
      placeholders.push('?');
    }
    
    if (hsn_code) {
      columns.push('hsn_code');
      values.push(hsn_code);
      placeholders.push('?');
    }
    
    const result = await db.promise().query(
      `INSERT INTO products (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );
    
    const insertedProductId = result[0].insertId;
    
    // Create inventory record
    await db.promise().query(
      `INSERT INTO inventory (product_id, stock_on_hand, min_stock_level, reorder_point, reorder_quantity)
       VALUES (?, ?, ?, ?, ?)`,
      [insertedProductId, stock_on_hand || 0, min_stock_level || 0, reorder_point || 0, reorder_quantity || 0]
    );
    
    res.status(201).json({ message: 'Product created successfully', productId: productId, insertedId: insertedProductId });
  } catch (error) {
    console.error('Create admin product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update product for admin
app.put('/api/admin/products/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, description, sku, category, price, mrp, cost_price, image_url, product_images, unit, weight,
      stock_on_hand, stock_reserved, min_stock_level, reorder_point, reorder_quantity, hsn_code, gst_slab,
      status
    } = req.body;
    
    // Check if product exists
    const productCheck = await db.promise().query(
      'SELECT id FROM products WHERE id = ?',
      [id]
    );
    
    if (productCheck[0].length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Check if Product already exists in the database (excluding current product)
    const existingSku = await db.promise().query(
      'SELECT id FROM products WHERE sku = ? AND id != ?',
      [sku, id]
    );
    
    if (existingSku[0].length > 0) {
      return res.status(400).json({ error: 'Product already exists in the database' });
    }
    
    const gstCheck = validateGSTCategory(category, hsn_code);
    if (!gstCheck.ok) {
      return res.status(400).json({ error: gstCheck.message });
    }
    
    const hasMrpCol = await tableHasColumn('products', 'mrp');
    const hasCostPriceCol = await tableHasColumn('products', 'cost_price');
    const hasGstSlabCol = await tableHasColumn('products', 'gst_slab');
    const hasProductImagesCol = await tableHasColumn('products', 'product_images');
    
    const sets = [];
    const values = [];

    // Only update provided fields to support partial updates (e.g., status-only)
    if (name !== undefined) { sets.push('name = ?'); values.push(name); }
    if (description !== undefined) { sets.push('description = ?'); values.push(description); }
    if (sku !== undefined) { sets.push('sku = ?'); values.push(sku); }
    if (category !== undefined) { sets.push('category = ?'); values.push(category); }
    if (price !== undefined) { 
      sets.push('price = ?'); 
      values.push(price ? Number(price).toFixed(2) : '0.00'); 
    }
    if (hasCostPriceCol && cost_price !== undefined) { 
      sets.push('cost_price = ?'); 
      values.push(cost_price ? Number(cost_price).toFixed(2) : null); 
    }
    if (image_url !== undefined) { sets.push('image_url = ?'); values.push(image_url); }
    if (unit !== undefined) { sets.push('unit = ?'); values.push(unit); }
    if (weight !== undefined) { sets.push('weight = ?'); values.push(weight); }
    
    if (hasMrpCol && mrp !== undefined) {
      sets.push('mrp = ?');
      values.push(mrp ? Number(mrp).toFixed(2) : null);
    }
    
    if (hasGstSlabCol && (gst_slab !== undefined || category !== undefined)) {
      sets.push('gst_slab = ?');
      const slabCheck = deriveGstSlab(category, gst_slab);
      values.push(slabCheck.ok ? slabCheck.value : gst_slab);
    }
    
    if (hasProductImagesCol && product_images !== undefined) {
      sets.push('product_images = ?');
      values.push(product_images ? (Array.isArray(product_images) ? JSON.stringify(product_images) : product_images) : null);
    }
    
    if (hsn_code !== undefined) {
      sets.push('hsn_code = ?');
      values.push(hsn_code);
    }

    if (status !== undefined) {
      // Normalize status to lowercase values expected by DB if necessary
      const normalized = String(status).toLowerCase();
      // Accept common variants
      const allowed = ['active', 'inactive', 'discontinued'];
      sets.push('status = ?');
      values.push(allowed.includes(normalized) ? normalized : status);
    }
    
    values.push(id);
    
    if (sets.length > 0) {
      await db.promise().query(
        `UPDATE products SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`,
        values
      );
    }
    
    // Update inventory
    if ([min_stock_level, reorder_point, reorder_quantity].some(v => v !== undefined)) {
      await db.promise().query(
        `UPDATE inventory SET 
           min_stock_level = COALESCE(?, min_stock_level),
           reorder_point = COALESCE(?, reorder_point),
           reorder_quantity = COALESCE(?, reorder_quantity),
           updated_at = NOW()
         WHERE product_id = ?`,
        [min_stock_level, reorder_point, reorder_quantity, id]
      );
    }
    
    // Update stock if provided
    if (stock_on_hand !== undefined || stock_reserved !== undefined) {
      if (stock_on_hand !== undefined && Number(stock_on_hand) < 0) {
        return res.status(400).json({ error: 'stock_on_hand cannot be negative' });
      }
      if (stock_reserved !== undefined && Number(stock_reserved) < 0) {
        return res.status(400).json({ error: 'stock_reserved cannot be negative' });
      }
      const currentStock = await db.promise().query(
        'SELECT stock_on_hand, stock_reserved FROM inventory WHERE product_id = ?',
        [id]
      );
      if (currentStock[0].length > 0) {
        const prevOnHand = Number(currentStock[0][0].stock_on_hand || 0);
        const prevReserved = Number(currentStock[0][0].stock_reserved || 0);
        const nextOnHand = stock_on_hand !== undefined ? Number(stock_on_hand) : prevOnHand;
        const nextReserved = stock_reserved !== undefined ? Number(stock_reserved) : prevReserved;
        if (nextOnHand - nextReserved < 0) {
          return res.status(400).json({ error: 'stock_reserved cannot exceed stock_on_hand' });
        }
        await db.promise().query(
          'UPDATE inventory SET stock_on_hand = ?, stock_reserved = ?, updated_at = NOW() WHERE product_id = ?',
          [nextOnHand, nextReserved, id]
        );

        // Record stock movements for audit trail
        const onHandDiff = nextOnHand - prevOnHand;
        if (onHandDiff !== 0) {
          await db.promise().query(
            'INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)',
            [id, onHandDiff > 0 ? 'in' : 'out', Math.abs(onHandDiff), 'admin_update', 'Admin updated stock_on_hand', 0]
          );
        }
        const reservedDiff = nextReserved - prevReserved;
        if (reservedDiff !== 0) {
          await db.promise().query(
            'INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)',
            [id, 'reserved', Math.abs(reservedDiff), 'admin_update', 'Admin updated stock_reserved', 0]
          );
        }
      }
    }
    
    res.json({ message: 'Product updated successfully' });
  } catch (error) {
    console.error('Update admin product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete product for admin
app.delete('/api/admin/products/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if product exists
    const productCheck = await db.promise().query(
      'SELECT id FROM products WHERE id = ?',
      [id]
    );
    
    if (productCheck[0].length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Delete product (cascade will handle inventory and stock_movements)
    await db.promise().query(
      'DELETE FROM products WHERE id = ?',
      [id]
    );
    
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Delete admin product error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PRICE CONTROL MODULE API ROUTES

// Update individual product price
app.put('/api/admin/products/:id/price', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { new_price, reason, min_price, max_price } = req.body;

    if (!new_price || isNaN(new_price) || new_price <= 0) {
      return res.status(400).json({ error: 'Valid price is required' });
    }

    // Get current product details
    const [productRows] = await db.promise().query(
      'SELECT p.*, v.shop_name, v.owner_email FROM products p LEFT JOIN vendors v ON p.vendor_id = v.id WHERE p.id = ?',
      [id]
    );

    if (productRows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = productRows[0];
    const oldPrice = product.price;

    // Validate price against thresholds
    if (min_price && new_price < min_price) {
      return res.status(400).json({ error: `Price cannot be below minimum threshold of ₹${min_price}` });
    }
    if (max_price && new_price > max_price) {
      return res.status(400).json({ error: `Price cannot exceed maximum threshold of ₹${max_price}` });
    }

    // Update product price
    await db.promise().query(
      'UPDATE products SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [new_price, id]
    );

    // Log price change in history
    await db.promise().query(
      'INSERT INTO price_history (product_id, old_price, new_price, reason, changed_by, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [id, oldPrice, new_price, reason || 'Admin price update', 'admin']
    );

    // Send notification to vendor
    if (product.owner_email) {
      const subject = `Price Update: ${product.name}`;
      const body = `
        Hello ${product.shop_name || 'Vendor'},
        
        The price for your product "${product.name}" has been updated:
        
        Old Price: ₹${oldPrice}
        New Price: ₹${new_price}
        Reason: ${reason || 'Admin price update'}
        
        This change is effective immediately.
        
        Best regards,
        Admin Team
      `;
      await sendEmail(product.owner_email, subject, body);
    }

    res.json({ 
      message: 'Price updated successfully',
      old_price: oldPrice,
      new_price: new_price,
      vendor_notified: !!product.owner_email
    });
  } catch (error) {
    console.error('Update product price error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk price updates
app.put('/api/admin/products/bulk-price-update', verifyAdmin, async (req, res) => {
  try {
    const { 
      product_ids, 
      update_type, 
      value, 
      reason, 
      filters = {},
      min_price,
      max_price 
    } = req.body;

    if (!update_type || !value || isNaN(value)) {
      return res.status(400).json({ error: 'Valid update type and value required' });
    }

    let whereClause = 'WHERE 1=1';
    let params = [];

    // Apply filters
    if (filters.vendor_id) {
      whereClause += ' AND p.vendor_id = ?';
      params.push(filters.vendor_id);
    }
    if (filters.category) {
      whereClause += ' AND p.category = ?';
      params.push(filters.category);
    }
    if (filters.status) {
      whereClause += ' AND p.status = ?';
      params.push(filters.status);
    }
    if (product_ids && product_ids.length > 0) {
      whereClause += ' AND p.id IN (' + product_ids.map(() => '?').join(',') + ')';
      params.push(...product_ids);
    }

    // Get products to update
    const [products] = await db.promise().query(
      `SELECT p.*, v.shop_name, v.owner_email FROM products p 
       LEFT JOIN vendors v ON p.vendor_id = v.id 
       ${whereClause}`,
      params
    );

    if (products.length === 0) {
      return res.status(404).json({ error: 'No products found matching criteria' });
    }

    const updates = [];
    const notifications = [];

    for (const product of products) {
      let newPrice = product.price;

      // Calculate new price based on update type
      switch (update_type) {
        case 'percentage_increase':
          newPrice = product.price * (1 + value / 100);
          break;
        case 'percentage_decrease':
          newPrice = product.price * (1 - value / 100);
          break;
        case 'fixed_increase':
          newPrice = product.price + value;
          break;
        case 'fixed_decrease':
          newPrice = product.price - value;
          break;
        case 'set_price':
          newPrice = value;
          break;
        default:
          return res.status(400).json({ error: 'Invalid update type' });
      }

      // Validate price thresholds
      if (min_price && newPrice < min_price) {
        updates.push({
          product_id: product.id,
          success: false,
          error: `Price would be below minimum threshold of ₹${min_price}`
        });
        continue;
      }
      if (max_price && newPrice > max_price) {
        updates.push({
          product_id: product.id,
          success: false,
          error: `Price would exceed maximum threshold of ₹${max_price}`
        });
        continue;
      }

      // Update product price
      await db.promise().query(
        'UPDATE products SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [newPrice, product.id]
      );

      // Log price change
      await db.promise().query(
        'INSERT INTO price_history (product_id, old_price, new_price, reason, changed_by, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [product.id, product.price, newPrice, reason || `Bulk ${update_type}`, 'admin']
      );

      updates.push({
        product_id: product.id,
        product_name: product.name,
        old_price: product.price,
        new_price: newPrice,
        success: true
      });

      // Collect vendor notification data
      if (product.owner_email) {
        notifications.push({
          email: product.owner_email,
          shop_name: product.shop_name,
          product_name: product.name,
          old_price: product.price,
          new_price: newPrice
        });
      }
    }

    // Send notifications to vendors
    for (const notification of notifications) {
      const subject = `Bulk Price Update: ${notification.product_name}`;
      const body = `
        Hello ${notification.shop_name || 'Vendor'},
        
        The price for your product "${notification.product_name}" has been updated as part of a bulk price update:
        
        Old Price: ₹${notification.old_price}
        New Price: ₹${notification.new_price}
        Reason: ${reason || 'Bulk price update'}
        
        This change is effective immediately.
        
        Best regards,
        Admin Team
      `;
      await sendEmail(notification.email, subject, body);
    }

    res.json({
      message: 'Bulk price update completed',
      total_products: products.length,
      successful_updates: updates.filter(u => u.success).length,
      failed_updates: updates.filter(u => !u.success).length,
      updates: updates,
      vendors_notified: notifications.length
    });
  } catch (error) {
    console.error('Bulk price update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get price history for a product
app.get('/api/admin/products/:id/price-history', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    // Get price history
    const [history] = await db.promise().query(
      `SELECT ph.*, p.name as product_name, p.sku 
       FROM price_history ph 
       LEFT JOIN products p ON ph.product_id = p.id 
       WHERE ph.product_id = ? 
       ORDER BY ph.created_at DESC 
       LIMIT ? OFFSET ?`,
      [id, parseInt(limit), parseInt(offset)]
    );

    // Get total count
    const [countResult] = await db.promise().query(
      'SELECT COUNT(*) as total FROM price_history WHERE product_id = ?',
      [id]
    );

    res.json({
      history: history,
      total: countResult[0].total,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Get price history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all price history (admin view)
app.get('/api/admin/price-history', verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, product_id, vendor_id, date_from, date_to } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    let params = [];

    if (product_id) {
      whereClause += ' AND ph.product_id = ?';
      params.push(product_id);
    }
    if (vendor_id) {
      whereClause += ' AND p.vendor_id = ?';
      params.push(vendor_id);
    }
    if (date_from) {
      whereClause += ' AND ph.created_at >= ?';
      params.push(date_from);
    }
    if (date_to) {
      whereClause += ' AND ph.created_at <= ?';
      params.push(date_to);
    }

    const [history] = await db.promise().query(
      `SELECT ph.*, p.name as product_name, p.sku, p.vendor_id, v.shop_name as vendor_name
       FROM price_history ph 
       LEFT JOIN products p ON ph.product_id = p.id 
       LEFT JOIN vendors v ON p.vendor_id = v.id 
       ${whereClause}
       ORDER BY ph.created_at DESC 
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const [countResult] = await db.promise().query(
      `SELECT COUNT(*) as total FROM price_history ph 
       LEFT JOIN products p ON ph.product_id = p.id 
       ${whereClause}`,
      params
    );

    res.json({
      history: history,
      total: countResult[0].total,
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Get all price history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle/Set product status for admin
app.put('/api/admin/products/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ['active', 'inactive', 'discontinued'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Ensure product exists
    const [rows] = await db.promise().query('SELECT id FROM products WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    await db.promise().query('UPDATE products SET status = ? WHERE id = ?', [status, id]);
    res.json({ message: 'Status updated', id, status });
  } catch (error) {
    console.error('Admin set product status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk update product status for admin
app.put('/api/admin/products/bulk-status', verifyAdmin, async (req, res) => {
  try {
    const { productIds = [], status } = req.body || {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'productIds required' });
    }
    const allowed = ['active', 'inactive', 'discontinued'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const [result] = await db.promise().query(
      `UPDATE products SET status = ? WHERE id IN (${productIds.map(() => '?').join(',')})`,
      [status, ...productIds]
    );

    res.json({ message: 'Bulk status updated', affectedRows: result.affectedRows });
  } catch (error) {
    console.error('Admin bulk product status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk delete products for admin
app.delete('/api/admin/products/bulk-delete', verifyAdmin, async (req, res) => {
  try {
    const { productIds = [] } = req.body || {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'productIds required' });
    }

    const [result] = await db.promise().query(
      `DELETE FROM products WHERE id IN (${productIds.map(() => '?').join(',')})`,
      productIds
    );

    res.json({ message: 'Bulk delete completed', affectedRows: result.affectedRows });
  } catch (error) {
    console.error('Admin bulk product delete error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Seed basic products for admin (can specify vendor_id)
app.post('/api/admin/products/seed-basic', verifyAdmin, async (req, res) => {
  try {
    const { vendor_id } = req.body;
    
    if (!vendor_id) {
      return res.status(400).json({ error: 'Vendor ID is required' });
    }
    
    // Check if vendor exists
    const vendorCheck = await db.promise().query(
      'SELECT id FROM vendors WHERE id = ?',
      [vendor_id]
    );
    
    if (vendorCheck[0].length === 0) {
      return res.status(400).json({ error: 'Vendor not found' });
    }
    
    const samples = [
      { name: 'Amul Taaza Milk 1L', sku: `MILK-1L-${Date.now()}`.slice(0, 20), category: 'Dairy', mrp: 68.00, price: 65.00, stock: 40, unit: 'l', hsn: '0401' },
      { name: 'Brown Bread 400g', sku: `BREAD-400-${Date.now()}`.slice(0, 20), category: 'Bakery', mrp: 45.00, price: 42.00, stock: 30, unit: 'pack', hsn: '1905' },
      { name: 'Basmati Rice 5kg', sku: `RICE-5KG-${Date.now()}`.slice(0, 20), category: 'Pantry', mrp: 520.00, price: 499.00, stock: 25, unit: 'kg', hsn: '1006' },
      { name: 'Banana (Dozen)', sku: `BANANA-${Date.now()}`.slice(0, 20), category: 'Fresh Produce', mrp: 60.00, price: 55.00, stock: 50, unit: 'piece', hsn: '0803' },
      { name: 'Cola Drink 1.25L', sku: `COLA-1250-${Date.now()}`.slice(0, 20), category: 'Food & Beverages', mrp: 75.00, price: 70.00, stock: 35, unit: 'l', hsn: '2202' }
    ];
    let created = 0;
    for (const s of samples) {
      const slab = deriveGstSlab(s.category).value;
      const [ins] = await db.promise().query(
        `INSERT INTO products (vendor_id, name, description, sku, category, price, mrp, cost_price, unit, barcode, gst_slab, status, hsn_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 'active', ?)`,
        [vendor_id, s.name, null, s.sku, s.category, s.price, s.mrp, s.unit, slab, s.hsn]
      );
      const pid = ins.insertId;
      await db.promise().query(
        `INSERT INTO inventory (product_id, stock_on_hand, min_stock_level, max_stock_level, reorder_point, reorder_quantity)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [pid, s.stock, 5, null, 10, 20]
      );
      created++;
    }
    res.json({ message: 'Sample products created', created });
  } catch (e) {
    console.error('Seed admin products error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// CSV Upload for admin
app.post('/api/admin/products/upload-csv', verifyAdmin, upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    const csvData = fs.readFileSync(req.file.path, 'utf8');
    const lines = csvData.split('\n').filter(line => line.trim());
    
    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV file must have at least a header and one data row' });
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const requiredHeaders = ['name', 'sku', 'category', 'price'];
    
    for (const required of requiredHeaders) {
      if (!headers.includes(required)) {
        return res.status(400).json({ error: `Missing required column: ${required}` });
      }
    }

    let successfulRows = 0;
    let failedRows = 0;
    const errors = [];

    for (let i = 1; i < lines.length; i++) {
      try {
        const csvValues = lines[i].split(',').map(v => v.trim());
        const row = {};
        
        headers.forEach((header, index) => {
          row[header] = csvValues[index] || '';
        });

        // Validate required fields
        if (!row.name || !row.sku || !row.category || !row.price) {
          errors.push(`Row ${i + 1}: Missing required fields`);
          failedRows++;
          continue;
        }

        // Check if Product already exists in the database
        const existingSku = await db.promise().query(
          'SELECT id FROM products WHERE sku = ?',
          [row.sku]
        );

        if (existingSku[0].length > 0) {
          errors.push(`Row ${i + 1}: SKU ${row.sku} already exists`);
          failedRows++;
          continue;
        }

        // For admin, we need a vendor_id - use first available vendor for now
        const vendors = await db.promise().query('SELECT id FROM vendors LIMIT 1');
        if (vendors[0].length === 0) {
          errors.push(`Row ${i + 1}: No vendors available`);
          failedRows++;
          continue;
        }
        const vendorId = vendors[0][0].id;

        const hasMrpCol = await tableHasColumn('products', 'mrp');
        const hasGstSlabCol = await tableHasColumn('products', 'gst_slab');

        const columns = ['vendor_id', 'name', 'description', 'sku', 'category', 'price', 'image_url', 'unit', 'weight', 'dimensions', 'barcode', 'status'];
        const values = [vendorId, row.name, row.description || '', row.sku, row.category, parseFloat(row.price), row.image_url || '', row.unit || 'piece', row.weight || '', row.dimensions || '', row.barcode || '', 'active'];
        const placeholders = ['?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?', '?'];

        if (hasMrpCol) {
          columns.push('mrp');
          values.push(row.mrp ? parseFloat(row.mrp) : null);
          placeholders.push('?');
        }

        if (hasGstSlabCol) {
          columns.push('gst_slab');
          values.push(row.gst_slab || deriveGstSlab(row.category).value);
          placeholders.push('?');
        }

        if (row.hsn_code) {
          columns.push('hsn_code');
          values.push(row.hsn_code);
          placeholders.push('?');
        }

        const result = await db.promise().query(
          `INSERT INTO products (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
          values
        );

        const productId = result[0].insertId;

        // Create inventory record
        await db.promise().query(
          `INSERT INTO inventory (product_id, stock_on_hand, min_stock_level, max_stock_level, reorder_point, reorder_quantity)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [productId, parseInt(row.stock_on_hand) || 0, parseInt(row.min_stock_level) || 0, row.max_stock_level ? parseInt(row.max_stock_level) : null, parseInt(row.reorder_point) || 0, parseInt(row.reorder_quantity) || 0]
        );

        successfulRows++;
      } catch (error) {
        errors.push(`Row ${i + 1}: ${error.message}`);
        failedRows++;
      }
    }

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.json({
      message: 'CSV upload completed',
      totalRows: lines.length - 1,
      successfulRows,
      failedRows,
      errors: errors.slice(0, 10) // Limit errors to first 10
    });
  } catch (error) {
    console.error('CSV upload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ADMIN INVENTORY MANAGEMENT ROUTES

// Admin: list stock movements for a product (all vendors)
app.get('/api/admin/inventory/movements', verifyAdmin, async (req, res) => {
  try {
    const { product_id, page = 1, limit = 20 } = req.query;
    if (!product_id) {
      return res.status(400).json({ error: 'product_id is required' });
    }
    const offset = (page - 1) * limit;

    const [rows] = await db.promise().query(
      `SELECT sm.id, sm.product_id, sm.movement_type, sm.quantity, sm.reference_type, sm.reference_id, sm.notes, sm.created_by, sm.created_at,
              p.name AS product_name, p.sku, v.id AS vendor_id, v.shop_name AS vendor_name
       FROM stock_movements sm
       JOIN products p ON sm.product_id = p.id
       LEFT JOIN vendors v ON p.vendor_id = v.id
       WHERE sm.product_id = ?
       ORDER BY sm.created_at DESC
       LIMIT ? OFFSET ?`,
      [product_id, parseInt(limit), parseInt(offset)]
    );

    // total count
    const [[countRow]] = await db.promise().query(
      'SELECT COUNT(*) AS total FROM stock_movements WHERE product_id = ?',
      [product_id]
    );

    res.json({ movements: rows, total: countRow.total, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    console.error('Admin get stock movements error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: adjust stock for a product (records movement)
app.post('/api/admin/inventory/:id/adjust', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, movement_type, notes } = req.body;

    if (!['in', 'out', 'adjustment'].includes(movement_type)) {
      return res.status(400).json({ error: 'Invalid movement type' });
    }

    const [[product]] = await db.promise().query(
      'SELECT id FROM products WHERE id = ?',
      [id]
    );
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const [[inv]] = await db.promise().query(
      'SELECT stock_on_hand FROM inventory WHERE product_id = ?',
      [id]
    );
    const currentStockValue = inv ? inv.stock_on_hand || 0 : 0;
    let newStockValue;
    const qty = parseInt(quantity);

    if (Number.isNaN(qty)) {
      return res.status(400).json({ error: 'quantity must be a number' });
    }

    if (movement_type === 'in') {
      newStockValue = currentStockValue + qty;
    } else if (movement_type === 'out') {
      newStockValue = currentStockValue - qty;
      if (newStockValue < 0) {
        return res.status(400).json({ error: 'Insufficient stock' });
      }
    } else { // adjustment -> set absolute value
      if (qty < 0) {
        return res.status(400).json({ error: 'Adjusted stock cannot be negative' });
      }
      newStockValue = qty;
    }

    await db.promise().query(
      'UPDATE inventory SET stock_on_hand = ?, updated_at = NOW() WHERE product_id = ?',
      [newStockValue, id]
    );

    await db.promise().query(
      'INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [id, movement_type, Math.abs(qty), 'admin_adjustment', notes || null, 0]
    );

    res.json({ message: 'Stock adjusted successfully', newStock: newStockValue });
  } catch (error) {
    console.error('Admin adjust stock error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: export movements CSV
app.get('/api/admin/inventory/movements/export', verifyAdmin, async (req, res) => {
  try {
    const { product_id } = req.query;
    if (!product_id) {
      return res.status(400).json({ error: 'product_id is required' });
    }

    const [rows] = await db.promise().query(
      `SELECT sm.id, sm.product_id, sm.movement_type, sm.quantity, sm.reference_type, sm.reference_id, sm.notes, sm.created_by, sm.created_at,
              p.name AS product_name, p.sku, v.id AS vendor_id, v.shop_name AS vendor_name
       FROM stock_movements sm
       JOIN products p ON sm.product_id = p.id
       LEFT JOIN vendors v ON p.vendor_id = v.id
       WHERE sm.product_id = ?
       ORDER BY sm.created_at DESC`,
      [product_id]
    );

    const headers = ['id','product_id','product_name','sku','vendor_id','vendor_name','movement_type','quantity','reference_type','reference_id','notes','created_by','created_at'];
    const csvRows = [headers.join(',')].concat(rows.map(r => headers.map(h => {
      const val = r[h] == null ? '' : String(r[h]);
      const escaped = val.replace(/"/g, '""');
      return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
    }).join(',')));
    const csv = csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="stock_movements.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Admin export movements error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// INVENTORY MANAGEMENT ROUTES

// Get inventory summary
app.get('/api/inventory', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', status = '' } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT p.id, p.name, p.sku, p.category, p.price, p.status,
             i.stock_on_hand, i.stock_reserved, i.stock_available, i.min_stock_level, i.reorder_point,
             CASE 
               WHEN i.stock_available <= 0 THEN 'Out of Stock'
               WHEN i.stock_available <= i.min_stock_level THEN 'Low Stock'
               WHEN i.stock_available <= i.reorder_point THEN 'Reorder Point'
               ELSE 'In Stock'
             END as stock_status
      FROM products p
      LEFT JOIN inventory i ON p.id = i.product_id
      WHERE p.vendor_id = ?
    `;
    let params = [req.vendorId];
    
    if (search) {
      query += ' AND (p.name LIKE ? OR p.sku LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    if (status) {
      query += ' AND (CASE WHEN i.stock_available <= 0 THEN "Out of Stock" WHEN i.stock_available <= i.min_stock_level THEN "Low Stock" WHEN i.stock_available <= i.reorder_point THEN "Reorder Point" ELSE "In Stock" END) = ?';
      params.push(status);
    }
    
    query += ' ORDER BY i.stock_available ASC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const inventory = await db.promise().query(query, params);
    
    res.json(inventory[0]);
  } catch (error) {
    console.error('Get inventory error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Adjust stock levels
app.post('/api/inventory/:id/adjust', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, movement_type, notes } = req.body;
    
    // Validate movement type
    if (!['in', 'out', 'adjustment'].includes(movement_type)) {
      return res.status(400).json({ error: 'Invalid movement type' });
    }
    
    // Check if product exists and belongs to vendor
    const product = await db.promise().query(
      'SELECT id FROM products WHERE id = ? AND vendor_id = ?',
      [id, req.vendorId]
    );
    
    if (product[0].length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Get current stock
    const currentStock = await db.promise().query(
      'SELECT stock_on_hand FROM inventory WHERE product_id = ?',
      [id]
    );
    
    const currentStockValue = currentStock[0][0]?.stock_on_hand || 0;
    let newStockValue;
    
    if (movement_type === 'in') {
      newStockValue = currentStockValue + parseInt(quantity);
    } else if (movement_type === 'out') {
      newStockValue = currentStockValue - parseInt(quantity);
      if (newStockValue < 0) {
        return res.status(400).json({ error: 'Insufficient stock' });
      }
    } else {
      newStockValue = parseInt(quantity);
    }
    
    // Update inventory
    await db.promise().query(
      'UPDATE inventory SET stock_on_hand = ?, updated_at = NOW() WHERE product_id = ?',
      [newStockValue, id]
    );
    
    // Record stock movement
    await db.promise().query(
      'INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [id, movement_type, Math.abs(parseInt(quantity)), 'adjustment', notes, req.vendorId]
    );
    
    res.json({ message: 'Stock adjusted successfully', newStock: newStockValue });
  } catch (error) {
    console.error('Adjust stock error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get stock movements
app.get('/api/inventory/:id/movements', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    // Check if product exists and belongs to vendor
    const product = await db.promise().query(
      'SELECT id FROM products WHERE id = ? AND vendor_id = ?',
      [id, req.vendorId]
    );
    
    if (product[0].length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    const movements = await db.promise().query(
      `SELECT sm.*, p.name as product_name, p.sku
       FROM stock_movements sm
       JOIN products p ON sm.product_id = p.id
       WHERE sm.product_id = ?
       ORDER BY sm.created_at DESC
       LIMIT ? OFFSET ?`,
      [id, parseInt(limit), parseInt(offset)]
    );
    
    res.json(movements[0]);
  } catch (error) {
    console.error('Get stock movements error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// STOCK ALERTS ROUTES

// Get stock alerts
app.get('/api/alerts', verifyToken, async (req, res) => {
  try {
    const { resolved = false } = req.query;
    
    const alerts = await db.promise().query(
      `SELECT sa.*, p.name as product_name, p.sku, p.category
       FROM stock_alerts sa
       JOIN products p ON sa.product_id = p.id
       WHERE p.vendor_id = ? AND sa.is_resolved = ?
       ORDER BY sa.created_at DESC`,
      [req.vendorId, resolved === 'true']
    );
    
    res.json(alerts[0]);
  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PRICING MANAGEMENT ROUTES

// Enhanced price calculation function
const calculateFinalPrice = async (productId, basePrice, customerId = null, sessionId = null, locationData = null) => {
  try {
    // Handle null/undefined basePrice
    if (basePrice === null || basePrice === undefined || basePrice === '') {
      console.warn('Base price is null/undefined, skipping price calculation');
      return {
        finalPrice: 0,
        appliedRules: [],
        calculationDetails: { basePrice: 0, finalPrice: 0, adjustments: [] }
      };
    }
    
    let finalPrice = parseFloat(basePrice);
    
    // Check for NaN after parsing
    if (isNaN(finalPrice)) {
      console.warn('Base price is NaN, skipping price calculation');
      return {
        finalPrice: 0,
        appliedRules: [],
        calculationDetails: { basePrice: 0, finalPrice: 0, adjustments: [] }
      };
    }
    
    const appliedRules = [];
    const calculationDetails = {
      basePrice: finalPrice,
      adjustments: []
    };

    // Get active pricing rules (existing system)
    const [[pricingRule]] = await db.promise().query(
      `SELECT * FROM pricing_rules WHERE is_active = 1 AND (
          scope = 'product' AND product_id = ?
        ) OR (
          scope = 'category' AND category = (SELECT category FROM products WHERE id = ?)
        ) OR (
          scope = 'global'
        ) ORDER BY 
          CASE scope WHEN 'product' THEN 1 WHEN 'category' THEN 2 ELSE 3 END ASC,
          updated_at DESC LIMIT 1`,
      [productId, productId]
    );

    // Apply basic pricing rules
    if (pricingRule) {
      if (!isNaN(pricingRule.surge_percentage)) {
        const surgeAmount = finalPrice * (Number(pricingRule.surge_percentage) / 100);
        finalPrice += surgeAmount;
        appliedRules.push('surge');
        calculationDetails.adjustments.push({
          type: 'surge',
          percentage: pricingRule.surge_percentage,
          amount: surgeAmount
        });
      }
      
      if (!isNaN(pricingRule.promo_percentage)) {
        const promoAmount = finalPrice * (Number(pricingRule.promo_percentage) / 100);
        finalPrice -= promoAmount;
        appliedRules.push('promo');
        calculationDetails.adjustments.push({
          type: 'promo',
          percentage: pricingRule.promo_percentage,
          amount: -promoAmount
        });
      }
    }

    // Apply dynamic pricing rules based on consumer behavior
    if (customerId || sessionId) {
      // Get customer segment
      let segmentId = null;
      if (customerId) {
        const [[segment]] = await db.promise().query(
          `SELECT id FROM consumer_segments WHERE is_active = 1 ORDER BY priority DESC LIMIT 1`
        );
        if (segment) segmentId = segment.id;
      }

      // Get applicable dynamic pricing rules
      const [dynamicRules] = await db.promise().query(
        `SELECT * FROM dynamic_pricing_rules 
         WHERE is_active = 1 
         AND (product_id = ? OR product_id IS NULL)
         AND (segment_id = ? OR segment_id IS NULL)
         ORDER BY priority ASC`,
        [productId, segmentId]
      );

      // Apply dynamic rules
      for (const rule of dynamicRules) {
        let shouldApply = false;
        
        // Check behavior triggers
        if (rule.behavior_trigger === 'new_customer' && customerId) {
          const [[orderCount]] = await db.promise().query(
            `SELECT COUNT(*) as count FROM orders WHERE customer_id = ?`,
            [customerId]
          );
          shouldApply = orderCount.count === 0;
        } else if (rule.behavior_trigger === 'high_demand') {
          // Check recent demand (last 24 hours)
          const [[demand]] = await db.promise().query(
            `SELECT COUNT(*) as count FROM consumer_behavior 
             WHERE product_id = ? AND behavior_type = 'view' 
             AND timestamp > DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
            [productId]
          );
          shouldApply = demand.count > 10; // Threshold for high demand
        }

        if (shouldApply) {
          let adjustmentAmount = 0;
          
          if (rule.price_adjustment_type === 'percentage') {
            adjustmentAmount = finalPrice * (Number(rule.price_adjustment_value) / 100);
          } else if (rule.price_adjustment_type === 'fixed') {
            adjustmentAmount = Number(rule.price_adjustment_value);
          } else if (rule.price_adjustment_type === 'multiplier') {
            finalPrice = finalPrice * Number(rule.price_adjustment_value);
            adjustmentAmount = finalPrice - calculationDetails.basePrice;
          }

          if (rule.price_adjustment_type !== 'multiplier') {
            finalPrice += adjustmentAmount;
          }

          appliedRules.push(rule.rule_name);
          calculationDetails.adjustments.push({
            type: 'dynamic',
            rule: rule.rule_name,
            adjustmentType: rule.price_adjustment_type,
            value: rule.price_adjustment_value,
            amount: adjustmentAmount
          });
        }
      }
    }

    // Apply floor and ceiling constraints
    if (pricingRule) {
      if (!isNaN(pricingRule.floor_price)) {
        finalPrice = Math.max(finalPrice, Number(pricingRule.floor_price));
        if (finalPrice === Number(pricingRule.floor_price)) {
          appliedRules.push('floor');
          calculationDetails.adjustments.push({
            type: 'floor',
            amount: Number(pricingRule.floor_price) - finalPrice
          });
        }
      }
      
      if (!isNaN(pricingRule.ceiling_price)) {
        finalPrice = Math.min(finalPrice, Number(pricingRule.ceiling_price));
        if (finalPrice === Number(pricingRule.ceiling_price)) {
          appliedRules.push('ceiling');
          calculationDetails.adjustments.push({
            type: 'ceiling',
            amount: Number(pricingRule.ceiling_price) - finalPrice
          });
        }
      }
    }

    finalPrice = Number(finalPrice.toFixed(2));
    
    // Check for NaN before database insertion
    if (isNaN(finalPrice)) {
      console.warn('Final price is NaN, using base price instead');
      finalPrice = parseFloat(basePrice) || 0;
    }
    
    calculationDetails.finalPrice = finalPrice;

    // Log price calculation for audit
    await db.promise().query(
      `INSERT INTO price_calculations (product_id, base_price, final_price, customer_id, session_id, segment_id, applied_rules, calculation_details) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [productId, basePrice || 0, finalPrice, customerId, sessionId, null, JSON.stringify(appliedRules), JSON.stringify(calculationDetails)]
    );

    return {
      finalPrice,
      appliedRules,
      calculationDetails
    };
  } catch (error) {
    console.error('Price calculation error:', error);
    return {
      finalPrice: parseFloat(basePrice),
      appliedRules: [],
      calculationDetails: { basePrice: parseFloat(basePrice), finalPrice: parseFloat(basePrice), adjustments: [] }
    };
  }
};

// Track consumer behavior
app.post('/api/consumer-behavior', async (req, res) => {
  try {
    const { product_id, behavior_type, price_shown, quantity = 1, location_data, device_info, session_id, customer_id } = req.body;
    
    if (!product_id || !behavior_type) {
      return res.status(400).json({ error: 'Product ID and behavior type are required' });
    }

    await db.promise().query(
      `INSERT INTO consumer_behavior (product_id, behavior_type, price_shown, quantity, location_data, device_info, session_id, customer_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [product_id, behavior_type, price_shown, quantity, JSON.stringify(location_data), JSON.stringify(device_info), session_id, customer_id]
    );

    res.json({ message: 'Behavior tracked successfully' });
  } catch (error) {
    console.error('Behavior tracking error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get final price for a product (with consumer behavior consideration)
app.get('/api/products/:id/price', async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_id, session_id, location_data } = req.query;
    
    const [[product]] = await db.promise().query(
      `SELECT id, price, category FROM products WHERE id = ? AND status = 'active'`,
      [id]
    );

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const priceCalculation = await calculateFinalPrice(
      id, 
      product.price, 
      customer_id, 
      session_id, 
      parseJsonSafely(location_data, null)
    );

    res.json({
      product_id: id,
      base_price: product.price,
      final_price: priceCalculation.finalPrice,
      applied_rules: priceCalculation.appliedRules,
      calculation_details: priceCalculation.calculationDetails
    });
  } catch (error) {
    console.error('Get price error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Vendor requests a price change (cannot change directly)
app.post('/api/products/:id/price-request', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { requested_price, reason } = req.body || {};
    const priceNum = parseFloat(requested_price);
    if (isNaN(priceNum) || priceNum <= 0) return res.status(400).json({ error: 'Invalid requested price' });
    const [[p]] = await db.promise().query(`SELECT id FROM products WHERE id = ? AND vendor_id = ?`, [id, req.vendorId]);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    await db.promise().query(
      `INSERT INTO price_change_requests (product_id, vendor_id, requested_price, reason) VALUES (?, ?, ?, ?)`,
      [id, req.vendorId, priceNum, reason || null]
    );
    res.json({ message: 'Price change request submitted' });
  } catch (e) {
    console.error('Price request error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: list price requests
app.get('/api/admin/price-requests', verifyAdmin, async (req, res) => {
  try {
    const { status = '' } = req.query;
    
    // Check if product columns exist
    const hasSku = await tableHasColumn('products', 'sku');
    const hasCategory = await tableHasColumn('products', 'category');
    const hasBusinessName = await tableHasColumn('vendors', 'business_name');
    
    // Build SELECT columns dynamically
    const selectCols = ['pcr.*', 'p.name'];
    if (hasSku) selectCols.push('p.sku');
    if (hasCategory) selectCols.push('p.category');
    if (hasBusinessName) {
      selectCols.push('v.business_name as vendor_name');
    } else {
      selectCols.push('NULL as vendor_name');
    }
    
    const where = [];
    const params = [];
    if (status) { where.push('pcr.status = ?'); params.push(status); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await db.promise().query(
      `SELECT ${selectCols.join(', ')}
       FROM price_change_requests pcr
       JOIN products p ON pcr.product_id = p.id
       JOIN vendors v ON pcr.vendor_id = v.id
       ${whereSql}
       ORDER BY pcr.created_at DESC`
      , params
    );
    res.json(rows);
  } catch (e) {
    console.error('List price requests error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: approve/reject price request and apply rules
app.post('/api/admin/price-requests/:id/review', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, admin_notes } = req.body || {};
    if (!['approve','reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const [[reqRow]] = await db.promise().query(`SELECT * FROM price_change_requests WHERE id = ?`, [id]);
    if (!reqRow || reqRow.status !== 'pending') return res.status(400).json({ error: 'Request not pending or not found' });
    if (action === 'reject') {
      await db.promise().query(`UPDATE price_change_requests SET status='rejected', admin_notes=?, reviewed_at=NOW() WHERE id=?`, [admin_notes || null, id]);
      return res.json({ message: 'Request rejected' });
    }
    // approve -> compute final price with rules
    const { product_id, requested_price } = reqRow;
    const [[prod]] = await db.promise().query(`SELECT category, price FROM products WHERE id = ?`, [product_id]);
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    let finalPrice = Number(requested_price);
    const [[rule]] = await db.promise().query(
      `SELECT * FROM pricing_rules WHERE is_active = 1 AND (
          scope = 'product' AND product_id = ?
        ) OR (
          scope = 'category' AND category = ?
        ) OR (
          scope = 'global'
        ) ORDER BY 
          CASE scope WHEN 'product' THEN 1 WHEN 'category' THEN 2 ELSE 3 END ASC,
          updated_at DESC LIMIT 1`,
      [product_id, prod.category]
    );
    if (rule) {
      if (!isNaN(rule.surge_percentage)) finalPrice = finalPrice * (1 + Number(rule.surge_percentage)/100);
      if (!isNaN(rule.promo_percentage)) finalPrice = finalPrice * (1 - Number(rule.promo_percentage)/100);
      if (!isNaN(rule.floor_price)) finalPrice = Math.max(finalPrice, Number(rule.floor_price));
      if (!isNaN(rule.ceiling_price)) finalPrice = Math.min(finalPrice, Number(rule.ceiling_price));
    }
    finalPrice = Number(finalPrice.toFixed(2));
    await db.promise().query(`UPDATE products SET price = ?, updated_at = NOW() WHERE id = ?`, [finalPrice, product_id]);
    await db.promise().query(
      `INSERT INTO price_history (product_id, old_price, new_price, reason, changed_by) VALUES (?, ?, ?, ?, 'admin')`,
      [product_id, prod.price, finalPrice, 'Approved vendor request']
    );
    await db.promise().query(`UPDATE price_change_requests SET status='approved', admin_notes=?, reviewed_at=NOW() WHERE id=?`, [admin_notes || null, id]);
    res.json({ message: 'Request approved', finalPrice });
  } catch (e) {
    console.error('Approve price request error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: CRUD pricing rules
app.get('/api/admin/pricing-rules', verifyAdmin, async (req, res) => {
  try {
    const [rows] = await db.promise().query(`SELECT * FROM pricing_rules ORDER BY updated_at DESC`);
    res.json(rows);
  } catch (e) {
    console.error('List pricing rules error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/pricing-rules', verifyAdmin, async (req, res) => {
  try {
    const { scope = 'global', category = null, product_id = null, floor_price = null, ceiling_price = null, surge_percentage = null, promo_percentage = null, is_active = 1 } = req.body || {};
    await db.promise().query(
      `INSERT INTO pricing_rules (scope, category, product_id, floor_price, ceiling_price, surge_percentage, promo_percentage, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [scope, category, product_id, floor_price, ceiling_price, surge_percentage, promo_percentage, is_active ? 1 : 0]
    );
    res.status(201).json({ message: 'Rule created' });
  } catch (e) {
    console.error('Create pricing rule error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Admin: Consumer behavior and dynamic pricing management
app.get('/api/admin/consumer-segments', verifyAdmin, async (req, res) => {
  try {
    const [segments] = await db.promise().query(`SELECT * FROM consumer_segments ORDER BY created_at DESC`);
    res.json(segments);
  } catch (error) {
    console.error('Get consumer segments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/consumer-segments', verifyAdmin, async (req, res) => {
  try {
    const { segment_name, description, criteria, pricing_multiplier = 1.0, is_active = 1 } = req.body;
    
    if (!segment_name || !criteria) {
      return res.status(400).json({ error: 'Segment name and criteria are required' });
    }

    await db.promise().query(
      `INSERT INTO consumer_segments (segment_name, description, criteria, pricing_multiplier, is_active) 
       VALUES (?, ?, ?, ?, ?)`,
      [segment_name, description, JSON.stringify(criteria), pricing_multiplier, is_active ? 1 : 0]
    );

    res.status(201).json({ message: 'Consumer segment created successfully' });
  } catch (error) {
    console.error('Create consumer segment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/dynamic-pricing-rules', verifyAdmin, async (req, res) => {
  try {
    const [rules] = await db.promise().query(`
      SELECT dpr.*, p.name as product_name, cs.segment_name 
      FROM dynamic_pricing_rules dpr
      LEFT JOIN products p ON dpr.product_id = p.id
      LEFT JOIN consumer_segments cs ON dpr.segment_id = cs.id
      ORDER BY dpr.priority ASC, dpr.created_at DESC
    `);
    res.json(rules);
  } catch (error) {
    console.error('Get dynamic pricing rules error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/dynamic-pricing-rules', verifyAdmin, async (req, res) => {
  try {
    const { 
      rule_name, 
      product_id, 
      category, 
      segment_id, 
      behavior_trigger, 
      time_condition, 
      location_condition, 
      price_adjustment_type, 
      price_adjustment_value, 
      min_price, 
      max_price, 
      is_active = 1, 
      priority = 0 
    } = req.body;

    if (!rule_name || !price_adjustment_type || !price_adjustment_value) {
      return res.status(400).json({ error: 'Rule name, adjustment type, and adjustment value are required' });
    }

    await db.promise().query(
      `INSERT INTO dynamic_pricing_rules 
       (rule_name, product_id, category, segment_id, behavior_trigger, time_condition, location_condition, 
        price_adjustment_type, price_adjustment_value, min_price, max_price, is_active, priority) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rule_name, product_id, category, segment_id, behavior_trigger, 
        JSON.stringify(time_condition), JSON.stringify(location_condition),
        price_adjustment_type, price_adjustment_value, min_price, max_price, 
        is_active ? 1 : 0, priority
      ]
    );

    res.status(201).json({ message: 'Dynamic pricing rule created successfully' });
  } catch (error) {
    console.error('Create dynamic pricing rule error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/price-calculations', verifyAdmin, async (req, res) => {
  try {
    const { product_id, customer_id, limit = 100 } = req.query;
    let whereClause = '';
    let params = [];
    
    if (product_id) {
      whereClause += ' WHERE pc.product_id = ?';
      params.push(product_id);
    }
    if (customer_id) {
      whereClause += whereClause ? ' AND pc.customer_id = ?' : ' WHERE pc.customer_id = ?';
      params.push(customer_id);
    }

    const [calculations] = await db.promise().query(`
      SELECT pc.*, p.name as product_name, v.shop_name as customer_name
      FROM price_calculations pc
      LEFT JOIN products p ON pc.product_id = p.id
      LEFT JOIN vendors v ON pc.customer_id = v.id
      ${whereClause}
      ORDER BY pc.created_at DESC
      LIMIT ?
    `, [...params, parseInt(limit)]);

    res.json(calculations);
  } catch (error) {
    console.error('Get price calculations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/consumer-behavior-analytics', verifyAdmin, async (req, res) => {
  try {
    const { product_id, days = 30 } = req.query;
    
    // Get behavior analytics
    const [analytics] = await db.promise().query(`
      SELECT 
        cb.product_id,
        p.name as product_name,
        cb.behavior_type,
        COUNT(*) as count,
        AVG(cb.price_shown) as avg_price_shown,
        AVG(cb.price_paid) as avg_price_paid,
        DATE(cb.timestamp) as date
      FROM consumer_behavior cb
      LEFT JOIN products p ON cb.product_id = p.id
      WHERE cb.timestamp > DATE_SUB(NOW(), INTERVAL ? DAY)
      ${product_id ? 'AND cb.product_id = ?' : ''}
      GROUP BY cb.product_id, cb.behavior_type, DATE(cb.timestamp)
      ORDER BY date DESC, count DESC
    `, [parseInt(days), ...(product_id ? [product_id] : [])]);

    // Get demand patterns
    const [demandPatterns] = await db.promise().query(`
      SELECT 
        cb.product_id,
        p.name as product_name,
        HOUR(cb.timestamp) as hour,
        COUNT(*) as views,
        AVG(cb.price_shown) as avg_price
      FROM consumer_behavior cb
      LEFT JOIN products p ON cb.product_id = p.id
      WHERE cb.behavior_type = 'view' 
      AND cb.timestamp > DATE_SUB(NOW(), INTERVAL ? DAY)
      ${product_id ? 'AND cb.product_id = ?' : ''}
      GROUP BY cb.product_id, HOUR(cb.timestamp)
      ORDER BY cb.product_id, hour
    `, [parseInt(days), ...(product_id ? [product_id] : [])]);

    res.json({
      analytics,
      demandPatterns
    });
  } catch (error) {
    console.error('Get consumer behavior analytics error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/admin/pricing-rules/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { scope, category, product_id, floor_price, ceiling_price, surge_percentage, promo_percentage, is_active } = req.body || {};
    await db.promise().query(
      `UPDATE pricing_rules SET scope = COALESCE(?, scope), category = ?, product_id = ?, floor_price = ?, ceiling_price = ?, surge_percentage = ?, promo_percentage = ?, is_active = COALESCE(?, is_active), updated_at = NOW() WHERE id = ?`,
      [scope || null, category || null, product_id || null, floor_price || null, ceiling_price || null, surge_percentage || null, promo_percentage || null, typeof is_active === 'number' ? is_active : null, id]
    );
    res.json({ message: 'Rule updated' });
  } catch (e) {
    console.error('Update pricing rule error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/admin/pricing-rules/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await db.promise().query(`DELETE FROM pricing_rules WHERE id = ?`, [id]);
    res.json({ message: 'Rule deleted' });
  } catch (e) {
    console.error('Delete pricing rule error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Resolve alert
app.put('/api/alerts/:id/resolve', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if alert exists and belongs to vendor
    const alert = await db.promise().query(
      `SELECT sa.id FROM stock_alerts sa
       JOIN products p ON sa.product_id = p.id
       WHERE sa.id = ? AND p.vendor_id = ?`,
      [id, req.vendorId]
    );
    
    if (alert[0].length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    
    await db.promise().query(
      'UPDATE stock_alerts SET is_resolved = TRUE, resolved_at = NOW() WHERE id = ?',
      [id]
    );
    
    res.json({ message: 'Alert resolved successfully' });
  } catch (error) {
    console.error('Resolve alert error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check stock alerts (run stored procedure)
app.post('/api/alerts/check', verifyToken, async (req, res) => {
  try {
    await db.promise().query('CALL CheckStockAlerts(?)', [req.vendorId]);
    res.json({ message: 'Stock alerts checked successfully' });
  } catch (error) {
    console.error('Check alerts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ORDER MANAGEMENT ROUTES

// Create order
app.post('/api/orders', verifyToken, async (req, res) => {
  let conn;
  try {
    const { items, customer_id, shipping_address, notes } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Order items are required' });
    }

    // Normalize items
    const normalizedItems = items.map((i) => ({
      product_id: Number(i.product_id),
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price)
    }));
    for (const it of normalizedItems) {
      if (!it.product_id || !it.quantity || it.quantity <= 0 || !isFinite(it.unit_price) || it.unit_price < 0) {
        return res.status(400).json({ error: 'Invalid order item payload' });
      }
    }

    // Generate order number
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Calculate total amount
    const totalAmount = normalizedItems.reduce((sum, it) => sum + (it.quantity * it.unit_price), 0);

    // Set SLA deadline (e.g., 30 minutes from now)
    const slaDeadline = new Date(Date.now() + 30 * 60 * 1000);

    // Start transaction on a single dedicated connection
    conn = await db.promise().getConnection();
    await conn.beginTransaction();

    // Create order
    const orderResult = await conn.query(
      `INSERT INTO orders (vendor_id, customer_id, order_number, status, total_amount, shipping_address, notes, sla_deadline)
       VALUES (?, ?, ?, 'placed', ?, ?, ?, ?)`,
      [req.vendorId, (customer_id !== undefined && customer_id !== null && customer_id !== '') ? Number(customer_id) : null, orderNumber, totalAmount, shipping_address || null, notes || null, slaDeadline]
    );
    const orderId = orderResult[0].insertId;

    // Create order items and reserve stock
    for (const item of normalizedItems) {
      // Check if product exists and belongs to vendor
      const [productRows] = await conn.query(
        'SELECT id, price FROM products WHERE id = ? AND vendor_id = ?',
        [item.product_id, req.vendorId]
      );
      if (!productRows || productRows.length === 0) {
        await conn.rollback();
        return res.status(400).json({ error: `Product ${item.product_id} not found for this vendor` });
      }

      // Ensure inventory row exists
      const [invRows] = await conn.query(
        'SELECT stock_available FROM inventory WHERE product_id = ? FOR UPDATE',
        [item.product_id]
      );
      if (!invRows || invRows.length === 0) {
        // Seed inventory from product's current stock if available
        let seedOnHand = 0;
        try {
          const [prodStock] = await conn.query(
            'SELECT stock_on_hand FROM products WHERE id = ? AND vendor_id = ? LIMIT 1',
            [item.product_id, req.vendorId]
          );
          if (prodStock && prodStock.length > 0 && prodStock[0].stock_on_hand != null) {
            seedOnHand = Number(prodStock[0].stock_on_hand) || 0;
          }
        } catch (_) {}
        await conn.query(
          'INSERT INTO inventory (product_id, stock_on_hand, stock_reserved, min_stock_level, reorder_point) VALUES (?, ?, 0, 0, 0) ON DUPLICATE KEY UPDATE product_id = product_id',
          [item.product_id, seedOnHand]
        );
      }

      // Re-check available stock
      const [invCheck] = await conn.query(
        'SELECT stock_available FROM inventory WHERE product_id = ? FOR UPDATE',
        [item.product_id]
      );
      const available = Number(invCheck[0]?.stock_available || 0);
      if (available < item.quantity) {
        await conn.rollback();
        return res.status(400).json({ error: `Insufficient stock for product ${item.product_id}` });
      }

      // Create order item
      await conn.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price, reserved_quantity)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, item.product_id, item.quantity, item.unit_price, item.quantity * item.unit_price, item.quantity]
      );

      // Reserve stock (try procedure, fallback to direct update)
      try {
        await conn.query('CALL ReserveStock(?, ?, ?, ?, ?)', [
          item.product_id, item.quantity, 'order', orderId, req.vendorId
        ]);
      } catch (reserveErr) {
        await conn.query(
          'UPDATE inventory SET stock_reserved = stock_reserved + ?, updated_at = NOW() WHERE product_id = ?',
          [item.quantity, item.product_id]
        );
        await conn.query(
          'INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, reference_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [item.product_id, 'reservation', item.quantity, 'order', orderId, 'auto-reserve-fallback', req.vendorId]
        );
      }
    }

    await conn.commit();

    // Determine if this is the first order since opening
    let firstAfterOpen = false;
    try {
      const [rows] = await db.promise().query(
        'SELECT is_open, last_opened_at, last_first_order_at FROM vendors WHERE id = ? LIMIT 1',
        [req.vendorId]
      );
      if (rows && rows.length > 0) {
        const v = rows[0];
        if ((v.is_open === 1 || v.is_open === true) && v.last_opened_at && !v.last_first_order_at) {
          firstAfterOpen = true;
          await db.promise().query(
            'UPDATE vendors SET last_first_order_at = NOW(), updated_at = NOW() WHERE id = ? AND last_first_order_at IS NULL',
            [req.vendorId]
          );
        }
      }
    } catch (e) {
      console.error('firstAfterOpen check error:', e);
    }

    const orderData = {
      id: orderId,
      order_number: orderNumber,
      status: 'placed',
      total_amount: totalAmount,
      created_at: new Date(),
      action: 'created',
      first_after_open: firstAfterOpen
    };
    emitOrderUpdate(req.vendorId, orderData);
    emitAdminOrderUpdate(orderData);

    res.status(201).json({ message: 'Order created successfully', orderId, orderNumber });
  } catch (error) {
    try { if (conn) await conn.rollback(); } catch (_) {}
    console.error('Create order error:', error);
    res.status(500).json({ error: error?.sqlMessage || error?.message || 'Internal server error' });
  } finally {
    try { if (conn) conn.release(); } catch (_) {}
  }
});

// Accept order
app.put('/api/orders/:id/accept', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if order exists and belongs to vendor
    const order = await db.promise().query(
      'SELECT id, status, sla_deadline FROM orders WHERE id = ? AND vendor_id = ?',
      [id, req.vendorId]
    );
    
    if (order[0].length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    if (order[0][0].status !== 'placed') {
      return res.status(400).json({ error: 'Order is not in placed status' });
    }
    
    // Check if SLA deadline has passed
    const now = new Date();
    const slaDeadline = new Date(order[0][0].sla_deadline);
    if (now > slaDeadline) {
      return res.status(400).json({ error: 'SLA deadline has passed. Order cannot be accepted.' });
    }
    
    // Update order status and timestamps
    await db.promise().query(
      'UPDATE orders SET status = ?, accepted_at = NOW(), confirmed_at = NOW(), updated_at = NOW() WHERE id = ?',
      ['confirmed', id]
    );
    
    // Emit order update via WebSocket
    const orderData = {
      id: parseInt(id),
      status: 'confirmed',
      accepted_at: now,
      action: 'accepted'
    };
    emitOrderUpdate(req.vendorId, orderData);
    emitAdminOrderUpdate(orderData);
    
    res.json({ message: 'Order accepted successfully' });
  } catch (error) {
    console.error('Accept order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reject order
app.put('/api/orders/:id/reject', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    // Check if order exists and belongs to vendor
    const order = await db.promise().query(
      'SELECT id, status FROM orders WHERE id = ? AND vendor_id = ?',
      [id, req.vendorId]
    );
    
    if (order[0].length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    if (order[0][0].status !== 'placed') {
      return res.status(400).json({ error: 'Order is not in placed status' });
    }
    
    // Get order items to release reserved stock
    const orderItems = await db.promise().query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
      [id]
    );
    
    // Release reserved stock for each item
    for (const item of orderItems[0]) {
      await db.promise().query('CALL ReleaseStock(?, ?, ?, ?, ?)', [
        item.product_id, item.quantity, 'order', id, req.vendorId
      ]);
    }
    
    // Update order status
    await db.promise().query(
      'UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?',
      ['rejected', id]
    );
    
    // Emit order update via WebSocket
    const orderData = {
      id: parseInt(id),
      status: 'rejected',
      action: 'rejected',
      reason: reason
    };
    emitOrderUpdate(req.vendorId, orderData);
    emitAdminOrderUpdate(orderData);
    
    // If rejection reason is out_of_stock, try auto-reassignment
    if (reason && typeof reason === 'string' && reason.toLowerCase().includes('out_of_stock')) {
      try {
        // Find alternative vendors
        const [alternatives] = await db.promise().query(
          `SELECT v.id, COALESCE(v.business_name, v.owner_name, v.owner_email) as shop_name
           FROM vendors v 
           WHERE v.id != ? 
             AND v.status = 'APPROVED'
           ORDER BY v.rating DESC, v.created_at ASC
           LIMIT 3`,
          [req.vendorId]
        );

        if (alternatives.length > 0) {
          const newVendor = alternatives[0];

          // Create reassignment record
          await db.promise().query(
            'INSERT INTO order_reassignments (order_id, from_vendor_id, to_vendor_id, reason, notes) VALUES (?, ?, ?, ?, ?)',
            [id, req.vendorId, newVendor.id, 'out_of_stock', 'Auto-reassigned due to out-of-stock rejection']
          );

          // Update order to new vendor and reset SLA
          await db.promise().query(
            'UPDATE orders SET vendor_id = ?, status = \'placed\', sla_deadline = DATE_ADD(NOW(), INTERVAL 30 MINUTE), updated_at = NOW() WHERE id = ?',
            [newVendor.id, id]
          );

          // Reserve stock for new vendor
          for (const item of orderItems[0]) {
            await db.promise().query('CALL ReserveStock(?, ?, ?, ?, ?)', [
              item.product_id, item.quantity, 'order', id, newVendor.id
            ]);
          }

          // Notify both vendors
          const reassignmentData = {
            id: parseInt(id),
            status: 'reassigned',
            action: 'reassigned',
            reason: 'out_of_stock'
          };
          emitOrderUpdate(req.vendorId, { ...reassignmentData, message: `Order ${id} reassigned due to out-of-stock` });
          emitOrderUpdate(newVendor.id, { ...reassignmentData, message: `New order ${id} assigned to you` });
          emitAdminOrderUpdate({ ...reassignmentData, message: `Order ${id} auto-reassigned due to out-of-stock` });
        }
      } catch (e) {
        console.error('Auto-reassign on out_of_stock failed:', e);
      }
    }

    res.json({ message: 'Order rejected successfully' });
  } catch (error) {
    console.error('Reject order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update order status
app.put('/api/orders/:id/status', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    // Validate status
    const validStatuses = ['confirmed', 'packing', 'ready', 'out_for_delivery', 'delivered'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    // Check if order exists and belongs to vendor
    const order = await db.promise().query(
      'SELECT id, status FROM orders WHERE id = ? AND vendor_id = ?',
      [id, req.vendorId]
    );
    
    if (order[0].length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const currentStatus = order[0][0].status;
    
    // Validate status transition
    const validTransitions = {
      'confirmed': ['packing'],
      'packing': ['ready'],
      'ready': ['out_for_delivery'],
      'out_for_delivery': ['delivered']
    };
    
    if (!validTransitions[currentStatus] || !validTransitions[currentStatus].includes(status)) {
      return res.status(400).json({ error: `Invalid status transition from ${currentStatus} to ${status}` });
    }
    
    // Update order status with appropriate timestamp
    let timestampField = '';
    switch (status) {
      case 'packing':
        timestampField = 'packing_at = NOW()';
        break;
      case 'ready':
        timestampField = 'ready_at = NOW()';
        break;
      case 'out_for_delivery':
        timestampField = 'out_for_delivery_at = NOW()';
        break;
      case 'delivered':
        timestampField = 'delivered_at = NOW()';
        break;
    }
    
    await db.promise().query(
      `UPDATE orders SET status = ?, ${timestampField}, updated_at = NOW() WHERE id = ?`,
      [status, id]
    );
    
    // Inventory integration
    if (['confirmed', 'out_for_delivery', 'delivered'].includes(status)) {
      const [orderItems] = await db.promise().query(
        'SELECT id, product_id, reserved_quantity FROM order_items WHERE order_id = ?',
        [id]
      );
      for (const item of orderItems) {
        const toCommit = Number(item.reserved_quantity || 0);
        if (toCommit > 0) {
          await db.promise().query('CALL CommitStock(?, ?, ?, ?, ?)', [
            item.product_id, toCommit, 'order', id, req.vendorId
          ]);
          await db.promise().query('UPDATE order_items SET reserved_quantity = 0 WHERE id = ?', [item.id]);
        }
      }
    }
    
    // Emit order update via WebSocket
    const orderData = {
      id: parseInt(id),
      status: status,
      action: 'status_updated',
      updated_at: new Date()
    };
    emitOrderUpdate(req.vendorId, orderData);
    emitAdminOrderUpdate(orderData);
    
    res.json({ message: `Order status updated to ${status} successfully` });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cancel order (release reserved stock)
app.put('/api/orders/:id/cancel', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if order exists and belongs to vendor
    const order = await db.promise().query(
      'SELECT id, status FROM orders WHERE id = ? AND vendor_id = ?',
      [id, req.vendorId]
    );
    
    if (order[0].length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    if (order[0][0].status !== 'pending') {
      return res.status(400).json({ error: 'Order is not in pending status' });
    }
    
    // Get order items
    const orderItems = await db.promise().query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
      [id]
    );
    
    // Release reserved stock for each item
    for (const item of orderItems[0]) {
      await db.promise().query('CALL ReleaseStock(?, ?, ?, ?, ?)', [
        item.product_id, item.quantity, 'order', id, req.vendorId
      ]);
    }
    
    // Update order status
    await db.promise().query(
      'UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?',
      ['cancelled', id]
    );
    
    res.json({ message: 'Order cancelled successfully' });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get orders
app.get('/api/orders', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, status = '' } = req.query;
    const offset = (page - 1) * limit;

    let baseQuery = `
      SELECT 
        o.id,
        o.vendor_id,
        o.customer_id,
        o.order_number,
        o.status,
        o.total_amount,
        o.payment_status,
        o.shipping_address,
        o.sla_deadline,
        o.accepted_at,
        o.confirmed_at,
        o.packing_at,
        o.ready_at,
        o.out_for_delivery_at,
        o.delivered_at,
        o.created_at,
        o.updated_at,
        (
          SELECT COUNT(*) FROM order_items oi 
          WHERE oi.order_id = o.id
        ) AS item_count,
        (
          SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi 
          WHERE oi.order_id = o.id
        ) AS total_quantity,
        CASE 
          WHEN o.sla_deadline < NOW() AND o.status = 'placed' THEN 'sla_breached'
          WHEN o.sla_deadline < DATE_ADD(NOW(), INTERVAL 5 MINUTE) AND o.status = 'placed' THEN 'sla_warning'
          ELSE 'normal'
        END AS sla_status
      FROM orders o
      WHERE o.vendor_id = ?
    `;
    const params = [req.vendorId];

    if (status) {
      baseQuery += ' AND o.status = ?';
      params.push(status);
    }

    baseQuery += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [rows] = await db.promise().query(baseQuery, params);
    res.json(rows);
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Compatibility: Get vendor orders by explicit vendorId path
app.get('/api/orders/vendor/:vendorId', verifyToken, async (req, res) => {
  try {
    const { vendorId } = req.params;
    // Enforce vendor isolation
    if (String(req.vendorId) !== String(vendorId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { page = 1, limit = 20, status = '', search = '' } = req.query || {};
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = ['o.vendor_id = ?'];
    const params = [req.vendorId];
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (search) { where.push('(o.order_number LIKE ?)'); params.push(`%${search}%`); }

    const base = `
      FROM orders o
      WHERE ${where.join(' AND ')}
    `;
    const [countRows] = await db.promise().query(`SELECT COUNT(*) as cnt ${base}`, params);
    const total = Number(countRows[0]?.cnt || 0);

    const [rows] = await db.promise().query(
      `SELECT 
         o.id, o.vendor_id, o.order_number, o.status, o.total_amount, o.payment_status,
         o.created_at, o.updated_at,
         (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
       ${base}
       ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const totalPages = Math.ceil(total / parseInt(limit || 1));
    res.json({ orders: rows, pagination: { current_page: parseInt(page), total_pages: totalPages, total_items: total } });
  } catch (error) {
    console.error('Get vendor orders (compat) error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Compatibility: Vendor order notifications
app.get('/api/orders/notifications/:vendorId', verifyToken, async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (String(req.vendorId) !== String(vendorId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { limit = 10, unread_only } = req.query || {};

    // If notifications table exists, use it; otherwise, return a safe empty list
    const hasTable = async (name) => {
      const [[row]] = await db.promise().query("SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [name]);
      return Number(row?.cnt || 0) > 0;
    };

    const notifications = [];
    if (await hasTable('order_notifications')) {
      const where = ['vendor_id = ?'];
      const params = [req.vendorId];
      if (String(unread_only).toLowerCase() === 'true') { where.push('is_read = 0'); }

      // Check if created_at column exists to sort by it; otherwise sort by id
      const [[colRow]] = await db.promise().query(
        "SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_notifications' AND column_name = 'created_at'"
      );
      const hasCreatedAt = Number(colRow?.cnt || 0) > 0;
      const orderBy = hasCreatedAt ? 'created_at' : 'id';

      const [rows] = await db.promise().query(
        `SELECT id, order_id, type, message, is_read${hasCreatedAt ? ', created_at' : ''}
         FROM order_notifications
         WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy} DESC
         LIMIT ?`,
        [...params, parseInt(limit)]
      );
      for (const r of rows) notifications.push(r);
    }

    res.json({ notifications });
  } catch (error) {
    console.error('Order notifications (compat) error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DASHBOARD METRICS
// Weekly revenue for current and previous week, plus daily breakdown
app.get('/api/metrics/weekly-revenue', verifyToken, async (req, res) => {
  try {
    const [current] = await db.promise().query(
      `SELECT DATE_FORMAT(created_at, '%a') as day, SUM(total_amount) as amount
       FROM orders
       WHERE vendor_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
       GROUP BY DAYOFWEEK(created_at)
       ORDER BY DAYOFWEEK(created_at)`,
      [req.vendorId]
    );

    const [prev] = await db.promise().query(
      `SELECT SUM(total_amount) as amount
       FROM orders
       WHERE vendor_id = ? AND created_at >= DATE_SUB(DATE_SUB(CURDATE(), INTERVAL 7 DAY), INTERVAL WEEKDAY(CURDATE()) DAY)
         AND created_at < DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)`,
      [req.vendorId]
    );

    const currentSum = current.reduce((s, r) => s + (r.amount || 0), 0);
    const prevSum = prev[0]?.amount || 0;
    const change = prevSum > 0 ? ((currentSum - prevSum) / prevSum) * 100 : 100;

    // Ensure all 7 days present Mon..Sun
    const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const map = Object.fromEntries(current.map(r => [r.day, Number(r.amount || 0)]));
    const dailyBreakdown = dayOrder.map(d => ({ day: d, amount: map[d] || 0 }));

    res.json({ current: currentSum, previous: prevSum, change, dailyBreakdown });
  } catch (error) {
    console.error('Weekly revenue error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Weekly revenue CSV export
app.get('/api/metrics/weekly-revenue.csv', verifyToken, async (req, res) => {
  try {
    const [current] = await db.promise().query(
      `SELECT DATE_FORMAT(created_at, '%a') as day, SUM(total_amount) as amount
       FROM orders
       WHERE vendor_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
       GROUP BY DAYOFWEEK(created_at)
       ORDER BY DAYOFWEEK(created_at)`,
      [req.vendorId]
    );
    const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const map = Object.fromEntries(current.map(r => [r.day, Number(r.amount || 0)]));
    const rows = dayOrder.map(d => ({ day: d, amount: map[d] || 0 }));
    const header = 'day,amount\n';
    const body = rows.map(r => `${r.day},${r.amount}`).join('\n');
    const csv = header + body + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="weekly-revenue.csv"');
    res.send(csv);
  } catch (e) {
    console.error('Weekly revenue CSV error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Orders by status summary
app.get('/api/metrics/orders-status', verifyToken, async (req, res) => {
  try {
    // Current week
    const [rowsCurr] = await db.promise().query(
      `SELECT status, COUNT(*) as count, SUM(total_amount) as amount
       FROM orders
       WHERE vendor_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
       GROUP BY status`,
      [req.vendorId]
    );
    // Previous week
    const [rowsPrev] = await db.promise().query(
      `SELECT status, COUNT(*) as count, SUM(total_amount) as amount
       FROM orders
       WHERE vendor_id = ? 
         AND created_at >= DATE_SUB(DATE_SUB(CURDATE(), INTERVAL 7 DAY), INTERVAL WEEKDAY(CURDATE()) DAY)
         AND created_at < DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
       GROUP BY status`,
      [req.vendorId]
    );
    const summarize = (rows) => {
      const res = { pending: { count: 0, amount: 0 }, shipped: { count: 0, amount: 0 }, delivered: { count: 0, amount: 0 } };
      for (const r of rows) {
        const amt = Number(r.amount || 0);
        if (r.status === 'placed' || r.status === 'confirmed' || r.status === 'packing' || r.status === 'ready') {
          res.pending.count += r.count; res.pending.amount += amt;
        } else if (r.status === 'out_for_delivery') {
          res.shipped.count += r.count; res.shipped.amount += amt;
        } else if (r.status === 'delivered') {
          res.delivered.count += r.count; res.delivered.amount += amt;
        }
      }
      return res;
    };
    const curr = summarize(rowsCurr);
    const prev = summarize(rowsPrev);
    const withDelta = {
      pending: { 
        count: curr.pending.count, 
        amount: curr.pending.amount,
        changeCount: curr.pending.count - prev.pending.count,
        changeAmount: curr.pending.amount - prev.pending.amount
      },
      shipped: { 
        count: curr.shipped.count, 
        amount: curr.shipped.amount,
        changeCount: curr.shipped.count - prev.shipped.count,
        changeAmount: curr.shipped.amount - prev.shipped.amount
      },
      delivered: { 
        count: curr.delivered.count, 
        amount: curr.delivered.amount,
        changeCount: curr.delivered.count - prev.delivered.count,
        changeAmount: curr.delivered.amount - prev.delivered.amount
      }
    };
    res.json(withDelta);
  } catch (error) {
    console.error('Orders status metrics error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Payouts summary and list
app.get('/api/payouts/summary', verifyToken, async (req, res) => {
  try {
    const [[totals]] = await db.promise().query(
      `SELECT 
         (SELECT IFNULL(SUM(total_amount),0) FROM orders WHERE vendor_id = ?) as total_earnings,
         (SELECT IFNULL(SUM(amount),0) FROM payouts WHERE vendor_id = ? AND status = 'pending') as pending_payout,
         (SELECT IFNULL(SUM(amount),0) FROM payouts WHERE vendor_id = ? AND status = 'paid' AND paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) as last_30d_paid`,
      [req.vendorId, req.vendorId, req.vendorId]
    );
    const [[lastPaid]] = await db.promise().query(
      `SELECT amount, paid_at, method FROM payouts WHERE vendor_id = ? AND status='paid' ORDER BY paid_at DESC LIMIT 1`,
      [req.vendorId]
    );
    // Next payout date policy: every Friday this week
    const nextFriday = (() => { const d = new Date(); const day = d.getDay(); const diff = (5 - day + 7) % 7; d.setDate(d.getDate() + diff || 7); return d; })();
    res.json({
      totalEarnings: Number(totals.total_earnings || 0),
      pendingPayout: Number(totals.pending_payout || 0),
      lastPayout: Number(lastPaid?.amount || 0),
      nextPayoutDate: nextFriday.toISOString().slice(0,10),
      payoutMethod: lastPaid?.method ? lastPaid.method.replace('_',' ') : 'Bank Transfer'
    });
  } catch (error) {
    console.error('Payout summary error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/payouts', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT * FROM payouts WHERE vendor_id = ? ORDER BY created_at DESC`,
      [req.vendorId]
    );
    res.json(rows);
  } catch (error) {
    console.error('Payouts list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Payout preview (estimated next payout and schedule)
app.get('/api/payouts/preview', verifyToken, async (req, res) => {
  try {
    // Load settings (with defaults)
    const [settingsRows] = await db.promise().query(
      'SELECT * FROM vendor_payout_settings WHERE vendor_id = ?',
      [req.vendorId]
    );
    const settings = settingsRows[0] || {
      mode: 'auto',
      day_of_week: 5,
      min_payout_amount: 0,
      is_bank_verified: 0
    };

    // Compute next payout date based on mode/day_of_week
    const now = new Date();
    let nextDate;
    if (settings.mode === 'auto') {
      const targetDow = Number.isInteger(settings.day_of_week) ? Math.min(6, Math.max(0, settings.day_of_week)) : 5;
      const day = now.getDay();
      const diff = (targetDow - day + 7) % 7 || 7; // at least next week if today
      nextDate = new Date(now);
      nextDate.setDate(now.getDate() + diff);
    } else {
      // Manual mode: no auto schedule; show N/A
      nextDate = null;
    }

    // Estimate available balance for payout: total earnings minus all payouts created
    // For simplicity, treat orders.total_amount as earnings (no fees) and exclude already created payouts
    const [[earnings]] = await db.promise().query(
      `SELECT IFNULL(SUM(total_amount),0) AS total_earnings FROM orders WHERE vendor_id = ?`,
      [req.vendorId]
    );
    const [[payoutsTotals]] = await db.promise().query(
      `SELECT IFNULL(SUM(amount),0) AS total_outgoing FROM payouts WHERE vendor_id = ?`,
      [req.vendorId]
    );
    const available = Math.max(0, Number(earnings.total_earnings || 0) - Number(payoutsTotals.total_outgoing || 0));

    // Respect minimum payout amount
    const meetsMinimum = available >= Number(settings.min_payout_amount || 0);

    res.json({
      mode: settings.mode,
      isBankVerified: !!settings.is_bank_verified,
      nextPayoutDate: nextDate ? nextDate.toISOString().slice(0,10) : null,
      estimatedAmount: Number(available.toFixed(2)),
      meetsMinimum,
      minimumRequired: Number(settings.min_payout_amount || 0)
    });
  } catch (e) {
    console.error('Payout preview error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get payout settings
app.get('/api/payouts/settings', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      'SELECT * FROM vendor_payout_settings WHERE vendor_id = ?',
      [req.vendorId]
    );
    if (rows.length === 0) {
      // return defaults
      return res.json({
        mode: 'auto',
        day_of_week: 5,
        min_payout_amount: 0,
        bank_account_holder: '',
        bank_account_number: '',
        bank_ifsc: '',
        is_bank_verified: 0
      });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error('Get payout settings error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update payout settings
app.put('/api/payouts/settings', verifyToken, async (req, res) => {
  try {
    const { mode, day_of_week, min_payout_amount, bank_account_holder, bank_account_number, bank_ifsc } = req.body;
    const safeMode = mode === 'manual' ? 'manual' : 'auto';
    const safeDow = Number.isInteger(day_of_week) ? Math.min(6, Math.max(0, day_of_week)) : 5;
    const minAmt = isNaN(parseFloat(min_payout_amount)) ? 0 : parseFloat(min_payout_amount);
    await db.promise().query(
      `INSERT INTO vendor_payout_settings (vendor_id, mode, day_of_week, min_payout_amount, bank_account_holder, bank_account_number, bank_ifsc)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE mode=VALUES(mode), day_of_week=VALUES(day_of_week), min_payout_amount=VALUES(min_payout_amount), bank_account_holder=VALUES(bank_account_holder), bank_account_number=VALUES(bank_account_number), bank_ifsc=VALUES(bank_ifsc)`,
      [req.vendorId, safeMode, safeDow, minAmt, bank_account_holder || null, bank_account_number || null, bank_ifsc || null]
    );
    res.json({ message: 'Payout settings updated' });
  } catch (e) {
    console.error('Update payout settings error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bank details verification (mock)
app.post('/api/payouts/bank-verify', verifyToken, async (req, res) => {
  try {
    const { bank_account_holder, bank_account_number, bank_ifsc } = req.body;
    if (!bank_account_holder || !bank_account_number || !bank_ifsc) {
      return res.status(400).json({ error: 'Missing bank details' });
    }
    // Simple validation mocks
    const ifscValid = /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(bank_ifsc);
    const accValid = String(bank_account_number).length >= 9 && String(bank_account_number).length <= 18;
    if (!ifscValid || !accValid) {
      return res.status(400).json({ error: 'Bank details failed verification' });
    }
    await db.promise().query(
      `INSERT INTO vendor_payout_settings (vendor_id, bank_account_holder, bank_account_number, bank_ifsc, is_bank_verified)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE bank_account_holder=VALUES(bank_account_holder), bank_account_number=VALUES(bank_account_number), bank_ifsc=VALUES(bank_ifsc), is_bank_verified=1`,
      [req.vendorId, bank_account_holder, bank_account_number, bank_ifsc]
    );
    res.json({ message: 'Bank details verified', is_bank_verified: 1 });
  } catch (e) {
    console.error('Bank verification error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manual payout request
app.post('/api/payouts/request', verifyToken, async (req, res) => {
  try {
    const { amount, method = 'bank_transfer' } = req.body;
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    // Check bank verified and minimum amount
    const [[settings]] = await db.promise().query(
      'SELECT is_bank_verified, min_payout_amount FROM vendor_payout_settings WHERE vendor_id = ?',
      [req.vendorId]
    );
    if (!settings || !settings.is_bank_verified) {
      return res.status(400).json({ error: 'Bank details not verified' });
    }
    if (amt < Number(settings.min_payout_amount || 0)) {
      return res.status(400).json({ error: `Amount below minimum payout (${settings.min_payout_amount})` });
    }
    // Create payout record (pending)
    await db.promise().query(
      `INSERT INTO payouts (vendor_id, amount, status, method) VALUES (?, ?, 'pending', ?)`,
      [req.vendorId, amt, method]
    );
    res.json({ message: 'Payout request submitted' });
  } catch (e) {
    console.error('Manual payout request error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Simple weekly auto-payout scheduler (runs hourly)
const autoPayoutScheduler = async () => {
  try {
    const current = new Date();
    const currentDow = current.getDay(); // 0=Sun..6=Sat
    // Select vendors on auto mode due today and verified
    const [rows] = await db.promise().query(
      `SELECT vps.vendor_id, vps.min_payout_amount
       FROM vendor_payout_settings vps
       WHERE vps.mode = 'auto' AND vps.day_of_week = ? AND vps.is_bank_verified = 1`,
      [currentDow]
    );
    for (const r of rows) {
      // Compute pending payout from existing summary components
      const [[{ amount: last30Paid } = {}]] = await db.promise().query(
        `SELECT IFNULL(SUM(amount),0) as amount FROM payouts WHERE vendor_id = ? AND status = 'paid' AND paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
        [r.vendor_id]
      );
      const [[{ total_earnings } = {}]] = await db.promise().query(
        `SELECT IFNULL(SUM(total_amount),0) as total_earnings FROM orders WHERE vendor_id = ?`,
        [r.vendor_id]
      );
      const [[{ pending_payout } = {}]] = await db.promise().query(
        `SELECT IFNULL(SUM(amount),0) as pending_payout FROM payouts WHERE vendor_id = ? AND status = 'pending'`,
        [r.vendor_id]
      );
      const available = Number(total_earnings || 0) - Number(last30Paid || 0) - Number(pending_payout || 0);
      if (available > 0 && available >= Number(r.min_payout_amount || 0)) {
        await db.promise().query(
          `INSERT INTO payouts (vendor_id, amount, status, method) VALUES (?, ?, 'pending', 'bank_transfer')`,
          [r.vendor_id, available]
        );
        console.log(`Auto payout created for vendor ${r.vendor_id}: ${available}`);
      }
    }
  } catch (e) {
    console.error('autoPayoutScheduler error:', e);
  }
};

setInterval(autoPayoutScheduler, 60 * 60 * 1000);
// Admin payouts endpoints
app.get('/api/admin/payouts', verifyAdmin, async (req, res) => {
  try {
    const {
      status = '',
      vendor = '',
      date_from = '',
      date_to = '',
      page = 1,
      limit = 20
    } = req.query;

    const where = [];
    const params = [];

    if (status) { where.push('p.status = ?'); params.push(status); }
    if (vendor) {
      where.push('(v.business_name LIKE ? OR v.owner_email LIKE ? OR CAST(p.vendor_id AS CHAR) LIKE ?)');
      params.push(`%${vendor}%`, `%${vendor}%`, `%${vendor}%`);
    }
    if (date_from) { where.push('p.created_at >= ?'); params.push(date_from); }
    if (date_to) { where.push('p.created_at <= ?'); params.push(date_to); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [rows] = await db.promise().query(
      `SELECT p.*, v.business_name as vendor_name, v.owner_email as vendor_email
       FROM payouts p
       JOIN vendors v ON p.vendor_id = v.id
       ${whereSql}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const [[{ total } = {}]] = await db.promise().query(
      `SELECT COUNT(*) as total
       FROM payouts p
       JOIN vendors v ON p.vendor_id = v.id
       ${whereSql}`,
      params
    );

    res.json({ items: rows, total: Number(total || 0) });
  } catch (e) {
    console.error('Admin payouts list error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Payouts summary for dashboard widgets and charts
app.get('/api/admin/payouts/summary', verifyAdmin, async (req, res) => {
  try {
    const [[totals]] = await db.promise().query(
      `SELECT 
         COALESCE(SUM(amount),0) AS total_amount,
         COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END),0) AS pending_amount,
         COALESCE(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paid_amount,
         COALESCE(SUM(CASE WHEN status='failed' THEN amount ELSE 0 END),0) AS failed_amount,
         COUNT(*) AS total_count,
         SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count,
         SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) AS paid_count,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_count
       FROM payouts`
    );

    const [trendRows] = await db.promise().query(
      `SELECT DATE(created_at) as day, 
              SUM(amount) as total,
              SUM(CASE WHEN status='paid' THEN amount ELSE 0 END) as paid,
              SUM(CASE WHEN status='pending' THEN amount ELSE 0 END) as pending,
              SUM(CASE WHEN status='failed' THEN amount ELSE 0 END) as failed
       FROM payouts
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at)
       ORDER BY day ASC`
    );

    const [vendorAgg] = await db.promise().query(
      `SELECT v.id as vendor_id, v.business_name as vendor_name, 
              SUM(p.amount) as total_amount, 
              SUM(CASE WHEN p.status='pending' THEN p.amount ELSE 0 END) as pending_amount,
              SUM(CASE WHEN p.status='paid' THEN p.amount ELSE 0 END) as paid_amount
       FROM payouts p JOIN vendors v ON v.id = p.vendor_id
       GROUP BY v.id, v.business_name
       ORDER BY paid_amount DESC
       LIMIT 20`
    );

    const [methodAgg] = await db.promise().query(
      `SELECT method, SUM(amount) as total
       FROM payouts
       GROUP BY method`
    );

    res.json({
      totals: {
        totalAmount: Number(totals?.total_amount || 0),
        pendingAmount: Number(totals?.pending_amount || 0),
        paidAmount: Number(totals?.paid_amount || 0),
        failedAmount: Number(totals?.failed_amount || 0),
        totalCount: Number(totals?.total_count || 0),
        pendingCount: Number(totals?.pending_count || 0),
        paidCount: Number(totals?.paid_count || 0),
        failedCount: Number(totals?.failed_count || 0)
      },
      trend: trendRows,
      vendorAggregation: vendorAgg,
      methodBreakdown: methodAgg
    });
  } catch (e) {
    console.error('Admin payouts summary error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/admin/payouts/:id/mark-paid', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reference } = req.body || {};
    await db.promise().query(
      `UPDATE payouts SET status='paid', reference = ?, paid_at = NOW() WHERE id = ?`,
      [reference || null, id]
    );
    await logPayoutAudit({ payoutId: Number(id), action: 'mark_paid', adminIdentifier: req.adminIdentifier || req.adminKey || 'admin', notes: reference || null });
    res.json({ message: 'Payout marked as paid' });
  } catch (e) {
    console.error('Admin mark paid error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// CSV export for admin payouts with filters
app.get('/api/admin/payouts/export', verifyAdmin, async (req, res) => {
  try {
    const {
      status = '', vendor = '', date_from = '', date_to = ''
    } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('p.status = ?'); params.push(status); }
    if (vendor) {
      where.push('(v.business_name LIKE ? OR v.owner_email LIKE ? OR CAST(p.vendor_id AS CHAR) LIKE ?)');
      params.push(`%${vendor}%`, `%${vendor}%`, `%${vendor}%`);
    }
    if (date_from) { where.push('p.created_at >= ?'); params.push(date_from); }
    if (date_to) { where.push('p.created_at <= ?'); params.push(date_to); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await db.promise().query(
      `SELECT p.id, p.vendor_id, v.business_name as vendor_name, v.owner_email as vendor_email, p.amount, p.status, p.method, p.reference, p.created_at, p.paid_at
       FROM payouts p
       JOIN vendors v ON p.vendor_id = v.id
       ${whereSql}
       ORDER BY p.created_at DESC`,
      params
    );

    const header = ['id','vendor_id','vendor_name','vendor_email','amount','status','method','reference','created_at','paid_at'];
    const csvRows = [header.join(',')].concat(rows.map(r => header.map(h => {
      const v = r[h] == null ? '' : r[h];
      const s = String(v).replace(/"/g,'""');
      return /[",\r\n]/.test(s) ? `"${s}"` : s;
    }).join(',')));
    const csv = csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payouts.csv"');
    res.send(csv);
  } catch (e) {
    console.error('Admin payouts export error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get payout details (with vendor and computed fields)
app.get('/api/admin/payouts/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [[row]] = await db.promise().query(
      `SELECT p.*, v.business_name AS vendor_name, v.owner_email AS vendor_email, v.owner_phone AS vendor_phone
       FROM payouts p JOIN vendors v ON v.id = p.vendor_id WHERE p.id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Payout not found' });
    res.json(row);
  } catch (e) {
    console.error('Admin payout details error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Get payout audit logs
app.get('/api/admin/payouts/:id/logs', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.promise().query(
      `SELECT id, payout_id, vendor_id, admin_identifier, action, amount, method, notes, created_at
       FROM payout_audit_logs WHERE payout_id = ? ORDER BY created_at DESC`,
      [id]
    );
    res.json(rows || []);
  } catch (e) {
    console.error('Admin payout logs error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Bulk update payout status
app.post('/api/admin/payouts/bulk/update-status', verifyAdmin, async (req, res) => {
  try {
    const { ids = [], status, reference = null, failure_reason = null } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
    const allowed = new Set(['pending','paid','failed']);
    if (!allowed.has(status)) return res.status(400).json({ error: 'Invalid status' });
    const conn = db;
    const placeholders = ids.map(() => '?').join(',');
    await conn.promise().query(
      `UPDATE payouts SET status = ?, reference = COALESCE(?, reference), notes = COALESCE(?, notes), 
        paid_at = CASE WHEN ? = 'paid' THEN NOW() ELSE paid_at END,
        updated_at = NOW()
       WHERE id IN (${placeholders})`,
      [status, reference, failure_reason, status, ...ids]
    );
    const adminIdentifier = req.adminIdentifier || req.adminKey || 'admin';
    for (const pid of ids) {
      const action = status === 'paid' ? 'bulk_mark_paid' : (status === 'failed' ? 'bulk_mark_failed' : 'bulk_mark_pending');
      await logPayoutAudit({ payoutId: Number(pid), action, adminIdentifier, notes: reference || failure_reason || null });
    }
    res.json({ updated: ids.length });
  } catch (e) {
    console.error('Admin bulk update status error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Download payout receipt (simple CSV receipt)
app.get('/api/admin/payouts/:id/receipt', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [[row]] = await db.promise().query(
      `SELECT p.id, p.vendor_id, v.business_name AS vendor_name, v.owner_email AS vendor_email,
              p.amount, p.status, p.method, p.reference, p.created_at, p.paid_at
       FROM payouts p JOIN vendors v ON v.id = p.vendor_id WHERE p.id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Payout not found' });
    const header = ['field','value'];
    const flat = Object.entries(row).map(([k,v]) => `${JSON.stringify(k)},${JSON.stringify(v == null ? '' : v)}`);
    const csv = [header.join(','), ...flat].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payout-${id}-receipt.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('Admin payout receipt error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Initiate a manual payout (by vendor, optional period or orders)
app.post('/api/admin/payouts/initiate', verifyAdmin, async (req, res) => {
  try {
    const { vendor_id, amount, method = 'bank_transfer', notes = null, period_start = null, period_end = null, order_ids = [] } = req.body || {};
    const adminIdentifier = req.adminIdentifier || req.adminKey || 'admin';
    if (!vendor_id || !(Number(amount) > 0)) {
      return res.status(400).json({ error: 'vendor_id and positive amount are required' });
    }
    const [ins] = await db.promise().query(
      `INSERT INTO payouts (vendor_id, amount, status, method, notes, period_start, period_end) VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
      [vendor_id, Number(amount), method, notes, period_start || null, period_end || null]
    );
    const payoutId = ins.insertId;
    // Optionally associate orders via vendor_earnings if present
    if (Array.isArray(order_ids) && order_ids.length > 0) {
      try {
        await db.promise().query(
          `UPDATE vendor_earnings SET payout_id = ? , status = 'paid' WHERE vendor_id = ? AND order_id IN (${order_ids.map(()=>'?').join(',')})`,
          [payoutId, vendor_id, ...order_ids]
        );
      } catch (_) { /* ignore if table missing */ }
    }
    await logPayoutAudit({ payoutId, vendorId: vendor_id, action: 'initiate', amount: Number(amount), method, adminIdentifier, notes });
    res.json({ id: payoutId, message: 'Payout initiated' });
  } catch (e) {
    console.error('Admin initiate payout error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Update payout status (approve, reject, fail, refund)
app.put('/api/admin/payouts/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reference = null, failure_reason = null, notes = null } = req.body || {};
    const allowed = new Set(['pending','paid','failed']);
    if (!allowed.has(status)) return res.status(400).json({ error: 'Invalid status' });
    await db.promise().query(
      `UPDATE payouts SET status = ?, reference = COALESCE(?, reference), notes = COALESCE(?, notes), updated_at = NOW() WHERE id = ?`,
      [status, reference, failure_reason || notes || null, id]
    );
    const action = status === 'paid' ? 'approve' : (status === 'failed' ? 'fail' : 'approve');
    await logPayoutAudit({ payoutId: Number(id), action, adminIdentifier: req.adminIdentifier || req.adminKey || 'admin', notes: reference || failure_reason || notes || null });
    res.json({ message: 'Payout status updated' });
  } catch (e) {
    console.error('Admin payout status update error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Vendor payouts view with balances and bank/UPI details
app.get('/api/admin/vendors/payouts', verifyAdmin, async (req, res) => {
  try {
    const { vendor = '', page = 1, limit = 20 } = req.query;
    const where = [];
    const params = [];
    if (vendor) { where.push('(v.business_name LIKE ? OR v.owner_email LIKE ? OR CAST(v.id AS CHAR) LIKE ?)'); params.push(`%${vendor}%`,`%${vendor}%`,`%${vendor}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [rows] = await db.promise().query(
      `SELECT 
         v.id as vendor_id,
         v.business_name as vendor_name,
         v.owner_email as contact_email,
         v.owner_phone as contact_phone,
         COALESCE(SUM(o.total_amount),0) as total_earnings,
         (
           SELECT COALESCE(SUM(p1.amount),0) FROM payouts p1 WHERE p1.vendor_id = v.id AND p1.status = 'pending'
         ) as pending_balance,
         (
           SELECT p2.paid_at FROM payouts p2 WHERE p2.vendor_id = v.id AND p2.status='paid' ORDER BY p2.paid_at DESC LIMIT 1
         ) as last_payout_at,
         (
           SELECT CONCAT(COALESCE(s.bank_account_holder,''),' | ',COALESCE(s.bank_account_number,''),' | ',COALESCE(s.bank_ifsc,''))
           FROM vendor_payout_settings s WHERE s.vendor_id = v.id
         ) as bank_details
       FROM vendors v
       LEFT JOIN orders o ON o.vendor_id = v.id
       ${whereSql}
       GROUP BY v.id, v.business_name, v.owner_email, v.owner_phone
       ORDER BY v.id DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    const [[{ total } = {}]] = await db.promise().query(
      `SELECT COUNT(*) as total FROM vendors v ${whereSql}`,
      params
    );
    res.json({ items: rows, total: Number(total || 0) });
  } catch (e) {
    console.error('Admin vendors payouts error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: List all KYC documents with filters
app.get('/api/admin/kyc-documents', verifyAdmin, async (req, res) => {
  try {
    const {
      vendor = '',
      document_type = '',
      status = '',
      verification_status = '',
      expiry_from = '',
      expiry_to = '',
      submitted_from = '',
      submitted_to = '',
      page = 1,
      limit = 20
    } = req.query;

    const where = [];
    const params = [];

    if (vendor) {
      where.push('(v.shop_name LIKE ? OR v.owner_name LIKE ? OR CAST(v.id AS CHAR) LIKE ? )');
      params.push(`%${vendor}%`, `%${vendor}%`, `%${vendor}%`);
    }
    if (document_type) { where.push('kd.document_type = ?'); params.push(document_type); }
    if (status) { where.push('kd.doc_status = ?'); params.push(status.toUpperCase()); }
    if (verification_status) { where.push('kd.verification_status = ?'); params.push(verification_status.toUpperCase()); }
    // expiry_date may not exist on all environments; ignore expiry filters if column is absent
    if (submitted_from) { where.push('kd.uploaded_at >= ?'); params.push(submitted_from); }
    if (submitted_to) { where.push('kd.uploaded_at <= ?'); params.push(submitted_to); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [rows] = await db.promise().query(
      `SELECT kd.id,
              kd.vendor_id,
              v.shop_name as vendor_name,
              v.owner_name,
              kd.document_type,
              kd.uploaded_at,
              kd.doc_status,
              kd.original_name,
              kd.verification_status,
              kd.verification_mismatches,
              (
                SELECT l.admin_identifier
                FROM kyc_audit_logs l
                WHERE l.document_id = kd.id AND l.action IN ('approve','reject','verify')
                ORDER BY l.created_at DESC
                LIMIT 1
              ) AS verified_by
       FROM kyc_documents kd
       JOIN vendors v ON v.id = kd.vendor_id
       ${whereSql}
       ORDER BY kd.uploaded_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const [[{ total } = {}]] = await db.promise().query(
      `SELECT COUNT(*) as total
       FROM kyc_documents kd
       JOIN vendors v ON v.id = kd.vendor_id
       ${whereSql}`,
      params
    );

    res.json({ items: rows, total: Number(total || 0) });
  } catch (e) {
    console.error('Admin list KYC documents error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Admin: KYC dashboard summary with filters and expiring alerts
app.get('/api/admin/kyc-summary', verifyAdmin, async (req, res) => {
  try {
    const {
      vendor = '',
      document_type = '',
      status = '',
      date_from = '',
      date_to = ''
    } = req.query;

    const where = [];
    const params = [];

    if (vendor) {
      where.push('(v.shop_name LIKE ? OR v.owner_name LIKE ? OR CAST(v.id AS CHAR) LIKE ? )');
      params.push(`%${vendor}%`, `%${vendor}%`, `%${vendor}%`);
    }
    if (document_type) { where.push('kd.document_type = ?'); params.push(document_type); }
    if (status) { where.push('kd.doc_status = ?'); params.push(status.toUpperCase()); }
    if (date_from) { where.push('kd.uploaded_at >= ?'); params.push(date_from); }
    if (date_to) { where.push('kd.uploaded_at <= ?'); params.push(date_to); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[vendorCount]] = await db.promise().query(
      `SELECT COUNT(DISTINCT kd.vendor_id) as c
       FROM kyc_documents kd
       JOIN vendors v ON v.id = kd.vendor_id
       ${whereSql}`,
      params
    );

    const [[docCount]] = await db.promise().query(
      `SELECT COUNT(*) as c
       FROM kyc_documents kd
       JOIN vendors v ON v.id = kd.vendor_id
       ${whereSql}`,
      params
    );

    const [[verifiedCount]] = await db.promise().query(
      `SELECT COUNT(*) as c
       FROM kyc_documents kd
       JOIN vendors v ON v.id = kd.vendor_id
       ${whereSql} ${whereSql ? ' AND ' : ' WHERE '} kd.verification_status = 'VERIFIED'`,
      params
    );

    const [[rejectedCount]] = await db.promise().query(
      `SELECT COUNT(*) as c
       FROM kyc_documents kd
       JOIN vendors v ON v.id = kd.vendor_id
       ${whereSql} ${whereSql ? ' AND ' : ' WHERE '} kd.verification_status = 'REJECTED'`,
      params
    );

    const [[pendingCount]] = await db.promise().query(
      `SELECT COUNT(*) as c
       FROM kyc_documents kd
       JOIN vendors v ON v.id = kd.vendor_id
       ${whereSql} ${whereSql ? ' AND ' : ' WHERE '} (kd.verification_status IS NULL OR kd.verification_status = 'PENDING')`,
      params
    );

    // Expiring alerts use retention_until for now (expiry_date may be absent)
    const [expiring30] = await db.promise().query(
      `SELECT COUNT(*) as c FROM kyc_documents kd JOIN vendors v ON v.id = kd.vendor_id
       ${whereSql} ${whereSql ? ' AND ' : ' WHERE '} kd.retention_until IS NOT NULL AND kd.retention_until <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)`,
      params
    );
    const [expiring60] = await db.promise().query(
      `SELECT COUNT(*) as c FROM kyc_documents kd JOIN vendors v ON v.id = kd.vendor_id
       ${whereSql} ${whereSql ? ' AND ' : ' WHERE '} kd.retention_until IS NOT NULL AND kd.retention_until <= DATE_ADD(CURDATE(), INTERVAL 60 DAY)`,
      params
    );
    const [expiring90] = await db.promise().query(
      `SELECT COUNT(*) as c FROM kyc_documents kd JOIN vendors v ON v.id = kd.vendor_id
       ${whereSql} ${whereSql ? ' AND ' : ' WHERE '} kd.retention_until IS NOT NULL AND kd.retention_until <= DATE_ADD(CURDATE(), INTERVAL 90 DAY)`,
      params
    );

    res.json({
      totalVendors: Number(vendorCount?.c || 0),
      totalDocuments: Number(docCount?.c || 0),
      verifiedDocuments: Number(verifiedCount?.c || 0),
      rejectedDocuments: Number(rejectedCount?.c || 0),
      pendingVerification: Number(pendingCount?.c || 0),
      expiring: {
        days30: Number(expiring30?.[0]?.c || 0),
        days60: Number(expiring60?.[0]?.c || 0),
        days90: Number(expiring90?.[0]?.c || 0)
      }
    });
  } catch (e) {
    console.error('Admin KYC summary error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: KYC audit logs (searchable, filterable)
app.get('/api/admin/kyc-audit', verifyAdmin, async (req, res) => {
  try {
    const {
      vendor = '',
      document_id = '',
      action = '',
      admin = '',
      date_from = '',
      date_to = '',
      page = 1,
      limit = 50
    } = req.query;

    const where = [];
    const params = [];

    if (vendor) {
      where.push('(kal.vendor_id = ? OR v.shop_name LIKE ? OR v.owner_name LIKE ? OR CAST(v.id AS CHAR) LIKE ?)');
      params.push(vendor, `%${vendor}%`, `%${vendor}%`, `%${vendor}%`);
    }
    if (document_id) { where.push('kal.document_id = ?'); params.push(document_id); }
    if (action) { where.push('kal.action = ?'); params.push(action); }
    if (admin) { where.push('(kal.admin_identifier = ? OR kal.admin_identifier LIKE ?)'); params.push(admin, `%${admin}%`); }
    if (date_from) { where.push('kal.created_at >= ?'); params.push(date_from); }
    if (date_to) { where.push('kal.created_at <= ?'); params.push(date_to); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [rows] = await db.promise().query(
      `SELECT kal.id, kal.vendor_id, kal.document_id, kal.admin_identifier, kal.action, kal.notes, kal.created_at,
              v.shop_name as vendor_name, kd.document_type, kd.original_name
       FROM kyc_audit_logs kal
       LEFT JOIN vendors v ON v.id = kal.vendor_id
       LEFT JOIN kyc_documents kd ON kd.id = kal.document_id
       ${whereSql}
       ORDER BY kal.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const [[{ total } = {}]] = await db.promise().query(
      `SELECT COUNT(*) as total
       FROM kyc_audit_logs kal
       LEFT JOIN vendors v ON v.id = kal.vendor_id
       LEFT JOIN kyc_documents kd ON kd.id = kal.document_id
       ${whereSql}`,
      params
    );

    res.json({ items: rows, total: Number(total || 0) });
  } catch (e) {
    console.error('Admin KYC audit list error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Secure download of a KYC document (admin-only, with audit)
app.get('/api/admin/kyc-documents/:docId/download', verifyAdmin, async (req, res) => {
  try {
    const { docId } = req.params;
    const [[doc]] = await db.promise().query(
      `SELECT kd.id, kd.vendor_id, kd.file_path, kd.mime_type, kd.original_name, kd.storage_class
       FROM kyc_documents kd WHERE kd.id = ?`,
      [docId]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Audit access
    await db.promise().query(
      `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes)
       VALUES (?, ?, ?, 'download', 'Admin downloaded document')`,
      [doc.vendor_id, docId, req.adminId || 'admin-api-key']
    );

    const path = require('path');
    const fs = require('fs');
    const absolute = path.resolve(doc.file_path);
    if (!fs.existsSync(absolute)) return res.status(404).json({ error: 'File not found' });

    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.original_name || 'document')}"`);
    fs.createReadStream(absolute).pipe(res);
  } catch (e) {
    console.error('Admin KYC download error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Verify OCR against expected fields and set verification status
app.post('/api/admin/kyc/:docId/verify', verifyAdmin, async (req, res) => {
  try {
    const { docId } = req.params;
    const { expected = {} } = req.body || {};
    const [[doc]] = await db.promise().query('SELECT id, vendor_id, ocr_text FROM kyc_documents WHERE id = ?', [docId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const mismatches = [];
    const text = String(doc.ocr_text || '').toLowerCase();
    Object.entries(expected || {}).forEach(([k, v]) => {
      if (v && !text.includes(String(v).toLowerCase())) mismatches.push(k);
    });

    const status = mismatches.length ? 'REJECTED' : 'VERIFIED';

    await db.promise().query(
      `UPDATE kyc_documents SET verification_status = ?, verification_mismatches = ?, verification_checked_at = NOW() WHERE id = ?`,
      [status, JSON.stringify(mismatches), docId]
    );

    await db.promise().query(
      `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes) VALUES (?, ?, 'admin-api-key', 'verify', ?)`,
      [doc.vendor_id, docId, status]
    );

    res.json({ message: 'Verification complete', status, mismatches });
  } catch (e) {
    console.error('Admin KYC verify error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Update KYC document status (approve/reject/flag/manual transitions)
app.put('/api/admin/kyc-documents/:docId/status', verifyAdmin, async (req, res) => {
  try {
    const { docId } = req.params;
    const { status, notes } = req.body || {};
    const desired = String(status || '').toUpperCase();
    if (!desired) return res.status(400).json({ error: 'status is required' });

    const [[doc]] = await db.promise().query(
      'SELECT id, vendor_id, doc_status FROM kyc_documents WHERE id = ? LIMIT 1',
      [docId]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const current = String(doc.doc_status || 'UPLOADED').toUpperCase();
    const allowed = DOC_ALLOWED_NEXT[current] || [];
    if (!allowed.includes(desired)) {
      return res.status(400).json({ error: `Invalid transition from ${current} to ${desired}` });
    }

    await db.promise().query(
      'UPDATE kyc_documents SET doc_status = ?, doc_status_notes = ?, doc_status_updated_at = NOW(), verification_status = CASE WHEN ? IN ("APPROVED") THEN "VERIFIED" WHEN ? IN ("REJECTED") THEN "REJECTED" ELSE verification_status END, verification_checked_at = NOW() WHERE id = ?',
      [desired, notes || null, desired, desired, docId]
    );

    await db.promise().query(
      `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [doc.vendor_id, docId, 'admin-api-key', desired.toLowerCase(), notes || null]
    );

    // Record vendor notification audit event (for compliance traceability)
    try {
      await db.promise().query(
        `INSERT INTO kyc_audit_logs (vendor_id, document_id, admin_identifier, action, notes)
         VALUES (?, ?, ?, 'notify', CONCAT('Vendor notified of ', ?))`,
        [doc.vendor_id, docId, 'admin-api-key', desired]
      );
    } catch (_) {}

    res.json({ message: 'Document status updated', from: current, to: desired });
  } catch (e) {
    console.error('Admin KYC document status update error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Get order reassignments
app.get('/api/orders/reassignments', verifyToken, async (req, res) => {
  try {
    const reassignments = await db.promise().query(
      `SELECT or.*, o.order_number, 
              fv.business_name as from_vendor_name,
              tv.business_name as to_vendor_name
       FROM order_reassignments or
       JOIN orders o ON or.order_id = o.id
       LEFT JOIN vendors fv ON or.from_vendor_id = fv.id
       LEFT JOIN vendors tv ON or.to_vendor_id = tv.id
       WHERE o.vendor_id = ? OR or.from_vendor_id = ? OR or.to_vendor_id = ?
       ORDER BY or.created_at DESC`,
      [req.vendorId, req.vendorId, req.vendorId]
    );
    
    res.json(reassignments[0]);
  } catch (error) {
    console.error('Get reassignments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ADMIN ORDER MANAGEMENT ROUTES

// Get all orders for admin (across all vendors)
app.get('/api/admin/orders', verifyAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      status = '',
      vendor_id = '',
      search = '',
      payment_status = '',
      order_id = '',
      order_number = '',
      date_from = '',
      date_to = ''
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    const whereClauses = ['1=1'];
    const params = [];

    if (status) {
      whereClauses.push('o.status = ?');
      params.push(status);
    }

    if (vendor_id) {
      whereClauses.push('o.vendor_id = ?');
      params.push(vendor_id);
    }

    if (payment_status) {
      whereClauses.push('o.payment_status = ?');
      params.push(payment_status);
    }

    if (order_id) {
      whereClauses.push('o.id = ?');
      params.push(order_id);
    }

    if (order_number) {
      whereClauses.push('o.order_number LIKE ?');
      params.push(`%${order_number}%`);
    }

    if (search) {
      whereClauses.push(`(
        o.order_number LIKE ? 
        OR v.business_name LIKE ? 
        OR o.customer_name LIKE ? 
        OR o.customer_phone LIKE ? 
        OR o.customer_address LIKE ?
        OR o.shipping_address LIKE ?
      )`);
      params.push(
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`
      );
    }

    if (date_from) {
      whereClauses.push('DATE(o.created_at) >= ?');
      params.push(date_from);
    }

    if (date_to) {
      whereClauses.push('DATE(o.created_at) <= ?');
      params.push(date_to);
    }

    const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

    const listQuery = `
      SELECT 
        o.*,
        v.business_name as vendor_name,
        v.owner_email as vendor_email,
        COUNT(oi.id) as item_count,
        COALESCE(SUM(oi.quantity), 0) as total_quantity,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0) as subtotal_amount,
        GREATEST(COALESCE(o.total_amount, 0) - COALESCE(SUM(oi.quantity * oi.unit_price), 0), 0) as tax_amount,
        o.sla_deadline as expected_delivery_date,
        CASE 
          WHEN o.sla_deadline IS NOT NULL AND o.sla_deadline < NOW() AND o.status IN ('placed', 'pending') THEN 'sla_breached'
          WHEN o.sla_deadline IS NOT NULL AND o.sla_deadline < DATE_ADD(NOW(), INTERVAL 5 MINUTE) AND o.status IN ('placed', 'pending') THEN 'sla_warning'
          ELSE 'normal'
        END as sla_status
      FROM orders o
      LEFT JOIN vendors v ON o.vendor_id = v.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      ${whereSql}
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const listParams = [...params, limitNum, offset];
    const [rows] = await db.promise().query(listQuery, listParams);

    const countQuery = `
      SELECT COUNT(*) as total
      FROM orders o
      LEFT JOIN vendors v ON o.vendor_id = v.id
      ${whereSql}
    `;
    const [[countRow]] = await db.promise().query(countQuery, params);
    const total = Number(countRow?.total || 0);

    const statusMap = {
      pending: 'placed',
      shipped: 'out_for_delivery'
    };

    const normalizedOrders = rows.map((row) => {
      const shippingAddress = row.shipping_address || row.customer_address || row.delivery_address || '';
      const paymentMode = row.payment_mode || row.payment_method || row.transaction_mode || '';
      const subtotalAmount = Number(row.subtotal_amount || 0);
      const taxAmount = Number(row.tax_amount || 0);
      const totalAmount = row.total_amount !== null && row.total_amount !== undefined
        ? Number(row.total_amount)
        : subtotalAmount + taxAmount;

      return {
        ...row,
        status_original: row.status,
        status: row.status ? (statusMap[row.status] || row.status) : 'placed',
        shipping_address: shippingAddress,
        payment_mode: paymentMode,
        subtotal_amount: subtotalAmount,
        tax_amount: taxAmount,
        total_amount: totalAmount,
        item_count: Number(row.item_count || 0),
        total_quantity: Number(row.total_quantity || 0)
      };
    });

    res.json({
      orders: normalizedOrders,
      pagination: {
        total_orders: total,
        current_page: pageNum,
        per_page: limitNum,
        total_pages: total > 0 ? Math.ceil(total / limitNum) : 1,
        has_next: offset + normalizedOrders.length < total,
        has_prev: offset > 0
      }
    });
  } catch (error) {
    console.error('Admin get orders error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get order details for admin
app.get('/api/admin/orders/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get order with vendor info
    const orderResult = await db.promise().query(`
      SELECT o.*, v.business_name as vendor_name, v.owner_email as vendor_email
      FROM orders o
      LEFT JOIN vendors v ON o.vendor_id = v.id
      WHERE o.id = ?
    `, [id]);
    
    if (orderResult[0].length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderResult[0][0];
    
    // Get order items
    const itemsResult = await db.promise().query(`
      SELECT oi.*, p.name as product_name, p.sku, p.category
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `, [id]);
    
    order.items = itemsResult[0];
    
    res.json(order);
  } catch (error) {
    console.error('Admin get order details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single order details (vendor scoped)
app.get('/api/orders/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [orderRows] = await db.promise().query(
      `SELECT o.* FROM orders o WHERE o.id = ? AND o.vendor_id = ? LIMIT 1`,
      [id, req.vendorId]
    );
    if (!orderRows || orderRows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderRows[0];
    const [itemsRows] = await db.promise().query(
      `SELECT oi.*, p.name as product_name, p.sku, p.category
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = ?`,
      [id]
    );
    order.items = itemsRows;
    return res.json(order);
  } catch (e) {
    console.error('Vendor get order details error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reassign order to different vendor (admin only)
app.put('/api/admin/orders/:id/reassign', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { vendor_id, reason } = req.body;
    
    if (!vendor_id) {
      return res.status(400).json({ error: 'Vendor ID is required' });
    }
    
    // Check if order exists
    const orderResult = await db.promise().query(
      'SELECT id, vendor_id, status FROM orders WHERE id = ?',
      [id]
    );
    
    if (orderResult[0].length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderResult[0][0];
    
    // Check if new vendor exists and is approved
    const vendorResult = await db.promise().query(
      'SELECT id, business_name, status FROM vendors WHERE id = ? AND status = "APPROVED"',
      [vendor_id]
    );
    
    if (vendorResult[0].length === 0) {
      return res.status(400).json({ error: 'Vendor not found or not approved' });
    }
    
    const newVendor = vendorResult[0][0];
    
    // Check if order can be reassigned
    if (['delivered', 'cancelled', 'rejected'].includes(order.status)) {
      return res.status(400).json({ error: 'Cannot reassign completed orders' });
    }
    
    // Start transaction
    await db.promise().query('START TRANSACTION');
    
    try {
      // Create reassignment record
      await db.promise().query(`
        INSERT INTO order_reassignments (order_id, from_vendor_id, to_vendor_id, reason, created_by, created_at)
        VALUES (?, ?, ?, ?, 'admin', NOW())
      `, [id, order.vendor_id, vendor_id, reason || 'Admin reassignment']);
      
      // Update order vendor
      await db.promise().query(
        'UPDATE orders SET vendor_id = ?, updated_at = NOW() WHERE id = ?',
        [vendor_id, id]
      );
      
      // If order was in progress, reset to placed status for new vendor
      if (['confirmed', 'packing', 'ready', 'out_for_delivery'].includes(order.status)) {
        await db.promise().query(
          'UPDATE orders SET status = "placed", updated_at = NOW() WHERE id = ?',
          [id]
        );
      }
      
      await db.promise().query('COMMIT');
      
      // Emit order update via WebSocket
      const orderData = {
        id: parseInt(id),
        vendor_id: parseInt(vendor_id),
        vendor_name: newVendor.business_name,
        status: ['confirmed', 'packing', 'ready', 'out_for_delivery'].includes(order.status) ? 'placed' : order.status,
        action: 'reassigned',
        reassign_reason: reason,
        updated_at: new Date()
      };
      
      // Notify both old and new vendors
      emitOrderUpdate(order.vendor_id, orderData);
      emitOrderUpdate(vendor_id, orderData);
      emitAdminOrderUpdate(orderData);

      // Log action
      try {
        await db.promise().query(
          `INSERT INTO order_action_logs (order_id, action, from_value, to_value, reason, created_by)
           VALUES (?, 'reassign', ?, ?, ?, 'admin')`,
          [id, String(order.vendor_id), String(vendor_id), reason || null]
        );
      } catch (_) {}
      
      res.json({ 
        message: 'Order reassigned successfully',
        new_vendor: newVendor.business_name
      });
      
    } catch (error) {
      await db.promise().query('ROLLBACK');
      throw error;
    }
    
  } catch (error) {
    console.error('Admin reassign order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update order status (admin override)
app.put('/api/admin/orders/:id/status', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    // Validate status
    const validStatuses = ['placed', 'confirmed', 'packing', 'ready', 'out_for_delivery', 'delivered', 'cancelled', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    // Check if order exists
    const orderResult = await db.promise().query(
      'SELECT id, vendor_id, status FROM orders WHERE id = ?',
      [id]
    );
    
    if (orderResult[0].length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderResult[0][0];
    
    // Update order status with appropriate timestamp
    let timestampField = '';
    switch (status) {
      case 'confirmed':
        timestampField = 'confirmed_at = NOW()';
        break;
      case 'packing':
        timestampField = 'packing_at = NOW()';
        break;
      case 'ready':
        timestampField = 'ready_at = NOW()';
        break;
      case 'out_for_delivery':
        timestampField = 'out_for_delivery_at = NOW()';
        break;
      case 'delivered':
        timestampField = 'delivered_at = NOW()';
        break;
    }
    
    const updateQuery = timestampField 
      ? `UPDATE orders SET status = ?, ${timestampField}, updated_at = NOW() WHERE id = ?`
      : `UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?`;
    
    await db.promise().query(updateQuery, [status, id]);

    // Log status change
    try {
      await db.promise().query(
        `INSERT INTO order_action_logs (order_id, action, from_value, to_value, reason, created_by)
         VALUES (?, 'status_update', ?, ?, NULL, 'admin')`,
        [id, order.status, status]
      );
    } catch (_) {}
    
    // Inventory integration for admin driven status
    if (['confirmed', 'out_for_delivery', 'delivered'].includes(status)) {
      const [orderItems] = await db.promise().query(
        'SELECT id, product_id, reserved_quantity FROM order_items WHERE order_id = ?',
        [id]
      );
      for (const item of orderItems) {
        const toCommit = Number(item.reserved_quantity || 0);
        if (toCommit > 0) {
          await db.promise().query('CALL CommitStock(?, ?, ?, ?, ?)', [
            item.product_id, toCommit, 'order', id, order.vendor_id
          ]);
          await db.promise().query('UPDATE order_items SET reserved_quantity = 0 WHERE id = ?', [item.id]);
        }
      }
    }
    
    // Emit order update via WebSocket
    const orderData = {
      id: parseInt(id),
      status: status,
      action: 'status_updated',
      updated_at: new Date()
    };
    emitOrderUpdate(order.vendor_id, orderData);
    emitAdminOrderUpdate(orderData);
    
    res.json({ message: `Order status updated to ${status} successfully` });
  } catch (error) {
    console.error('Admin update order status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cancel order (admin) with reason logging and stock release
app.put('/api/admin/orders/:id/cancel', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    const [[order]] = await db.promise().query(
      'SELECT id, vendor_id, status FROM orders WHERE id = ? LIMIT 1',
      [id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (['delivered', 'cancelled', 'rejected'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot cancel order in status ${order.status}` });
    }

    const [orderItems] = await db.promise().query(
      'SELECT id, product_id, reserved_quantity FROM order_items WHERE order_id = ?',
      [id]
    );
    for (const item of orderItems) {
      const toRelease = Number(item.reserved_quantity || 0);
      if (toRelease > 0) {
        try {
          await db.promise().query('CALL ReleaseStock(?, ?, ?, ?, ?)', [
            item.product_id, toRelease, 'order', id, order.vendor_id
          ]);
          await db.promise().query('UPDATE order_items SET reserved_quantity = 0 WHERE id = ?', [item.id]);
        } catch (_) {}
      }
    }

    await db.promise().query(
      'UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?',
      ['cancelled', id]
    );

    // Log cancel
    try {
      await db.promise().query(
        `INSERT INTO order_action_logs (order_id, action, from_value, to_value, reason, created_by)
         VALUES (?, 'cancel', ?, 'cancelled', ?, 'admin')`,
        [id, order.status, reason || null]
      );
    } catch (_) {}

    // Emit updates
    const payload = { id: parseInt(id), status: 'cancelled', action: 'status_updated', updated_at: new Date() };
    emitOrderUpdate(order.vendor_id, payload);
    emitAdminOrderUpdate(payload);

    return res.json({ message: 'Order cancelled successfully' });
  } catch (e) {
    console.error('Admin cancel order error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Refund order payment (admin) with reason logging
app.put('/api/admin/orders/:id/refund', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    const [[order]] = await db.promise().query(
      'SELECT id, vendor_id, payment_status FROM orders WHERE id = ? LIMIT 1',
      [id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status === 'refunded') {
      return res.status(400).json({ error: 'Order is already refunded' });
    }

    await db.promise().query(
      'UPDATE orders SET payment_status = ?, updated_at = NOW() WHERE id = ?',
      ['refunded', id]
    );

    // Log refund
    try {
      await db.promise().query(
        `INSERT INTO order_action_logs (order_id, action, from_value, to_value, reason, created_by)
         VALUES (?, 'refund', ?, 'refunded', ?, 'admin')`,
        [id, order.payment_status, reason || null]
      );
    } catch (_) {}

    // Emit updates
    const payload = { id: parseInt(id), payment_status: 'refunded', action: 'payment_updated', updated_at: new Date() };
    emitOrderUpdate(order.vendor_id, payload);
    emitAdminOrderUpdate(payload);

    return res.json({ message: 'Order refunded successfully' });
  } catch (e) {
    console.error('Admin refund order error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get order reassignment history (admin)
app.get('/api/admin/orders/:id/reassignments', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const reassignments = await db.promise().query(`
      SELECT or.*, 
             fv.business_name as from_vendor_name,
             tv.business_name as to_vendor_name
      FROM order_reassignments or
      LEFT JOIN vendors fv ON or.from_vendor_id = fv.id
      LEFT JOIN vendors tv ON or.to_vendor_id = tv.id
      WHERE or.order_id = ?
      ORDER BY or.created_at DESC
    `, [id]);
    
    res.json(reassignments[0]);
  } catch (error) {
    console.error('Admin get order reassignments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get audit logs for a specific order (admin)
app.get('/api/admin/orders/:id/audit-logs', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [logs] = await db.promise().query(
      `SELECT id, order_id, action, from_value, to_value, reason, created_by, created_at
       FROM order_action_logs
       WHERE order_id = ?
       ORDER BY created_at DESC, id DESC`,
      [id]
    );
    res.json(logs);
  } catch (e) {
    console.error('Admin get order audit logs error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Get order statistics for admin dashboard
app.get('/api/admin/orders/stats', verifyAdmin, async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    
    let dateFilter = '';
    let params = [];
    
    if (date_from && date_to) {
      dateFilter = 'WHERE o.created_at BETWEEN ? AND ?';
      params = [date_from, date_to];
    }
    
    const stats = await db.promise().query(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN o.status = 'placed' THEN 1 ELSE 0 END) as pending_orders,
        SUM(CASE WHEN o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery') THEN 1 ELSE 0 END) as active_orders,
        SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) as delivered_orders,
        SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        SUM(CASE WHEN o.status = 'rejected' THEN 1 ELSE 0 END) as rejected_orders,
        SUM(CASE WHEN o.sla_deadline < NOW() AND o.status = 'placed' THEN 1 ELSE 0 END) as sla_breached_orders,
        SUM(o.total_amount) as total_revenue,
        AVG(o.total_amount) as avg_order_value
      FROM orders o
      ${dateFilter}
    `, params);
    
    res.json(stats[0][0]);
  } catch (error) {
    console.error('Admin get order stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin analytics: summary cards (today/week/month)
app.get('/api/admin/reports/summary', verifyAdmin, async (req, res) => {
  try {
    const [[today]] = await db.promise().query(`
      SELECT 
        COUNT(*) AS total_orders,
        SUM(CASE WHEN status = 'placed' THEN 1 ELSE 0 END) AS pending_orders,
        SUM(CASE WHEN status IN ('out_for_delivery','ready','packing','confirmed') THEN 1 ELSE 0 END) AS active_orders,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered_orders,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_orders,
        SUM(CASE WHEN payment_status = 'refunded' THEN 1 ELSE 0 END) AS refunds_issued,
        SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END) AS total_revenue
      FROM orders WHERE DATE(created_at) = CURDATE()`);

    const [[week]] = await db.promise().query(`
      SELECT 
        COUNT(*) AS total_orders,
        SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END) AS total_revenue
      FROM orders WHERE YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)`);

    const [[month]] = await db.promise().query(`
      SELECT 
        COUNT(*) AS total_orders,
        SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END) AS total_revenue
      FROM orders WHERE YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())`);

    res.json({ today, week, month });
  } catch (e) {
    console.error('Admin reports summary error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin analytics: orders trend
app.get('/api/admin/reports/trend', verifyAdmin, async (req, res) => {
  try {
    const { granularity = 'daily', days = 30 } = req.query;
    if (granularity === 'daily') {
      const [rows] = await db.promise().query(`
        SELECT DATE(created_at) as period,
               COUNT(*) as orders,
               SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END) as revenue
        FROM orders
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY DATE(created_at)
        ORDER BY period ASC
      `, [Number(days) || 30]);
      return res.json(rows);
    }
    if (granularity === 'weekly') {
      const [rows] = await db.promise().query(`
        SELECT YEARWEEK(created_at, 1) as period,
               COUNT(*) as orders,
               SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END) as revenue
        FROM orders
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY YEARWEEK(created_at, 1)
        ORDER BY period ASC
      `, [Number(days) || 180]);
      return res.json(rows);
    }
    // monthly
    const [rows] = await db.promise().query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m-01') as period,
             COUNT(*) as orders,
             SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END) as revenue
      FROM orders
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      ORDER BY period ASC
    `);
    res.json(rows);
  } catch (e) {
    console.error('Admin reports trend error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin analytics: top vendors by orders and revenue
app.get('/api/admin/reports/top-vendors', verifyAdmin, async (req, res) => {
  try {
    const { limit = 10, date_from = '', date_to = '' } = req.query;
    const where = [];
    const params = [];
    if (date_from && date_to) { where.push('o.created_at BETWEEN ? AND ?'); params.push(date_from, date_to); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await db.promise().query(`
      SELECT v.id as vendor_id, v.business_name as vendor_name,
             COUNT(o.id) as order_count,
             SUM(CASE WHEN o.payment_status = 'paid' THEN o.total_amount ELSE 0 END) as revenue
      FROM orders o
      LEFT JOIN vendors v ON o.vendor_id = v.id
      ${whereSql}
      GROUP BY v.id
      ORDER BY revenue DESC, order_count DESC
      LIMIT ?
    `, [...params, parseInt(limit)]);
    res.json(rows);
  } catch (e) {
    console.error('Admin reports top vendors error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin analytics: top selling products
app.get('/api/admin/reports/top-products', verifyAdmin, async (req, res) => {
  try {
    const { limit = 10, date_from = '', date_to = '' } = req.query;
    const where = [];
    const params = [];
    if (date_from && date_to) { where.push('o.created_at BETWEEN ? AND ?'); params.push(date_from, date_to); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await db.promise().query(`
      SELECT p.id as product_id, p.name as product_name, p.category,
             SUM(oi.quantity) as sales,
             SUM(oi.total_price) as revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN products p ON oi.product_id = p.id
      ${whereSql}
      GROUP BY p.id
      ORDER BY sales DESC, revenue DESC
      LIMIT ?
    `, [...params, parseInt(limit)]);
    res.json(rows);
  } catch (e) {
    console.error('Admin reports top products error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Import utility modules
const { encrypt, decrypt, createAccountHash, verifyAccountHash } = require('./utils/encryption');
const { 
  validateIFSCFormat, 
  getBankDetailsFromIFSC, 
  validateUPIFormat, 
  validateAccountNumber, 
  validateAccountHolderName 
} = require('./utils/ifscValidator');

// VENDOR BANK DETAILS API ENDPOINTS

// Save vendor bank details
app.post('/api/vendor/bank-details', verifyToken, upload.single('cancelled_cheque'), async (req, res) => {
  try {
    const {
      account_holder_name,
      account_number,
      account_number_confirm,
      ifsc_code,
      upi_id
    } = req.body;

    // Validation
    if (!account_holder_name || !account_number || !ifsc_code) {
      return res.status(400).json({ error: 'Account holder name, account number, and IFSC code are required' });
    }

    if (account_number !== account_number_confirm) {
      return res.status(400).json({ error: 'Account numbers do not match' });
    }

    if (!validateAccountHolderName(account_holder_name)) {
      return res.status(400).json({ error: 'Invalid account holder name format' });
    }

    if (!validateAccountNumber(account_number)) {
      return res.status(400).json({ error: 'Invalid account number format' });
    }

    if (!validateIFSCFormat(ifsc_code)) {
      return res.status(400).json({ error: 'Invalid IFSC code format' });
    }

    if (upi_id && !validateUPIFormat(upi_id)) {
      return res.status(400).json({ error: 'Invalid UPI ID format' });
    }

    // Get bank details from IFSC
    const bankDetails = await getBankDetailsFromIFSC(ifsc_code);
    if (!bankDetails) {
      return res.status(400).json({ error: 'Invalid IFSC code or bank not found' });
    }

    // Encrypt account number
    const encryptedAccountNumber = encrypt(account_number);
    const accountHash = createAccountHash(account_number);

    // Handle cancelled cheque upload
    let cancelledChequePath = null;
    if (req.file) {
      cancelledChequePath = req.file.path;
    }

    // Save or update bank details
    const [result] = await db.promise().query(`
      INSERT INTO vendor_bank_details 
      (vendor_id, account_holder_name, account_number_encrypted, account_number_hash, 
       ifsc_code, bank_name, upi_id, cancelled_cheque_path, verification_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
      ON DUPLICATE KEY UPDATE
      account_holder_name = VALUES(account_holder_name),
      account_number_encrypted = VALUES(account_number_encrypted),
      account_number_hash = VALUES(account_number_hash),
      ifsc_code = VALUES(ifsc_code),
      bank_name = VALUES(bank_name),
      upi_id = VALUES(upi_id),
      cancelled_cheque_path = VALUES(cancelled_cheque_path),
      verification_status = 'PENDING',
      verified_at = NULL,
      verification_notes = NULL
    `, [
      req.vendorId,
      account_holder_name,
      encryptedAccountNumber,
      accountHash,
      ifsc_code.toUpperCase(),
      bankDetails.bankName,
      upi_id || null,
      cancelledChequePath
    ]);

    res.json({ 
      message: 'Bank details saved successfully',
      bankDetails: {
        account_holder_name,
        ifsc_code: ifsc_code.toUpperCase(),
        bank_name: bankDetails.bankName,
        upi_id: upi_id || null,
        verification_status: 'PENDING'
      }
    });

  } catch (error) {
    console.error('Save bank details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get vendor bank details
app.get('/api/vendor/bank-details', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.promise().query(`
      SELECT 
        id,
        account_holder_name,
        ifsc_code,
        bank_name,
        upi_id,
        verification_status,
        verification_notes,
        verified_at,
        created_at,
        updated_at
      FROM vendor_bank_details 
      WHERE vendor_id = ?
    `, [req.vendorId]);

    if (rows.length === 0) {
      return res.json({ bankDetails: null });
    }

    const bankDetails = rows[0];
    res.json({ bankDetails });

  } catch (error) {
    console.error('Get bank details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Trigger bank verification (admin endpoint)
app.post('/api/vendor/verify-bank', verifyToken, async (req, res) => {
  try {
    const { verification_status, verification_notes } = req.body;

    if (!['VERIFIED', 'REJECTED'].includes(verification_status)) {
      return res.status(400).json({ error: 'Invalid verification status' });
    }

    // Update verification status
    await db.promise().query(`
      UPDATE vendor_bank_details 
      SET verification_status = ?, 
          verification_notes = ?,
          verified_at = NOW()
      WHERE vendor_id = ?
    `, [verification_status, verification_notes || null, req.vendorId]);

    res.json({ 
      message: `Bank details ${verification_status.toLowerCase()} successfully`,
      verification_status 
    });

  } catch (error) {
    console.error('Verify bank error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin endpoint to get all bank details for verification
app.get('/api/admin/bank-details', verifyAdmin, async (req, res) => {
  try {
    const { status = '', page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = '';
    let params = [];

    if (status) {
      whereClause = 'WHERE vbd.verification_status = ?';
      params.push(status);
    }

    const [rows] = await db.promise().query(`
      SELECT 
        vbd.id,
        vbd.vendor_id,
        v.shop_name,
        v.owner_name,
        v.owner_email,
        vbd.account_holder_name,
        vbd.ifsc_code,
        vbd.bank_name,
        vbd.upi_id,
        vbd.verification_status,
        vbd.verification_notes,
        vbd.verified_at,
        vbd.created_at,
        vbd.updated_at
      FROM vendor_bank_details vbd
      JOIN vendors v ON vbd.vendor_id = v.id
      ${whereClause}
      ORDER BY vbd.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    // Get total count
    const [countResult] = await db.promise().query(`
      SELECT COUNT(*) as total
      FROM vendor_bank_details vbd
      JOIN vendors v ON vbd.vendor_id = v.id
      ${whereClause}
    `, params);

    res.json({
      bankDetails: rows,
      total: countResult[0].total,
      page: parseInt(page),
      limit: parseInt(limit)
    });

  } catch (error) {
    console.error('Admin get bank details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin endpoint to update bank verification status
app.put('/api/admin/bank-details/:id/verify', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { verification_status, verification_notes } = req.body;

    if (!['VERIFIED', 'REJECTED'].includes(verification_status)) {
      return res.status(400).json({ error: 'Invalid verification status' });
    }

    await db.promise().query(`
      UPDATE vendor_bank_details 
      SET verification_status = ?, 
          verification_notes = ?,
          verified_by = ?,
          verified_at = NOW()
      WHERE id = ?
    `, [verification_status, verification_notes || null, req.adminId, id]);

    res.json({ 
      message: `Bank details ${verification_status.toLowerCase()} successfully`,
      verification_status 
    });

  } catch (error) {
    console.error('Admin verify bank error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enhanced payouts API with earnings breakdown
app.get('/api/vendor/earnings', verifyToken, async (req, res) => {
  try {
    const { period = 'current_month' } = req.query;
    
    let dateFilter = '';
    let params = [req.vendorId];

    switch (period) {
      case 'current_month':
        dateFilter = 'AND DATE(created_at) >= DATE_FORMAT(NOW(), "%Y-%m-01")';
        break;
      case 'last_month':
        dateFilter = 'AND DATE(created_at) >= DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MONTH), "%Y-%m-01") AND DATE(created_at) < DATE_FORMAT(NOW(), "%Y-%m-01")';
        break;
      case 'last_30_days':
        dateFilter = 'AND DATE(created_at) >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
        break;
      case 'last_7_days':
        dateFilter = 'AND DATE(created_at) >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
        break;
    }

    // Get earnings breakdown
    const [earnings] = await db.promise().query(`
      SELECT 
        COALESCE(SUM(gross_revenue), 0) as total_sales,
        COALESCE(SUM(platform_commission), 0) as platform_commission,
        COALESCE(SUM(delivery_fee_share), 0) as delivery_fee_share,
        COALESCE(SUM(tds_amount), 0) as tds_amount,
        COALESCE(SUM(gst_amount), 0) as gst_amount,
        COALESCE(SUM(net_earnings), 0) as net_earnings
      FROM vendor_earnings 
      WHERE vendor_id = ? ${dateFilter}
    `, params);

    // Get payout schedule
    const [schedule] = await db.promise().query(`
      SELECT 
        frequency,
        day_of_week,
        day_of_month,
        min_payout_amount,
        next_payout_date,
        last_payout_date
      FROM payout_schedules 
      WHERE vendor_id = ?
    `, [req.vendorId]);

    res.json({
      earnings: earnings[0],
      schedule: schedule[0] || null,
      period
    });

  } catch (error) {
    console.error('Get earnings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate payout statement (PDF/Excel)
app.get('/api/payouts/:id/statement', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { format = 'pdf' } = req.query;

    // Verify payout belongs to vendor
    const [payoutRows] = await db.promise().query(`
      SELECT p.*, v.shop_name, v.owner_name, v.owner_email
      FROM payouts p
      JOIN vendors v ON p.vendor_id = v.id
      WHERE p.id = ? AND p.vendor_id = ?
    `, [id, req.vendorId]);

    if (payoutRows.length === 0) {
      return res.status(404).json({ error: 'Payout not found' });
    }

    const payout = payoutRows[0];

    // Get earnings details for this payout
    const [earningsRows] = await db.promise().query(`
      SELECT * FROM vendor_earnings 
      WHERE payout_id = ? AND vendor_id = ?
    `, [id, req.vendorId]);

    // Get bank details
    const [bankRows] = await db.promise().query(`
      SELECT account_holder_name, ifsc_code, bank_name, upi_id
      FROM vendor_bank_details 
      WHERE vendor_id = ? AND verification_status = 'VERIFIED'
    `, [req.vendorId]);

    const bankDetails = bankRows[0] || null;

    if (format === 'pdf') {
      // Generate PDF statement
      const pdfBuffer = await generatePDFStatement(payout, earningsRows, bankDetails);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="payout-statement-${id}.pdf"`);
      res.send(pdfBuffer);
    } else if (format === 'excel') {
      // Generate Excel statement
      const excelBuffer = await generateExcelStatement(payout, earningsRows, bankDetails);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="payout-statement-${id}.xlsx"`);
      res.send(excelBuffer);
    } else {
      res.status(400).json({ error: 'Invalid format. Use pdf or excel' });
    }

  } catch (error) {
    console.error('Generate statement error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to generate PDF statement
async function generatePDFStatement(payout, earnings, bankDetails) {
  const puppeteer = require('puppeteer');
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { text-align: center; margin-bottom: 30px; }
        .title { font-size: 24px; font-weight: bold; color: #333; }
        .subtitle { font-size: 16px; color: #666; margin-top: 5px; }
        .section { margin-bottom: 25px; }
        .section-title { font-size: 18px; font-weight: bold; color: #333; margin-bottom: 10px; border-bottom: 2px solid #333; padding-bottom: 5px; }
        .info-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        .info-table td { padding: 8px; border: 1px solid #ddd; }
        .info-table .label { background-color: #f5f5f5; font-weight: bold; width: 30%; }
        .earnings-table { width: 100%; border-collapse: collapse; }
        .earnings-table th, .earnings-table td { padding: 10px; border: 1px solid #ddd; text-align: left; }
        .earnings-table th { background-color: #f5f5f5; font-weight: bold; }
        .total-row { font-weight: bold; background-color: #f0f9ff; }
        .footer { margin-top: 40px; text-align: center; font-size: 12px; color: #666; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="title">PAYOUT STATEMENT</div>
        <div class="subtitle">Statement #${payout.id}</div>
      </div>

      <div class="section">
        <div class="section-title">Vendor Information</div>
        <table class="info-table">
          <tr><td class="label">Shop Name:</td><td>${payout.shop_name}</td></tr>
          <tr><td class="label">Owner Name:</td><td>${payout.owner_name}</td></tr>
          <tr><td class="label">Email:</td><td>${payout.owner_email}</td></tr>
        </table>
      </div>

      <div class="section">
        <div class="section-title">Payout Details</div>
        <table class="info-table">
          <tr><td class="label">Payout ID:</td><td>#${payout.id}</td></tr>
          <tr><td class="label">Amount:</td><td>₹${payout.amount.toFixed(2)}</td></tr>
          <tr><td class="label">Status:</td><td>${payout.status.toUpperCase()}</td></tr>
          <tr><td class="label">Method:</td><td>${payout.method.replace('_', ' ').toUpperCase()}</td></tr>
          <tr><td class="label">Created:</td><td>${new Date(payout.created_at).toLocaleDateString()}</td></tr>
          ${payout.paid_at ? `<tr><td class="label">Paid At:</td><td>${new Date(payout.paid_at).toLocaleDateString()}</td></tr>` : ''}
          ${payout.reference ? `<tr><td class="label">Reference:</td><td>${payout.reference}</td></tr>` : ''}
        </table>
      </div>

      ${bankDetails ? `
      <div class="section">
        <div class="section-title">Bank Details</div>
        <table class="info-table">
          <tr><td class="label">Account Holder:</td><td>${bankDetails.account_holder_name}</td></tr>
          <tr><td class="label">Bank:</td><td>${bankDetails.bank_name}</td></tr>
          <tr><td class="label">IFSC:</td><td>${bankDetails.ifsc_code}</td></tr>
          ${bankDetails.upi_id ? `<tr><td class="label">UPI ID:</td><td>${bankDetails.upi_id}</td></tr>` : ''}
        </table>
      </div>
      ` : ''}

      <div class="section">
        <div class="section-title">Earnings Breakdown</div>
        <table class="earnings-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Amount (₹)</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Total Sales (Gross Revenue)</td><td>₹${payout.gross_amount ? payout.gross_amount.toFixed(2) : '0.00'}</td></tr>
            <tr><td>Platform Commission</td><td>-₹${payout.commission_amount ? payout.commission_amount.toFixed(2) : '0.00'}</td></tr>
            <tr><td>Delivery Fee Share</td><td>-₹${payout.delivery_fee_amount ? payout.delivery_fee_amount.toFixed(2) : '0.00'}</td></tr>
            <tr><td>TDS (Tax Deducted at Source)</td><td>-₹${payout.tds_amount ? payout.tds_amount.toFixed(2) : '0.00'}</td></tr>
            <tr><td>GST</td><td>-₹${payout.gst_amount ? payout.gst_amount.toFixed(2) : '0.00'}</td></tr>
            <tr class="total-row"><td><strong>Net Earnings (Payable)</strong></td><td><strong>₹${payout.amount.toFixed(2)}</strong></td></tr>
          </tbody>
        </table>
      </div>

      <div class="footer">
        <p>This is a computer-generated statement. No signature required.</p>
        <p>Generated on: ${new Date().toLocaleDateString()}</p>
      </div>
    </body>
    </html>
  `;

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(html);
  const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
  await browser.close();

  return pdfBuffer;
}

// Helper function to generate Excel statement
async function generateExcelStatement(payout, earnings, bankDetails) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Payout Statement');

  // Add header
  worksheet.mergeCells('A1:D1');
  worksheet.getCell('A1').value = 'PAYOUT STATEMENT';
  worksheet.getCell('A1').font = { size: 16, bold: true };
  worksheet.getCell('A1').alignment = { horizontal: 'center' };

  worksheet.mergeCells('A2:D2');
  worksheet.getCell('A2').value = `Statement #${payout.id}`;
  worksheet.getCell('A2').font = { size: 12 };
  worksheet.getCell('A2').alignment = { horizontal: 'center' };

  // Vendor Information
  let row = 4;
  worksheet.getCell(`A${row}`).value = 'VENDOR INFORMATION';
  worksheet.getCell(`A${row}`).font = { bold: true };
  row++;

  const vendorInfo = [
    ['Shop Name', payout.shop_name],
    ['Owner Name', payout.owner_name],
    ['Email', payout.owner_email]
  ];

  vendorInfo.forEach(([label, value]) => {
    worksheet.getCell(`A${row}`).value = label;
    worksheet.getCell(`B${row}`).value = value;
    row++;
  });

  // Payout Details
  row++;
  worksheet.getCell(`A${row}`).value = 'PAYOUT DETAILS';
  worksheet.getCell(`A${row}`).font = { bold: true };
  row++;

  const payoutInfo = [
    ['Payout ID', `#${payout.id}`],
    ['Amount', `₹${payout.amount.toFixed(2)}`],
    ['Status', payout.status.toUpperCase()],
    ['Method', payout.method.replace('_', ' ').toUpperCase()],
    ['Created', new Date(payout.created_at).toLocaleDateString()],
    ...(payout.paid_at ? [['Paid At', new Date(payout.paid_at).toLocaleDateString()]] : []),
    ...(payout.reference ? [['Reference', payout.reference]] : [])
  ];

  payoutInfo.forEach(([label, value]) => {
    worksheet.getCell(`A${row}`).value = label;
    worksheet.getCell(`B${row}`).value = value;
    row++;
  });

  // Bank Details
  if (bankDetails) {
    row++;
    worksheet.getCell(`A${row}`).value = 'BANK DETAILS';
    worksheet.getCell(`A${row}`).font = { bold: true };
    row++;

    const bankInfo = [
      ['Account Holder', bankDetails.account_holder_name],
      ['Bank', bankDetails.bank_name],
      ['IFSC', bankDetails.ifsc_code],
      ...(bankDetails.upi_id ? [['UPI ID', bankDetails.upi_id]] : [])
    ];

    bankInfo.forEach(([label, value]) => {
      worksheet.getCell(`A${row}`).value = label;
      worksheet.getCell(`B${row}`).value = value;
      row++;
    });
  }

  // Earnings Breakdown
  row++;
  worksheet.getCell(`A${row}`).value = 'EARNINGS BREAKDOWN';
  worksheet.getCell(`A${row}`).font = { bold: true };
  row++;

  const earningsData = [
    ['Description', 'Amount (₹)'],
    ['Total Sales (Gross Revenue)', `₹${payout.gross_amount ? payout.gross_amount.toFixed(2) : '0.00'}`],
    ['Platform Commission', `-₹${payout.commission_amount ? payout.commission_amount.toFixed(2) : '0.00'}`],
    ['Delivery Fee Share', `-₹${payout.delivery_fee_amount ? payout.delivery_fee_amount.toFixed(2) : '0.00'}`],
    ['TDS (Tax Deducted at Source)', `-₹${payout.tds_amount ? payout.tds_amount.toFixed(2) : '0.00'}`],
    ['GST', `-₹${payout.gst_amount ? payout.gst_amount.toFixed(2) : '0.00'}`],
    ['Net Earnings (Payable)', `₹${payout.amount.toFixed(2)}`]
  ];

  earningsData.forEach(([description, amount], index) => {
    worksheet.getCell(`A${row}`).value = description;
    worksheet.getCell(`B${row}`).value = amount;
    
    if (index === 0) {
      worksheet.getCell(`A${row}`).font = { bold: true };
      worksheet.getCell(`B${row}`).font = { bold: true };
    } else if (index === earningsData.length - 1) {
      worksheet.getCell(`A${row}`).font = { bold: true };
      worksheet.getCell(`B${row}`).font = { bold: true };
    }
    
    row++;
  });

  // Set column widths
  worksheet.getColumn('A').width = 30;
  worksheet.getColumn('B').width = 20;

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large' });
    }
  }
  res.status(500).json({ error: error.message });
});

// Start server with automatic fallback if the port is in use
function startServer(portToUse, attempt = 0) {
  const parsedPort = Number(portToUse) || 5000;

  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      const nextPort = parsedPort + 1;
      console.warn(`Port ${parsedPort} in use, retrying on ${nextPort}...`);
      // Retry on the next port
      startServer(nextPort, attempt + 1);
      return;
    }
    console.error('Server listen error:', err);
    process.exit(1);
  });

  server.listen(parsedPort, 'localhost', () => {
    console.log(`Server running on http://localhost:${parsedPort}`);
  });
}

startServer(PORT);