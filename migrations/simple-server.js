const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, and PDF files are allowed'));
    }
  }
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Simple JSON database functions
const dbPath = path.join(__dirname, 'data');
const vendorsFile = path.join(dbPath, 'vendors.json');
const kycFile = path.join(dbPath, 'kyc_documents.json');

const readVendors = () => {
  try {
    const data = fs.readFileSync(vendorsFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
};

const writeVendors = (vendors) => {
  fs.writeFileSync(vendorsFile, JSON.stringify(vendors, null, 2));
};

const readKYC = () => {
  try {
    const data = fs.readFileSync(kycFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
};

const writeKYC = (kycDocs) => {
  fs.writeFileSync(kycFile, JSON.stringify(kycDocs, null, 2));
};

// Routes

// Vendor Registration
app.post('/api/vendors/register', async (req, res) => {
  try {
    const { shopName, ownerName, email, phone, shopAddress, password, latitude, longitude } = req.body;
    
    const vendors = readVendors();
    
    // Check if vendor already exists by email
    const existingVendorByEmail = vendors.find(v => v.email === email);
    if (existingVendorByEmail) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    // Check if vendor already exists by phone number
    const existingVendorByPhone = vendors.find(v => v.phone === phone);
    if (existingVendorByPhone) {
      return res.status(400).json({ error: 'Contact number already exists' });
    }

    const passwordHash = password && password.length >= 8 ? await bcrypt.hash(password, 10) : null;
    if (!passwordHash) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    // Create new vendor
    const newVendor = {
      id: vendors.length + 1,
      shop_name: shopName,
      owner_name: ownerName,
      email: email,
      phone: phone,
      shop_address: shopAddress,
      password: passwordHash,
      status: 'DRAFT',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      latitude: typeof latitude !== 'undefined' ? latitude : null,
      longitude: typeof longitude !== 'undefined' ? longitude : null,
      location_updated_at: (typeof latitude !== 'undefined' || typeof longitude !== 'undefined') ? new Date().toISOString() : null,
      kyc_submitted_at: null,
      kyc_reviewed_at: null,
      review_notes: null
    };
    
    vendors.push(newVendor);
    writeVendors(vendors);
    
    // Generate JWT token
    const token = jwt.sign({ vendorId: newVendor.id, email }, JWT_SECRET, { expiresIn: '24h' });
    
    res.status(201).json({
      message: 'Vendor registered successfully',
      vendorId: newVendor.id,
      token,
      status: 'DRAFT'
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
    
    const vendors = readVendors();
    const vendor = vendors.find(v => v.email === email);
    
    if (!vendor) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Check password
    const isValidPassword = await bcrypt.compare(password, vendor.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Check if vendor is approved for login
    // Note: Database schema only supports: 'pending','approved','rejected','suspended'
    const approvedStatuses = ['approved']; // Only 'approved' status allows login
    const currentStatus = (vendor.status || 'pending').toLowerCase(); // Handle null/empty status and normalize case
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
        shopName: vendor.shop_name,
        ownerName: vendor.owner_name,
        email: vendor.email,
        status: vendor.status
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update Location
app.put('/api/vendors/:id/location', async (req, res) => {
  try {
    const { id } = req.params;
    const { address, coordinates } = req.body;
    
    const vendors = readVendors();
    const vendorIndex = vendors.findIndex(v => v.id == id);
    
    if (vendorIndex === -1) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    
    vendors[vendorIndex].shop_address = address;
    vendors[vendorIndex].latitude = coordinates.lat;
    vendors[vendorIndex].longitude = coordinates.lng;
    vendors[vendorIndex].location_updated_at = new Date().toISOString();
    vendors[vendorIndex].updated_at = new Date().toISOString();
    
    writeVendors(vendors);
    
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
    
    const vendors = readVendors();
    const vendorIndex = vendors.findIndex(v => v.id == id);
    
    if (vendorIndex === -1) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    
    // Update vendor status to SUBMITTED
    vendors[vendorIndex].status = 'SUBMITTED';
    vendors[vendorIndex].kyc_submitted_at = new Date().toISOString();
    vendors[vendorIndex].updated_at = new Date().toISOString();
    
    writeVendors(vendors);
    
    // Save document information
    const kycDocs = readKYC();
    const documentData = {};
    
    Object.keys(files).forEach(docType => {
      const file = files[docType][0];
      documentData[docType] = {
        filename: file.filename,
        originalName: file.originalname,
        path: file.path,
        size: file.size,
        mimetype: file.mimetype
      };
    });
    
    // Insert or update KYC documents
    for (const [docType, docData] of Object.entries(documentData)) {
      const existingDocIndex = kycDocs.findIndex(doc => doc.vendor_id == id && doc.document_type === docType);
      
      const docRecord = {
        id: kycDocs.length + 1,
        vendor_id: parseInt(id),
        document_type: docType,
        filename: docData.filename,
        original_name: docData.originalName,
        file_path: docData.path,
        file_size: docData.size,
        mime_type: docData.mimetype,
        uploaded_at: new Date().toISOString()
      };
      
      if (existingDocIndex !== -1) {
        kycDocs[existingDocIndex] = docRecord;
      } else {
        kycDocs.push(docRecord);
      }
    }
    
    writeKYC(kycDocs);
    
    res.json({ message: 'KYC documents uploaded successfully', status: 'SUBMITTED' });
  } catch (error) {
    console.error('KYC upload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Vendor KYC Status
app.get('/api/vendors/:id/kyc-status', async (req, res) => {
  try {
    const { id } = req.params;
    
    const vendors = readVendors();
    const vendor = vendors.find(v => v.id == id);
    
    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    
    res.json({
      status: vendor.status,
      submittedAt: vendor.kyc_submitted_at,
      reviewedAt: vendor.kyc_reviewed_at
    });
  } catch (error) {
    console.error('KYC status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: Update KYC Status
app.put('/api/admin/vendors/:id/kyc-status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes } = req.body;
    
    const vendors = readVendors();
    const vendorIndex = vendors.findIndex(v => v.id == id);
    
    if (vendorIndex === -1) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    
    vendors[vendorIndex].status = status;
    vendors[vendorIndex].kyc_reviewed_at = new Date().toISOString();
    vendors[vendorIndex].review_notes = reviewNotes;
    vendors[vendorIndex].updated_at = new Date().toISOString();
    
    writeVendors(vendors);
    
    res.json({ message: 'KYC status updated successfully' });
  } catch (error) {
    console.error('KYC status update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get All Vendors (Admin)
app.get('/api/admin/vendors', async (req, res) => {
  try {
    const vendors = readVendors();
    
    const vendorList = vendors.map(v => ({
      id: v.id,
      shop_name: v.shop_name,
      owner_name: v.owner_name,
      email: v.email,
      phone: v.phone,
      shop_address: v.shop_address,
      status: v.status,
      created_at: v.created_at
    }));
    
    res.json(vendorList);
  } catch (error) {
    console.error('Get vendors error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large' });
    }
  }
  res.status(500).json({ error: error.message });
});

// Initialize database
const initDatabase = () => {
  const dbPath = path.join(__dirname, 'data');
  const vendorsFile = path.join(dbPath, 'vendors.json');
  const kycFile = path.join(dbPath, 'kyc_documents.json');
  
  // Create data directory if it doesn't exist
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
  }
  
  // Initialize JSON files if they don't exist
  if (!fs.existsSync(vendorsFile)) {
    fs.writeFileSync(vendorsFile, JSON.stringify([], null, 2));
  }
  
  if (!fs.existsSync(kycFile)) {
    fs.writeFileSync(kycFile, JSON.stringify([], null, 2));
  }
  
  console.log('✅ Simple JSON database initialized successfully!');
};

// Start server
initDatabase();

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Using JSON database for demo purposes`);
  console.log(`🔗 API endpoints available at http://localhost:${PORT}/api/`);
});