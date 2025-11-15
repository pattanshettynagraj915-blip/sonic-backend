const axios = require('axios');

async function testServerStatus() {
  console.log('🔍 TESTING SERVER STATUS\n');
  
  try {
    // Test health endpoint
    console.log('1. Testing health endpoint...');
    const healthResponse = await axios.get('http://localhost:5000/api/health');
    console.log('✅ Health endpoint working:', healthResponse.data);
  } catch (error) {
    console.log('❌ Health endpoint failed:', error.message);
  }
  
  try {
    // Test vendor login endpoint
    console.log('\n2. Testing vendor login endpoint...');
    const loginResponse = await axios.post('http://localhost:5000/api/vendors/login', {
      email: 'testvendor@example.com',
      password: 'TestPassword123!'
    });
    console.log('✅ Login endpoint working:', loginResponse.data.message);
  } catch (error) {
    console.log('❌ Login endpoint failed:', error.response?.data || error.message);
  }
  
  try {
    // Test with wrong credentials
    console.log('\n3. Testing security with wrong credentials...');
    const wrongLoginResponse = await axios.post('http://localhost:5000/api/vendors/login', {
      email: 'testvendor@example.com',
      password: 'wrongpassword'
    });
    console.log('❌ Security issue: Wrong password accepted');
  } catch (error) {
    if (error.response?.status === 401) {
      console.log('✅ Security OK: Wrong password correctly rejected');
    } else {
      console.log('❌ Unexpected error:', error.response?.data || error.message);
    }
  }
}

testServerStatus().catch(console.error);
