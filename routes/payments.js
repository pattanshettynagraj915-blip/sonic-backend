const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const sharedPool = require('../utils/db');
const { jsPDF } = require('jspdf');

// Wrap callback-style pool with promise API
const pool = sharedPool.promise();

function maskSensitive(sensitiveMasked) {
  try {
    const data = typeof sensitiveMasked === 'string' ? JSON.parse(sensitiveMasked) : sensitiveMasked || {};
    if (data.card_last4) {
      data.card_last4 = String(data.card_last4).replace(/\d/g, '*');
    }
    if (data.upi_id) {
      const upi = String(data.upi_id);
      const [id, bank] = upi.split('@');
      data.upi_id = `${id?.slice(0, 2) || ''}****@${bank || ''}`;
    }
    return data;
  } catch (_) {
    return {};
  }
}

async function logPaymentAudit(paymentId, action, actor, notes, beforeState, afterState) {
  try {
    await pool.query(
      `INSERT INTO payment_audit_logs (payment_id, action, actor, notes, before_state, after_state) VALUES (?,?,?,?,?,?)`,
      [paymentId, action, actor || null, notes || null, beforeState ? JSON.stringify(beforeState) : null, afterState ? JSON.stringify(afterState) : null]
    );
  } catch (_) {}
}

// GET /api/admin/payments
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      status = '',
      method = '',
      vendor = '',
      customer = '',
      date_from = '',
      date_to = '',
      min_amount = '',
      max_amount = ''
    } = req.query || {};

    const where = [];
    const params = [];
    if (search) {
      where.push('(transaction_id LIKE ? OR gateway_payment_id LIKE ? OR gateway_order_id LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) { where.push('status = ?'); params.push(status); }
    if (method) { where.push('method_id IN (SELECT id FROM payment_methods WHERE code = ?)'); params.push(method); }
    if (vendor) { where.push('vendor_id = ?'); params.push(Number(vendor)); }
    if (customer) { where.push('customer_id = ?'); params.push(Number(customer)); }
    if (date_from) { where.push('DATE(created_at) >= ?'); params.push(date_from); }
    if (date_to) { where.push('DATE(created_at) <= ?'); params.push(date_to); }
    if (min_amount) { where.push('amount >= ?'); params.push(Number(min_amount)); }
    if (max_amount) { where.push('amount <= ?'); params.push(Number(max_amount)); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (Number(page) - 1) * Number(limit);

    const [[{ cnt }]] = await pool.query(`SELECT COUNT(*) as cnt FROM payments ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT p.*, pm.code as method_code, pm.display_name as method_name,
              v.shop_name as vendor_name, c.name as customer_name
       FROM payments p
       LEFT JOIN payment_methods pm ON pm.id = p.method_id
       LEFT JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN customers c ON c.id = p.customer_id
       ${whereSql}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    const data = rows.map(r => ({
      ...r,
      sensitive_masked: maskSensitive(r.sensitive_masked)
    }));

    res.json({ page: Number(page), limit: Number(limit), total: cnt, data });
  } catch (e) {
    console.error('Payments list error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/payments/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [[row]] = await pool.query(
      `SELECT p.*, pm.code as method_code, pm.display_name as method_name,
              v.shop_name as vendor_name, c.name as customer_name
       FROM payments p
       LEFT JOIN payment_methods pm ON pm.id = p.method_id
       LEFT JOIN vendors v ON v.id = p.vendor_id
       LEFT JOIN customers c ON c.id = p.customer_id
       WHERE p.id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    row.sensitive_masked = maskSensitive(row.sensitive_masked);
    res.json(row);
  } catch (e) {
    console.error('Payment view error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/payments/:id/refund { amount, reason }
router.post('/:id/refund', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { amount, reason = '' } = req.body || {};
    const refundAmount = Number(amount);
    const [[payment]] = await conn.query('SELECT * FROM payments WHERE id = ? FOR UPDATE', [id]);
    if (!payment) return res.status(404).json({ error: 'Not found' });
    if (!(payment.status === 'success' || payment.status === 'partial_refunded')) {
      return res.status(400).json({ error: 'Refund allowed only for successful payments' });
    }
    if (!(refundAmount > 0) || refundAmount > Number(payment.amount) - Number(payment.refund_amount || 0)) {
      return res.status(400).json({ error: 'Invalid refund amount' });
    }
    await conn.beginTransaction();
    const before = { status: payment.status, refund_amount: payment.refund_amount };
    const newRefunded = Number(payment.refund_amount || 0) + refundAmount;
    const newStatus = newRefunded >= Number(payment.amount) ? 'refunded' : 'partial_refunded';
    await conn.query('UPDATE payments SET refund_amount = ?, status = ?, updated_at = NOW() WHERE id = ?', [newRefunded, newStatus, id]);
    await logPaymentAudit(id, 'refund', 'admin', reason, before, { status: newStatus, refund_amount: newRefunded });
    await conn.commit();
    res.json({ message: 'Refund processed', status: newStatus, refund_amount: newRefunded });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error('Refund error:', e);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    conn.release();
  }
});

// POST /api/admin/payments/:id/reprocess
router.post('/:id/reprocess', async (req, res) => {
  try {
    const { id } = req.params;
    const [[payment]] = await pool.query('SELECT * FROM payments WHERE id = ?', [id]);
    if (!payment) return res.status(404).json({ error: 'Not found' });
    if (!(payment.status === 'failed' || payment.status === 'pending')) {
      return res.status(400).json({ error: 'Only failed or pending can be reprocessed' });
    }
    const before = { status: payment.status };
    // In a real integration, call gateway API here
    await pool.query('UPDATE payments SET status = ?, updated_at = NOW() WHERE id = ?', ['pending', id]);
    await logPaymentAudit(id, 'reprocess', 'admin', 'Reprocess triggered', before, { status: 'pending' });
    res.json({ message: 'Reprocess initiated', status: 'pending' });
  } catch (e) {
    console.error('Reprocess error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/payments/bulk
router.post('/bulk', async (req, res) => {
  try {
    const { action, ids = [], amount, reason = '' } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
    const results = [];
    for (const pid of ids) {
      if (action === 'reprocess') {
        const [[p]] = await pool.query('SELECT status FROM payments WHERE id = ?', [pid]);
        if (p && (p.status === 'failed' || p.status === 'pending')) {
          await pool.query('UPDATE payments SET status = ?, updated_at = NOW() WHERE id = ?', ['pending', pid]);
          await logPaymentAudit(pid, 'reprocess', 'admin', 'Bulk reprocess', { status: p.status }, { status: 'pending' });
          results.push({ id: pid, ok: true });
        } else {
          results.push({ id: pid, ok: false, error: 'Not reprocessable' });
        }
      } else if (action === 'refund') {
        const [[p]] = await pool.query('SELECT amount, refund_amount, status FROM payments WHERE id = ?', [pid]);
        if (!p) { results.push({ id: pid, ok: false, error: 'Not found' }); continue; }
        if (!(p.status === 'success' || p.status === 'partial_refunded')) { results.push({ id: pid, ok: false, error: 'Not refundable' }); continue; }
        const maxRefund = Number(p.amount) - Number(p.refund_amount || 0);
        const rAmt = Math.min(Number(amount || maxRefund), maxRefund);
        const newRefund = Number(p.refund_amount || 0) + rAmt;
        const newStatus = newRefund >= Number(p.amount) ? 'refunded' : 'partial_refunded';
        await pool.query('UPDATE payments SET refund_amount = ?, status = ?, updated_at = NOW() WHERE id = ?', [newRefund, newStatus, pid]);
        await logPaymentAudit(pid, 'refund', 'admin', reason || 'Bulk refund', { status: p.status, refund_amount: p.refund_amount }, { status: newStatus, refund_amount: newRefund });
        results.push({ id: pid, ok: true, refund_amount: rAmt });
      } else {
        results.push({ id: pid, ok: false, error: 'Unknown action' });
      }
    }
    res.json({ results });
  } catch (e) {
    console.error('Bulk action error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/payments/export.csv
router.get('/export.csv', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT transaction_id, amount, currency, status, gateway, created_at FROM payments ORDER BY created_at DESC LIMIT 5000`);
    const header = 'transaction_id,amount,currency,status,gateway,created_at';
    const csv = [header].concat(rows.map(r => [r.transaction_id, r.amount, r.currency, r.status, r.gateway, r.created_at?.toISOString?.() || r.created_at].map(v => {
      const s = String(v ?? '');
      const esc = s.replace(/"/g, '""');
      return /[",\n]/.test(esc) ? `"${esc}"` : esc;
    }).join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
    res.send(csv);
  } catch (e) {
    console.error('Export CSV error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/payments/:id/receipt.pdf
router.get('/:id/receipt.pdf', async (req, res) => {
  try {
    const { id } = req.params;
    const [[p]] = await pool.query('SELECT * FROM payments WHERE id = ?', [id]);
    if (!p) return res.status(404).json({ error: 'Not found' });

    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text('Payment Receipt', 14, 20);
    doc.setFontSize(11);
    const lines = [
      `Transaction ID: ${p.transaction_id}`,
      `Amount: ${p.amount} ${p.currency || 'INR'}`,
      `Status: ${p.status}`,
      `Gateway: ${p.gateway}`,
      `Paid At: ${p.paid_at || ''}`,
      `Created At: ${p.created_at}`
    ];
    let y = 35;
    lines.forEach(line => { doc.text(line, 14, y); y += 7; });
    const pdf = doc.output('arraybuffer');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${p.transaction_id}.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (e) {
    console.error('Receipt PDF error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

const authenticateAdmin = (req, res, next) => {
	const apiKey = req.headers['x-admin-key']
		|| req.headers['admin-api-key']
		|| req.headers['adminapikey']
		|| req.query['x-admin-key']
		|| req.query['adminApiKey']
		|| (req.cookies && (req.cookies['x-admin-key'] || req.cookies['adminApiKey']));
    if (apiKey && apiKey === ADMIN_API_KEY) {
        req.user = { role: 'admin' };
        return next();
    }

	const authHeader = req.headers['authorization'];
	const token = authHeader && authHeader.split(' ')[1];
	if (!token) return res.status(401).json({ error: 'Access token required' });
	try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
		req.user = decoded;
		next();
	} catch (e) {
		return res.status(403).json({ error: 'Invalid token' });
	}
};

// Helpers for filters
function buildListQuery(params) {
	const {
		q, status, method, vendorId, minAmount, maxAmount, fromDate, toDate, page = 1, pageSize = 20, sortBy = 'created_at', sortDir = 'desc'
	} = params;

	const where = [];
	const values = [];

	if (q) {
		where.push('(transaction_id LIKE ? OR gateway_reference LIKE ? )');
		values.push(`%${q}%`, `%${q}%`);
	}
	if (status) { where.push('status = ?'); values.push(status); }
	if (method) { where.push('method_code = ?'); values.push(method); }
	if (vendorId) { where.push('vendor_id = ?'); values.push(Number(vendorId)); }
	if (minAmount) { where.push('amount >= ?'); values.push(Number(minAmount)); }
	if (maxAmount) { where.push('amount <= ?'); values.push(Number(maxAmount)); }
	if (fromDate) { where.push('(paid_at IS NOT NULL AND paid_at >= ?)'); values.push(new Date(fromDate)); }
	if (toDate) { where.push('(paid_at IS NOT NULL AND paid_at <= ?)'); values.push(new Date(toDate)); }

	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
	const validSort = ['transaction_id','amount','status','method_code','paid_at','created_at'];
	const sortCol = validSort.includes(sortBy) ? sortBy : 'created_at';
	const sortOrder = (String(sortDir).toLowerCase() === 'asc') ? 'ASC' : 'DESC';
	const limit = Math.max(1, Math.min(200, Number(pageSize)));
	const offset = (Math.max(1, Number(page)) - 1) * limit;

	return { whereSql, values, limit, offset, sortCol, sortOrder };
}

// GET /api/payments
router.get('/', authenticateAdmin, async (req, res) => {
	try {
		const { whereSql, values, limit, offset, sortCol, sortOrder } = buildListQuery(req.query);
		const [rows] = await pool.execute(`
			SELECT p.id, p.transaction_id, p.vendor_id, v.shop_name AS vendor_name, p.customer_id, c.name AS customer_name,
			       p.method_code, pm.display_name AS method_name, p.amount, p.status, p.paid_at, p.created_at
			FROM payments p
			LEFT JOIN vendors v ON p.vendor_id = v.id
			LEFT JOIN customers c ON p.customer_id = c.id
			LEFT JOIN payment_methods pm ON p.method_code = pm.method_code
			${whereSql}
			ORDER BY ${sortCol} ${sortOrder}
			LIMIT ? OFFSET ?
		`, [...values, limit, offset]);

		const [[{ total }]] = await pool.execute(`
			SELECT COUNT(*) AS total FROM payments p ${whereSql}
		`, values);

		res.json({ data: rows, page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 20), total });
	} catch (e) {
		console.error('List payments error:', e);
		res.status(500).json({ error: 'Failed to list payments' });
	}
});

// GET /api/payments/:id
router.get('/:id', authenticateAdmin, async (req, res) => {
	try {
		const paymentId = Number(req.params.id);
		const [[payment]] = await pool.execute(`
			SELECT p.*, v.shop_name AS vendor_name, c.name AS customer_name, pm.display_name AS method_name
			FROM payments p
			LEFT JOIN vendors v ON p.vendor_id = v.id
			LEFT JOIN customers c ON p.customer_id = c.id
			LEFT JOIN payment_methods pm ON p.method_code = pm.method_code
			WHERE p.id = ?
		`, [paymentId]);
		if (!payment) return res.status(404).json({ error: 'Payment not found' });

		const [refunds] = await pool.execute('SELECT * FROM payment_refunds WHERE payment_id = ? ORDER BY created_at DESC', [paymentId]);
		res.json({ payment, refunds });
	} catch (e) {
		console.error('Get payment error:', e);
		res.status(500).json({ error: 'Failed to get payment' });
	}
});

// POST /api/payments/:id/refund
router.post('/:id/refund', authenticateAdmin, async (req, res) => {
	try {
		const paymentId = Number(req.params.id);
		const { amount, reason } = req.body || {};
		if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount required' });

		const [[payment]] = await pool.execute('SELECT * FROM payments WHERE id = ?', [paymentId]);
		if (!payment) return res.status(404).json({ error: 'Payment not found' });
		if (payment.status === 'failed' || payment.status === 'pending') {
			return res.status(400).json({ error: 'Cannot refund failed/pending payment' });
		}

		const refundId = `RFD-${Date.now()}`;
		await pool.execute(
			'INSERT INTO payment_refunds (payment_id, refund_id, amount, reason) VALUES (?,?,?,?)',
			[paymentId, refundId, Number(amount), reason || null]
		);
		await pool.execute(
			'INSERT INTO payment_audit_logs (payment_id, actor_type, actor_id, action, details) VALUES (?,?,?,?,?)',
			[paymentId, 'admin', req.user?.id || null, 'refund_initiated', JSON.stringify({ amount, reason })]
		);

		res.json({ success: true, refundId });
	} catch (e) {
		console.error('Refund error:', e);
		res.status(500).json({ error: 'Failed to initiate refund' });
	}
});

// POST /api/payments/:id/reprocess
router.post('/:id/reprocess', authenticateAdmin, async (req, res) => {
	try {
		const paymentId = Number(req.params.id);
		const [[payment]] = await pool.execute('SELECT * FROM payments WHERE id = ?', [paymentId]);
		if (!payment) return res.status(404).json({ error: 'Payment not found' });
		if (payment.status !== 'failed' && payment.status !== 'pending' && payment.status !== 'processing') {
			return res.status(400).json({ error: 'Only failed or pending payments can be reprocessed' });
		}
		await pool.execute('UPDATE payments SET status = "processing", updated_at = NOW() WHERE id = ?', [paymentId]);
		await pool.execute(
			'INSERT INTO payment_audit_logs (payment_id, actor_type, actor_id, action) VALUES (?,?,?,?)',
			[paymentId, 'admin', req.user?.id || null, 'reprocess_triggered']
		);
		res.json({ success: true });
	} catch (e) {
		console.error('Reprocess error:', e);
		res.status(500).json({ error: 'Failed to reprocess payment' });
	}
});

// POST /api/payments/bulk
router.post('/bulk', authenticateAdmin, async (req, res) => {
	try {
		const { action, ids = [], amount } = req.body || {};
		if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
		if (!action) return res.status(400).json({ error: 'action required' });

		if (action === 'refund') {
			const results = [];
			for (const id of ids) {
				try {
					const refundId = `RFD-${Date.now()}-${id}`;
					await pool.execute('INSERT INTO payment_refunds (payment_id, refund_id, amount) VALUES (?,?,?)', [id, refundId, Number(amount || 0)]);
					await pool.execute('INSERT INTO payment_audit_logs (payment_id, actor_type, action) VALUES (?,?,?)', [id, 'admin', 'bulk_refund_initiated']);
					results.push({ id, status: 'ok', refundId });
				} catch (e) {
					results.push({ id, status: 'error', message: e.message });
				}
			}
			return res.json({ success: true, results });
		}

		if (action === 'reprocess') {
			await pool.execute(`UPDATE payments SET status = 'processing', updated_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
			for (const id of ids) {
				await pool.execute('INSERT INTO payment_audit_logs (payment_id, actor_type, action) VALUES (?,?,?)', [id, 'admin', 'bulk_reprocess_triggered']);
			}
			return res.json({ success: true, count: ids.length });
		}

		return res.status(400).json({ error: 'Unsupported action' });
	} catch (e) {
		console.error('Bulk action error:', e);
		res.status(500).json({ error: 'Failed to perform bulk action' });
	}
});

module.exports = router;


