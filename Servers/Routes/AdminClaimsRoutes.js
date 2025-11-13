// routes/adminClaimsRoutes.js
// Specialized admin claim tools (bulk, audit, history, risk flagging)
// Import specialized admin controllers
import express from 'express';
import {
  bulkReviewClaims,
  auditClaimsWithAI,
  getClaimHistory,
  flagHighRiskCreators,
  getClaimById,  // Admin-specific full view
} from '../Controllers/AdminClaimsController.js';
import authMiddleware from '../Middlewares/Authenticator.js';
import { adminMiddleware } from '../Middlewares/Admin.js';

const adminClaimsRouter = express.Router();

// Specialized Admin Routes (Private: Auth + Admin required)
adminClaimsRouter.post('/bulk-review', authMiddleware, adminMiddleware, bulkReviewClaims);  // Array-based reviews
adminClaimsRouter.post('/audit', authMiddleware, adminMiddleware, auditClaimsWithAI);  // AI deep audit on claimIds
adminClaimsRouter.get('/:id/history', authMiddleware, adminMiddleware, getClaimHistory);  // Full audit trail
adminClaimsRouter.get('/high-risk-creators', authMiddleware, adminMiddleware, flagHighRiskCreators);  // Risk profiling
adminClaimsRouter.get('/:id', authMiddleware, adminMiddleware, getClaimById);  // Admin full claim view (enhanced)

export default adminClaimsRouter;