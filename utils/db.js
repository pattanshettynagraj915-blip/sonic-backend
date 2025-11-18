// // Always load dotenv to ensure environment variables are available
// const path = require('path');
// const envPath = path.resolve(__dirname, '../.env');
// const dotenvResult = require('dotenv').config({ path: envPath });

// if (dotenvResult.error) {
//   console.error('❌ Error loading .env file:', dotenvResult.error.message);
//   console.error('Tried path:', envPath);
// } else {
//   console.log('✓ .env file loaded from:', envPath);
// }

// const mysql = require('mysql2');

// // Get environment variables and ensure they're strings
// const DB_HOST = String(process.env.DB_HOST || 'localhost').trim();
// const DB_USER = String(process.env.DB_USER || 'root').trim();
// let DB_PASSWORD = process.env.DB_PASSWORD;
// if (!DB_PASSWORD || typeof DB_PASSWORD !== 'string') {
//   console.error('❌ FATAL: DB_PASSWORD is not set or is not a string!');
//   console.error('Type:', typeof DB_PASSWORD);
//   console.error('Value:', DB_PASSWORD);
//   process.exit(1);
// }
// DB_PASSWORD = String(DB_PASSWORD).trim();
// const DB_NAME = String(process.env.DB_NAME || 'vendor_portal').trim();

// // Debug: Check if env variables are loaded
// console.log('Environment check:', {
//   DB_HOST: DB_HOST ? '✓' : '✗',
//   DB_USER: DB_USER ? '✓' : '✗',
//   DB_PASSWORD: DB_PASSWORD ? '✓ (set)' : '✗ (NOT SET)',
//   DB_NAME: DB_NAME ? '✓' : '✗'
// });

// if (!DB_PASSWORD) {
//   console.error("⚠️  WARNING: DB_PASSWORD is not set in environment variables");
//   console.error("Current process.env.DB_PASSWORD:", process.env.DB_PASSWORD);
// } else {
//   console.log(`✓ DB_PASSWORD loaded (${DB_PASSWORD.length} characters)`);
// }

// // Create database configuration - explicitly set password
// const dbConfig = {
//   host: DB_HOST,
//   user: DB_USER,
//   password: DB_PASSWORD, // Explicitly set password
//   database: DB_NAME,
//   waitForConnections: true,
//   connectionLimit: 10,
//   queueLimit: 0
// };

// // Verify password is in config
// if (!dbConfig.password || dbConfig.password.length === 0) {
//   console.error('❌ FATAL: Password is missing in dbConfig!');
//   console.error('dbConfig:', { ...dbConfig, password: '[REDACTED]' });
//   process.exit(1);
// }

// // Final verification - ensure password is a non-empty string
// if (typeof dbConfig.password !== 'string' || dbConfig.password.trim().length === 0) {
//   console.error('❌ FATAL: Password is not a valid string!');
//   console.error('Password type:', typeof dbConfig.password);
//   console.error('Password length:', dbConfig.password ? dbConfig.password.length : 0);
//   process.exit(1);
// }

// // Debug: Log the actual config (without showing password value)
// console.log('Database config:', {
//   host: dbConfig.host,
//   user: dbConfig.user,
//   password: dbConfig.password ? `[SET: ${dbConfig.password.length} chars]` : '[NOT SET]',
//   database: dbConfig.database
// });

// // Create pool with explicit password - ensure password is definitely a string
// const poolConfig = {
//   host: String(dbConfig.host),
//   user: String(dbConfig.user),
//   password: String(dbConfig.password), // Force to string
//   database: String(dbConfig.database),
//   waitForConnections: true,
//   connectionLimit: 5, // Reduced from 10 to prevent too many connections
//   queueLimit: 0,
//   // Connection timeouts
//   acquireTimeout: 60000,
//   timeout: 60000,
//   // Enable keep-alive to prevent connection resets
//   enableKeepAlive: true,
//   keepAliveInitialDelay: 0
// };

// // Final check - log the actual password value (first 2 chars only for security)
// console.log('Pool config password check:', {
//   passwordType: typeof poolConfig.password,
//   passwordLength: poolConfig.password ? poolConfig.password.length : 0,
//   passwordPreview: poolConfig.password ? poolConfig.password.substring(0, 2) + '...' : 'NOT SET'
// });

// // Create pool with error handling
// let pool;
// try {
//   pool = mysql.createPool(poolConfig);
// } catch (error) {
//   console.error('❌ Failed to create database pool:', error.message);
//   throw error;
// }

// // Attach error handlers IMMEDIATELY after pool creation
// // Handle pool errors (unhandled error events) - prevent crash
// pool.on('error', (err) => {
//   console.error('❌ MySQL Pool Error:', err.message);
//   if (err.code === 'ER_ACCESS_DENIED_ERROR') {
//     console.error('Access denied - Check DB_USER and DB_PASSWORD in .env file');
//     console.error('Current config:', {
//       host: DB_HOST,
//       user: DB_USER,
//       passwordSet: !!DB_PASSWORD,
//       passwordLength: DB_PASSWORD ? DB_PASSWORD.length : 0,
//       passwordValue: DB_PASSWORD ? DB_PASSWORD.substring(0, 2) + '...' : 'NOT SET'
//     });
//     console.error('⚠️  Server will continue but database operations may fail');
//   }
//   // Don't throw - let server continue
//   // Prevent unhandled error from crashing the process
//   if (err.fatal) {
//     console.error('⚠️  Fatal database error - connections will be retried automatically');
//   }
// });

