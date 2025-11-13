// routes/claims.js
// Creator and general claim routes (submit, track, basic process)
// Import creator/general controllers
import express from 'express';
import { 
  // Creator routes
  submitClaim, 
  getMyClaims, 
  getClaimById,  // Shared, with role check
  updateClaimEvidence, 
  submitAppeal, 
  deleteClaim, 
  // General admin (non-bulk/specialized)
  evaluateClaimAI, 
  reviewClaimManual, 
  getAllClaims, 
  getPendingDeadlineClaims, 
  getClaimAnalytics, 
  generateClaimReport, 
  // Middleware
  uploadClaimFiles 
} from '../Controllers/ClaimsController.js';
import authMiddleware from '../Middlewares/Authenticator.js';
import { adminMiddleware } from '../Middlewares/Admin.js';

const claimsRouter = express.Router();

// Creator Routes (Private: Auth required, no admin needed)
claimsRouter.post('/submit', authMiddleware, uploadClaimFiles, submitClaim);  // CCI: 4 fields + optional evidence
claimsRouter.get('/my-claims', authMiddleware, getMyClaims);  // Paginated list for creator
claimsRouter.get('/:id', authMiddleware, getClaimById);  // Single claim (internal role check for access)
claimsRouter.put('/:id/evidence', authMiddleware, uploadClaimFiles, updateClaimEvidence);  // Pre-review updates
claimsRouter.post('/:id/appeal', authMiddleware, uploadClaimFiles, submitAppeal);  // Re-process rejected
claimsRouter.delete('/:id', authMiddleware, deleteClaim);  // Pre-processing deletion only

// Admin/General Routes (Private: Auth + Admin for oversight)
claimsRouter.post('/admin/:id/evaluate-ai', authMiddleware, adminMiddleware, evaluateClaimAI);  // AI fraud enhancement
claimsRouter.post('/admin/:id/review-manual', authMiddleware, adminMiddleware, reviewClaimManual);  // Manual for edge cases
claimsRouter.get('/admin/all', authMiddleware, adminMiddleware, getAllClaims);  // Paginated admin dashboard
claimsRouter.get('/admin/pending-deadline', authMiddleware, adminMiddleware, getPendingDeadlineClaims);  // SLA monitoring
claimsRouter.get('/admin/analytics', authMiddleware, adminMiddleware, getClaimAnalytics);  // Stats + insights
claimsRouter.get('/admin/report', authMiddleware, adminMiddleware, generateClaimReport);  // Export reports

export default claimsRouter;