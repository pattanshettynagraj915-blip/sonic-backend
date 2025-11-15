const mysql = require('mysql2');
require('dotenv').config();

const db = mysql.createConnection({
	host: process.env.DB_HOST || 'localhost',
	user: process.env.DB_USER || 'root',
	password: process.env.DB_PASSWORD || '',
	database: process.env.DB_NAME || 'vendor_portal'
});

async function initPaymentsTables() {
	try {
		console.log('Initializing payments tables...');

		// Payment methods master
		await db.promise().query(`
			CREATE TABLE IF NOT EXISTS payment_methods (
				id INT AUTO_INCREMENT PRIMARY KEY,
				method_code VARCHAR(50) UNIQUE NOT NULL,
				display_name VARCHAR(100) NOT NULL,
				is_active TINYINT(1) DEFAULT 1,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
				INDEX idx_payment_methods_active (is_active)
			)
		`);

		// Customers (minimal) for mapping payments; reuse vendors table for vendor side
		await db.promise().query(`
			CREATE TABLE IF NOT EXISTS customers (
				id INT AUTO_INCREMENT PRIMARY KEY,
				name VARCHAR(255) NOT NULL,
				email VARCHAR(255) NULL,
				phone VARCHAR(20) NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
				UNIQUE KEY uniq_customer_email (email)
			)
		`);

		// Payments
		await db.promise().query(`
			CREATE TABLE IF NOT EXISTS payments (
				id BIGINT AUTO_INCREMENT PRIMARY KEY,
				transaction_id VARCHAR(100) UNIQUE NOT NULL,
				vendor_id INT NULL,
				customer_id INT NULL,
				order_id INT NULL,
				method_code VARCHAR(50) NOT NULL,
				currency VARCHAR(10) DEFAULT 'INR',
				amount DECIMAL(12,2) NOT NULL,
				fee_amount DECIMAL(12,2) DEFAULT 0,
				net_amount DECIMAL(12,2) GENERATED ALWAYS AS (amount - fee_amount) STORED,
				status ENUM('pending','processing','successful','failed','refunded','partially_refunded') DEFAULT 'pending',
				gateway VARCHAR(50) NULL,
				gateway_reference VARCHAR(100) NULL,
				failure_reason TEXT NULL,
				metadata JSON NULL,
				paid_at TIMESTAMP NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
				FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL,
				FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
				INDEX idx_payments_status (status),
				INDEX idx_payments_vendor (vendor_id),
				INDEX idx_payments_customer (customer_id),
				INDEX idx_payments_method (method_code),
				INDEX idx_payments_paid_at (paid_at),
				INDEX idx_payments_created_at (created_at)
			)
		`);

		// Refunds
		await db.promise().query(`
			CREATE TABLE IF NOT EXISTS payment_refunds (
				id BIGINT AUTO_INCREMENT PRIMARY KEY,
				payment_id BIGINT NOT NULL,
				refund_id VARCHAR(100) UNIQUE NOT NULL,
				amount DECIMAL(12,2) NOT NULL,
				status ENUM('initiated','processing','successful','failed') DEFAULT 'initiated',
				reason VARCHAR(255) NULL,
				gateway_reference VARCHAR(100) NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				processed_at TIMESTAMP NULL,
				FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
				INDEX idx_refunds_payment (payment_id),
				INDEX idx_refunds_status (status)
			)
		`);

		// Audit logs for payment actions
		await db.promise().query(`
			CREATE TABLE IF NOT EXISTS payment_audit_logs (
				id BIGINT AUTO_INCREMENT PRIMARY KEY,
				payment_id BIGINT NULL,
				actor_type ENUM('system','admin') DEFAULT 'system',
				actor_id INT NULL,
				action VARCHAR(100) NOT NULL,
				details JSON NULL,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				INDEX idx_payment_audit_payment (payment_id),
				INDEX idx_payment_audit_action (action)
			)
		`);

		// Seed common methods
		await db.promise().query(`
			INSERT IGNORE INTO payment_methods (method_code, display_name) VALUES
			('card', 'Card'),
			('upi', 'UPI'),
			('netbanking', 'Net Banking'),
			('wallet', 'Wallet'),
			('cod', 'Cash On Delivery')
		`);

		console.log('✅ Payments tables initialized');
	} catch (err) {
		console.error('❌ Error initializing payments tables:', err.message);
	} finally {
		db.end();
	}
}

initPaymentsTables();


