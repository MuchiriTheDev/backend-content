// routes/analytics.js
import express from 'express';
import {
  getYouTubeAnalyticsReport,
  getUserVideos,
  getVideoDetails,     // ← NEW: Added
  getAnalyticsTrends
} from '../Controllers/AnalyticsController.js';
import authMiddleware from '../Middlewares/Authenticator.js';

const analyticsRouter = express.Router();

/**
 * @route   GET /api/analytics/youtube-report
 * @desc    Fetch comprehensive YouTube analytics report with AI insights
 * @access  Private
 */
analyticsRouter.get('/youtube-report', authMiddleware, getYouTubeAnalyticsReport);

/**
 * @route   GET /api/analytics/videos
 * @desc    Fetch all videos with stats + up to 100 comments each
 * @access  Private
 */
analyticsRouter.get('/videos', authMiddleware, getUserVideos);

/**
 * @route   GET /api/analytics/video/:videoId
 * @desc    Fetch single video + full AI comment analysis (sentiment + niche fit)
 * @access  Private
 */
analyticsRouter.get('/video/:videoId', authMiddleware, getVideoDetails);

/**
 * @route   GET /api/analytics/trends
 * @desc    Get historical earnings/views trends for charts
 * @access  Private
 */
analyticsRouter.get('/trends', authMiddleware, getAnalyticsTrends);

export default analyticsRouter;