// // Handle connection errors on individual connections
// pool.on('connection', (connection) => {
//   connection.on('error', (err) => {
//     // Only log ECONNRESET errors occasionally to avoid spam
//     if (err.code === 'ECONNRESET') {
//       // Log only once per minute to avoid spam
//       if (!pool._lastResetLog || Date.now() - pool._lastResetLog > 60000) {
//         console.warn('⚠️  MySQL connection reset by server (this is normal for idle connections)');
//         pool._lastResetLog = Date.now();
//       }
//     } else {
//       console.error('❌ MySQL Connection Error:', err.message, err.code);
//       if (err.code === 'ER_ACCESS_DENIED_ERROR') {
//         console.error('⚠️  Connection authentication failed - check credentials');
//       }
//     }
//     // Don't throw - pool will handle reconnection
//   });
  
//   // Log successful connections (only occasionally)
//   if (!pool._connectionCount) pool._connectionCount = 0;
//   pool._connectionCount++;
//   if (pool._connectionCount <= 1) {
//     console.log('✓ Database connection established');
//   }
// });

// // Prevent unhandled promise rejections from pool operations
// const originalUnhandledRejection = process.listeners('unhandledRejection').find(
//   listener => listener.toString().includes('database error')
// );

// if (!originalUnhandledRejection) {
//   process.on('unhandledRejection', (reason, promise) => {
//     if (reason && reason.code) {
//       // Handle database errors gracefully
//       if (reason.code.startsWith('ER_') || reason.code === 'ECONNRESET' || reason.code === 'PROTOCOL_CONNECTION_LOST') {
//         // Suppress ECONNRESET spam - only log occasionally
//         if (reason.code === 'ECONNRESET') {
//           if (!pool._lastUnhandledReset || Date.now() - pool._lastUnhandledReset > 60000) {
//             console.warn('⚠️  Unhandled connection reset (pool will retry automatically)');
//             pool._lastUnhandledReset = Date.now();
//           }
//         } else {
//           console.error('❌ Unhandled database error:', reason.message, reason.code);
//         }
//         // Don't crash - log and continue
//         return;
//       }
//     }
//     // Let other unhandled rejections through to default handler
//   });
// }

// // Test connection asynchronously (non-blocking) with retry logic
// let connectionAttempts = 0;
// const maxConnectionAttempts = 3;

// const testConnection = () => {
//   connectionAttempts++;
//   pool.getConnection((err, conn) => {
//     if (err) {
//       if (err.code === 'ECONNRESET' && connectionAttempts < maxConnectionAttempts) {
//         // Retry on connection reset
//         console.log(`⏳ Retrying database connection (attempt ${connectionAttempts}/${maxConnectionAttempts})...`);
//         setTimeout(testConnection, 2000); // Wait 2 seconds before retry
//         return;
//       }
      
//       console.error("❌ MySQL Connection Error:", err.sqlMessage || err.message);
//       console.error("Error code:", err.code);
      
//       if (err.code === 'ER_ACCESS_DENIED_ERROR') {
//         console.error("Connection details:", {
//           host: DB_HOST,
//           user: DB_USER,
//           database: DB_NAME,
//           passwordSet: !!DB_PASSWORD,
//           passwordLength: DB_PASSWORD ? DB_PASSWORD.length : 0
//         });
//       } else if (err.code === 'ECONNRESET') {
//         console.warn("⚠️  Connection reset by server - this may be due to:");
//         console.warn("   - Server connection limits");
//         console.warn("   - Network issues");
//         console.warn("   - Idle connection timeout");
//         console.warn("   The pool will automatically retry connections when needed.");
//       }
//       // Don't exit - let the server start and handle errors gracefully
//     } else {
//       console.log("✅ MySQL Connected Successfully");
//       conn.release();
//     }
//   });
// };

// // Test connection after a short delay to let the pool initialize
// setTimeout(testConnection, 1000);

// module.exports = pool;



const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, '../.env')
});

const mysql = require('mysql2');

const ENV = process.env.NODE_ENV || "local";

const DB_HOST = process.env.DB_HOST || "localhost";
const DB_USER = process.env.DB_USER || "root";
let DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME || "vendor_portal";
const DB_PORT = process.env.DB_PORT || 3306;

// Allow empty password only in local
if (ENV === "production" && (!DB_PASSWORD || DB_PASSWORD.trim().length === 0)) {
  console.error("❌ FATAL: DB_PASSWORD is required in production!");
  process.exit(1);
}

// If local, empty password is OK
if (ENV === "local" && (!DB_PASSWORD || DB_PASSWORD.trim().length === 0)) {
  DB_PASSWORD = "";
  console.log("⚠️ Running in LOCAL mode with EMPTY password");
}

console.log(`✓ Running in ${ENV} mode`);
console.log("DB Config Loaded:", {
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD ? "***" : "(empty)",
  database: DB_NAME
});

const pool = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  port: DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test database connection
pool.getConnection((err, conn) => {
  if (err) {
    console.error("❌ Database Connection Error:", err.message);
  } else {
    console.log("✅ Database Connected Successfully");
    conn.release();
  }
});

module.exports = pool;
