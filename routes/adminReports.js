const express = require('express');
const router = express.Router();
const sharedPool = require('../utils/db');
const jwt = require('jsonwebtoken');

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Wrap callback-style pool with promise API
const pool = sharedPool.promise();

// Admin auth middleware (mirrors server verifyAdmin behavior)
const verifyAdmin = (req, res, next) => {
	try {
		const apiKey = req.headers['x-admin-key']
			|| req.headers['admin-api-key']
			|| req.headers['adminapikey'];
		if (apiKey && apiKey === ADMIN_API_KEY) {
			req.adminId = 'admin-api-key';
			return next();
		}
		const auth = req.headers['authorization'] || req.headers['Authorization'];
		if (auth && String(auth).startsWith('Bearer ')) {
			const token = String(auth).slice(7).trim();
			try {
				const payload = jwt.verify(token, JWT_SECRET);
            const isAdmin = payload?.role === 'admin' || payload?.is_admin === true || (Array.isArray(payload?.roles) && payload.roles.includes('admin'));
				if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
				req.adminId = payload?.sub || payload?.id || payload?.email || 'admin-jwt';
				return next();
			} catch (_) {
				return res.status(401).json({ error: 'Invalid or expired token' });
			}
		}
		return res.status(401).json({ error: 'Unauthorized (admin)' });
	} catch (_) {
		return res.status(401).json({ error: 'Unauthorized (admin)' });
	}
};

// Utilities
async function tableExists(tableName) {
	try {
		const [rows] = await pool.execute(`
			SELECT COUNT(*) AS cnt FROM information_schema.tables
			WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1
		`, [tableName]);
		return (rows?.[0]?.cnt || 0) > 0;
	} catch (_) { return false; }
}

// Common filter parsing
function parseDateRange(query) {
	const { preset, date_from, date_to } = query;
	if (date_from && date_to) return { sql: ' BETWEEN ? AND ? ', params: [date_from, date_to] };
	const now = new Date();
	const start = new Date();
	if (preset === 'today') {
		start.setHours(0,0,0,0);
		return { sql: ' BETWEEN ? AND ? ', params: [start, now] };
	}
	if (preset === '7d' || preset === 'last7days') {
		start.setDate(now.getDate() - 7);
		return { sql: ' BETWEEN ? AND ? ', params: [start, now] };
	}
	if (preset === '30d' || preset === 'last30days') {
		start.setDate(now.getDate() - 30);
		return { sql: ' BETWEEN ? AND ? ', params: [start, now] };
	}
	return { sql: '', params: [] };
}

function applyOrderFilters(base, query, params) {
	const where = [];
	if (query.vendorId) { where.push('o.vendor_id = ?'); params.push(query.vendorId); }
	if (query.orderStatus) { where.push('o.status = ?'); params.push(query.orderStatus); }
	if (query.paymentStatus) { where.push('o.payment_status = ?'); params.push(query.paymentStatus); }
	const dr = parseDateRange(query);
	let whereSql = '';
	if (dr.sql) { where.push(`o.created_at ${dr.sql}`); params.push(...dr.params); }
	if (where.length) whereSql = ` WHERE ${where.join(' AND ')} `;
	return base + whereSql;
}

function toCSV(rows) {
	if (!rows || rows.length === 0) return '';
	const headers = Object.keys(rows[0]);
	const escape = (v) => {
		if (v == null) return '';
		const s = String(v);
		if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
		return s;
	};
	const lines = [headers.join(',')];
	for (const r of rows) lines.push(headers.map(h => escape(r[h])).join(','));
	return lines.join('\n');
}

// Vendor Reports
router.get('/vendors/active-inactive', verifyAdmin, async (req, res) => {
	try {
		const [rows] = await pool.execute(`
			SELECT 
				COUNT(*) AS total,
				SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
				SUM(CASE WHEN status <> 'ACTIVE' THEN 1 ELSE 0 END) AS inactive
			FROM vendors
		`);
		res.json(rows[0] || { total: 0, active: 0, inactive: 0 });
	} catch (e) {
		res.status(500).json({ error: 'Failed to get vendor active/inactive' });
	}
});

