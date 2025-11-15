const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const sharedPool = require('../utils/db');

const pool = sharedPool.promise();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// GET /api/vendors/:id - fetch vendor profile (restricted to owner)
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const vendorId = parseInt(id, 10);
    if (!Number.isFinite(vendorId) || vendorId <= 0) {
      return res.status(400).json({ error: 'Invalid vendor id' });
    }
    if (req.user.vendorId && req.user.vendorId !== vendorId && req.user.vendor_id !== vendorId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const [rows] = await pool.execute(
      `SELECT id, shop_name, owner_name, owner_email as email, owner_phone as phone, address as shopAddress, status, kyc_status
       FROM vendors WHERE id = ? LIMIT 1`,
      [vendorId]
    );
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('GET /api/vendors/:id error', e);
    res.status(500).json({ error: 'Failed to fetch vendor' });
  }
});

// PUT /api/vendors/:id - update vendor profile (restricted to owner)
router.put('/:id', authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const vendorId = parseInt(id, 10);
    if (!Number.isFinite(vendorId) || vendorId <= 0) {
      return res.status(400).json({ error: 'Invalid vendor id' });
    }
    if (req.user.vendorId && req.user.vendorId !== vendorId && req.user.vendor_id !== vendorId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const [[exists]] = await conn.execute('SELECT id FROM vendors WHERE id = ? LIMIT 1', [vendorId]);
    if (!exists) return res.status(404).json({ error: 'Vendor not found' });

    const allowed = ['shop_name','owner_name','owner_email','owner_phone','address','city','state','zip_code','country','logo_url','banner_url'];
    const fields = [];
    const values = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        fields.push(`${key} = ?`);
        values.push(req.body[key]);
      }
    }
    if (!fields.length) return res.json({ success: true });

    await conn.execute(`UPDATE vendors SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, [...values, vendorId]);
    res.json({ success: true });
  } catch (e) {
    console.error('PUT /api/vendors/:id error', e);
    res.status(500).json({ error: 'Failed to update vendor' });
  } finally {
    conn.release();
  }
});

// GET /api/vendors/:id/dashboard - lightweight vendor dashboard
router.get('/:id/dashboard', authenticateToken, async (req, res) => {
  try {
    const vendorId = parseInt(req.params.id, 10);
    if (!Number.isFinite(vendorId) || vendorId <= 0) {
      return res.status(400).json({ error: 'Invalid vendor id' });
    }
    if (req.user.vendorId && req.user.vendorId !== vendorId && req.user.vendor_id !== vendorId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const [[orderStats]] = await pool.execute(
      `SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_orders
       FROM orders WHERE vendor_id = ?`,
      [vendorId]
    );
    const [[productStats]] = await pool.execute(
      `SELECT COUNT(*) as total_products FROM products WHERE vendor_id = ?`,
      [vendorId]
    );
    res.json({
      vendor_id: vendorId,
      orders: orderStats || { total_orders: 0, pending_orders: 0, delivered_orders: 0 },
      products: productStats || { total_products: 0 }
    });
  } catch (e) {
    console.error('GET /api/vendors/:id/dashboard error', e);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

module.exports = router;


