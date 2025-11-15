const express = require('express');
const router = express.Router();
const InventoryService = require('../utils/inventoryService');
const mysql = require('mysql2/promise');
const sharedPool = require('../utils/db');
const jwt = require('jsonwebtoken');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Initialize database connection
// Wrap callback-style pool with promise API
const pool = sharedPool.promise();

// Initialize Redis client (optional)
let redisClient = null;
if (process.env.REDIS_URL) {
    try {
        const Redis = require('redis');
        redisClient = Redis.createClient({ url: process.env.REDIS_URL });
        redisClient.connect().catch(console.error);
    } catch (err) {
        console.warn('Redis not installed or failed to initialize; continuing without Redis caching.');
        redisClient = null;
    }
}

// Initialize inventory service
const inventoryService = new InventoryService(pool, redisClient);

// Helpers: existence checks to avoid calling missing DB objects in lean setups
async function tableExists(tableName) {
    try {
        const [rows] = await pool.execute(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_name = ?
            LIMIT 1
        `, [tableName]);
        return (rows?.[0]?.cnt || 0) > 0;
    } catch (_) {
        return false;
    }
}

async function tableHasColumn(tableName, columnName) {
    try {
        const [rows] = await pool.execute(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
            LIMIT 1
        `, [tableName, columnName]);
        return (rows?.[0]?.cnt || 0) > 0;
    } catch (_) {
        return false;
    }
}

async function procedureExists(procName) {
    try {
        const [rows] = await pool.execute(`
            SELECT COUNT(*) AS cnt
            FROM information_schema.routines
            WHERE routine_schema = DATABASE() AND routine_name = ? AND routine_type = 'PROCEDURE'
            LIMIT 1
        `, [procName]);
        return (rows?.[0]?.cnt || 0) > 0;
    } catch (_) {
        return false;
    }
}

// Middleware for authentication
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    // Verify JWT token (implement your JWT verification logic)
    // For now, we'll assume the token is valid and extract vendor_id
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

