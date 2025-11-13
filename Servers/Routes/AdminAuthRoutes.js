import express from 'express';
import {
  getAllUsers,
  getUserDetails,
  updateUser,
  deactivateUser,
  resendVerificationEmail,
  getAnalytics,
  generateUserReport
} from '../Controllers/AdminAuthController.js';
import authMiddleware from '../Middlewares/Authenticator.js';
import { adminMiddleware } from '../Middlewares/Admin.js';
const adminRouter = express.Router();

// Admin Routes (Private)
adminRouter.get('/users', authMiddleware, adminMiddleware, getAllUsers);
adminRouter.get('/users/:id', authMiddleware, adminMiddleware, getUserDetails);
adminRouter.put('/users/:id', authMiddleware, adminMiddleware, updateUser);
adminRouter.delete('/users/:id', authMiddleware, adminMiddleware, deactivateUser);
adminRouter.post('/users/:id/resend-verification', authMiddleware, adminMiddleware, resendVerificationEmail);
adminRouter.get('/analytics', authMiddleware, adminMiddleware, getAnalytics);
adminRouter.get('/report', authMiddleware, adminMiddleware, generateUserReport)

export default adminRouter;