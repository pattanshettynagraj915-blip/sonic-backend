const mysql = require('mysql2/promise');

class InventoryService {
    constructor(dbConnection, redisClient = null) {
        this.db = dbConnection;
        this.redis = redisClient;
        this.lockTimeout = 30000; // 30 seconds
    }

    /**
     * Reserve stock for a product with auto-fallback vendor selection
     * @param {Object} params - Reservation parameters
     * @param {number} params.productId - Product ID
     * @param {number} params.quantity - Quantity to reserve
     * @param {string} params.zone - Delivery zone
     * @param {number} params.orderId - Order ID
     * @param {number} params.customerLat - Customer latitude
     * @param {number} params.customerLng - Customer longitude
     * @returns {Object} Reservation result
     */
    async reserveStock(params) {
        const { productId, quantity, zone, orderId, customerLat, customerLng } = params;
        
        try {
            // Use Redis lock for high contention scenarios
            const lockKey = `inventory_lock:${productId}:${zone}`;
            const lockValue = `${Date.now()}-${Math.random()}`;
            
            if (this.redis) {
                const lockAcquired = await this.acquireRedisLock(lockKey, lockValue);
                if (!lockAcquired) {
                    throw new Error('Could not acquire inventory lock');
                }
            }

            try {
                // Call stored procedure for atomic reservation with fallback
                const [result] = await this.db.execute(
                    'CALL ReserveStockWithFallback(?, ?, ?, ?, ?, ?, @vendor_id, @reservation_id, @success)',
                    [productId, quantity, zone, orderId, customerLat, customerLng]
                );

                // Get output parameters
                const [output] = await this.db.execute('SELECT @vendor_id as vendor_id, @reservation_id as reservation_id, @success as success');
                const { vendor_id, reservation_id, success } = output[0];

                if (!success) {
                    throw new Error('No vendors available with sufficient stock');
                }

                return {
                    success: true,
                    vendorId: vendor_id,
                    reservationId: reservation_id,
                    message: 'Stock reserved successfully'
                };

            } finally {
                // Release Redis lock
                if (this.redis) {
                    await this.releaseRedisLock(lockKey, lockValue);
                }
            }

        } catch (error) {
            console.error('Error in reserveStock:', error);
            throw error;
        }
    }

    /**
     * Commit a reservation (permanently decrease stock)
     * @param {Object} params - Commit parameters
     * @param {number} params.reservationId - Reservation ID
     * @param {number} params.vendorId - Vendor ID
     * @param {number} params.productId - Product ID
     * @param {number} params.quantity - Quantity to commit
     * @returns {Object} Commit result
     */
    async commitReservation(params) {
        const { reservationId, vendorId, productId, quantity } = params;
        
        try {
            const [result] = await this.db.execute(
                'CALL CommitReservation(?, ?, ?, ?, @success)',
                [reservationId, vendorId, productId, quantity]
            );

            const [output] = await this.db.execute('SELECT @success as success');
            const { success } = output[0];

            if (!success) {
                throw new Error('Failed to commit reservation - insufficient reserved stock');
            }

            return {
                success: true,
                message: 'Reservation committed successfully'
            };

        } catch (error) {
            console.error('Error in commitReservation:', error);
            throw error;
        }
    }

    /**
     * Release a reservation (free up reserved stock)
     * @param {Object} params - Release parameters
     * @param {number} params.reservationId - Reservation ID
     * @param {number} params.vendorId - Vendor ID
     * @param {number} params.productId - Product ID
     * @param {number} params.quantity - Quantity to release
     * @returns {Object} Release result
     */
    async releaseReservation(params) {
        const { reservationId, vendorId, productId, quantity } = params;
        
        try {
            const [result] = await this.db.execute(
                'CALL ReleaseReservation(?, ?, ?, ?, @success)',
                [reservationId, vendorId, productId, quantity]
            );

            const [output] = await this.db.execute('SELECT @success as success');
            const { success } = output[0];

            if (!success) {
                throw new Error('Failed to release reservation - insufficient reserved stock');
            }

            return {
                success: true,
                message: 'Reservation released successfully'
            };

        } catch (error) {
            console.error('Error in releaseReservation:', error);
            throw error;
        }
    }

