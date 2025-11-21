const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const sharedPool = require('../utils/db');
const {
  uploadMulterFileToCloudinary,
  deleteCloudinaryAsset,
  extractPublicIdFromUrl
} = require('../utils/cloudinary');

const pool = sharedPool.promise();

// Configure multer for category image uploads (using memory storage for Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files (JPG, PNG, GIF, WEBP) are allowed'));
    }
  }
});

// GET /api/categories - get all categories
router.get('/', async (req, res) => {
  console.log('GET /api/categories - Request received');
  try {
    // Check which image columns exist
    const hasCategoryImage = await columnExists('product_categories', 'category_image');
    const hasImageUrl = await columnExists('product_categories', 'image_url');
    
    console.log('Image columns check - category_image:', hasCategoryImage, 'image_url:', hasImageUrl);
    
    // Build query based on available columns
    let query = 'SELECT id, name, description, gst_rate, hsn_code';
    
    if (hasCategoryImage && hasImageUrl) {
      query += `, COALESCE(NULLIF(category_image, ''), NULLIF(image_url, ''), '') as category_image`;
    } else if (hasCategoryImage) {
      query += `, COALESCE(category_image, '') as category_image`;
    } else if (hasImageUrl) {
      query += `, COALESCE(image_url, '') as category_image`;
    } else {
      query += `, '' as category_image`;
    }
    
    query += ' FROM product_categories ORDER BY name ASC';
    
    console.log('Executing query:', query);
    const [categories] = await pool.execute(query);
    
    console.log(`Found ${categories.length} categories`);
    
    // Log image paths for debugging
    categories.forEach((cat, index) => {
      if (cat.category_image) {
        console.log(`Category ${index + 1} (${cat.name}): image = ${cat.category_image}`);
      }
    });
    
    res.json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage
    });
    
    // Check if it's a table doesn't exist error
    if (error.code === 'ER_NO_SUCH_TABLE' || error.message?.includes('doesn\'t exist') || error.message?.includes('Unknown table')) {
      return res.status(404).json({ 
        error: 'Categories table not found',
        message: 'The product_categories table does not exist. Please create it first.',
        details: error.message
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch categories',
      details: error.message || 'Unknown error occurred',
      code: error.code
    });
  }
});

