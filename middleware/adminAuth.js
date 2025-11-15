const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key';

/**
 * Comprehensive admin authentication middleware
 * Supports both JWT tokens and API keys
 * Validates admin role and token expiry
 */
const adminAuth = (req, res, next) => {
  try {
    // Option 1: Check for API key in headers
    const apiKey = req.headers['x-admin-key'] 
      || req.headers['admin-api-key'] 
      || req.headers['adminapikey']
      || req.query['x-admin-key']
      || req.query['adminApiKey'];

    if (apiKey && apiKey === ADMIN_API_KEY) {
      req.adminId = 'admin-api-key';
      req.user = { role: 'admin', id: 'api-key' };
      return next();
    }

    // Option 2: Check for JWT token in Authorization header
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Check if user has admin role
        const isAdmin = decoded.role === 'admin' 
          || decoded.is_admin === true 
          || (Array.isArray(decoded.roles) && decoded.roles.includes('admin'));
        
        if (!isAdmin) {
          return res.status(403).json({ 
            error: 'Admin access required',
            message: 'This endpoint requires admin privileges'
          });
        }

        // Set admin context
        req.adminId = decoded.adminId || decoded.id || decoded.email || 'admin-jwt';
        req.user = {
          id: decoded.adminId || decoded.id,
          email: decoded.email,
          role: 'admin',
          username: decoded.username
        };
        
        return next();
      } catch (error) {
        if (error.name === 'TokenExpiredError') {
          return res.status(401).json({ 
            error: 'Token expired',
            message: 'Your session has expired. Please log in again.'
          });
        } else if (error.name === 'JsonWebTokenError') {
          return res.status(401).json({ 
            error: 'Invalid token',
            message: 'Invalid authentication token.'
          });
        } else {
          return res.status(401).json({ 
            error: 'Token validation failed',
            message: 'Unable to validate authentication token.'
          });
        }
      }
    }

    // Option 3: Check for JWT token in cookies (for httpOnly cookies)
    const cookieToken = req.cookies?.admin_token;
    if (cookieToken) {
      try {
        const decoded = jwt.verify(cookieToken, JWT_SECRET);
        
        const isAdmin = decoded.role === 'admin' 
          || decoded.is_admin === true 
          || (Array.isArray(decoded.roles) && decoded.roles.includes('admin'));
        
        if (!isAdmin) {
          return res.status(403).json({ 
            error: 'Admin access required',
            message: 'This endpoint requires admin privileges'
          });
        }

        req.adminId = decoded.adminId || decoded.id || decoded.email || 'admin-cookie';
        req.user = {
          id: decoded.adminId || decoded.id,
          email: decoded.email,
          role: 'admin',
          username: decoded.username
        };
        
        return next();
      } catch (error) {
        // Cookie token is invalid, continue to check other methods
        console.log('Cookie token validation failed:', error.message);
      }
    }

    // No valid authentication found
    return res.status(401).json({ 
      error: 'Authentication required',
      message: 'Please provide a valid admin API key or JWT token.',
      hint: 'Include x-admin-key header or Authorization: Bearer <token>'
    });

  } catch (error) {
    console.error('Admin auth middleware error:', error);
    return res.status(500).json({ 
      error: 'Authentication error',
      message: 'An error occurred during authentication.'
    });
  }
};

/**
 * Optional admin authentication middleware
 * Allows requests to proceed even if not authenticated
 * Sets req.isAdmin based on authentication status
 */
const optionalAdminAuth = (req, res, next) => {
  try {
    // Try to authenticate, but don't fail if not authenticated
    const apiKey = req.headers['x-admin-key'] 
      || req.headers['admin-api-key'] 
      || req.headers['adminapikey'];

    if (apiKey && apiKey === ADMIN_API_KEY) {
      req.isAdmin = true;
      req.adminId = 'admin-api-key';
      req.user = { role: 'admin', id: 'api-key' };
    } else {
      const authHeader = req.headers['authorization'] || req.headers['Authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          const isAdmin = decoded.role === 'admin' 
            || decoded.is_admin === true 
            || (Array.isArray(decoded.roles) && decoded.roles.includes('admin'));
          
          if (isAdmin) {
            req.isAdmin = true;
            req.adminId = decoded.adminId || decoded.id || decoded.email || 'admin-jwt';
            req.user = {
              id: decoded.adminId || decoded.id,
              email: decoded.email,
              role: 'admin',
              username: decoded.username
            };
          }
        } catch (error) {
          // Token is invalid, but that's okay for optional auth
        }
      }
    }

    next();
  } catch (error) {
    console.error('Optional admin auth middleware error:', error);
    next();
  }
};

module.exports = {
  adminAuth,
  optionalAdminAuth
};