    /**
     * Get available stock for a product across all vendors in a zone
     * @param {number} productId - Product ID
     * @param {string} zone - Delivery zone
     * @returns {Object} Stock availability
     */
    async getStockAvailability(productId, zone) {
        try {
            // Check cache first
            if (this.redis) {
                const cacheKey = `stock_availability:${productId}:${zone}`;
                const cached = await this.redis.get(cacheKey);
                if (cached) {
                    return JSON.parse(cached);
                }
            }

            // Query database
            const [rows] = await this.db.execute(`
                SELECT 
                    vp.vendor_id,
                    v.shop_name,
                    v.rating,
                    v.sla_minutes,
                    v.avg_prep_time,
                    vp.stock_available,
                    vp.price,
                    vp.commission_rate
                FROM vendor_products vp
                JOIN vendors v ON vp.vendor_id = v.id
                WHERE vp.product_id = ? 
                AND v.is_active = TRUE 
                AND v.status = 'ACTIVE'
                AND JSON_CONTAINS(v.delivery_zones, JSON_QUOTE(?))
                AND vp.stock_available > 0
                ORDER BY vp.stock_available DESC
            `, [productId, zone]);

            const result = {
                productId,
                zone,
                totalAvailable: rows.reduce((sum, row) => sum + row.stock_available, 0),
                vendorCount: rows.length,
                vendors: rows,
                lastUpdated: new Date()
            };

            // Cache the result
            if (this.redis) {
                const cacheKey = `stock_availability:${productId}:${zone}`;
                await this.redis.setex(cacheKey, 300, JSON.stringify(result)); // 5 minutes cache
            }

            return result;

        } catch (error) {
            console.error('Error in getStockAvailability:', error);
            throw error;
        }
    }

    /**
     * Update vendor priority queue for a product-zone combination
     * @param {number} productId - Product ID
     * @param {string} zone - Delivery zone
     * @param {number} customerLat - Customer latitude
     * @param {number} customerLng - Customer longitude
     */
    async updateVendorPriorityQueue(productId, zone, customerLat, customerLng) {
        try {
            await this.db.execute(
                'CALL CalculateVendorPriority(?, ?, ?, ?)',
                [productId, zone, customerLat, customerLng]
            );
        } catch (error) {
            console.error('Error in updateVendorPriorityQueue:', error);
            throw error;
        }
    }

    /**
     * Get vendor priority queue for a product-zone combination
     * @param {number} productId - Product ID
     * @param {string} zone - Delivery zone
     * @returns {Array} Priority queue
     */
    async getVendorPriorityQueue(productId, zone) {
        try {
            const [rows] = await this.db.execute(`
                SELECT 
                    vpq.vendor_id,
                    v.shop_name,
                    v.rating,
                    v.sla_minutes,
                    v.avg_prep_time,
                    v.commission_rate,
                    vpq.priority_score,
                    vpq.distance_km,
                    vp.stock_available,
                    vp.price
                FROM vendor_priority_queue vpq
                JOIN vendors v ON vpq.vendor_id = v.id
                JOIN vendor_products vp ON vpq.vendor_id = vp.vendor_id AND vpq.product_id = vp.product_id
                WHERE vpq.product_id = ? 
                AND vpq.zone = ? 
                AND vpq.is_active = TRUE
                ORDER BY vpq.priority_score ASC
            `, [productId, zone]);

            return rows;
        } catch (error) {
            console.error('Error in getVendorPriorityQueue:', error);
            throw error;
        }
    }

    /**
     * Clean up expired reservations
     */
    async cleanupExpiredReservations() {
        try {
            await this.db.execute('CALL CleanupExpiredReservations()');
        } catch (error) {
            console.error('Error in cleanupExpiredReservations:', error);
            throw error;
        }
    }

