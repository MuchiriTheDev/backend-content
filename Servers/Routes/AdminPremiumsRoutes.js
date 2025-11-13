// routes/adminPremiumRoutes.js
import express from 'express';
import {
  bulkAdjustPremiums,
  sendPaymentReminders,
  auditPremiumsWithAI,
  getPremiumHistory,
  generatePremiumReport,
} from '../Controllers/AdminPremiumController.js';
import { adminMiddleware } from '../Middlewares/Admin.js';
import authMiddleware from '../Middlewares/Authenticator.js';

const adminPremiumRouter = express.Router();

adminPremiumRouter.post('/bulk-adjust', authMiddleware, adminMiddleware, bulkAdjustPremiums);
adminPremiumRouter.post('/reminders', authMiddleware, adminMiddleware, sendPaymentReminders);
adminPremiumRouter.post('/audit', authMiddleware, adminMiddleware, auditPremiumsWithAI);
adminPremiumRouter.get('/:id/history', authMiddleware, adminMiddleware, getPremiumHistory);
adminPremiumRouter.post('/report', authMiddleware, adminMiddleware, generatePremiumReport)

export default adminPremiumRouter;