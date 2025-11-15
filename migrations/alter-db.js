const mysql = require('mysql2');

const connection = mysql.createConnection({
	host: process.env.DB_HOST || 'localhost',
	user: process.env.DB_USER || 'root',
	password: process.env.DB_PASSWORD || '',
	multipleStatements: true
});

async function ensureDatabaseAndUse(dbName) {
	await connection.promise().query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
	await connection.promise().query(`USE \`${dbName}\``);
}

async function columnExists(table, column) {
	const [rows] = await connection.promise().query('SHOW COLUMNS FROM `' + table + '` LIKE ?', [column]);
	return rows.length > 0;
}

async function indexExists(table, indexName) {
	const [rows] = await connection.promise().query('SHOW INDEX FROM `' + table + '` WHERE Key_name = ?', [indexName]);
	return rows.length > 0;
}

async function tableExists(table) {
	const [rows] = await connection.promise().query('SHOW TABLES LIKE ?', [table]);
	return rows.length > 0;
}

async function ensureVendorsTable() {
	if (!(await tableExists('vendors'))) {
		await connection.promise().query(`
			CREATE TABLE IF NOT EXISTS vendors (
				id INT AUTO_INCREMENT PRIMARY KEY,
				shop_name VARCHAR(255) NOT NULL,
				owner_name VARCHAR(255) NOT NULL,
				email VARCHAR(255) UNIQUE NOT NULL,
				phone VARCHAR(20) NOT NULL,
				shop_address TEXT NOT NULL,
				city VARCHAR(100) NULL,
				latitude DECIMAL(10, 8),
				longitude DECIMAL(11, 8),
				password VARCHAR(255) NULL,
				status ENUM('DRAFT','SUBMITTED','UNDER_REVIEW','IN_REVIEW','APPROVED','REJECTED','ACTIVE','SUSPENDED') DEFAULT 'DRAFT',
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
				location_updated_at TIMESTAMP NULL,
				kyc_submitted_at TIMESTAMP NULL,
				kyc_reviewed_at TIMESTAMP NULL,
				review_notes TEXT NULL
			)
		`);
	}

	const alters = [];
    const desiredColumns = [
        // Ensure columns that queries depend on exist
        ['shop_name', "VARCHAR(255) NULL"],
        ['owner_name', "VARCHAR(255) NULL"],
        // Optional/extended columns
		['city', "VARCHAR(100) NULL"],
		['latitude', "DECIMAL(10, 8)"],
		['longitude', "DECIMAL(11, 8)"],
		['password', "VARCHAR(255) NULL"],
		['status', "ENUM('DRAFT','SUBMITTED','UNDER_REVIEW','IN_REVIEW','APPROVED','REJECTED','ACTIVE','SUSPENDED') DEFAULT 'DRAFT'"],
		['created_at', "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"],
		['updated_at', "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"],
		['location_updated_at', "TIMESTAMP NULL"],
		['kyc_submitted_at', "TIMESTAMP NULL"],
		['kyc_reviewed_at', "TIMESTAMP NULL"],
        ['review_notes', "TEXT NULL"],
        ['flagged', "TINYINT(1) NOT NULL DEFAULT 0"],
        ['is_suspended', "TINYINT(1) NOT NULL DEFAULT 0"],
        ['suspended_at', "TIMESTAMP NULL"],
        ['logo_url', "VARCHAR(512) NULL"],
        ['banner_url', "VARCHAR(512) NULL"],
        ['hours_json', "JSON NULL"],
        ['social_json', "JSON NULL"],
	];

	for (const [col, defn] of desiredColumns) {
		if (!(await columnExists('vendors', col))) {
			alters.push(`ADD COLUMN \`${col}\` ${defn}`);
		}
	}

	if (alters.length) {
		await connection.promise().query(`ALTER TABLE vendors ${alters.join(', ')}`);
	}

	// Only create indexes if the referenced columns exist
	if (!(await indexExists('vendors', 'idx_vendors_email')) && (await columnExists('vendors', 'email'))) {
		await connection.promise().query('CREATE INDEX idx_vendors_email ON vendors(email)');
	}
	if (!(await indexExists('vendors', 'idx_vendors_status')) && (await columnExists('vendors', 'status'))) {
		await connection.promise().query('CREATE INDEX idx_vendors_status ON vendors(status)');
	}
}

