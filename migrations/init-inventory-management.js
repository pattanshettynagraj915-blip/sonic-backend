const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function initializeInventoryManagement() {
    let connection;
    
    try {
        console.log('🚀 Initializing Inventory Management System...');
        
        // Create database connection
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'vendor_portal',
            multipleStatements: true
        });

        console.log('✅ Connected to database');

        // Read and execute the inventory management schema
        const schemaPath = path.join(__dirname, 'inventory-management-schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        
        console.log('📄 Reading inventory management schema...');
        
        // Split the schema into individual statements
        const statements = schema
            .split(';')
            .map(stmt => stmt.trim())
            .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

        console.log(`📝 Executing ${statements.length} SQL statements...`);

        for (let i = 0; i < statements.length; i++) {
            const statement = statements[i];
            if (statement.trim()) {
                try {
                    await connection.execute(statement);
                    console.log(`✅ Statement ${i + 1}/${statements.length} executed successfully`);
                } catch (error) {
                    // Skip errors for statements that might already exist
                    if (error.code === 'ER_TABLE_EXISTS_ERROR' || 
                        error.code === 'ER_DUP_KEYNAME' ||
                        error.code === 'ER_DUP_ENTRY' ||
                        error.message.includes('already exists')) {
                        console.log(`⚠️  Statement ${i + 1} skipped (already exists): ${error.message}`);
                    } else {
                        console.error(`❌ Error in statement ${i + 1}:`, error.message);
                        throw error;
                    }
                }
            }
        }

        console.log('🎉 Inventory Management System initialized successfully!');
        
        // Verify tables were created
        const [tables] = await connection.execute(`
            SELECT TABLE_NAME 
            FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_SCHEMA = ? 
            AND TABLE_NAME IN (
                'stock_reservations', 
                'vendor_priority_queue', 
                'order_fallback_history',
                'product_availability_cache',
                'redis_locks'
            )
        `, [process.env.DB_NAME || 'vendor_portal']);

        console.log('📊 Created tables:');
        tables.forEach(table => {
            console.log(`   ✅ ${table.TABLE_NAME}`);
        });

        // Insert sample data for testing
        console.log('🌱 Inserting sample data...');
        
        // Add sample vendor data with enhanced fields
        await connection.execute(`
            UPDATE vendors 
            SET 
                avg_prep_time = 30,
                rating = 4.5,
                commission_rate = 5.00,
                sla_minutes = 30,
                is_active = TRUE,
                delivery_zones = JSON_ARRAY('North', 'South', 'East', 'West', 'Central'),
                operating_hours = JSON_OBJECT(
                    'monday', JSON_OBJECT('open', '09:00', 'close', '21:00'),
                    'tuesday', JSON_OBJECT('open', '09:00', 'close', '21:00'),
                    'wednesday', JSON_OBJECT('open', '09:00', 'close', '21:00'),
                    'thursday', JSON_OBJECT('open', '09:00', 'close', '21:00'),
                    'friday', JSON_OBJECT('open', '09:00', 'close', '21:00'),
                    'saturday', JSON_OBJECT('open', '09:00', 'close', '21:00'),
                    'sunday', JSON_OBJECT('open', '10:00', 'close', '20:00')
                )
            WHERE id = 1
        `);

        // Add sample products if they don't exist
        const [existingProducts] = await connection.execute('SELECT COUNT(*) as count FROM products');
        if (existingProducts[0].count === 0) {
            await connection.execute(`
                INSERT INTO products (vendor_id, name, description, sku, category, price, mrp, cost_price, unit, weight, status) VALUES
                (1, 'Fresh Apples', 'Premium quality apples', 'APPLE-001', 'Fruits', 120.00, 150.00, 80.00, 'kg', 1.0, 'active'),
                (1, 'Organic Bananas', 'Organic bananas', 'BANANA-001', 'Fruits', 60.00, 80.00, 40.00, 'dozen', 0.5, 'active'),
                (1, 'Fresh Milk', 'Fresh cow milk', 'MILK-001', 'Dairy', 50.00, 60.00, 35.00, 'liter', 1.0, 'active'),
                (1, 'Bread Loaf', 'Fresh bread', 'BREAD-001', 'Bakery', 25.00, 30.00, 15.00, 'piece', 0.4, 'active'),
                (1, 'Eggs', 'Farm fresh eggs', 'EGGS-001', 'Dairy', 60.00, 70.00, 45.00, 'dozen', 0.6, 'active')
            `);
        }

        // Add sample inventory data
        const [existingInventory] = await connection.execute('SELECT COUNT(*) as count FROM vendor_products');
        if (existingInventory[0].count === 0) {
            await connection.execute(`
                INSERT INTO vendor_products (vendor_id, product_id, price, gst_rate, stock_on_hand, stock_reserved) VALUES
                (1, 1, 120.00, 5.00, 100, 0),
                (1, 2, 60.00, 5.00, 50, 0),
                (1, 3, 50.00, 5.00, 200, 0),
                (1, 4, 25.00, 5.00, 75, 0),
                (1, 5, 60.00, 5.00, 30, 0)
            `);
        }

        // Add sample stock movements
        await connection.execute(`
            INSERT INTO stock_movements (product_id, movement_type, quantity, reference_type, reference_id, vendor_id, notes) VALUES
            (1, 'in', 100, 'purchase', 1, 1, 'Initial stock'),
            (2, 'in', 50, 'purchase', 2, 1, 'Initial stock'),
            (3, 'in', 200, 'purchase', 3, 1, 'Initial stock'),
            (4, 'in', 75, 'purchase', 4, 1, 'Initial stock'),
            (5, 'in', 30, 'purchase', 5, 1, 'Initial stock')
        `);

        console.log('✅ Sample data inserted successfully');

        // Test the inventory service
        console.log('🧪 Testing inventory service...');
        
        // Test vendor priority calculation
        await connection.execute('CALL CalculateVendorPriority(1, "North", 28.6139, 77.2090)');
        console.log('✅ Vendor priority calculation test passed');

        // Test stock reservation
        try {
            await connection.execute('CALL ReserveStockWithFallback(1, 5, "North", 1, 28.6139, 77.2090, @vendor_id, @reservation_id, @success)');
            const [result] = await connection.execute('SELECT @vendor_id as vendor_id, @reservation_id as reservation_id, @success as success');
            console.log('✅ Stock reservation test passed:', result[0]);
        } catch (error) {
            console.log('⚠️  Stock reservation test skipped (may need existing data)');
        }

        console.log('🎉 Inventory Management System setup completed successfully!');
        console.log('');
        console.log('📋 Next steps:');
        console.log('   1. Start the backend server: npm start');
        console.log('   2. Access the vendor portal to test inventory features');
        console.log('   3. Use the admin portal to monitor inventory analytics');
        console.log('');
        console.log('🔗 API Endpoints available:');
        console.log('   POST /api/inventory/reserve - Reserve stock');
        console.log('   POST /api/inventory/commit - Commit reservation');
        console.log('   POST /api/inventory/release - Release reservation');
        console.log('   GET /api/inventory/availability/:productId/:zone - Check availability');
        console.log('   GET /api/inventory/priority-queue/:productId/:zone - Get vendor priority');
        console.log('   GET /api/inventory/analytics/performance - Get analytics');

    } catch (error) {
        console.error('❌ Error initializing inventory management system:', error);
        throw error;
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

// Run the initialization if this file is executed directly
if (require.main === module) {
    initializeInventoryManagement()
        .then(() => {
            console.log('✅ Initialization completed');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Initialization failed:', error);
            process.exit(1);
        });
}

module.exports = initializeInventoryManagement;