router.get('/vendors/performance', verifyAdmin, async (req, res) => {
	try {
		const { limit = 100 } = req.query;
		const params = [];
		let base = `
			SELECT 
				v.id AS vendor_id,
				v.shop_name AS vendor_name,
				COUNT(o.id) AS orders,
				SUM(CASE WHEN o.payment_status = 'paid' THEN o.total_amount ELSE 0 END) AS revenue,
				COALESCE(SUM(oi.quantity), 0) AS stock_sold
			FROM vendors v
			LEFT JOIN orders o ON o.vendor_id = v.id
			LEFT JOIN order_items oi ON oi.order_id = o.id
		`;
		base = applyOrderFilters(base, req.query, params);
		const [rows] = await pool.execute(`
			${base}
			GROUP BY v.id
			ORDER BY revenue DESC, orders DESC
			LIMIT ?
		`, [...params, parseInt(limit)]);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get vendor performance' });
	}
});

router.get('/vendors/approval-history', verifyAdmin, async (req, res) => {
	try {
		if (!(await tableExists('audit_log'))) return res.json([]);
		const { vendorId } = req.query;
		const where = ["entity_type = 'vendor_status'"];
		const params = [];
		if (vendorId) { where.push('entity_id = ?'); params.push(vendorId); }
		const whereSql = `WHERE ${where.join(' AND ')}`;
		const [rows] = await pool.execute(`
			SELECT id, entity_id AS vendor_id, action, user_id, timestamp, before_state, after_state
			FROM audit_log
			${whereSql}
			ORDER BY timestamp DESC
			LIMIT 500
		`, params);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get approval history' });
	}
});

// Product Reports
router.get('/products/sales-revenue', verifyAdmin, async (req, res) => {
	try {
		const { limit = 200, productId, vendorId } = req.query;
		const params = [];
		let base = `
			SELECT p.id AS product_id, p.name AS product_name, p.category,
				SUM(oi.quantity) AS units_sold,
				SUM(oi.total_price) AS revenue
			FROM order_items oi
			JOIN orders o ON o.id = oi.order_id
			JOIN products p ON p.id = oi.product_id
		`;
		base = applyOrderFilters(base, req.query, params);
		if (productId) { base += (base.includes('WHERE') ? ' AND ' : ' WHERE ') + ' p.id = ? '; params.push(productId); }
		if (vendorId) { base += (base.includes('WHERE') ? ' AND ' : ' WHERE ') + ' p.vendor_id = ? '; params.push(vendorId); }
		const [rows] = await pool.execute(`
			${base}
			GROUP BY p.id
			ORDER BY revenue DESC
			LIMIT ?
		`, [...params, parseInt(limit)]);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get product sales and revenue' });
	}
});

router.get('/products/low-stock', verifyAdmin, async (req, res) => {
	try {
		if (!(await tableExists('inventory'))) return res.json([]);
		const { threshold = 5 } = req.query;
		const [rows] = await pool.execute(`
			SELECT p.id AS product_id, p.name AS product_name, i.stock_available, i.min_stock_level
			FROM products p
			JOIN inventory i ON i.product_id = p.id
			WHERE i.stock_available <= GREATEST(i.min_stock_level, ?)
			ORDER BY i.stock_available ASC
		`, [parseInt(threshold)]);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get low stock products' });
	}
});

router.get('/products/top-least', verifyAdmin, async (req, res) => {
	try {
		const { limit = 10 } = req.query;
		const params = [];
		let base = `
			FROM order_items oi
			JOIN orders o ON o.id = oi.order_id
			JOIN products p ON p.id = oi.product_id
		`;
		base = applyOrderFilters(base, req.query, params);
		const [top] = await pool.execute(`
			SELECT p.id AS product_id, p.name AS product_name, SUM(oi.quantity) AS units_sold, SUM(oi.total_price) AS revenue
			${base}
			GROUP BY p.id
			ORDER BY units_sold DESC
			LIMIT ?
		`, [...params, parseInt(limit)]);
		const [least] = await pool.execute(`
			SELECT p.id AS product_id, p.name AS product_name, SUM(oi.quantity) AS units_sold, SUM(oi.total_price) AS revenue
			${base}
			GROUP BY p.id
			ORDER BY units_sold ASC
			LIMIT ?
		`, [...params, parseInt(limit)]);
		res.json({ top, least });
	} catch (e) {
		res.status(500).json({ error: 'Failed to get top/least products' });
	}
});

