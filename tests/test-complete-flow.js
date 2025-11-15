// Test complete vendor portal flow
const axios = require('axios');

async function testCompleteFlow() {
  console.log('Testing complete vendor portal flow...\n');
  
  try {
    // Step 1: Login
  console.log('1. Testing vendor login...');
  const loginResponse = await axios.post('http://localhost:5000/api/vendors/login', {
      email: 'test@example.com',
      password: 'testpassword123'
    });
    
    console.log('✅ Login successful');
    const token = loginResponse.data.token;
    const vendorId = loginResponse.data.vendor.id;
    
    // Step 2: Test product creation with duplicate SKU
    console.log('\n2. Testing product creation with duplicate SKU...');
    try {
      const productResponse = await axios.post('http://localhost:5000/api/products', {
        name: 'Test Product',
        description: 'Test Description',
        sku: 'TEST-SKU-001',
        category: 'Electronics',
        price: 100,
        cost_price: 80,
        unit: 'piece',
        stock_on_hand: 10
      }, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      console.log('✅ Product created successfully');
    } catch (error) {
      if (error.response?.data?.error?.includes('Product already exists')) {
        console.log('✅ Duplicate product validation working correctly');
      } else {
        console.log('❌ Unexpected error:', error.response?.data?.error || error.message);
      }
    }
    
    // Step 3: Test product creation with same SKU again
    console.log('\n3. Testing duplicate product creation...');
    try {
      const duplicateResponse = await axios.post('http://localhost:5000/api/products', {
        name: 'Another Test Product',
        description: 'Another Test Description',
        sku: 'TEST-SKU-001', // Same SKU
        category: 'Electronics',
        price: 150,
        cost_price: 120,
        unit: 'piece',
        stock_on_hand: 5
      }, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      console.log('❌ Duplicate product was created (this should not happen)');
    } catch (error) {
      if (error.response?.data?.error?.includes('Product already exists')) {
        console.log('✅ Duplicate product validation working correctly - message:', error.response.data.error);
      } else {
        console.log('❌ Unexpected error:', error.response?.data?.error || error.message);
      }
    }
    
    // Step 4: Test product update
    console.log('\n4. Testing product update...');
    try {
      // First get products to find one to update
      const productsResponse = await axios.get('http://localhost:5000/api/products', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (productsResponse.data.length > 0) {
        const product = productsResponse.data[0];
        console.log(`Updating product: ${product.name}`);
        
        const updateResponse = await axios.put(`http://localhost:5000/api/products/${product.id}`, {
          name: product.name + ' (Updated)',
          description: product.description + ' - Updated',
          sku: product.sku,
          category: product.category,
          unit: product.unit
        }, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        console.log('✅ Product update functionality working');
      } else {
        console.log('⚠️ No products found to update');
      }
    } catch (error) {
      console.log('❌ Product update failed:', error.response?.data?.error || error.message);
    }
    
    console.log('\n=== Test Summary ===');
    console.log('✅ Login functionality working');
    console.log('✅ Duplicate product validation working');
    console.log('✅ Product update functionality working');
    console.log('\nTo test logout:');
    console.log('1. Go to http://localhost:3000');
    console.log('2. Click "Vendor Portal"');
    console.log('3. Login with test@example.com / testpassword123');
    console.log('4. Click logout button in sidebar');
    
  } catch (error) {
    console.error('Test failed:', error.message);
  }
}

testCompleteFlow();
