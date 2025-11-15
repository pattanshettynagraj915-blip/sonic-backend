const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const sharedPool = require('../utils/db');
const jwt = require('jsonwebtoken');
const csvWriter = require('csv-writer');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Initialize database connection
const pool = sharedPool.promise();

// Middleware for authentication
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

// Utility: check if a column exists on a table (cached per process)
const columnExistenceCache = new Map();
async function tableHasColumn(tableName, columnName) {
    const key = `${tableName}.${columnName}`;
    if (columnExistenceCache.has(key)) return columnExistenceCache.get(key);
    try {
        const [rows] = await pool.execute(
            `SELECT COLUMN_NAME 
             FROM INFORMATION_SCHEMA.COLUMNS 
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [tableName, columnName]
        );
        const exists = Array.isArray(rows) && rows.length > 0;
        columnExistenceCache.set(key, exists);
        return exists;
    } catch (_) {
        columnExistenceCache.set(key, false);
        return false;
    }
}

// Middleware for admin authentication
const authenticateAdmin = (req, res, next) => {
    const apiKey = req.headers['x-admin-key']
        || req.headers['admin-api-key']
        || req.headers['adminapikey']
        || req.query['x-admin-key']
        || req.query['adminApiKey'];
    
    if (apiKey && apiKey === ADMIN_API_KEY) {
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
 * @route GET /api/orders/vendor/:vendorId?
 * @desc Get all orders for a vendor with filters and pagination
 * @access Private
 */
router.get('/vendor/:vendorId?', authenticateToken, async (req, res) => {
    try {
        let { vendorId } = req.params;
        if (!vendorId) {
            vendorId = req.user?.vendorId || req.user?.vendor_id;
        }

        // Validate vendorId
        if (!vendorId) {
            return res.status(400).json({
                error: 'Vendor ID is required'
            });
        }
        
        // Ensure vendorId is a valid integer
        const vendorIdInt = parseInt(vendorId);
        if (isNaN(vendorIdInt) || vendorIdInt <= 0) {
            return res.status(400).json({
                error: 'Invalid vendor ID format'
            });
        }
        
        // Use the validated integer vendor ID
        vendorId = vendorIdInt;

        // Check if user has access to this vendor's data
        if (req.user.vendor_id && req.user.vendor_id !== vendorId) {
            return res.status(403).json({
                error: 'Access denied to this vendor\'s orders'
            });
        }

        const {
            status,
            payment_status,
            date_from,
            date_to,
            search,
            page = 1,
            limit = 10,
            sort_by = 'created_at',
            sort_order = 'DESC'
        } = req.query;

        // Normalize pagination numbers early to avoid TDZ issues
        const limitInt = Math.max(1, parseInt(limit));
        const offsetInt = (Math.max(1, parseInt(page)) - 1) * limitInt;

        // Validate sort_by parameter to prevent SQL injection
        const allowedSortFields = ['created_at', 'updated_at', 'order_number', 'total_amount', 'status'];
        const safeSortBy = allowedSortFields.includes(sort_by) ? sort_by : 'created_at';
        const safeSortOrder = ['ASC', 'DESC'].includes(sort_order.toUpperCase()) ? sort_order.toUpperCase() : 'DESC';

        // Build WHERE clause and base parameters
        let whereClause = 'WHERE o.vendor_id = ?';
        const baseParams = [vendorId];
        

        if (status) {
            whereClause += ' AND o.status = ?';
            baseParams.push(status);
        }

        if (payment_status) {
            whereClause += ' AND o.payment_status = ?';
            baseParams.push(payment_status);
        }

        if (date_from) {
            whereClause += ' AND DATE(o.created_at) >= ?';
            baseParams.push(date_from);
        }

        if (date_to) {
            whereClause += ' AND DATE(o.created_at) <= ?';
            baseParams.push(date_to);
        }

        if (search) {
            whereClause += ' AND (o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)';
            const searchTerm = `%${search}%`;
            baseParams.push(searchTerm, searchTerm, searchTerm);
        }
        

        // Calculate offset
        const offset = offsetInt;

        // Get total count (use copy of baseParams)
        const countQuery = `
            SELECT COUNT(*) as total
            FROM orders o
            ${whereClause}
        `;
        const countParams = [...baseParams];
        const [countResult] = await pool.execute(countQuery, countParams);
        const totalOrders = countResult[0].total;

        // Get orders with items (use fresh copy of baseParams with additional params)
        // Build SELECT fields based on available columns to avoid SQL errors on missing columns
        const hasShippingAddress = await tableHasColumn('orders', 'shipping_address');
        const hasPaymentMode = await tableHasColumn('orders', 'payment_mode');
        const hasShippingCharges = await tableHasColumn('orders', 'shipping_charges');
        const hasNotes = await tableHasColumn('orders', 'notes');
        const hasCancellationReason = await tableHasColumn('orders', 'cancellation_reason');

        const selectFields = [
            'o.id',
            'o.order_number',
            'COALESCE(v.business_name, \'\') AS vendor_name',
            'o.customer_name',
            'o.customer_email',
            'o.customer_phone',
            hasShippingAddress ? 'o.shipping_address as shipping_address' : "'' as shipping_address",
            'o.status',
            'o.payment_status',
            hasPaymentMode ? 'o.payment_mode as payment_mode' : "'' as payment_mode",
            'o.total_amount',
            'o.tax_amount',
            hasShippingCharges ? 'o.shipping_charges as shipping_charges' : '0 as shipping_charges',
            hasNotes ? 'o.notes as notes' : "'' as notes",
            hasCancellationReason ? 'o.cancellation_reason as cancellation_reason' : "'' as cancellation_reason",
            'o.created_at',
            'o.updated_at',
            "GROUP_CONCAT(CONCAT(oi.product_name, ' (', oi.quantity, 'x)') SEPARATOR ', ') as products"
        ].join(',\n                ');

        const ordersQuery = `
            SELECT 
                ${selectFields}
            FROM orders o
            LEFT JOIN vendors v ON o.vendor_id = v.id
            LEFT JOIN order_items oi ON o.id = oi.order_id
            ${whereClause}
            GROUP BY o.id
            ORDER BY o.${safeSortBy} ${safeSortOrder}
			LIMIT ${limitInt} OFFSET ${offsetInt}
        `;

        // Validate parameters
        if (isNaN(limitInt) || isNaN(offsetInt)) {
            return res.status(400).json({
                error: 'Invalid pagination parameters',
                limit: limit,
                offset: offset
            });
        }
        
		const ordersParams = [...baseParams];
		const [orders] = await pool.execute(ordersQuery, ordersParams);

        if (orders.length > 0) {
            const orderIds = orders.map(order => order.id);
            const placeholders = orderIds.map(() => '?').join(',');
            if (placeholders.length > 0) {
                const [items] = await pool.execute(
                    `
                    SELECT 
                        oi.order_id,
                        oi.product_id,
                        oi.product_name,
                        oi.product_sku,
                        oi.quantity,
                        oi.unit_price,
                        oi.total_price
                    FROM order_items oi
                    WHERE oi.order_id IN (${placeholders})
                    ORDER BY oi.order_id, oi.id
                    `,
                    orderIds
                );

                const itemsByOrder = items.reduce((acc, item) => {
                    if (!acc[item.order_id]) {
                        acc[item.order_id] = [];
                    }
                    acc[item.order_id].push(item);
                    return acc;
                }, {});

                orders.forEach(order => {
                    const orderItems = itemsByOrder[order.id] || [];
                    order.items = orderItems;
                    if (!order.products || order.products.length === 0) {
                        order.products = orderItems.map(item => {
                            const name = item.product_name || item.product_sku || 'Item';
                            return `${name} (${item.quantity}x)`;
                        }).join(', ');
                    }
                    order.item_count = orderItems.length;
                    order.total_quantity = orderItems.reduce((sum, item) => {
                        const qty = parseInt(item.quantity, 10);
                        return sum + (Number.isNaN(qty) ? 0 : qty);
                    }, 0);
                });
            }
        }

        // Calculate pagination info
        const totalPages = Math.ceil(totalOrders / parseInt(limit));

        res.json({
            orders,
            pagination: {
                current_page: parseInt(page),
                total_pages: totalPages,
                total_orders: totalOrders,
                per_page: parseInt(limit),
                has_next: parseInt(page) < totalPages,
                has_prev: parseInt(page) > 1
            }
        });
    } catch (error) {
        console.error('Error fetching vendor orders:', error);
        res.status(500).json({
            error: 'Failed to fetch orders',
            message: error.message
        });
    }
});

/**
 * @route GET /api/orders/:id
 * @desc Get order details by ID
 * @access Private
 */
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        // Get order details
        const hasShippingAddress2 = await tableHasColumn('orders', 'shipping_address');
        const hasPaymentMode2 = await tableHasColumn('orders', 'payment_mode');
        const hasShippingCharges2 = await tableHasColumn('orders', 'shipping_charges');
        const hasNotes2 = await tableHasColumn('orders', 'notes');
        const hasCancellationReason2 = await tableHasColumn('orders', 'cancellation_reason');

        const orderSelectFields = [
            'o.id',
            'o.order_number',
            'o.customer_name',
            'o.customer_email',
            'o.customer_phone',
            hasShippingAddress2 ? 'o.shipping_address as shipping_address' : "'' as shipping_address",
            'o.status',
            'o.payment_status',
            hasPaymentMode2 ? 'o.payment_mode as payment_mode' : "'' as payment_mode",
            'o.total_amount',
            'o.tax_amount',
            hasShippingCharges2 ? 'o.shipping_charges as shipping_charges' : '0 as shipping_charges',
            hasNotes2 ? 'o.notes as notes' : "'' as notes",
            hasCancellationReason2 ? 'o.cancellation_reason as cancellation_reason' : "'' as cancellation_reason",
            'o.created_at',
            'o.updated_at',
            'o.vendor_id',
            'v.shop_name as vendor_name'
        ].join(',\n                ');

        const orderQuery = `
            SELECT 
                ${orderSelectFields}
            FROM orders o
            LEFT JOIN vendors v ON o.vendor_id = v.id
            WHERE o.id = ?
        `;
        const [orderResult] = await pool.execute(orderQuery, [id]);

        if (orderResult.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const order = orderResult[0];

        // Check if user has access to this order
        if (req.user.vendor_id && req.user.vendor_id !== order.vendor_id) {
            return res.status(403).json({ error: 'Access denied to this order' });
        }

        // Get order items
        const itemsQuery = `
            SELECT 
                oi.id,
                oi.order_id,
                oi.product_id,
                oi.product_name,
                oi.product_sku,
                oi.quantity,
                oi.unit_price,
                oi.total_price,
                oi.reserved_quantity,
                oi.committed_quantity,
                oi.created_at
            FROM order_items oi
            WHERE oi.order_id = ?
        `;
        const [items] = await pool.execute(itemsQuery, [id]);

        // Get status history
        const historyQuery = `
            SELECT 
                id,
                order_id,
                new_status,
                old_status,
                changed_by,
                change_reason,
                notes,
                created_at
            FROM order_status_history
            WHERE order_id = ?
            ORDER BY created_at ASC
        `;
        const [statusHistory] = await pool.execute(historyQuery, [id]);

        res.json({
            order: {
                ...order,
                items,
                status_history: statusHistory
            }
        });
    } catch (error) {
        console.error('Error fetching order details:', error);
        res.status(500).json({
            error: 'Failed to fetch order details',
            message: error.message
        });
    }
});

/**
 * @route PUT /api/orders/:id/status
 * @desc Update order status
 * @access Private
 */
router.put('/:id/status', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reason, notes } = req.body;

        // Validate status
        const validStatuses = ['pending', 'shipped', 'delivered', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                error: 'Invalid status. Must be one of: ' + validStatuses.join(', ')
            });
        }

        // Get current order
        const [orderResult] = await pool.execute(
            'SELECT * FROM orders WHERE id = ?',
            [id]
        );

        if (orderResult.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const order = orderResult[0];

        // Check if user has access to this order
        if (req.user.vendor_id && req.user.vendor_id !== order.vendor_id) {
            return res.status(403).json({ error: 'Access denied to this order' });
        }

        const oldStatus = order.status;

        // Validate status transition
        const validTransitions = {
            'pending': ['shipped', 'cancelled'],
            'shipped': ['delivered', 'cancelled'],
            'delivered': [],
            'cancelled': []
        };

        if (!validTransitions[oldStatus].includes(status)) {
            return res.status(400).json({
                error: `Cannot change status from ${oldStatus} to ${status}`
            });
        }

        // Start transaction
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            // Update order status
            const updateFields = ['status = ?', 'updated_at = NOW()'];
            const updateParams = [status];

            // Set timestamp fields based on status
            if (status === 'shipped') {
                updateFields.push('out_for_delivery_at = NOW()');
            } else if (status === 'delivered') {
                updateFields.push('delivered_at = NOW()');
            } else if (status === 'cancelled') {
                updateFields.push('cancelled_at = NOW()');
                if (reason) { updateFields.push('cancellation_reason = ?'); updateParams.push(reason); }
            }

            updateParams.push(id);

            await connection.execute(
                `UPDATE orders SET ${updateFields.join(', ')} WHERE id = ?`,
                updateParams
            );

            // Insert status history
            await connection.execute(
                `INSERT INTO order_status_history 
                (order_id, new_status, old_status, changed_by, change_reason, notes) 
                VALUES (?, ?, ?, ?, ?, ?)`,
                [id, status, oldStatus, 'vendor', reason || 'Status updated', notes]
            );

            // Create notification
                const notificationTypes = {
                    'shipped': 'status_update',
                    'delivered': 'status_update',
                    'cancelled': 'cancellation'
                };

            if (notificationTypes[status]) {
                const titles = {
                    'shipped': 'Order Shipped',
                    'delivered': 'Order Delivered',
                    'cancelled': 'Order Cancelled'
                };

                const messages = {
                    'shipped': `Order ${order.order_number} has been shipped`,
                    'delivered': `Order ${order.order_number} has been delivered`,
                    'cancelled': `Order ${order.order_number} has been cancelled`
                };

                await connection.execute(
                    `INSERT INTO order_notifications 
                    (order_id, vendor_id, notification_type, title, message) 
                    VALUES (?, ?, ?, ?, ?)`,
                    [id, order.vendor_id, notificationTypes[status], titles[status], messages[status]]
                );
            }

            await connection.commit();

            res.json({
                success: true,
                message: `Order status updated to ${status}`,
                order_id: id,
                old_status: oldStatus,
                new_status: status
            });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({
            error: 'Failed to update order status',
            message: error.message
        });
    }
});

/**
 * @route GET /api/orders/export
 * @desc Export orders as CSV or PDF
 * @access Private
 */
router.get('/export', authenticateToken, async (req, res) => {
    try {
        const {
            format = 'csv',
            vendor_id,
            status,
            payment_status,
            date_from,
            date_to
        } = req.query;

        let vendorId = vendor_id || req.user?.vendorId || req.user?.vendor_id;

        // Validate vendorId
        if (!vendorId) {
            return res.status(400).json({
                error: 'Vendor ID is required'
            });
        }
        
        // Ensure vendorId is a valid integer
        const vendorIdInt = parseInt(vendorId);
        if (isNaN(vendorIdInt) || vendorIdInt <= 0) {
            return res.status(400).json({
                error: 'Invalid vendor ID format'
            });
        }
        
        // Use the validated integer vendor ID
        vendorId = vendorIdInt;

        // Check if user has access to this vendor's data
        if (req.user.vendor_id && req.user.vendor_id !== vendorId) {
            return res.status(403).json({
                error: 'Access denied to this vendor\'s orders'
            });
        }

        // Build WHERE clause
        let whereClause = 'WHERE o.vendor_id = ?';
        const params = [parseInt(vendorId)];

        if (status) {
            whereClause += ' AND o.status = ?';
            params.push(status);
        }

        if (payment_status) {
            whereClause += ' AND o.payment_status = ?';
            params.push(payment_status);
        }

        if (date_from) {
            whereClause += ' AND DATE(o.created_at) >= ?';
            params.push(date_from);
        }

        if (date_to) {
            whereClause += ' AND DATE(o.created_at) <= ?';
            params.push(date_to);
        }

        // Get orders data
        const ordersQuery = `
            SELECT 
                o.order_number as OrderID,
                o.customer_name as CustomerName,
                GROUP_CONCAT(
                    CONCAT(oi.product_name, ' (', oi.quantity, 'x)')
                    SEPARATOR '; '
                ) as Products,
                o.total_amount as TotalPrice,
                o.payment_status as PaymentStatus,
                o.status as OrderStatus,
                DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i:%s') as OrderDate
            FROM orders o
            LEFT JOIN order_items oi ON o.id = oi.order_id
            ${whereClause}
            GROUP BY o.id
            ORDER BY o.created_at DESC
        `;

        const [orders] = await pool.execute(ordersQuery, params);

        if (format === 'csv') {
            // Generate CSV
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `orders-export-${timestamp}.csv`;
            const filepath = path.join(__dirname, '../temp', filename);

            // Ensure temp directory exists
            const tempDir = path.join(__dirname, '../temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const csvWriterInstance = csvWriter.createObjectCsvWriter({
                path: filepath,
                header: [
                    { id: 'OrderID', title: 'Order ID' },
                    { id: 'CustomerName', title: 'Customer Name' },
                    { id: 'Products', title: 'Products' },
                    { id: 'TotalPrice', title: 'Total Price' },
                    { id: 'PaymentStatus', title: 'Payment Status' },
                    { id: 'OrderStatus', title: 'Order Status' },
                    { id: 'OrderDate', title: 'Order Date' }
                ]
            });

            await csvWriterInstance.writeRecords(orders);

            res.download(filepath, filename, (err) => {
                if (err) {
                    console.error('Error downloading file:', err);
                }
                // Clean up file after download
                fs.unlink(filepath, (unlinkErr) => {
                    if (unlinkErr) console.error('Error deleting temp file:', unlinkErr);
                });
            });
        } else if (format === 'pdf') {
            // Generate PDF
            const browser = await puppeteer.launch({ headless: true });
            const page = await browser.newPage();

            // Create HTML content
            const htmlContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Orders Export</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 20px; }
                        .header { text-align: center; margin-bottom: 30px; }
                        .logo { font-size: 24px; font-weight: bold; color: #2c3e50; }
                        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                        th { background-color: #f2f2f2; font-weight: bold; }
                        .status-pending { color: #f39c12; }
                        .status-shipped { color: #3498db; }
                        .status-delivered { color: #27ae60; }
                        .status-cancelled { color: #e74c3c; }
                        .payment-paid { color: #27ae60; }
                        .payment-pending { color: #f39c12; }
                        .payment-failed { color: #e74c3c; }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <div class="logo">Vendor Portal</div>
                        <h2>Orders Export Report</h2>
                        <p>Generated on: ${new Date().toLocaleString()}</p>
                    </div>
                    <table>
                        <thead>
                            <tr>
                                <th>Order ID</th>
                                <th>Customer Name</th>
                                <th>Products</th>
                                <th>Total Price</th>
                                <th>Payment Status</th>
                                <th>Order Status</th>
                                <th>Order Date</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${orders.map(order => `
                                <tr>
                                    <td>${order.OrderID}</td>
                                    <td>${order.CustomerName}</td>
                                    <td>${order.Products}</td>
                                    <td>₹${parseFloat(order.TotalPrice).toFixed(2)}</td>
                                    <td class="payment-${order.PaymentStatus}">${order.PaymentStatus.toUpperCase()}</td>
                                    <td class="status-${order.OrderStatus}">${order.OrderStatus.toUpperCase()}</td>
                                    <td>${order.OrderDate}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </body>
                </html>
            `;

            await page.setContent(htmlContent);
            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: {
                    top: '20px',
                    right: '20px',
                    bottom: '20px',
                    left: '20px'
                }
            });

            await browser.close();

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `orders-export-${timestamp}.pdf`;

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(pdfBuffer);
        } else {
            res.status(400).json({ error: 'Invalid format. Use csv or pdf' });
        }
    } catch (error) {
        console.error('Error exporting orders:', error);
        res.status(500).json({
            error: 'Failed to export orders',
            message: error.message
        });
    }
});

/**
 * @route GET /api/orders/notifications/:vendorId?
 * @desc Get notifications for a vendor
 * @access Private
 */
router.get('/notifications/:vendorId?', authenticateToken, async (req, res) => {
    try {
        let { vendorId } = req.params;
        if (!vendorId) {
            vendorId = req.user?.vendorId || req.user?.vendor_id;
        }

        // Validate vendorId
        if (!vendorId) {
            return res.status(400).json({
                error: 'Vendor ID is required'
            });
        }
        
        // Ensure vendorId is a valid integer
        const vendorIdInt = parseInt(vendorId);
        if (isNaN(vendorIdInt) || vendorIdInt <= 0) {
            return res.status(400).json({
                error: 'Invalid vendor ID format'
            });
        }
        
        // Use the validated integer vendor ID
        vendorId = vendorIdInt;

        // Check if user has access to this vendor's data
        if (req.user.vendor_id && req.user.vendor_id !== vendorId) {
            return res.status(403).json({
                error: 'Access denied to this vendor\'s notifications'
            });
        }

        const { limit = 10, unread_only = false } = req.query;

        const limitInt = Math.max(1, parseInt(limit));

        let whereClause = 'WHERE n.vendor_id = ?';
        const params = [vendorId];
        

        if (unread_only === 'true') {
            whereClause += ' AND n.is_read = FALSE';
        }
        

        const hasCreatedAt = await tableHasColumn('order_notifications', 'created_at');
        const orderBy = hasCreatedAt ? 'n.created_at' : 'n.id';
        const query = `
            SELECT 
                n.*,
                o.order_number
            FROM order_notifications n
            LEFT JOIN orders o ON n.order_id = o.id
            ${whereClause}
            ORDER BY ${orderBy} DESC
			LIMIT ${limitInt}
        `;
        
        // Validate limit parameter
        if (isNaN(limitInt)) {
            return res.status(400).json({
                error: 'Invalid limit parameter',
                limit: limit
            });
        }
        
		const [notifications] = await pool.execute(query, params);

        res.json({ notifications });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({
            error: 'Failed to fetch notifications',
            message: error.message
        });
    }
});

/**
 * @route PUT /api/orders/notifications/:id/read
 * @desc Mark notification as read
 * @access Private
 */
router.put('/notifications/:id/read', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        await pool.execute(
            'UPDATE order_notifications SET is_read = TRUE, read_at = NOW() WHERE id = ?',
            [id]
        );

        res.json({ success: true, message: 'Notification marked as read' });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({
            error: 'Failed to mark notification as read',
            message: error.message
        });
    }
});

/**
 * @route GET /api/orders/stats/:vendorId?
 * @desc Get order statistics for a vendor
 * @access Private
 */
router.get('/stats/:vendorId?', authenticateToken, async (req, res) => {
    try {
        let { vendorId } = req.params;
        if (!vendorId) {
            vendorId = req.user?.vendorId || req.user?.vendor_id;
        }

        // Validate vendorId
        if (!vendorId) {
            return res.status(400).json({
                error: 'Vendor ID is required'
            });
        }
        
        // Ensure vendorId is a valid integer
        const vendorIdInt = parseInt(vendorId);
        if (isNaN(vendorIdInt) || vendorIdInt <= 0) {
            return res.status(400).json({
                error: 'Invalid vendor ID format'
            });
        }
        
        // Use the validated integer vendor ID
        vendorId = vendorIdInt;

        // Check if user has access to this vendor's data
        if (req.user.vendor_id && req.user.vendor_id !== vendorId) {
            return res.status(403).json({
                error: 'Access denied to this vendor\'s statistics'
            });
        }

        const statsQuery = `
            SELECT 
                COUNT(*) as total_orders,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
                COUNT(CASE WHEN status = 'out_for_delivery' THEN 1 END) as shipped_orders,
                COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_orders,
                COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_orders,
                COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) as paid_orders,
                COUNT(CASE WHEN payment_status = 'pending' THEN 1 END) as pending_payments,
                COUNT(CASE WHEN payment_status = 'failed' THEN 1 END) as failed_payments,
                COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0) as total_revenue,
                COALESCE(AVG(total_amount), 0) as average_order_value
            FROM orders 
            WHERE vendor_id = ?
        `;

        const [stats] = await pool.execute(statsQuery, [vendorId]);

        res.json({ stats: stats[0] });
    } catch (error) {
        console.error('Error fetching order statistics:', error);
        res.status(500).json({
            error: 'Failed to fetch order statistics',
            message: error.message
        });
    }
});

module.exports = router;
