import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import session from 'express-session';  // ← Added for Passport session support
import connectDB from './Servers/Config/db.js';
import errorHandler from './Servers/Middlewares/ErrorHandler.js';
import logger from './Servers/Utilities/Logger.js';
import AuthRouter from './Servers/Routes/AuthenticationRoutes.js';
import claimsRouter from './Servers/Routes/ClaimsRoutes.js';
import premiumRouter from './Servers/Routes/PremiumRoutes.js';
import contentRouter from './Servers/Routes/ContentRoutes.js';
import insuranceRouter from './Servers/Routes/InsuranceRoutes.js';
import adminRouter from './Servers/Routes/AdminAuthRoutes.js';
import adminInsuranceRouter from './Servers/Routes/AdminInsuranceRoutes.js';
import adminPremiumRouter from './Servers/Routes/AdminPremiumsRoutes.js';
import adminClaimsRouter from './Servers/Routes/AdminClaimsRoutes.js';
import adminContentRouter from './Servers/Routes/AdminContentRoutes.js';
import passport from './Servers/Config/passport.js';
import analyticsRouter from './Servers/Routes/AnalyticsRoutes.js';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();



// Core middleware (parsers first)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Sessions: REQUIRED for Passport OAuth (before Passport init)
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-session-secret',  // Use .env for prod
  resave: false,  // Don't save unmodified sessions
  saveUninitialized: true,  // Save empty sessions
  cookie: {
    secure: process.env.NODE_ENV === 'production',  // HTTPS only in prod
    maxAge: 24 * 60 * 60 * 1000  // 24 hours
  }
}));

// Connect to MongoDB
connectDB();

// Passport: AFTER sessions
app.use(passport.initialize());
app.use(passport.session());

// Log incoming requests (after middleware for full context)
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url} - User`);
  logger.info(`${req.method} ${req.url} - User`);
  next();
});

// API Routes (mounted after auth middleware)
app.use('/api/auth', AuthRouter);
app.use('/api/claims', claimsRouter);
app.use('/api/content', contentRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/premiums', premiumRouter);
app.use('/api/insurance', insuranceRouter);
app.use('/api/admin-auth/admin', adminRouter);
app.use('/api/admin-insurance/admin', adminInsuranceRouter);
app.use('/api/admin-premiums/admin', adminPremiumRouter);
app.use('/api/admin-claims/admin', adminClaimsRouter);
app.use('/api/admin-content/admin', adminContentRouter);

// Root route (health check with env info)
app.get('/', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Content Creators Insurance API', 
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

// 404 handler (before global error)
app.use((req, res, next) => {
  logger.warn(`404: ${req.method} ${req.url}`);
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global error handler (last)
app.use(errorHandler);

// Start the server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info(`Server running in ${process.env.NODE_ENV} mode on port ${PORT} (http://localhost:${PORT})`);
});

// Graceful shutdown handlers
process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled Rejection: ${err.message} | Stack: ${err.stack}`);
  server.close(() => process.exit(1));
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    logger.info('Process terminated.');
    process.exit(0);
  });
});