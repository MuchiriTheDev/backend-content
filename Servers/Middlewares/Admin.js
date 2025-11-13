// Middleware to restrict access to admins only
export const adminMiddleware = (req, res, next) => {
    if (!req.user || req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Unauthorized: Admin access required' });
    }
    next();
};