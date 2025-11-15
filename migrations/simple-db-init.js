const fs = require('fs');
const path = require('path');

// Create a simple JSON-based database for demo purposes
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
console.log('📁 Data directory:', dbPath);
console.log('📄 Vendors file:', vendorsFile);
console.log('📄 KYC documents file:', kycFile);