// Helper function to check if a column exists
async function columnExists(tableName, columnName) {
  try {
    const [rows] = await pool.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME = ? 
       AND COLUMN_NAME = ?`,
      [tableName, columnName]
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch (error) {
    return false;
  }
}

// PUT /api/categories/:id - update category with file upload support
router.put('/:id', (req, res, next) => {
  upload.single('category_image')(req, res, (err) => {
    if (err) {
      console.error('Multer error:', err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
        }
        return res.status(400).json({ error: 'File upload error: ' + err.message });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    console.log('PUT /api/categories/:id - Request received');
    console.log('File uploaded:', req.file ? 'Yes' : 'No');
    if (req.file) {
      console.log('File details:', {
        filename: req.file.filename,
        path: req.file.path,
        size: req.file.size,
        mimetype: req.file.mimetype
      });
    }
    console.log('Request body:', req.body);
    
    const { id } = req.params;
    const { name, gst_rate, hsn_code } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    // Check if category exists
    const [existing] = await pool.execute(
      'SELECT id FROM product_categories WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Check which columns exist and build update query dynamically
    const updateFields = [];
    const updateValues = [];

    // Always update name
    updateFields.push('name = ?');
    updateValues.push(name);

    // Update gst_rate if column exists
    const hasGstRate = await columnExists('product_categories', 'gst_rate');
    if (hasGstRate) {
      updateFields.push('gst_rate = ?');
      updateValues.push(gst_rate !== '' && gst_rate !== null && gst_rate !== undefined ? parseFloat(gst_rate) : null);
    }

    // Update hsn_code if column exists
    const hasHsnCode = await columnExists('product_categories', 'hsn_code');
    if (hasHsnCode) {
      updateFields.push('hsn_code = ?');
      updateValues.push(hsn_code || null);
    }

    // Handle image upload - if file was uploaded, upload to Cloudinary
    if (req.file) {
      console.log('Processing image upload to Cloudinary...');
      console.log('Uploaded file:', {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      });
      
      try {
        // Upload to Cloudinary
        const uploadResult = await uploadMulterFileToCloudinary(req.file, {
          folder: 'categories',
          resourceType: 'image',
          useFilename: true,
          uniqueFilename: true
        });
        
        const imageUrl = uploadResult.secure_url;
        console.log('Image uploaded to Cloudinary:', imageUrl);
        console.log('Cloudinary public_id:', uploadResult.public_id);
        
        // Check for both category_image and image_url columns
        const hasCategoryImage = await columnExists('product_categories', 'category_image');
        const hasImageUrl = await columnExists('product_categories', 'image_url');
        
        console.log('Column check - category_image:', hasCategoryImage, 'image_url:', hasImageUrl);
        
        // Get old image URL to delete it from Cloudinary later
        let oldImageUrl = null;
        if (hasCategoryImage) {
          const [oldData] = await pool.execute('SELECT category_image FROM product_categories WHERE id = ?', [id]);
          oldImageUrl = oldData[0]?.category_image;
          console.log('Old image URL from category_image:', oldImageUrl);
          updateFields.push('category_image = ?');
          updateValues.push(imageUrl);
        } else if (hasImageUrl) {
          const [oldData] = await pool.execute('SELECT image_url FROM product_categories WHERE id = ?', [id]);
          oldImageUrl = oldData[0]?.image_url;
          console.log('Old image URL from image_url:', oldImageUrl);
          updateFields.push('image_url = ?');
          updateValues.push(imageUrl);
        } else {
          console.warn('No image column found in product_categories table');
        }
        
        // Delete old image from Cloudinary if it exists
        if (oldImageUrl && oldImageUrl.includes('cloudinary.com')) {
          try {
            const oldPublicId = extractPublicIdFromUrl(oldImageUrl);
            if (oldPublicId) {
              console.log('Deleting old image from Cloudinary, public_id:', oldPublicId);
              await deleteCloudinaryAsset(oldPublicId, 'image');
              console.log('Old image deleted from Cloudinary successfully');
            }
          } catch (deleteError) {
            console.warn('Failed to delete old image from Cloudinary:', deleteError.message);
            // Don't fail the update if deletion fails
          }
        }
      } catch (cloudinaryError) {
        console.error('Cloudinary upload error:', cloudinaryError);
        throw new Error('Failed to upload image to Cloudinary: ' + (cloudinaryError.message || 'Unknown error'));
      }
    } else {
      console.log('No file uploaded in this request');
    }

    // Add updated_at if column exists
    const hasUpdatedAt = await columnExists('product_categories', 'updated_at');
    if (hasUpdatedAt) {
      updateFields.push('updated_at = CURRENT_TIMESTAMP');
    }

    // Add id for WHERE clause
    updateValues.push(id);

    // Execute update
    const updateQuery = `UPDATE product_categories SET ${updateFields.join(', ')} WHERE id = ?`;
    console.log('Update query:', updateQuery);
    console.log('Update values:', updateValues);
    await pool.execute(updateQuery, updateValues);

    console.log('Category updated successfully');
    res.json({ success: true, message: 'Category updated successfully' });
  } catch (error) {
    console.error('Error updating category:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to update category', details: error.message });
  }
});

// DELETE /api/categories/:id - delete category
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('DELETE /api/categories/:id - Request received for id:', id);

    // Check if category exists
    const [existing] = await pool.execute(
      'SELECT id, name, category_image FROM product_categories WHERE id = ?',
      [id]
    );

    if (existing.length === 0) {
      console.log('Category not found:', id);
      return res.status(404).json({ error: 'Category not found' });
    }

    const category = existing[0];
    console.log('Category found:', category.name);

    // Check if category is used by any products
    const [products] = await pool.execute(
      'SELECT COUNT(*) as count FROM products WHERE category_id = ? OR category = (SELECT name FROM product_categories WHERE id = ?)',
      [id, id]
    );

    const productCount = products[0]?.count || 0;
    console.log('Products using this category:', productCount);

    if (productCount > 0) {
      return res.status(400).json({ 
        error: `Cannot delete category. It is being used by ${productCount} product(s). Please update or remove those products first.` 
      });
    }

    // Delete image from Cloudinary if it exists
    if (category.category_image && category.category_image.includes('cloudinary.com')) {
      try {
        const publicId = extractPublicIdFromUrl(category.category_image);
        if (publicId) {
          console.log('Deleting image from Cloudinary, public_id:', publicId);
          await deleteCloudinaryAsset(publicId, 'image');
          console.log('Image deleted from Cloudinary successfully');
        }
      } catch (cloudinaryError) {
        console.warn('Failed to delete image from Cloudinary:', cloudinaryError.message);
        // Continue with category deletion even if image deletion fails
      }
    }

    // Delete category
    const [deleteResult] = await pool.execute(
      'DELETE FROM product_categories WHERE id = ?',
      [id]
    );

    console.log('Category deleted, affected rows:', deleteResult.affectedRows);

    if (deleteResult.affectedRows === 0) {
      return res.status(404).json({ error: 'Category not found or already deleted' });
    }

    res.json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Error deleting category:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to delete category', 
      details: error.message 
    });
  }
});

module.exports = router;

