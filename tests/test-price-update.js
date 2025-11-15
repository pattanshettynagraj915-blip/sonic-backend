const fetch = require('node-fetch');

async function testPriceUpdate() {
  try {
    console.log('Testing individual price update API...');
    
    // First, let's get a product to test with
    const productsResponse = await fetch('http://localhost:3001/api/admin/products?limit=1', {
      headers: {
        'x-admin-key': 'dev-admin-key'
      }
    });
    
    if (!productsResponse.ok) {
      console.error('Failed to fetch products:', productsResponse.status, productsResponse.statusText);
      return;
    }
    
    const productsData = await productsResponse.json();
    console.log('Products response:', productsData);
    
    if (!productsData || productsData.length === 0) {
      console.log('No products found to test with');
      return;
    }
    
    const product = productsData[0];
    console.log('Testing with product:', product.id, product.name, 'Current price:', product.price);
    
    // Now test the price update
    const updateResponse = await fetch(`http://localhost:3001/api/admin/products/${product.id}/price`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': 'dev-admin-key'
      },
      body: JSON.stringify({
        new_price: parseFloat(product.price) + 1,
        reason: 'Test price update',
        min_price: 0,
        max_price: 1000
      })
    });
    
    console.log('Update response status:', updateResponse.status);
    
    if (updateResponse.ok) {
      const result = await updateResponse.json();
      console.log('Price update successful:', result);
    } else {
      const error = await updateResponse.json();
      console.error('Price update failed:', error);
    }
    
  } catch (error) {
    console.error('Test error:', error);
  }
}

testPriceUpdate();
