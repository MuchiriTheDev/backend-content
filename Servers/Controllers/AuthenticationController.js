// controllers/authController.js
import jwt from 'jsonwebtoken';
import User from '../Models/User.js';
import Analytics from '../Models/Analytics.js';  // Import for post-onboard update
import { sendPasswordResetEmail, sendVerificationEmail } from '../Services/EmailServices.js';
import logger from '../Utilities/Logger.js';
import passport from '../Config/passport.js';

// @desc    YouTube OAuth callback handler (internal, called by Passport)
// @route   GET /api/auth/youtube/callback (handled in routes)
// @access  Public (via OAuth)
export const handleYouTubeCallback = async (req, res) => {
  try {
    const userData = req.user;  // From Passport: { id, token, youtubeId }
    const token = userData.token;
    const login = userData.login;

    logger.info(`OAuth callback successful for user ID: ${userData.id}, YouTube ID: ${userData.youtubeId}, Login: ${login}`);

    // Check if onboarded; redirect accordingly
    const user = await User.findById(userData.id);
    if (!user) {
      return res.status(400).json({ success: false, error: 'User not found after auth' });
    }

    const query = user.onboarded ? 'dashboard' : 'onboard';
    const redirectUrl = `${process.env.FRONTEND_URL}${query}?token=${token}`;
    console.log(`Redirecting to: ${redirectUrl}`);
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error(`OAuth callback error: ${error.message}`);
    res.redirect(`http://localhost:5173/login?error=${error.message}`);
  }
};

// @desc    Start YouTube OAuth (simple redirect handler)
// @route   GET /api/auth/youtube
// @access  Public
export const startYouTubeAuth = (req, res, next) => {
  passport.authenticate('google', {
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/youtube.readonly']
  })(req, res, next);
};

// @desc    Complete onboarding after YouTube auth
// @route   POST /api/auth/onboard
// @access  Private (requires JWT from OAuth)
export const completeOnboarding = async (req, res) => {
  try {
    const { phoneNumber, dateOfBirth, contentType } = req.body;
    const user = await User.findById(req.user.userId);

    if (user.onboarded) {
      return res.status(400).json({ success: false, error: 'Already onboarded' });
    }

    // Validate required fields (light for analytics; no manual earnings/risk)
    if (!phoneNumber || !contentType) {
      return res.status(400).json({ success: false, error: 'Phone and content type (niche) required' });
    }

    // Update user (align with schema: personalInfo, platformInfo.youtube.contentType, financialInfo.paymentMethod)
    user.personalInfo.phoneNumber = phoneNumber;
    user.personalInfo.dateOfBirth = dateOfBirth || null;
    user.platformInfo.youtube.contentType = contentType;  // Niche enum-validated in schema
    user.financialInfo.paymentMethod.details.mobileNumber = phoneNumber;  // M-Pesa reuse
    // App terms consent (general, not insurance-specific)
    user.insuranceStatus.termsAndAccuracy.hasAgreedToTerms = true;  // For app T&Cs
    user.insuranceStatus.termsAndAccuracy.termsAgreedAt = new Date();
    user.applicationProgress.step = 'Onboarded';  // Align with enum
    user.onboarded = true;
    user.isVerified = true;  // Auto-verify via OAuth

    await user.save();

    // Post-onboard: Trigger Analytics creation/update for auto-earnings
    let analytics = await Analytics.findOne({ userId: user._id });
    if (!analytics) {
      analytics = new Analytics({ userId: user._id });
      await analytics.save();
    }
    // Refresh metrics (stubbed/real API in method)
    await analytics.updateFromYouTube(user.platformInfo.youtube.accessToken);
    // Link back to user
    user.financialInfo.analyticsId = analytics._id;
    await user.save();

    logger.info(`Onboarding complete for: ${user.platformInfo.youtube.username}`);
    res.json({ 
      success: true, 
      message: 'Onboarding complete! Welcome to CCI.',
      user: { 
        id: user._id, 
        youtubeId: user.platformInfo.youtube.id,
        channelTitle: user.platformInfo.youtube.channel.title,
        subscriberCount: user.platformInfo.youtube.channel.subscriberCount,
        estimatedMonthlyEarnings: user.financialInfo.monthlyEarnings,  // Auto-set from Analytics
        niche: user.platformInfo.youtube.contentType  // For dashboard
      } 
    });
  } catch (error) {
    logger.error(`Onboarding error: ${error.message}`);
    res.status(400).json({ success: false, error: error.message });
  }
};

// @desc    Get current user profile (post-auth/onboard)
// @route   GET /api/auth/me
// @access  Private
export const getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-auth.password');
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (!user.onboarded) {
      return res.status(403).json({ success: false, error: 'Complete onboarding first' });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        personalInfo: user.personalInfo,
        platformInfo: user.platformInfo,
        financialInfo: user.financialInfo,  // Includes auto-earnings from Analytics
        claimHistory: user.claimHistory,
        insuranceStatus: user.insuranceStatus,
        applicationProgress: user.applicationProgress,
        role: user.role,
        isVerified: user.isVerified,
        onboarded: user.onboarded
      }
    });
  } catch (error) {
    logger.error(`Profile fetch error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// @desc    Fallback: Forgot password (email-based, for edge cases)
// @route   POST /api/auth/forgot-password
// @access  Public
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const user = await User.findOne({ 'personalInfo.email': email });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Generate reset token
    const resetToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    user.auth.resetPasswordToken = resetToken;
    user.auth.resetPasswordExpire = Date.now() + 3600000; // 1 hour
    await user.save();

    // Send reset email
    const resetLink = `https://cci-theta.vercel.app/reset-password/${resetToken}`;
    await sendPasswordResetEmail(email, resetToken);

    logger.info(`Password reset requested for: ${email}`);
    res.json({ success: true, message: 'Password reset link sent to email' });
  } catch (error) {
    logger.error(`Forgot password error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// @desc    Fallback: Reset password
// @route   POST /api/auth/reset-password/:token
// @access  Public
export const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ success: false, error: 'New password is required' });
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ success: false, error: 'Token expired' });
      }
      throw error;
    }

    const user = await User.findById(decoded.id).select('+auth.password');
    if (!user || user.auth.resetPasswordToken !== token || user.auth.resetPasswordExpire < Date.now()) {
      return res.status(400).json({ success: false, error: 'Invalid or expired reset token' });
    }

    // Update password (fallback only; hash in pre-save)
    user.auth.password = password;
    user.auth.resetPasswordToken = undefined;
    user.auth.resetPasswordExpire = undefined;
    await user.save();

    logger.info(`Password reset for: ${user.personalInfo.email}`);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    logger.error(`Reset password error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// @desc    Fallback: Verify email (if email used)
// @route   GET /api/auth/verify/:token
// @access  Public
export const verifyEmail = async (req, res) => {
  try {
    const { token } = req.params;

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }

    if (user.isVerified) {
      return res.status(400).json({ success: false, error: 'Email already verified' });
    }

    user.isVerified = true;
    await user.save();

    logger.info(`Email verified for: ${user.personalInfo.email}`);
    res.json({ success: true, message: 'Email verified successfully' });
  } catch (error) {
    logger.error(`Verify email error: ${error.message}`);
    res.status(400).json({ success: false, error: 'Invalid token' });
  }
};