    /**
     * Clean up expired stock records if schema supports batch expiry
     * This is a no-op if the table does not exist.
     */
    async cleanupExpiredStock() {
        try {
            // Attempt to remove expired stock from vendor_products batches or similar tables.
            // Since schema may not include batch expiry, we guard with EXISTS checks.
            // 1) If table inventory_batches exists with expiry_date column, delete expired rows and adjust stock.
            const [tables] = await this.db.query("SHOW TABLES LIKE 'inventory_batches'");
            if (Array.isArray(tables) && tables.length > 0) {
                // Soft delete or remove expired batches and decrement corresponding vendor_products.stock_on_hand
                // Use transactional safety
                await this.db.beginTransaction();
                try {
                    // Aggregate expired quantities by vendor_id and product_id
                    const [expired] = await this.db.execute(`
                        SELECT vendor_id, product_id, COALESCE(SUM(quantity), 0) AS qty
                        FROM inventory_batches
                        WHERE expiry_date < NOW()
                        GROUP BY vendor_id, product_id
                    `);

                    // Decrement stock_on_hand for each aggregated row
                    for (const row of expired) {
                        if (!row || !row.vendor_id || !row.product_id || !row.qty) continue;
                        await this.db.execute(
                            'UPDATE vendor_products SET stock_on_hand = GREATEST(stock_on_hand - ?, 0) WHERE vendor_id = ? AND product_id = ?;',
                            [row.qty, row.vendor_id, row.product_id]
                        );
                    }

                    // Remove expired batches
                    await this.db.execute('DELETE FROM inventory_batches WHERE expiry_date < NOW()');

                    await this.db.commit();
                } catch (txErr) {
                    await this.db.rollback();
                    throw txErr;
                }
            }
        } catch (error) {
            // Silently ignore if schema not present; rethrow other errors
            console.error('Error in cleanupExpiredStock (non-fatal if table missing):', error.message || error);
        }
    }

    /**
     * Remove reservations with invalid terminal statuses (expired/cancelled) leftovers
     */
    async cleanupInvalidReservations() {
        try {
            await this.db.execute(`
                DELETE FROM stock_reservations
                WHERE status IN ('expired','cancelled')
                    AND (expires_at IS NULL OR expires_at < DATE_SUB(NOW(), INTERVAL 30 DAY))
            `);
        } catch (error) {
            console.error('Error in cleanupInvalidReservations:', error);
            throw error;
        }
    }

    /**
     * Get inventory summary for a vendor
     * @param {number} vendorId - Vendor ID
     * @returns {Object} Inventory summary
     */
    async getVendorInventorySummary(vendorId) {
        try {
            const [rows] = await this.db.execute(`
                SELECT 
                    p.id AS product_id,
                    p.name AS product_name,
                    p.sku,
                    p.category,
                    COALESCE(i.stock_on_hand, 0) AS stock_on_hand,
                    COALESCE(i.stock_reserved, 0) AS stock_reserved,
                    COALESCE(i.stock_on_hand - i.stock_reserved, 0) AS stock_available,
                    p.price,
                    COALESCE(i.min_stock_level, 0) AS min_stock_level,
                    CASE 
                        WHEN COALESCE(i.stock_on_hand - i.stock_reserved, 0) <= 0 THEN 'Out of Stock'
                        WHEN COALESCE(i.stock_on_hand - i.stock_reserved, 0) <= COALESCE(i.min_stock_level, 0) THEN 'Low Stock'
                        ELSE 'In Stock'
                    END AS stock_status
                FROM products p
                LEFT JOIN inventory i ON p.id = i.product_id
                WHERE p.vendor_id = ?
                ORDER BY stock_available ASC
            `, [vendorId]);

            return {
                vendorId,
                totalProducts: rows.length,
                outOfStock: rows.filter(r => r.stock_status === 'Out of Stock').length,
                lowStock: rows.filter(r => r.stock_status === 'Low Stock').length,
                inStock: rows.filter(r => r.stock_status === 'In Stock').length,
                products: rows
            };
        } catch (error) {
            console.error('Error in getVendorInventorySummary:', error);
            throw error;
        }
    }

