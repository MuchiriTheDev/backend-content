// routes/adminClaimsRoutes.js
import express from 'express';
import {
  bulkReviewClaims,
  auditClaimsWithAI,
  getClaimHistory,
  flagHighRiskCreators,
} from '../Controllers/AdminClaimsController.js';
import { adminMiddleware } from '../Middlewares/Admin.js';
import authMiddleware from '../Middlewares/Authenticator.js';

const adminContentRouter = express.Router();

adminContentRouter.post('/bulk-review', authMiddleware, adminMiddleware, bulkReviewClaims);
adminContentRouter.post('/audit', authMiddleware, adminMiddleware, auditClaimsWithAI);
adminContentRouter.get('/:id/history', authMiddleware, adminMiddleware, getClaimHistory);
adminContentRouter.get('/high-risk-creators', authMiddleware, adminMiddleware, flagHighRiskCreators);

export default adminContentRouter;