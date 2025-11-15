const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const multer = require('multer');
const sharedPool = require('../utils/db');

const pool = sharedPool.promise();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Function to generate the next Product ID
async function generateProductId() {
  try {
    const [result] = await pool.execute(`
      SELECT COALESCE(MAX(CAST(SUBSTRING(product_id, 5) AS UNSIGNED)), 0) + 1 as next_num
      FROM products 
      WHERE product_id REGEXP '^PRDT[0-9]+$'
    `);
    
    const nextNumber = result[0]?.next_num || 1;
    return `PRDT${nextNumber.toString().padStart(3, '0')}`;
  } catch (error) {
    console.error('Error generating Product ID:', error);
    // Fallback: use timestamp-based ID
    const timestamp = Date.now().toString().slice(-6);
    return `PRDT${timestamp}`;
  }
}

// Reuse simple auth like inventory routes
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

// Utility: check if a column exists on a table (cached per process)
const columnExistenceCache = new Map();
async function tableHasColumn(tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  if (columnExistenceCache.has(key)) return columnExistenceCache.get(key);
  try {
    const [rows] = await pool.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
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

function buildStatusFilter(statusKey) {
  // Maps frontend status filter keys to SQL conditions on inventory/products
  switch ((statusKey || '').toLowerCase()) {
    case 'lowstock':
      return 'i.stock_available > 0 AND i.stock_available <= i.min_stock_level';
    case 'criticalstock':
      return 'i.stock_available > 0 AND i.stock_available <= i.reorder_point';
    case 'outofstock':
      return 'COALESCE(i.stock_available, 0) <= 0';
    case 'inactive':
      return "p.status = 'inactive'";
    case 'active':
      return "p.status = 'active'";
    default:
      return '1=1';
  }
}

function parseCategoryId(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed === '') return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

async function fetchCategoryIdByName(conn, categoryName) {
  if (!categoryName) return null;
  const trimmed = typeof categoryName === 'string' ? categoryName.trim() : '';
  if (!trimmed) return null;
  try {
    const [rows] = await conn.execute(
      'SELECT id FROM product_categories WHERE name = ? LIMIT 1',
      [trimmed]
    );
    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0].id;
    }
  } catch (err) {
    console.warn('Failed to resolve category_id from name:', err?.message || err);
  }
  return null;
}

async function resolveCategoryId(conn, options = {}) {
  if (!options) return null;
  const direct = parseCategoryId(options.categoryId ?? options.category_id);
  if (direct !== null) return direct;
  return fetchCategoryIdByName(conn, options.categoryName ?? options.category);
}

