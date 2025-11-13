// routes/insurance.js
import express from 'express';
import {
  applyForInsurance,
  reviewInsuranceApplication,
  getInsuranceStatus,
  getAllInsuranceContracts,
  getMyInsurance,
  addPlatform, // NEW: Imported new controller function
  editInsuranceApplication,
  getInsuranceAnalytics, // NEW: Imported new controller function
} from '../Controllers/InsuranceController.js'; // Adjusted path to match your structure
import authMiddleware from '../Middlewares/Authenticator.js';
import { adminMiddleware } from '../Middlewares/Admin.js';



const insuranceRouter = express.Router();

// Apply for insurance or save application progress
insuranceRouter.post('/apply', authMiddleware, applyForInsurance);
// Get insurance application status
insuranceRouter.get('/status', authMiddleware, getInsuranceStatus);
// Get user's specific insurance details (Creator)
insuranceRouter.get('/my-insurance', authMiddleware, getMyInsurance);
// NEW: Add a new platform to a pending application (Creator)
insuranceRouter.post('/add-platform', authMiddleware, addPlatform);
// NEW: Edit a pending insurance application (Creator)
insuranceRouter.put('/edit', authMiddleware, editInsuranceApplication);


// Admin review of insurance application (approve/reject)
insuranceRouter.post('/admin/review', authMiddleware, adminMiddleware, reviewInsuranceApplication);
// Get all insurance contracts (Admin)
insuranceRouter.get('/admin/contracts', authMiddleware, adminMiddleware, getAllInsuranceContracts);
// Get all insurance analytics (Admin)
insuranceRouter.get('/admin/analytics', authMiddleware, adminMiddleware, getInsuranceAnalytics);

export default insuranceRouter;