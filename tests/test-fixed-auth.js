const axios = require('axios');

const BASE_URL = 'http://localhost:5000';

async function testVendorAuth() {
  try {
    console.log('Testing fixed vendor authentication...\n');

    // Test registration
    console.log('--- Testing Registration ---');
    const registrationData = {
      shopName: 'Test Shop Fixed',
      ownerName: 'Test Owner Fixed',
      email: 'testfixed@example.com',
      phone: '9876543210',
      shopAddress: '123 Test Street, Test City',
      password: 'password123'
    };

    try {
      const registerResponse = await axios.post(`${BASE_URL}/api/vendors/register`, registrationData);
      console.log('Registration successful:', {
        status: registerResponse.status,
        message: registerResponse.data.message,
        vendorId: registerResponse.data.vendorId,
        hasToken: !!registerResponse.data.token
      });
    } catch (error) {
      console.log('Registration failed:', error.response?.data || error.message);
    }

    // Test login
    console.log('\n--- Testing Login ---');
    const loginData = {
      email: 'testfixed@example.com',
      password: 'password123'
    };

    try {
      const loginResponse = await axios.post(`${BASE_URL}/api/vendors/login`, loginData);
      console.log('Login successful:', {
        status: loginResponse.status,
        message: loginResponse.data.message,
        vendor: loginResponse.data.vendor,
        hasToken: !!loginResponse.data.token
      });
    } catch (error) {
      console.log('Login failed:', error.response?.data || error.message);
    }

    // Test login with wrong password
    console.log('\n--- Testing Login with Wrong Password ---');
    const wrongLoginData = {
      email: 'testfixed@example.com',
      password: 'wrongpassword'
    };

    try {
      const wrongLoginResponse = await axios.post(`${BASE_URL}/api/vendors/login`, wrongLoginData);
      console.log('Wrong password login unexpectedly successful:', wrongLoginResponse.data);
    } catch (error) {
      console.log('Wrong password login correctly failed:', error.response?.data || error.message);
    }

  } catch (error) {
    console.error('Test error:', error.message);
  }
}

testVendorAuth();
