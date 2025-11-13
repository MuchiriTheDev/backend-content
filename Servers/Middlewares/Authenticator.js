// middleware/auth.js
import jwt from 'jsonwebtoken';
import User from '../Models/User.js';
import logger from '../Utilities/Logger.js';

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Align with JWT payload: Use 'userId' (from passport generation)
    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    // Attach aligned user object to request (matches controller expectations: req.user.userId, etc.)
    req.user = { 
      userId: user._id, 
      youtubeId: decoded.youtubeId || user.platformInfo.youtube.id,  // From payload or user doc
      role: user.role 
    }; // Attach user to request
    next();
  } catch (error) {
    logger.error(`Auth error: ${error.message}`);
    console.log(error);
    res.status(401).json({ success: false, error: 'Unauthorized' });
  }
};

export default authMiddleware;