    /**
     * Update stock levels for a vendor product
     * @param {number} vendorId - Vendor ID
     * @param {number} productId - Product ID
     * @param {number} stockOnHand - New stock on hand
     * @param {string} reason - Reason for update
     * @returns {Object} Update result
     */
    async updateStockLevels(vendorId, productId, stockOnHand, reason = 'manual_adjustment') {
        try {
            // Get current product info and threshold
            const [productInfo] = await this.db.execute(`
                SELECT p.name as product_name, vp.min_stock_level, vp.stock_on_hand as current_stock
                FROM products p
                JOIN vendor_products vp ON p.id = vp.product_id
                WHERE vp.vendor_id = ? AND vp.product_id = ?
            `, [vendorId, productId]);

            if (productInfo.length === 0) {
                throw new Error('Product not found for this vendor');
            }

            const product = productInfo[0];
            const minStockLevel = product.min_stock_level || 10; // Default threshold
            const currentStock = product.current_stock || 0;

            await this.db.execute(`
                UPDATE vendor_products 
                SET stock_on_hand = ?
                WHERE vendor_id = ? AND product_id = ?
            `, [stockOnHand, vendorId, productId]);

            // Record stock movement
            await this.db.execute(`
                INSERT INTO stock_movements (
                    product_id, movement_type, quantity, reference_type, 
                    reference_id, vendor_id, notes
                ) VALUES (?, 'adjustment', ?, 'manual', 0, ?, ?)
            `, [productId, stockOnHand, vendorId, reason]);

            // Check for low stock alert
            if (stockOnHand <= minStockLevel && currentStock > minStockLevel) {
                // Stock just went below threshold
                if (global.notificationService) {
                    global.notificationService.emit('lowStockAlert', {
                        vendor_id: vendorId,
                        product_id: productId,
                        product_name: product.product_name,
                        current_stock: stockOnHand,
                        threshold: minStockLevel
                    });
                }
            }

            return {
                success: true,
                message: 'Stock levels updated successfully'
            };
        } catch (error) {
            console.error('Error in updateStockLevels:', error);
            throw error;
        }
    }

    /**
     * Acquire Redis lock
     * @param {string} key - Lock key
     * @param {string} value - Lock value
     * @returns {boolean} Success
     */
    async acquireRedisLock(key, value) {
        try {
            const result = await this.redis.set(key, value, 'PX', this.lockTimeout, 'NX');
            return result === 'OK';
        } catch (error) {
            console.error('Error acquiring Redis lock:', error);
            return false;
        }
    }

    /**
     * Release Redis lock
     * @param {string} key - Lock key
     * @param {string} value - Lock value
     */
    async releaseRedisLock(key, value) {
        try {
            const script = `
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            `;
            await this.redis.eval(script, 1, key, value);
        } catch (error) {
            console.error('Error releasing Redis lock:', error);
        }
    }

    /**
     * Handle partial order fulfillment across multiple vendors
     * @param {Object} params - Fulfillment parameters
     * @param {number} params.orderId - Order ID
     * @param {number} params.productId - Product ID
     * @param {number} params.totalQuantity - Total quantity needed
     * @param {string} params.zone - Delivery zone
     * @returns {Object} Fulfillment result
     */
    async handlePartialFulfillment(params) {
        const { orderId, productId, totalQuantity, zone } = params;
        
        try {
            const availability = await this.getStockAvailability(productId, zone);
            
            if (availability.totalAvailable < totalQuantity) {
                return {
                    success: false,
                    message: 'Insufficient stock across all vendors',
                    available: availability.totalAvailable,
                    needed: totalQuantity
                };
            }

            const fulfillments = [];
            let remainingQuantity = totalQuantity;

            // Try to fulfill from highest priority vendors
            for (const vendor of availability.vendors) {
                if (remainingQuantity <= 0) break;

                const fulfillQuantity = Math.min(remainingQuantity, vendor.stock_available);
                
                if (fulfillQuantity > 0) {
                    const reservation = await this.reserveStock({
                        productId,
                        quantity: fulfillQuantity,
                        zone,
                        orderId,
                        customerLat: 0, // Will be updated with actual coordinates
                        customerLng: 0
                    });

                    if (reservation.success) {
                        fulfillments.push({
                            vendorId: reservation.vendorId,
                            reservationId: reservation.reservationId,
                            quantity: fulfillQuantity
                        });
                        remainingQuantity -= fulfillQuantity;
                    }
                }
            }

            return {
                success: true,
                fulfillments,
                totalFulfilled: totalQuantity - remainingQuantity,
                remaining: remainingQuantity
            };

        } catch (error) {
            console.error('Error in handlePartialFulfillment:', error);
            throw error;
        }
    }
}

module.exports = InventoryService;