// Middleware for admin authentication (accepts either valid admin JWT or x-admin-key)
const authenticateAdmin = (req, res, next) => {
    // Accept admin key from multiple header aliases and fallbacks
    const apiKey = req.headers['x-admin-key']
        || req.headers['admin-api-key']
        || req.headers['adminapikey']
        || req.query['x-admin-key']
        || req.query['adminApiKey']
        || (req.cookies && (req.cookies['x-admin-key'] || req.cookies['adminApiKey']));
    if (apiKey && apiKey === ADMIN_API_KEY) {
        // Accept admin via API key
        req.user = { role: 'admin' };
        return next();
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

/**
 * @route POST /api/inventory/reserve
 * @desc Reserve stock for an order with auto-fallback vendor selection
 * @access Private
 */
router.post('/reserve', authenticateToken, async (req, res) => {
    try {
        const { productId, quantity, zone, orderId, customerLat, customerLng } = req.body;

        // Validate required fields
        if (!productId || !quantity || !zone || !orderId) {
            return res.status(400).json({
                error: 'Missing required fields: productId, quantity, zone, orderId'
            });
        }

        if (quantity <= 0) {
            return res.status(400).json({
                error: 'Quantity must be greater than 0'
            });
        }

        const result = await inventoryService.reserveStock({
            productId,
            quantity,
            zone,
            orderId,
            customerLat: customerLat || 0,
            customerLng: customerLng || 0
        });

        res.json(result);
    } catch (error) {
        console.error('Error in reserve stock:', error);
        res.status(500).json({
            error: 'Failed to reserve stock',
            message: error.message
        });
    }
});

/**
 * @route POST /api/inventory/commit
 * @desc Commit a reservation (permanently decrease stock)
 * @access Private
 */
router.post('/commit', authenticateToken, async (req, res) => {
    try {
        const { reservationId, vendorId, productId, quantity } = req.body;

        // Validate required fields
        if (!reservationId || !vendorId || !productId || !quantity) {
            return res.status(400).json({
                error: 'Missing required fields: reservationId, vendorId, productId, quantity'
            });
        }

        const result = await inventoryService.commitReservation({
            reservationId,
            vendorId,
            productId,
            quantity
        });

        res.json(result);
    } catch (error) {
        console.error('Error in commit reservation:', error);
        res.status(500).json({
            error: 'Failed to commit reservation',
            message: error.message
        });
    }
});

/**
 * @route POST /api/inventory/release
 * @desc Release a reservation (free up reserved stock)
 * @access Private
 */
router.post('/release', authenticateToken, async (req, res) => {
    try {
        const { reservationId, vendorId, productId, quantity } = req.body;

        // Validate required fields
        if (!reservationId || !vendorId || !productId || !quantity) {
            return res.status(400).json({
                error: 'Missing required fields: reservationId, vendorId, productId, quantity'
            });
        }

        const result = await inventoryService.releaseReservation({
            reservationId,
            vendorId,
            productId,
            quantity
        });

        res.json(result);
    } catch (error) {
        console.error('Error in release reservation:', error);
        res.status(500).json({
            error: 'Failed to release reservation',
            message: error.message
        });
    }
});

/**
 * @route GET /api/inventory/availability/:productId/:zone
 * @desc Get stock availability for a product in a specific zone
 * @access Public
 */
router.get('/availability/:productId/:zone', async (req, res) => {
    try {
        const { productId, zone } = req.params;

        const result = await inventoryService.getStockAvailability(
            parseInt(productId),
            zone
        );

        res.json(result);
    } catch (error) {
        console.error('Error in get stock availability:', error);
        res.status(500).json({
            error: 'Failed to get stock availability',
            message: error.message
        });
    }
});

/**
 * @route GET /api/inventory/priority-queue/:productId/:zone
 * @desc Get vendor priority queue for a product-zone combination
 * @access Public
 */
router.get('/priority-queue/:productId/:zone', async (req, res) => {
    try {
        const { productId, zone } = req.params;
        const { customerLat, customerLng } = req.query;

        // Update priority queue if customer coordinates provided
        if (customerLat && customerLng) {
            await inventoryService.updateVendorPriorityQueue(
                parseInt(productId),
                zone,
                parseFloat(customerLat),
                parseFloat(customerLng)
            );
        }

        const result = await inventoryService.getVendorPriorityQueue(
            parseInt(productId),
            zone
        );

        res.json(result);
    } catch (error) {
        console.error('Error in get vendor priority queue:', error);
        res.status(500).json({
            error: 'Failed to get vendor priority queue',
            message: error.message
        });
    }
});

/**
 * @route GET /api/inventory/vendor/:vendorId?/summary
 * @desc Get inventory summary for a vendor (vendorId param optional; falls back to token)
 * @access Private
 */
router.get('/vendor/:vendorId?/summary', authenticateToken, async (req, res) => {
    try {
        let { vendorId } = req.params;
        if (!vendorId) {
            vendorId = req.user?.vendorId || req.user?.vendor_id;
        }

        // Check if user has access to this vendor's data
        if (vendorId && req.user.vendor_id && req.user.vendor_id !== parseInt(vendorId)) {
            return res.status(403).json({
                error: 'Access denied to this vendor\'s inventory'
            });
        }

        const parsedId = parseInt(vendorId);
        if (!parsedId || Number.isNaN(parsedId)) {
            return res.status(400).json({ error: 'Vendor ID required' });
        }
        const result = await inventoryService.getVendorInventorySummary(parsedId);

        res.json(result);
    } catch (error) {
        console.error('Error in get vendor inventory summary:', error);
        res.status(500).json({
            error: 'Failed to get vendor inventory summary',
            message: error.message
        });
    }
});

/**
 * @route PUT /api/inventory/vendor/:vendorId/product/:productId/stock
 * @desc Update stock levels for a vendor product
 * @access Private
 */
router.put('/vendor/:vendorId/product/:productId/stock', authenticateToken, async (req, res) => {
    try {
        const { vendorId, productId } = req.params;
        const { stockOnHand, reason } = req.body;

        // Check if user has access to this vendor's data
        if (req.user.vendor_id && req.user.vendor_id !== parseInt(vendorId)) {
            return res.status(403).json({
                error: 'Access denied to this vendor\'s inventory'
            });
        }

        if (stockOnHand < 0) {
            return res.status(400).json({
                error: 'Stock on hand cannot be negative'
            });
        }

        const result = await inventoryService.updateStockLevels(
            parseInt(vendorId),
            parseInt(productId),
            stockOnHand,
            reason || 'manual_adjustment'
        );

        res.json(result);
    } catch (error) {
        console.error('Error in update stock levels:', error);
        res.status(500).json({
            error: 'Failed to update stock levels',
            message: error.message
        });
    }
});

/**
 * @route POST /api/inventory/partial-fulfillment
 * @desc Handle partial order fulfillment across multiple vendors
 * @access Private
 */
router.post('/partial-fulfillment', authenticateToken, async (req, res) => {
    try {
        const { orderId, productId, totalQuantity, zone } = req.body;

        // Validate required fields
        if (!orderId || !productId || !totalQuantity || !zone) {
            return res.status(400).json({
                error: 'Missing required fields: orderId, productId, totalQuantity, zone'
            });
        }

        const result = await inventoryService.handlePartialFulfillment({
            orderId,
            productId,
            totalQuantity,
            zone
        });

        res.json(result);
    } catch (error) {
        console.error('Error in partial fulfillment:', error);
        res.status(500).json({
            error: 'Failed to handle partial fulfillment',
            message: error.message
        });
    }
});

/**
 * @route GET /api/inventory/reservations
 * @desc Get active reservations for a vendor
 * @access Private
 */
router.get('/reservations', authenticateToken, async (req, res) => {
    try {
        const { vendorId } = req.query;
        const vendor_id = vendorId || req.user.vendor_id;

        if (!vendor_id) {
            return res.status(400).json({
                error: 'Vendor ID required'
            });
        }

        const hasReservations = await tableExists('stock_reservations');
        if (!hasReservations) {
            return res.json({ vendorId: vendor_id, reservations: [] });
        }
        const [rows] = await pool.execute(`
            SELECT 
                sr.id as reservation_id,
                sr.product_id,
                p.name as product_name,
                p.sku,
                sr.quantity,
                sr.reservation_type,
                sr.status,
                sr.expires_at,
                sr.created_at,
                o.order_number
            FROM stock_reservations sr
            JOIN products p ON sr.product_id = p.id
            LEFT JOIN orders o ON sr.order_id = o.id
            WHERE sr.vendor_id = ? 
            AND sr.status = 'active'
            ORDER BY sr.created_at DESC
        `, [vendor_id]);

        res.json({
            vendorId: vendor_id,
            reservations: rows
        });
    } catch (error) {
        console.error('Error in get reservations:', error);
        res.status(500).json({ error: 'Failed to get reservations', message: error.message });
    }
});

/**
 * @route POST /api/inventory/cleanup-expired
 * @desc Clean up expired reservations
 * @access Admin
 */
router.post('/cleanup-expired', authenticateAdmin, async (req, res) => {
    try {
        // Guard optional stored procedures
        try { await inventoryService.cleanupExpiredReservations(); } catch (_) {}
        try { await inventoryService.cleanupInvalidReservations(); } catch (_) {}
        try { await inventoryService.cleanupExpiredStock(); } catch (_) {}

        // After cleanup, also return fresh totals so the frontend can refresh immediately
        const [[vendorsRow]] = await pool.execute(`
            SELECT COUNT(*) AS total_vendors
            FROM vendors
            WHERE status = 'approved'
        `);

        const [[productsRow]] = await pool.execute(`
            SELECT COUNT(DISTINCT p.id) AS total_products
            FROM products p
            WHERE p.status = 'active'
        `);

        const [[stockRow]] = await pool.execute(`
            SELECT COALESCE(SUM(i.stock_available), 0) AS total_stock
            FROM inventory i
        `);

        const [[activeReservationsRow]] = await pool.execute(`
            SELECT COALESCE(SUM(CASE WHEN i.stock_reserved > 0 THEN 1 ELSE 0 END), 0) AS active_reservations
            FROM inventory i
        `);

        res.json({
            success: true,
            message: 'Cleanup completed',
            totals: {
                total_vendors: vendorsRow?.total_vendors || 0,
                total_products: productsRow?.total_products || 0,
                total_stock: stockRow?.total_stock || 0,
                active_reservations: activeReservationsRow?.active_reservations || 0,
                generatedAt: new Date()
            }
        });
    } catch (error) {
        console.error('Error in cleanup expired reservations:', error);
        res.status(500).json({
            error: 'Failed to cleanup expired reservations',
            message: error.message
        });
    }
});

/**
 * @route GET /api/inventory/summary
 * @desc Return platform-wide totals for admin dashboard
 * @access Admin
 */
router.get('/summary', authenticateAdmin, async (req, res) => {
    try {
        const [[vendorsRow]] = await pool.execute(`
            SELECT COUNT(*) AS total_vendors
            FROM vendors
            WHERE status = 'approved'
        `);

        // Check if status column exists
        const hasStatus = await tableHasColumn('products', 'status');
        const statusFilter = hasStatus ? "WHERE p.status = 'active'" : '';
        
        const [[productsRow]] = await pool.execute(`
            SELECT COUNT(DISTINCT p.id) AS total_products
            FROM products p
            ${statusFilter}
        `);

        const [[stockRow]] = await pool.execute(`
            SELECT COALESCE(SUM(i.stock_available), 0) AS total_stock
            FROM inventory i
        `);

        const [[activeReservationsRow]] = await pool.execute(`
            SELECT COALESCE(SUM(CASE WHEN i.stock_reserved > 0 THEN 1 ELSE 0 END), 0) AS active_reservations
            FROM inventory i
        `);

        res.json({
            total_vendors: vendorsRow?.total_vendors || 0,
            total_products: productsRow?.total_products || 0,
            total_stock: stockRow?.total_stock || 0,
            active_reservations: activeReservationsRow?.active_reservations || 0,
            generatedAt: new Date()
        });
    } catch (error) {
        console.error('Error in GET /api/inventory/summary:', error);
        res.status(500).json({
            error: 'Failed to get inventory summary',
            message: error.message
        });
    }
});

/**
 * @route POST /api/inventory/cleanup
 * @desc Identify and remove expired stock and invalid reservations
 * @access Admin
 */
router.post('/cleanup', authenticateAdmin, async (req, res) => {
    try {
        // Guard optional stored procedures
        try { await inventoryService.cleanupExpiredReservations(); } catch (_) {}
        try { await inventoryService.cleanupInvalidReservations(); } catch (_) {}
        try { await inventoryService.cleanupExpiredStock(); } catch (_) {}

        const vendorsActiveCol = (await tableExists('vendors')) ? 'status = \'ACTIVE\'' : '1=1';
        const [[vendorsRow]] = await pool.execute(`
            SELECT COUNT(*) AS total_vendors
            FROM vendors
            WHERE ${vendorsActiveCol}
        `);

        const [[productsRow]] = await pool.execute(`
            SELECT COUNT(DISTINCT p.id) AS total_products
            FROM products p
            WHERE p.status = 'active'
        `);

        let stockTotal = { total_stock: 0 };
        if (await tableExists('inventory')) {
            const [[row]] = await pool.execute(`
                SELECT COALESCE(SUM(stock_available), 0) AS total_stock
                FROM inventory
            `);
            stockTotal = row || stockTotal;
        }

        let activeRes = { active_reservations: 0 };
        if (await tableExists('stock_reservations')) {
            const [[row2]] = await pool.execute(`
                SELECT COUNT(*) AS active_reservations
                FROM stock_reservations
                WHERE status = 'active'
            `);
            activeRes = row2 || activeRes;
        }

        res.json({
            success: true,
            message: 'Cleanup completed',
            totals: {
                total_vendors: vendorsRow?.total_vendors || 0,
                total_products: productsRow?.total_products || 0,
                total_stock: stockTotal?.total_stock || 0,
                active_reservations: activeRes?.active_reservations || 0,
                generatedAt: new Date()
            }
        });
    } catch (error) {
        console.error('Error in POST /api/inventory/cleanup:', error);
        res.status(500).json({
            error: 'Failed to cleanup inventory',
            message: error.message
        });
    }
});

/**
 * @route GET /api/inventory/analytics/performance
 * @desc Get inventory performance analytics
 * @access Admin
 */
router.get('/analytics/performance', authenticateAdmin, async (req, res) => {
    try {
        // Check if columns exist
        const hasVendorId = await tableHasColumn('products', 'vendor_id');
        const hasStatus = await tableHasColumn('products', 'status');
        
        // Build join condition dynamically
        const joinConditions = [];
        if (hasVendorId) {
            joinConditions.push('p.vendor_id = v.id');
        }
        if (hasStatus) {
            joinConditions.push('p.status = \'active\'');
        }
        
        const joinCondition = joinConditions.length > 0 ? joinConditions.join(' AND ') : '1=0';
        
        const [rows] = await pool.execute(`
            SELECT 
                v.id AS vendor_id,
                COALESCE(v.shop_name, v.business_name) AS shop_name,
                COUNT(DISTINCT p.id) AS total_products,
                COALESCE(SUM(i.stock_available), 0) AS total_stock,
                COALESCE(AVG(i.stock_available), 0) AS avg_stock_per_product,
                COALESCE(SUM(CASE WHEN i.stock_reserved > 0 THEN 1 ELSE 0 END), 0) AS active_reservations,
                COALESCE(SUM(GREATEST(i.stock_reserved, 0)), 0) AS total_reserved_quantity
            FROM vendors v
            LEFT JOIN products p ON ${joinCondition}
            LEFT JOIN inventory i ON i.product_id = p.id
            WHERE v.status = 'approved'
            GROUP BY v.id, v.shop_name, v.business_name
            ORDER BY total_stock DESC
        `);

        res.json({
            analytics: rows,
            generatedAt: new Date()
        });
    } catch (error) {
        console.error('Error in get inventory analytics:', error);
        res.status(500).json({
            error: 'Failed to get inventory analytics',
            message: error.message
        });
    }
});

/**
 * @route GET /api/inventory/analytics/totals
 * @desc Get totals for admin dashboard: total vendors, total products, total stock
 * @access Admin
 */
router.get('/analytics/totals', authenticateAdmin, async (req, res) => {
    try {
        // Total active vendors
        const [[vendorsRow]] = await pool.execute(`
            SELECT COUNT(*) AS total_vendors
            FROM vendors
            WHERE is_active = TRUE
        `);

        // Total distinct products across all vendors (active products)
        const [[productsRow]] = await pool.execute(`
            SELECT COUNT(DISTINCT p.id) AS total_products
            FROM products p
            WHERE p.status = 'active'
        `);

        // Total available stock across all vendor_products
        const [[stockRow]] = await pool.execute(`
            SELECT COALESCE(SUM(vp.stock_available), 0) AS total_stock
            FROM vendor_products vp
        `);

        // Total active reservations across all vendors
        const [[activeReservationsRow]] = await pool.execute(`
            SELECT COUNT(*) AS active_reservations
            FROM stock_reservations
            WHERE status = 'active'
        `);

        res.json({
            total_vendors: vendorsRow?.total_vendors || 0,
            total_products: productsRow?.total_products || 0,
            total_stock: stockRow?.total_stock || 0,
            active_reservations: activeReservationsRow?.active_reservations || 0,
            generatedAt: new Date()
        });
    } catch (error) {
        console.error('Error in get inventory totals:', error);
        res.status(500).json({
            error: 'Failed to get inventory totals',
            message: error.message
        });
    }
});

/**
 * @route GET /api/inventory/analytics/stock-movements
 * @desc Get stock movement analytics
 * @access Admin
 */
router.get('/analytics/stock-movements', authenticateAdmin, async (req, res) => {
    try {
        const { days = 30, vendorId } = req.query;
        const dateFrom = new Date();
        dateFrom.setDate(dateFrom.getDate() - parseInt(days));

        let query = `
            SELECT 
                sm.movement_type,
                COUNT(*) as movement_count,
                SUM(sm.quantity) as total_quantity,
                DATE(sm.created_at) as movement_date
            FROM stock_movements sm
            WHERE sm.created_at >= ?
        `;
        const params = [dateFrom];

        if (vendorId) {
            query += ' AND sm.vendor_id = ?';
            params.push(vendorId);
        }

        query += ' GROUP BY sm.movement_type, DATE(sm.created_at) ORDER BY movement_date DESC';

        const [rows] = await pool.execute(query, params);

        res.json({
            movements: rows,
            period: `${days} days`,
            generatedAt: new Date()
        });
    } catch (error) {
        console.error('Error in get stock movements analytics:', error);
        res.status(500).json({
            error: 'Failed to get stock movements analytics',
            message: error.message
        });
    }
});

module.exports = router;