async function ensureProductsTable() {
	if (!(await tableExists('products'))) {
		await connection.promise().query(`
			CREATE TABLE IF NOT EXISTS products (
				id INT AUTO_INCREMENT PRIMARY KEY,
				vendor_id INT NOT NULL,
				name VARCHAR(255) NOT NULL,
				description TEXT,
				sku VARCHAR(100) UNIQUE NOT NULL,
				category VARCHAR(100) NOT NULL,
				price DECIMAL(10,2) NOT NULL,
				mrp DECIMAL(10,2) NULL,
				cost_price DECIMAL(10,2),
				image_url VARCHAR(512),
				unit VARCHAR(50) DEFAULT 'piece',
				weight DECIMAL(8,2),
				dimensions VARCHAR(100),
				barcode VARCHAR(100),
				gst_slab DECIMAL(4,2) NULL,
				status ENUM('active','inactive','discontinued') DEFAULT 'active',
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			)
		`);
	}

	const alters = [];
	if (!(await columnExists('products', 'category'))) {
		alters.push("ADD COLUMN `category` VARCHAR(100) NULL");
	}
	if (!(await columnExists('products', 'mrp'))) {
		alters.push("ADD COLUMN `mrp` DECIMAL(10,2) NULL");
	}
	if (!(await columnExists('products', 'gst_slab'))) {
		alters.push("ADD COLUMN `gst_slab` DECIMAL(4,2) NULL");
	}
	if (!(await columnExists('products', 'hsn_code'))) {
		alters.push("ADD COLUMN `hsn_code` VARCHAR(50) NULL");
	}
	if (!(await columnExists('products', 'image_url'))) {
		alters.push("ADD COLUMN `image_url` VARCHAR(512) NULL");
	}
	if (!(await columnExists('products', 'unit'))) {
		alters.push("ADD COLUMN `unit` VARCHAR(50) NULL");
	}
	if (!(await columnExists('products', 'weight'))) {
		alters.push("ADD COLUMN `weight` DECIMAL(8,2) NULL");
	}
	if (!(await columnExists('products', 'dimensions'))) {
		alters.push("ADD COLUMN `dimensions` VARCHAR(100) NULL");
	}
	if (!(await columnExists('products', 'barcode'))) {
		alters.push("ADD COLUMN `barcode` VARCHAR(100) NULL");
	}
	if (!(await columnExists('products', 'status'))) {
		alters.push("ADD COLUMN `status` ENUM('active','inactive','discontinued') DEFAULT 'active'");
	}
	if (alters.length) {
		await connection.promise().query(`ALTER TABLE products ${alters.join(', ')}`);
	}
}

async function ensureInventoryTable() {
	if (!(await tableExists('inventory'))) {
		await connection.promise().query(`
			CREATE TABLE IF NOT EXISTS inventory (
				id INT AUTO_INCREMENT PRIMARY KEY,
				product_id INT NOT NULL,
				stock_on_hand INT DEFAULT 0,
				stock_reserved INT DEFAULT 0,
				stock_available INT GENERATED ALWAYS AS (stock_on_hand - stock_reserved) STORED,
				min_stock_level INT DEFAULT 0,
				max_stock_level INT,
				reorder_point INT DEFAULT 0,
				reorder_quantity INT DEFAULT 0,
				last_restocked_at TIMESTAMP NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
				UNIQUE KEY unique_product_inventory (product_id)
			)
		`);
	}
	const alters = [];
	if (!(await columnExists('inventory', 'stock_on_hand'))) alters.push("ADD COLUMN `stock_on_hand` INT DEFAULT 0");
	if (!(await columnExists('inventory', 'stock_reserved'))) alters.push("ADD COLUMN `stock_reserved` INT DEFAULT 0");
	if (!(await columnExists('inventory', 'stock_available'))) alters.push("ADD COLUMN `stock_available` INT GENERATED ALWAYS AS (stock_on_hand - stock_reserved) STORED");
	if (!(await columnExists('inventory', 'min_stock_level'))) alters.push("ADD COLUMN `min_stock_level` INT DEFAULT 0");
	if (!(await columnExists('inventory', 'max_stock_level'))) alters.push("ADD COLUMN `max_stock_level` INT NULL");
	if (!(await columnExists('inventory', 'reorder_point'))) alters.push("ADD COLUMN `reorder_point` INT DEFAULT 0");
	if (!(await columnExists('inventory', 'reorder_quantity'))) alters.push("ADD COLUMN `reorder_quantity` INT DEFAULT 0");
	if (alters.length) {
		await connection.promise().query(`ALTER TABLE inventory ${alters.join(', ')}`);
	}
}

