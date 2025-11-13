// routes/adminInsuranceRoutes.js
import express from 'express';
import {
  bulkReviewApplications,
  manageContractRenewals,
  getContractById,
  analyzeContract,
  updateContract,
  terminateContract,
  getContractHistory,
} from '../Controllers/AdminInsuranceController.js';
import authMiddleware from '../Middlewares/Authenticator.js';
import { adminMiddleware } from '../Middlewares/Admin.js';
import { generateUserReport } from '../Controllers/AdminAuthController.js';

const adminInsuranceRouter = express.Router();

adminInsuranceRouter.post('/bulk-review', authMiddleware, adminMiddleware, bulkReviewApplications);
adminInsuranceRouter.post('/renewals', authMiddleware, adminMiddleware, manageContractRenewals);
adminInsuranceRouter.get('/contract/:id', authMiddleware, adminMiddleware, getContractById);
adminInsuranceRouter.post('/contract/:id/analyze', authMiddleware, adminMiddleware, analyzeContract);
adminInsuranceRouter.put('/contract/:id', authMiddleware, adminMiddleware, updateContract);
adminInsuranceRouter.post('/contract/:id/terminate', authMiddleware, adminMiddleware, terminateContract);
adminInsuranceRouter.get('/contract/:id/history', authMiddleware, adminMiddleware, getContractHistory);
adminInsuranceRouter.get('/report', authMiddleware, adminMiddleware, generateUserReport);

export default adminInsuranceRouter;