router.get('/products/price-history', verifyAdmin, async (req, res) => {
	try {
		if (!(await tableExists('price_calculations'))) return res.json([]);
		const { productId, limit = 100 } = req.query;
		const where = [];
		const params = [];
		if (productId) { where.push('pc.product_id = ?'); params.push(productId); }
		const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const [rows] = await pool.execute(`
			SELECT pc.id, pc.product_id, pc.base_price, pc.final_price, pc.applied_rules, pc.created_at
			FROM price_calculations pc
			${whereSql}
			ORDER BY pc.created_at DESC
			LIMIT ?
		`, [...params, parseInt(limit)]);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get price history' });
	}
});

// Inventory Reports
router.get('/inventory/stock-movements', verifyAdmin, async (req, res) => {
	try {
		if (!(await tableExists('stock_movements'))) return res.json([]);
		const { days = 30, vendorId, productId } = req.query;
		const dateFrom = new Date();
		dateFrom.setDate(dateFrom.getDate() - parseInt(days));
		let query = `SELECT movement_type, SUM(quantity) AS total_quantity, DATE(created_at) AS movement_date
			FROM stock_movements WHERE created_at >= ?`;
		const params = [dateFrom];
		if (vendorId) { query += ' AND created_by = ?'; params.push(vendorId); }
		if (productId) { query += ' AND product_id = ?'; params.push(productId); }
		query += ' GROUP BY movement_type, DATE(created_at) ORDER BY movement_date DESC';
		const [rows] = await pool.execute(query, params);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get stock movements' });
	}
});

router.get('/inventory/available-vs-reserved', verifyAdmin, async (req, res) => {
	try {
		if (!(await tableExists('inventory'))) return res.json([]);
		const [rows] = await pool.execute(`
			SELECT DATE(updated_at) AS day,
				SUM(stock_on_hand) AS stock_on_hand,
				SUM(stock_reserved) AS stock_reserved,
				SUM(GREATEST(stock_on_hand - stock_reserved, 0)) AS stock_available
			FROM inventory
			GROUP BY DATE(updated_at)
			ORDER BY day DESC
			LIMIT 90
		`);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get available vs reserved' });
	}
});

router.get('/inventory/historical-stock', verifyAdmin, async (req, res) => {
	try {
		if (!(await tableExists('inventory'))) return res.json([]);
		const { productId, vendorId, limit = 180 } = req.query;
		let query = `SELECT p.id AS product_id, p.name AS product_name, DATE(i.updated_at) AS day,
			SUM(i.stock_on_hand) AS stock_on_hand, SUM(i.stock_reserved) AS stock_reserved,
			SUM(GREATEST(i.stock_on_hand - i.stock_reserved, 0)) AS stock_available
			FROM products p JOIN inventory i ON i.product_id = p.id`;
		const where = [];
		const params = [];
		if (vendorId) { where.push('p.vendor_id = ?'); params.push(vendorId); }
		if (productId) { where.push('p.id = ?'); params.push(productId); }
		if (where.length) query += ` WHERE ${where.join(' AND ')}`;
		query += ' GROUP BY p.id, DATE(i.updated_at) ORDER BY day DESC LIMIT ?';
		params.push(parseInt(limit));
		const [rows] = await pool.execute(query, params);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get historical stock' });
	}
});

// Order Reports
router.get('/orders/by-status', verifyAdmin, async (req, res) => {
	try {
		const params = [];
		let base = ` SELECT status, COUNT(*) AS count FROM orders o`;
		base = applyOrderFilters(base, req.query, params);
		base += ' GROUP BY status ORDER BY count DESC';
		const [rows] = await pool.execute(base, params);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get orders by status' });
	}
});

router.get('/orders/payment-status', verifyAdmin, async (req, res) => {
	try {
		const params = [];
		let base = ` SELECT payment_status, COUNT(*) AS count FROM orders o`;
		base = applyOrderFilters(base, req.query, params);
		base += ' GROUP BY payment_status ORDER BY count DESC';
		const [rows] = await pool.execute(base, params);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get payment status report' });
	}
});

