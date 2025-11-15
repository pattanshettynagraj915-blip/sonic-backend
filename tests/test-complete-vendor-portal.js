const axios = require('axios');
const mysql = require('mysql2/promise');

// Database connection
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'vendor_portal'
};

const API_BASE = 'http://localhost:5000';

async function testCompleteVendorPortal() {
  console.log('🧪 COMPLETE VENDOR PORTAL TESTING\n');
  
  let db;
  let authToken = null;
  let vendorId = null;
  
  try {
    // Connect to database
    db = await mysql.createConnection(dbConfig);
    console.log('✅ Database connected');
    
    // 1. Test vendor login
    console.log('\n1. 🔐 TESTING VENDOR LOGIN');
    try {
      const loginResponse = await axios.post(`${API_BASE}/api/vendors/login`, {
        email: 'vendor.login@test.com',
        password: 'Password123!'
      }, { withCredentials: true });
      
      if (loginResponse.data.token) {
        authToken = loginResponse.data.token;
        vendorId = loginResponse.data.vendor.id;
        console.log('✅ Login successful');
        console.log(`   Vendor ID: ${vendorId}`);
        console.log(`   Shop Name: ${loginResponse.data.vendor.shopName}`);
        console.log(`   Status: ${loginResponse.data.vendor.status}`);
      }
    } catch (error) {
      console.log('❌ Login failed:', error.response?.data || error.message);
      return;
    }
    
    // 2. Test vendor dashboard access
    console.log('\n2. 📊 TESTING VENDOR DASHBOARD');
    try {
      const dashboardResponse = await axios.get(`${API_BASE}/api/vendors/${vendorId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        withCredentials: true
      });
      console.log('✅ Dashboard access successful');
      console.log(`   Business: ${dashboardResponse.data.business_name || dashboardResponse.data.shop_name || dashboardResponse.data.shopName}`);
      console.log(`   Status: ${dashboardResponse.data.status}`);
    } catch (error) {
      console.log('❌ Dashboard access failed:', error.response?.data || error.message);
    }
    
    // 3. Test product management
    console.log('\n3. 📦 TESTING PRODUCT MANAGEMENT');
    
    // Get existing products
    try {
      const productsResponse = await axios.get(`${API_BASE}/api/products`, {
        headers: { Authorization: `Bearer ${authToken}` },
        withCredentials: true
      });
      console.log('✅ Products access successful');
      console.log(`   Found ${(productsResponse.data.products || []).length} products`);
    } catch (error) {
      console.log('❌ Products access failed:', error.response?.data || error.message);
    }
    
    // 4. Test order management
    console.log('\n4. 📋 TESTING ORDER MANAGEMENT');
    try {
      const ordersResponse = await axios.get(`${API_BASE}/api/orders/vendor/${vendorId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        withCredentials: true
      });
      console.log('✅ Orders access successful');
      console.log(`   Found ${ordersResponse.data.orders?.length || 0} orders`);
    } catch (error) {
      console.log('❌ Orders access failed:', error.response?.data || error.message);
    }
    
    // 5. Test payout system summary (comprehensive payouts)
    console.log('\n5. 💰 TESTING PAYOUT SYSTEM');
    try {
      const payoutsResponse = await axios.get(`${API_BASE}/api/payouts/vendor/summary`, {
        headers: { Authorization: `Bearer ${authToken}` },
        withCredentials: true
      });
      console.log('✅ Payouts summary access successful');
    } catch (error) {
      console.log('❌ Payouts access failed:', error.response?.data || error.message);
    }
    
    // 6. Test KYC system (compat route)
    console.log('\n6. 📄 TESTING KYC SYSTEM');
    try {
      const kycResponse = await axios.get(`${API_BASE}/api/kyc/vendor/${vendorId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        withCredentials: true
      });
      console.log('✅ KYC access successful');
    } catch (error) {
      console.log('❌ KYC access failed:', error.response?.data || error.message);
    }
    
    // 7. Security checks
    console.log('\n7. 🔒 TESTING SECURITY');
    try {
      await axios.get(`${API_BASE}/api/vendors/${vendorId}`);
      console.log('❌ Security issue: Access allowed without token');
    } catch (error) {
      if (error.response?.status === 401) console.log('✅ Security OK: Access denied without token');
    }
    try {
      await axios.get(`${API_BASE}/api/vendors/${vendorId}`, { headers: { Authorization: 'Bearer invalid-token' } });
      console.log('❌ Security issue: Invalid token accepted');
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 403) console.log('✅ Security OK: Invalid token rejected');
    }
    
    // 8. Profile update
    console.log('\n8. 👤 TESTING PROFILE UPDATE');
    try {
      const updateData = { shop_name: 'Updated Test Business', owner_phone: '9876543210' };
      const updateResponse = await axios.put(`${API_BASE}/api/vendors/${vendorId}`, updateData, {
        headers: { Authorization: `Bearer ${authToken}` },
        withCredentials: true
      });
      console.log('✅ Profile update successful');
    } catch (error) {
      console.log('❌ Profile update failed:', error.response?.data || error.message);
    }
    
    console.log('\n🎉 VENDOR PORTAL TESTING COMPLETED');
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    if (db) await db.end();
  }
}

// Run the test
testCompleteVendorPortal().catch(console.error);