async function ensurePayoutsTable() {
	if (!(await tableExists('payouts'))) {
		await connection.promise().query(`
			CREATE TABLE IF NOT EXISTS payouts (
				id INT AUTO_INCREMENT PRIMARY KEY,
				vendor_id INT NOT NULL,
				amount DECIMAL(10,2) NOT NULL,
				status ENUM('pending','paid','failed') DEFAULT 'pending',
				method ENUM('bank_transfer','upi','wallet') DEFAULT 'bank_transfer',
				reference VARCHAR(100),
				notes TEXT,
				paid_at TIMESTAMP NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			)
		`);
	}
	const alters = [];
	if (!(await columnExists('payouts', 'amount'))) alters.push("ADD COLUMN `amount` DECIMAL(10,2) NOT NULL DEFAULT 0");
	if (!(await columnExists('payouts', 'paid_at'))) alters.push("ADD COLUMN `paid_at` TIMESTAMP NULL");
	if (alters.length) {
		await connection.promise().query(`ALTER TABLE payouts ${alters.join(', ')}`);
	}
}

async function ensureKycDocumentsTable() {
	if (!(await tableExists('kyc_documents'))) {
		await connection.promise().query(`
			CREATE TABLE IF NOT EXISTS kyc_documents (
				id INT AUTO_INCREMENT PRIMARY KEY,
				vendor_id INT NOT NULL,
				document_type ENUM('gst','fssai','shopLicense','pan','aadhaar','bankProof') NOT NULL,
				filename VARCHAR(255) NOT NULL,
				original_name VARCHAR(255) NOT NULL,
				file_path VARCHAR(500) NOT NULL,
				file_size INT NOT NULL,
				mime_type VARCHAR(100) NOT NULL,
				uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
				UNIQUE KEY unique_vendor_document (vendor_id, document_type)
			)
		`);
	}

	const desiredColumns = [
		['filename', "VARCHAR(255) NOT NULL"],
		['original_name', "VARCHAR(255) NOT NULL"],
		['file_path', "VARCHAR(500) NOT NULL"],
		['file_size', "INT NOT NULL"],
		['mime_type', "VARCHAR(100) NOT NULL"],
		['uploaded_at', "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"],
		// KYC review & compliance fields
		['doc_status', "ENUM('UPLOADED','OCR_CHECK','FLAGGED','MANUAL_REVIEW','APPROVED','REJECTED') DEFAULT 'UPLOADED'"],
		['doc_status_notes', "TEXT NULL"],
		['doc_status_updated_at', "TIMESTAMP NULL"],
		['document_number', "VARCHAR(100) NULL"],
		['expiry_date', "DATE NULL"],
		['checksum_sha256', "CHAR(64) NULL"],
		['retention_until', "DATE NULL"],
		['storage_class', "VARCHAR(50) NULL"],
		['ocr_text', "LONGTEXT NULL"],
		['ocr_boxes', "JSON NULL"],
		['verification_status', "ENUM('PENDING','VERIFIED','REJECTED') DEFAULT 'PENDING'"],
		['verification_mismatches', "JSON NULL"],
		['verification_checked_at', "TIMESTAMP NULL"],
	];

	const alters = [];
	for (const [col, defn] of desiredColumns) {
		if (!(await columnExists('kyc_documents', col))) {
			alters.push(`ADD COLUMN \`${col}\` ${defn}`);
		}
	}
	if (alters.length) {
		await connection.promise().query(`ALTER TABLE kyc_documents ${alters.join(', ')}`);
	}
}

async function ensureKycAuditLogsTable() {
    if (!(await tableExists('kyc_audit_logs'))) {
        await connection.promise().query(`
            CREATE TABLE IF NOT EXISTS kyc_audit_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                vendor_id INT NOT NULL,
                document_id INT NULL,
                admin_identifier VARCHAR(100) NULL,
                action VARCHAR(50) NOT NULL,
                notes TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_vendor_created (vendor_id, created_at),
                INDEX idx_document_created (document_id, created_at)
            )
        `);
    }
}

