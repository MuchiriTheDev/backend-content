import express from 'express';
import {
  estimatePremium,
  calculatePremium,
  getMyPremium,
  payPremium,
  applyContentReviewDiscount,
  getAllPremiums,
  getOverduePremiums,
  adjustPremium,
  getPremiumAnalytics,
  retryPayment,
  getPremiumByUserId,
} from '../Controllers/PremiumController.js';
import authMiddleware from '../Middlewares/Authenticator.js';
import { adminMiddleware } from '../Middlewares/Admin.js';

const premiumRouter = express.Router();

// Middleware to restrict access to admins only


// Creator Routes (Private)
premiumRouter.post('/estimate', authMiddleware, estimatePremium);
premiumRouter.get('/my-premium', authMiddleware, getMyPremium);
premiumRouter.post('/pay', authMiddleware, payPremium);
premiumRouter.put('/discount', authMiddleware, applyContentReviewDiscount);
premiumRouter.post('/retry-payment', authMiddleware, retryPayment);

// Admin Routes (Private)
premiumRouter.post('/calculate', authMiddleware, adminMiddleware, calculatePremium);
premiumRouter.get('/admin/all', authMiddleware, adminMiddleware, getAllPremiums);
premiumRouter.get('/overdue', authMiddleware, adminMiddleware, getOverduePremiums);
premiumRouter.put('/admin/:id/adjust', authMiddleware, adminMiddleware, adjustPremium);
premiumRouter.get('admin/:userId/premium', authMiddleware, adminMiddleware, getPremiumByUserId);
premiumRouter.get('/admin/analytics', authMiddleware, adminMiddleware, getPremiumAnalytics);

export default premiumRouter; 