// GET /api/products/categories - get all product categories (MUST be before /:id route)
router.get('/categories', async (req, res) => {
  try {
    const [categories] = await pool.execute(`
      SELECT id, name, description, gst_rate, hsn_code 
      FROM product_categories 
      WHERE is_active = TRUE 
      ORDER BY name ASC
    `);
    
    res.json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// GET /api/products/next-sku/:vendorId/:categoryCode - get next SKU number for vendor and category
router.get('/next-sku/:vendorId/:categoryCode', async (req, res) => {
  try {
    const { vendorId, categoryCode } = req.params;
    
    // Find existing products with similar SKU pattern
    const [existingProducts] = await pool.execute(`
      SELECT sku 
      FROM products 
      WHERE sku LIKE ? 
      ORDER BY sku DESC 
      LIMIT 1
    `, [`SONI-${vendorId}-${categoryCode}-%`]);
    
    let nextNumber = 1;
    
    if (existingProducts.length > 0) {
      // Extract the number from the last SKU
      const lastSku = existingProducts[0].sku;
      // Updated regex to handle VDR format: SONI-VDR001-ELE-0001
      const match = lastSku.match(/SONI-[A-Z0-9]+-[A-Z]{3}-(\d+)$/);
      if (match) {
        nextNumber = parseInt(match[1]) + 1;
      }
    }
    
    // Format the number with leading zeros (4 digits)
    const formattedNumber = nextNumber.toString().padStart(4, '0');
    const nextSku = `SONI-${vendorId}-${categoryCode}-${formattedNumber}`;
    
    res.json({ 
      nextSku,
      nextNumber,
      categoryCode,
      vendorId
    });
  } catch (error) {
    console.error('Error generating next SKU:', error);
    res.status(500).json({ error: 'Failed to generate next SKU' });
  }
});

// GET /api/products/gst-rates - get unique GST rates from product categories
router.get('/gst-rates', async (req, res) => {
  try {
    const [gstRates] = await pool.execute(`
      SELECT DISTINCT gst_rate 
      FROM product_categories 
      WHERE is_active = TRUE 
      ORDER BY gst_rate ASC
    `);
    
    // Format the GST rates with descriptions
    const formattedRates = gstRates.map(rate => {
      const gstValue = parseFloat(rate.gst_rate);
      let description = '';
      
      switch (gstValue) {
        case 0:
          description = 'Exempt';
          break;
        case 3:
          description = 'Precious Metals';
          break;
        case 5:
          description = 'Essential Items';
          break;
        case 12:
          description = 'Standard Rate';
          break;
        case 18:
          description = 'Standard Rate';
          break;
        case 28:
          description = 'Luxury Items';
          break;
        default:
          description = 'Other';
      }
      
      return {
        rate: gstValue,
        description: description,
        display: `${gstValue}% - ${description}`
      };
    });
    
    res.json({ gstRates: formattedRates });
  } catch (error) {
    console.error('Error fetching GST rates:', error);
    res.status(500).json({ error: 'Failed to fetch GST rates' });
  }
});

// GET /api/products/csv-template - provide CSV template for bulk upload
router.get('/csv-template', async (req, res) => {
  try {
    const headers = [
      'name','sku','category','price','stock_on_hand','min_stock_level','reorder_point','hsn_code','gst_slab','description','image_url','unit','weight','dimensions','barcode'
    ];
    const sample = [
      'Apple','APPLE-001','Food & Beverages','150','10','2','5','08081010','5','Fresh apples','https://example.com/apple.jpg','piece','1','',''
    ];
    const csv = `${headers.join(',')}\n${sample.join(',')}\n`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="product_template.csv"');
    res.send(csv);
  } catch (e) {
    console.error('Error in GET /api/products/csv-template:', e);
    res.status(500).json({ error: 'Failed to generate template' });
  }
});

// GET /api/products - list vendor products with pagination and filters
router.get('/', authenticateToken, async (req, res) => {
  try {
    const vendorId = req.user?.vendorId || req.user?.vendor_id;
    if (!vendorId) return res.status(400).json({ error: 'Vendor session missing' });

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 100);
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const category = (req.query.category || 'all').trim();
    const statusKey = (req.query.status || 'all').trim();

    const whereParts = ['p.vendor_id = ?'];
    const params = [vendorId];

    if (search) {
      whereParts.push('(p.name LIKE ? OR p.sku LIKE ? OR p.category LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (category && category.toLowerCase() !== 'all') {
      whereParts.push('p.category = ?');
      params.push(category);
    }
    const statusCond = buildStatusFilter(statusKey);
    if (statusCond !== '1=1') whereParts.push(statusCond);

    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const baseSelect = `
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      ${whereSql}
    `;

    // Count with JOIN to support status filters that reference inventory (e.g., i.stock_available)
    const [countRows] = await pool.execute(
      `SELECT COUNT(DISTINCT p.id) as total ${baseSelect}`,
      params
    );
    const total = countRows?.[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    // Use sanitized integers directly in LIMIT/OFFSET to avoid driver issues with placeholders there
    const limitInt = Number.isFinite(limit) ? limit : 10;
    const offsetInt = Number.isFinite(offset) ? offset : 0;

    const hasProductImagesCol = await tableHasColumn('products', 'product_images');
    const hasCategoryIdCol = await tableHasColumn('products', 'category_id');
    const productImagesSelect = hasProductImagesCol ? ', p.product_images' : '';
    const categoryIdSelect = hasCategoryIdCol ? ', p.category_id' : '';
    const [rows] = await pool.execute(
      `SELECT 
        p.id, p.product_id, p.vendor_id, p.name, p.description, p.sku, p.category${categoryIdSelect},
        p.price, p.mrp, p.cost_price, p.image_url${productImagesSelect}, p.unit, p.weight, p.dimensions,
        p.barcode, p.gst_slab, p.hsn_code, p.status, p.created_at, p.updated_at,
        COALESCE(i.stock_on_hand, 0) as stock_on_hand,
        COALESCE(i.stock_reserved, 0) as stock_reserved,
        COALESCE(i.stock_available, 0) as stock_available,
        COALESCE(i.min_stock_level, 0) as min_stock_level,
        COALESCE(i.max_stock_level, NULL) as max_stock_level,
        COALESCE(i.reorder_point, 0) as reorder_point,
        COALESCE(i.reorder_quantity, 0) as reorder_quantity
      ${baseSelect}
      ORDER BY p.created_at DESC
      LIMIT ${limitInt} OFFSET ${offsetInt}`,
      params
    );

    res.json({ products: rows, total, totalPages, page, limit });
  } catch (e) {
    console.error('Error in GET /api/products:', e);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /api/products/:id - get a single product with inventory fields
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const vendorId = req.user?.vendorId || req.user?.vendor_id;
    const { id } = req.params;
    const hasProductImagesCol = await tableHasColumn('products', 'product_images');
    const hasCategoryIdCol = await tableHasColumn('products', 'category_id');
    const productImagesSelect = hasProductImagesCol ? ', p.product_images' : '';
    const categoryIdSelect = hasCategoryIdCol ? ', p.category_id' : '';
    const [rows] = await pool.execute(
      `SELECT 
        p.id, p.product_id, p.vendor_id, p.name, p.description, p.sku, p.category${categoryIdSelect},
        p.price, p.mrp, p.cost_price, p.image_url${productImagesSelect}, p.unit, p.weight, p.dimensions,
        p.barcode, p.gst_slab, p.hsn_code, p.status, p.created_at, p.updated_at,
        COALESCE(i.stock_on_hand, 0) as stock_on_hand,
        COALESCE(i.stock_reserved, 0) as stock_reserved,
        COALESCE(i.stock_available, 0) as stock_available,
        COALESCE(i.min_stock_level, 0) as min_stock_level,
        COALESCE(i.max_stock_level, NULL) as max_stock_level,
        COALESCE(i.reorder_point, 0) as reorder_point,
        COALESCE(i.reorder_quantity, 0) as reorder_quantity
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.id = ? AND p.vendor_id = ?
      LIMIT 1`,
      [id, vendorId]
    );
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Error in GET /api/products/:id:', e);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// GET /api/products/:id/price - compute/fetch final price (simple passthrough for now)
router.get('/:id/price', authenticateToken, async (req, res) => {
  try {
    const vendorId = req.user?.vendorId || req.user?.vendor_id;
    const { id } = req.params;
    const [[product]] = await pool.execute(
      'SELECT price FROM products WHERE id = ? AND vendor_id = ? LIMIT 1',
      [id, vendorId]
    );
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ final_price: Number(product.price) });
  } catch (e) {
    console.error('Error in GET /api/products/:id/price:', e);
    res.status(500).json({ error: 'Failed to get price' });
  }
});

// POST /api/products/upload-csv - bulk upload products via CSV
router.post('/upload-csv', authenticateToken, upload.single('csvFile'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const vendorId = req.user?.vendorId || req.user?.vendor_id;
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'CSV file is required' });

    const buf = req.file.buffer.toString('utf8');
    const lines = buf.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) return res.status(400).json({ error: 'Empty CSV' });

    const headers = lines[0].split(',').map(h => h.trim());
    const requiredHeaders = ['name','sku','category','price'];
    for (const h of requiredHeaders) if (!headers.includes(h)) return res.status(400).json({ error: `Missing required header: ${h}` });

    const idx = (h) => headers.indexOf(h);

    let totalRows = 0;
    let successfulRows = 0;
    let failedRows = 0;
    const errors = [];

    await conn.beginTransaction();

    for (let i = 1; i < lines.length; i++) {
      const rowStr = lines[i];
      if (!rowStr.trim()) continue;
      totalRows++;
      try {
        // naive CSV split (assumes no commas inside fields)
        const cols = rowStr.split(',');
        const get = (h) => {
          const j = idx(h);
          return j >= 0 ? (cols[j] || '').trim() : '';
        };

        const name = get('name');
        const sku = get('sku');
        const category = get('category');
        const price = parseFloat(get('price') || '0');
        if (!name || !sku || !category || !isFinite(price)) throw new Error('Invalid required fields');

        const description = get('description') || null;
        const image_url = get('image_url') || null;
        const unit = get('unit') || 'piece';
        const weight = get('weight') ? parseFloat(get('weight')) : null;
        const dimensions = get('dimensions') || null;
        const barcode = get('barcode') || null;
        const gst_slab = get('gst_slab') ? parseFloat(get('gst_slab')) : null;
        const hsn_code = get('hsn_code') || null;
        const stock_on_hand = get('stock_on_hand') ? parseInt(get('stock_on_hand'), 10) : 0;
        const min_stock_level = get('min_stock_level') ? parseInt(get('min_stock_level'), 10) : 0;
        const reorder_point = get('reorder_point') ? parseInt(get('reorder_point'), 10) : 0;

        // Generate Product ID for CSV upload
        const productIdValue = await generateProductId();
        
        const [result] = await conn.execute(
          `INSERT INTO products (
            product_id, vendor_id, name, description, sku, category, price, mrp, cost_price, image_url,
            unit, weight, dimensions, barcode, gst_slab, hsn_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
          [productIdValue, vendorId, name, description, sku, category, price, image_url, unit, weight, dimensions, barcode, gst_slab, hsn_code]
        );
        const productId = result.insertId;

        await conn.execute(
          `INSERT INTO inventory (
            product_id, stock_on_hand, stock_reserved, min_stock_level, max_stock_level, reorder_point, reorder_quantity
          ) VALUES (?, ?, 0, ?, NULL, ?, 0)`,
          [productId, Number(stock_on_hand || 0), Number(min_stock_level || 0), Number(reorder_point || 0)]
        );

        successfulRows++;
      } catch (rowErr) {
        failedRows++;
        errors.push(`Row ${i + 1}: ${rowErr.message}`);
      }
    }

    await conn.commit();
    res.json({ totalRows, successfulRows, failedRows, errors });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error('Error in POST /api/products/upload-csv:', e);
    res.status(500).json({ error: 'Failed to upload CSV' });
  } finally {
    conn.release();
  }
});

// POST /api/products - create product (and its inventory row)
router.post('/', authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const vendorId = req.user?.vendorId || req.user?.vendor_id;
    const {
      name, description, sku, category, price, mrp, cost_price, image_url, product_images,
      unit, weight, dimensions, barcode, gst_slab, hsn_code,
      stock_on_hand = 0, min_stock_level = 0, max_stock_level = null,
      reorder_point = 0, reorder_quantity = 0,
      category_id: categoryIdFromBody,
      categoryId: categoryIdCamel
    } = req.body || {};

    // Basic required fields validation
    if (!name || !sku || !category || typeof price === 'undefined') {
      return res.status(400).json({ error: 'Missing required product fields' });
    }

    // Duplicate SKU validation (per vendor or globally if no vendor column)
    const hasVendorIdCol = await tableHasColumn('products', 'vendor_id');
    if (hasVendorIdCol) {
      const [[dup]] = await conn.execute(
        'SELECT id FROM products WHERE vendor_id = ? AND sku = ? LIMIT 1',
        [vendorId, sku]
      );
      if (dup) {
        return res.status(409).json({ error: 'Product already exists with the same SKU' });
      }
    } else {
      const [[dup]] = await conn.execute(
        'SELECT id FROM products WHERE sku = ? LIMIT 1',
        [sku]
      );
      if (dup) {
        return res.status(409).json({ error: 'Product already exists with the same SKU' });
      }
    }

    const hasCategoryIdCol = await tableHasColumn('products', 'category_id');
    let resolvedCategoryId = null;
    if (hasCategoryIdCol) {
      resolvedCategoryId = await resolveCategoryId(conn, {
        categoryId: categoryIdFromBody ?? categoryIdCamel,
        categoryName: category
      });
      if (resolvedCategoryId === null) {
        return res.status(400).json({ error: 'Invalid category selected' });
      }
    }

    await conn.beginTransaction();
    
    // Generate Product ID
    const productIdValue = await generateProductId();
    
    const hasProductImagesCol = await tableHasColumn('products', 'product_images');
    const productImagesValue = Array.isArray(product_images) ? JSON.stringify(product_images) : (typeof product_images === 'string' && product_images.trim() ? product_images : null);
    const columns = [
      'product_id',
      'vendor_id',
      'name',
      'description',
      'sku',
      'category'
    ];
    const values = [
      productIdValue,
      vendorId,
      name,
      description || null,
      sku,
      category
    ];
    if (hasCategoryIdCol) {
      columns.push('category_id');
      values.push(resolvedCategoryId);
    }
    columns.push('price', 'mrp', 'cost_price', 'image_url');
    values.push(price, mrp || null, cost_price || null, image_url || null);
    if (hasProductImagesCol) {
      columns.push('product_images');
      values.push(productImagesValue);
    }
    columns.push('unit', 'weight', 'gst_slab', 'hsn_code');
    values.push(unit || 'piece', weight || null, gst_slab || null, hsn_code || null);
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO products (${columns.join(', ')}) VALUES (${placeholders})`;
    const [result] = await conn.execute(insertSql, values);
    const productId = result.insertId;

    await conn.execute(
      `INSERT INTO inventory (
        product_id, stock_on_hand, stock_reserved, min_stock_level, reorder_point, reorder_quantity
      ) VALUES (?, ?, 0, ?, ?, ?)`,
      [productId, Number(stock_on_hand || 0), Number(min_stock_level || 0), Number(reorder_point || 0), Number(reorder_quantity || 0)]
    );

    await conn.commit();
    res.status(201).json({ id: productId });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error('Error in POST /api/products:', e);
    if (e && (e.code === 'ER_DUP_ENTRY' || (typeof e.message === 'string' && e.message.toLowerCase().includes('duplicate')))) {
      return res.status(409).json({ error: 'Product already exists with the same SKU' });
    }
    res.status(500).json({ error: 'Failed to create product' });
  } finally {
    conn.release();
  }
});

// PUT /api/products/:id - update product fields (and inventory if provided)
router.put('/:id', authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const vendorId = req.user?.vendorId || req.user?.vendor_id;
    const { id } = req.params;

    const [[exists]] = await conn.execute('SELECT id FROM products WHERE id = ? AND vendor_id = ? LIMIT 1', [id, vendorId]);
    if (!exists) return res.status(404).json({ error: 'Product not found' });

    const hasProductImagesCol = await tableHasColumn('products', 'product_images');
    const hasCategoryIdCol = await tableHasColumn('products', 'category_id');
    const updatable = ['name','description','sku','category','price','mrp','cost_price','image_url', ...(hasProductImagesCol ? ['product_images'] : []), 'unit','weight','gst_slab','hsn_code','status'];
    if (hasCategoryIdCol) updatable.push('category_id');
    const fields = [];
    const values = [];
    let categoryIdForUpdate = undefined;
    if (hasCategoryIdCol) {
      const hasCategoryIdInBody = Object.prototype.hasOwnProperty.call(req.body, 'category_id') || Object.prototype.hasOwnProperty.call(req.body, 'categoryId');
      const hasCategoryInBody = Object.prototype.hasOwnProperty.call(req.body, 'category');
      if (hasCategoryIdInBody || hasCategoryInBody) {
        categoryIdForUpdate = await resolveCategoryId(conn, {
          categoryId: hasCategoryIdInBody
            ? (Object.prototype.hasOwnProperty.call(req.body, 'category_id') ? req.body.category_id : req.body.categoryId)
            : undefined,
          categoryName: hasCategoryInBody ? req.body.category : undefined
        });
        if (categoryIdForUpdate === null) {
          return res.status(400).json({ error: 'Invalid category selected' });
        }
      }
    }

    for (const key of updatable) {
      if (key === 'category_id') {
        if (typeof categoryIdForUpdate !== 'undefined') {
          fields.push(`${key} = ?`);
          values.push(categoryIdForUpdate);
        }
        continue;
      }
      if (typeof req.body[key] !== 'undefined') {
        fields.push(`${key} = ?`);
        if (key === 'product_images') {
          const val = Array.isArray(req.body[key]) ? JSON.stringify(req.body[key]) : (typeof req.body[key] === 'string' ? req.body[key] : null);
          values.push(val);
        } else {
          values.push(req.body[key]);
        }
      }
    }

    await conn.beginTransaction();
    if (fields.length) {
      await conn.execute(`UPDATE products SET ${fields.join(', ')} WHERE id = ? AND vendor_id = ?`, [...values, id, vendorId]);
    }

    // Optional inventory updates
    const invMap = {
      stock_on_hand: 'stock_on_hand',
      stock_reserved: 'stock_reserved',
      min_stock_level: 'min_stock_level',
      reorder_point: 'reorder_point',
      reorder_quantity: 'reorder_quantity',
    };
    const invFields = [];
    const invValues = [];
    for (const [bodyKey, col] of Object.entries(invMap)) {
      if (typeof req.body[bodyKey] !== 'undefined') {
        invFields.push(`${col} = ?`);
        invValues.push(req.body[bodyKey]);
      }
    }
    if (invFields.length) {
      await conn.execute(
        `UPDATE inventory SET ${invFields.join(', ')} WHERE product_id = ?`,
        [...invValues, id]
      );
    }

    await conn.commit();
    res.json({ success: true });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error('Error in PUT /api/products/:id:', e);
    res.status(500).json({ error: 'Failed to update product' });
  } finally {
    conn.release();
  }
});

// DELETE /api/products/:id - delete a product
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const vendorId = req.user?.vendorId || req.user?.vendor_id;
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM products WHERE id = ? AND vendor_id = ?', [id, vendorId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true });
  } catch (e) {
    console.error('Error in DELETE /api/products/:id:', e);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// POST /api/products/:id/price-request - stub accept vendor price requests
router.post('/:id/price-request', authenticateToken, async (req, res) => {
  try {
    // In a full implementation, persist request for admin review
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to submit price request' });
  }
});

module.exports = router;


