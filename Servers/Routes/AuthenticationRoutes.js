// routes/auth.js
import express from 'express';
import passport from 'passport';
import { 
  completeOnboarding, 
  forgotPassword, 
  getUserProfile, 
  handleYouTubeCallback, 
  resetPassword, 
  startYouTubeAuth, 
  verifyEmail 
} from '../Controllers/AuthenticationController.js';
import authMiddleware from '../Middlewares/Authenticator.js';

const AuthRouter = express.Router();

// Public OAuth Routes (YouTube-first auth)
AuthRouter.get('/youtube', startYouTubeAuth);
// @desc    Start YouTube OAuth flow
// @route   GET /api/auth/youtube
// @access  Public
// Redirects to Google consent; pulls channel data on callback

AuthRouter.get('/youtube/callback', 
  passport.authenticate('google', { failureRedirect: 'http://localhost:5173/login' }),
  handleYouTubeCallback
);
// @desc    YouTube OAuth callback
// @route   GET /api/auth/youtube/callback
// @access  Public (via OAuth)
// Saves/pulls YouTube data, generates JWT, redirects to dashboard with ?onboard=true if new

// Fallback Email Routes (for edge cases, e.g., password recovery)
// AuthRouter.post('/register', registerUser);  // Keep as fallback if needed
// @desc    Register a new user (email/password fallback)
// @route   POST /api/auth/register
// @access  Public
// Payload: { firstName, lastName, email, password, phoneNumber, country, platforms }

// AuthRouter.post('/login', loginUser);  // Keep as fallback if needed
// @desc    Login user and return JWT (email/password fallback)
// @route   POST /api/auth/login
// @access  Public
// Payload: { email, password }

AuthRouter.get('/verify/:token', verifyEmail);
// @desc    Verify user email with token (fallback)
// @route   GET /api/auth/verify/:token
// @access  Public

AuthRouter.post('/forgot-password', forgotPassword);
// @desc    Request password reset link (fallback)
// @route   POST /api/auth/forgot-password
// @access  Public
// Payload: { email }

AuthRouter.post('/reset-password/:token', resetPassword);
// @desc    Reset password with token (fallback)
// @route   POST /api/auth/reset-password/:token
// @access  Public
// Payload: { password }

// Post-OAuth Onboarding Route
AuthRouter.post('/onboard', authMiddleware, completeOnboarding);
// @desc    Complete onboarding form after YouTube auth
// @route   POST /api/auth/onboard
// @access  Private (requires OAuth JWT)
// Payload: { phoneNumber, dateOfBirth, monthlyEarnings, contentType, niche, riskLevel }

// Protected Routes (require JWT from OAuth)
AuthRouter.get('/me', authMiddleware, getUserProfile);
// @desc    Get current user's profile (post-onboard)
// @route   GET /api/auth/me
// @access  Private
// Headers: Authorization: Bearer <token>

export default AuthRouter;