// Pricing & Analytics Tables
async function ensureConsumerBehaviorTable() {
    if (!(await tableExists('consumer_behavior'))) {
        await connection.promise().query(`
            CREATE TABLE IF NOT EXISTS consumer_behavior (
                id INT AUTO_INCREMENT PRIMARY KEY,
                customer_id INT NULL,
                session_id VARCHAR(255) NULL,
                product_id INT NOT NULL,
                behavior_type ENUM('view','add_to_cart','remove_from_cart','purchase','abandon') NOT NULL,
                price_shown DECIMAL(10,2) NULL,
                price_paid DECIMAL(10,2) NULL,
                quantity INT DEFAULT 1,
                location_data JSON NULL,
                device_info JSON NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }
    // indexes
    await connection.promise().query("CREATE INDEX IF NOT EXISTS idx_consumer_behavior_customer ON consumer_behavior(customer_id)").catch(() => {});
    await connection.promise().query("CREATE INDEX IF NOT EXISTS idx_consumer_behavior_product ON consumer_behavior(product_id)").catch(() => {});
    await connection.promise().query("CREATE INDEX IF NOT EXISTS idx_consumer_behavior_type ON consumer_behavior(behavior_type)").catch(() => {});
    await connection.promise().query("CREATE INDEX IF NOT EXISTS idx_consumer_behavior_timestamp ON consumer_behavior(timestamp)").catch(() => {});
}

async function ensureConsumerSegmentsTable() {
    if (!(await tableExists('consumer_segments'))) {
        await connection.promise().query(`
            CREATE TABLE IF NOT EXISTS consumer_segments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                segment_name VARCHAR(100) NOT NULL UNIQUE,
                description TEXT,
                criteria JSON NOT NULL,
                pricing_multiplier DECIMAL(5,4) DEFAULT 1.0000,
                priority INT DEFAULT 0,
                is_active TINYINT(1) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
    } else {
        // ensure priority column exists
        if (!(await columnExists('consumer_segments', 'priority'))) {
            await connection.promise().query("ALTER TABLE consumer_segments ADD COLUMN `priority` INT DEFAULT 0");
        }
    }
}

async function ensureDynamicPricingRulesTable() {
    if (!(await tableExists('dynamic_pricing_rules'))) {
        await connection.promise().query(`
            CREATE TABLE IF NOT EXISTS dynamic_pricing_rules (
                id INT AUTO_INCREMENT PRIMARY KEY,
                rule_name VARCHAR(100) NOT NULL,
                product_id INT NULL,
                category VARCHAR(100) NULL,
                segment_id INT NULL,
                behavior_trigger ENUM('high_demand','low_demand','new_customer','returning_customer','price_sensitive','premium_customer') NULL,
                time_condition JSON NULL,
                location_condition JSON NULL,
                price_adjustment_type ENUM('percentage','fixed','multiplier') NOT NULL,
                price_adjustment_value DECIMAL(10,4) NOT NULL,
                min_price DECIMAL(10,2) NULL,
                max_price DECIMAL(10,2) NULL,
                is_active TINYINT(1) DEFAULT 1,
                priority INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
    }
    // indexes
    await connection.promise().query("CREATE INDEX IF NOT EXISTS idx_dynamic_pricing_product ON dynamic_pricing_rules(product_id)").catch(() => {});
    await connection.promise().query("CREATE INDEX IF NOT EXISTS idx_dynamic_pricing_category ON dynamic_pricing_rules(category)").catch(() => {});
    await connection.promise().query("CREATE INDEX IF NOT EXISTS idx_dynamic_pricing_segment ON dynamic_pricing_rules(segment_id)").catch(() => {});
    await connection.promise().query("CREATE INDEX IF NOT EXISTS idx_dynamic_pricing_priority ON dynamic_pricing_rules(priority)").catch(() => {});
}

async function ensurePriceCalculationsTable() {
    if (!(await tableExists('price_calculations'))) {
        await connection.promise().query(`
            CREATE TABLE IF NOT EXISTS price_calculations (
                id INT AUTO_INCREMENT PRIMARY KEY,
                product_id INT NOT NULL,
                base_price DECIMAL(10,2) NOT NULL,
                final_price DECIMAL(10,2) NOT NULL,
                customer_id INT NULL,
                session_id VARCHAR(255) NULL,
                segment_id INT NULL,
                applied_rules JSON NULL,
                calculation_details JSON NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }
    await connection.promise().query("CREATE INDEX IF NOT EXISTS idx_price_calc_product ON price_calculations(product_id)").catch(() => {});
    await connection.promise().query("CREATE INDEX IF NOT EXISTS idx_price_calc_customer ON price_calculations(customer_id)").catch(() => {});
    await connection.promise().query("CREATE INDEX IF NOT EXISTS idx_price_calc_timestamp ON price_calculations(created_at)").catch(() => {});
}

async function main() {
	const dbName = process.env.DB_NAME || 'vendor_portal';
	console.log('Ensuring database and schema for:', dbName);
	await ensureDatabaseAndUse(dbName);
	await ensureVendorsTable();
	await ensureProductsTable();
	await ensureInventoryTable();
	await ensurePayoutsTable();
	await ensureKycDocumentsTable();
    await ensureKycAuditLogsTable();
    await ensureConsumerBehaviorTable();
    await ensureConsumerSegmentsTable();
    await ensureDynamicPricingRulesTable();
    await ensurePriceCalculationsTable();
	console.log('Schema ensured successfully.');
}

main()
	.then(() => connection.end())
	.catch(err => {
		console.error('DB migration error:', err);
		connection.end();
		process.exit(1);
	});