router.get('/orders/aggregate', verifyAdmin, async (req, res) => {
	try {
		const { group_by = 'vendor' } = req.query;
		const params = [];
		let select = '', group = '';
		if (group_by === 'vendor') { select = 'v.id AS vendor_id, v.shop_name AS vendor_name,'; group = 'v.id'; }
		else if (group_by === 'customer') { select = 'o.customer_id,'; group = 'o.customer_id'; }
		else { select = "DATE(o.created_at) AS day,"; group = 'DATE(o.created_at)'; }
		let base = `
			SELECT ${select}
				COUNT(o.id) AS orders,
				SUM(CASE WHEN o.payment_status = 'paid' THEN o.total_amount ELSE 0 END) AS revenue,
				SUM(CASE WHEN o.payment_status = 'refunded' THEN o.total_amount ELSE 0 END) AS refunds
			FROM orders o
			LEFT JOIN vendors v ON v.id = o.vendor_id
		`;
		base = applyOrderFilters(base, req.query, params);
		const [rows] = await pool.execute(`
			${base}
			GROUP BY ${group}
			ORDER BY orders DESC
		`, params);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to aggregate orders' });
	}
});

// KYC & Compliance Reports
router.get('/kyc/verification-status', verifyAdmin, async (req, res) => {
	try {
		if (!(await tableExists('vendor_docs'))) return res.json([]);
		const [rows] = await pool.execute(`
			SELECT status, COUNT(*) AS count FROM vendor_docs GROUP BY status
		`);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get KYC verification status' });
	}
});

router.get('/kyc/expiring-documents', verifyAdmin, async (req, res) => {
	try {
		// Using uploaded_at as proxy for expiry window; real systems should store expiry
		const { window_days = 90 } = req.query;
		const [rows] = await pool.execute(`
			SELECT id, vendor_id, doc_type, uploaded_at,
				DATE_ADD(uploaded_at, INTERVAL ? DAY) AS assumed_expiry
			FROM vendor_docs
			WHERE DATE_ADD(uploaded_at, INTERVAL ? DAY) BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
			ORDER BY assumed_expiry ASC
		`, [parseInt(window_days), parseInt(window_days), parseInt(window_days)]);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get expiring documents' });
	}
});

router.get('/kyc/audit-log', verifyAdmin, async (req, res) => {
	try {
		if (!(await tableExists('audit_log'))) return res.json([]);
		const [rows] = await pool.execute(`
			SELECT id, entity_type, entity_id, action, user_id, timestamp
			FROM audit_log
			WHERE entity_type IN ('kyc_document','kyc_verification','kyc_review')
			ORDER BY timestamp DESC
			LIMIT 500
		`);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: 'Failed to get KYC audit log' });
	}
});

// Export endpoints (CSV, XLSX, PDF) - for key reports
router.get('/export/:type', verifyAdmin, async (req, res) => {
	try {
		const { report = 'orders-aggregate', format = 'csv' } = req.query;
		const params = [];
		let rows = [];
		if (report === 'orders-aggregate') {
			let base = `
				SELECT v.shop_name AS vendor_name,
					COUNT(o.id) AS orders,
					SUM(CASE WHEN o.payment_status = 'paid' THEN o.total_amount ELSE 0 END) AS revenue
				FROM orders o LEFT JOIN vendors v ON v.id = o.vendor_id`;
			base = applyOrderFilters(base, req.query, params);
			base += ' GROUP BY v.id ORDER BY revenue DESC';
			const [r] = await pool.execute(base, params);
			rows = r;
		} else if (report === 'products-sales') {
			let base = `
				SELECT p.name AS product_name, p.category,
					SUM(oi.quantity) AS units_sold, SUM(oi.total_price) AS revenue
				FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id`;
			base = applyOrderFilters(base, req.query, params);
			base += ' GROUP BY p.id ORDER BY revenue DESC';
			const [r] = await pool.execute(base, params);
			rows = r;
		} else if (report === 'vendors-performance') {
			let base = `
				SELECT v.shop_name AS vendor_name,
					COUNT(o.id) AS orders,
					SUM(CASE WHEN o.payment_status = 'paid' THEN o.total_amount ELSE 0 END) AS revenue
				FROM vendors v LEFT JOIN orders o ON o.vendor_id = v.id`;
			base = applyOrderFilters(base, req.query, params);
			base += ' GROUP BY v.id ORDER BY revenue DESC';
			const [r] = await pool.execute(base, params);
			rows = r;
		}

		const filenameBase = `${report}-${Date.now()}`;
		if (format === 'csv') {
			const csv = toCSV(rows);
			res.setHeader('Content-Type', 'text/csv');
			res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
			return res.send(csv);
		}
		res.status(400).json({ error: 'Unsupported format. Only CSV supported currently.' });
	} catch (e) {
		console.error('Export error:', e);
		res.status(500).json({ error: 'Failed to export report' });
	}
});

module.exports = router;


