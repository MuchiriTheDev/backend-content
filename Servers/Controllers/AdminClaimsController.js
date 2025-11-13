// controllers/adminClaimsController.js
import Claim from '../Models/Claim.js';
import User from '../Models/User.js';
import Premium from '../Models/Premium.js';
import Analytics from '../Models/Analytics.js';
import { sendEmail } from '../Services/EmailServices.js';
import logger from '../Utilities/Logger.js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

// Initialize Gemini AI (for audit/insights; primary fraud in Claim model)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) throw new Error('Gemini API key is not configured');
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: process.env.MODEL_GEMINI });

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

// @desc    Get claim by ID (Admin only; full details)
// @route   GET /api/admin/claims/:id
// @access  Private (Admin)
export const getClaimById = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!req.user.role || req.user.role !== 'Admin') {
      logger.error(`Unauthorized access attempt by ${req.user.id} to claim ${id}`);
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const claim = await Claim.findById(id)
      .populate('claimDetails.userId', 'personalInfo.fullName personalInfo.email insuranceStatus')
      .populate('policyId', 'premiumDetails.finalAmount premiumDetails.monthlyCap')
      .lean();

    if (!claim) {
      return res.status(404).json({ success: false, error: 'Claim not found' });
    }

    // Enhance with analytics if available
    const analytics = await Analytics.findOne({ userId: claim.claimDetails.userId._id });
    const enhancedClaim = {
      ...claim,
      analyticsSummary: analytics ? {
        avgDailyRevenue90d: analytics.youtube.metrics.avgDailyRevenue90d,
        revenueVolatility: analytics.youtube.trends.revenueVolatility,
        riskAlerts: analytics.youtube.riskAlerts.length,
      } : null,
    };

    logger.info(`Admin ${req.user.id} retrieved claim ${id}`);
    res.json({ success: true, claim: enhancedClaim });
  } catch (error) {
    logger.error(`getClaimById error: ${error.message}`);
    next(error);
  }
};

// @desc    Bulk review claims (Admin only; for fraud 50-75 scores)
// @route   POST /api/admin/claims/bulk-review
// @access  Private (Admin)
export const bulkReviewClaims = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { reviews } = req.body; // Array of { claimId, isValid, notes }
    if (!Array.isArray(reviews) || reviews.length === 0) {
      logger.warn(`Invalid reviews array for admin ${adminId}`);
      return res.status(400).json({ success: false, error: 'Reviews array is required and cannot be empty' });
    }

    const results = [];
    for (const review of reviews) {
      const { claimId, isValid, notes } = review;
      if (!claimId || typeof isValid !== 'boolean' || !notes) {
        results.push({ claimId, success: false, error: 'claimId, isValid (boolean), and notes are required' });
        continue;
      }

      const claim = await Claim.findById(claimId).populate('claimDetails.userId');
      if (!claim) {
        results.push({ claimId, success: false, error: 'Claim not found' });
        continue;
      }

      // Ensure under manual review
      const currentStatus = claim.statusHistory.history[claim.statusHistory.history.length - 1].status;
      if (!['Under Review', 'Manual Review'].includes(currentStatus)) {
        results.push({ claimId, success: false, error: 'Claim not eligible for manual review' });
        continue;
      }

      try {
        // Set manual review
        claim.evaluation.manualReview = {
          reviewerId: adminId,
          notes,
          isValid,
        };

        let payout = 0;
        const newStatus = isValid ? 'Approved' : 'Rejected';
        if (isValid) {
          payout = await claim.calculatePayout();
          await claim.processPayout(payout);
        }

        const inAppMessage = isValid
          ? `Approved after review! KSh ${Math.round(payout)} incoming.`
          : 'Rejected after review.';
        await claim.updateStatus(newStatus, adminId, notes, inAppMessage);

        // Notify user
        const user = claim.claimDetails.userId;
        const emailMessage = `Your claim (ID: ${claimId}) has been ${newStatus.toLowerCase()}. ${notes}`;
        await sendEmail({
          to: user.personalInfo.email,
          subject: `Claim ${newStatus} - CCI`,
          text: emailMessage,
        });

        results.push({
          claimId,
          success: true,
          message: `Claim ${newStatus.toLowerCase()}`,
          payout: isValid ? payout : 0,
        });
      } catch (reviewError) {
        logger.error(`Bulk review error for claim ${claimId}: ${reviewError.message}`);
        results.push({ claimId, success: false, error: reviewError.message });
      }
    }

    logger.info(`Admin ${adminId} bulk reviewed ${reviews.length} claims: ${results.filter(r => r.success).length} successful`);
    res.json({
      success: true,
      message: 'Bulk claim reviews completed',
      data: results,
    });
  } catch (error) {
    logger.error(`bulkReviewClaims error: ${error.message}`);
    next(error);
  }
};

// @desc    Audit claims with AI (Admin only; enhance model's scanFraud)
// @route   POST /api/admin/claims/audit
// @access  Private (Admin)
export const auditClaimsWithAI = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { claimIds } = req.body; // Array of claim IDs
    if (!Array.isArray(claimIds) || claimIds.length === 0) {
      logger.warn(`Invalid claimIds array for admin ${adminId}`);
      return res.status(400).json({ success: false, error: 'Claim IDs array is required and cannot be empty' });
    }

    const results = [];
    for (const claimId of claimIds) {
      const claim = await Claim.findById(claimId)
        .populate('claimDetails.userId', 'personalInfo.email financialInfo.monthlyEarnings financialInfo.currency platformInfo.youtube')
        .populate('policyId', 'premiumDetails.monthlyCap');
      if (!claim) {
        logger.warn(`Claim not found: ${claimId} for admin ${adminId}`);
        results.push({ claimId, success: false, error: 'Claim not found' });
        continue;
      }

      if (!claim.claimDetails?.userId) {
        logger.warn(`User not found for claim ${claimId}`);
        results.push({ claimId, success: false, error: 'User not found for this claim' });
        continue;
      }

      // Leverage model's scanFraud first
      const fraudScore = await claim.scanFraud();
      claim.evaluation.aiAnalysis.fraudScore = fraudScore;
      await claim.save();

      // Gemini for deeper insights (e.g., evidence review)
      const evidenceData = claim.evidence.files.map(file => ({
        url: file.url,
        type: file.type,
        description: file.description,
      })).slice(0, 3);  // Limit for prompt

      const user = claim.claimDetails.userId;
      const monthlyEarnings = user.financialInfo?.monthlyEarnings ?? 0;
      const baselineDaily = claim.evaluation.baselineDaily || 0;
      const riskHistory = user.platformInfo?.youtube?.riskHistory || [];

      const prompt = `
        Audit CCI claim for fraud/anomalies. Fraud Score: ${fraudScore}. 
        Claim: Platform ${claim.claimDetails.platform}, Type ${claim.claimDetails.incidentType}, Drop ${claim.evaluation.revenueDropPercent}%, Lost Days ${claim.evaluation.lostDays}.
        Evidence: ${JSON.stringify(evidenceData)}.
        User: Earnings KSh ${monthlyEarnings}/mo, Baseline Daily KSh ${baselineDaily}, Risk History: ${JSON.stringify(riskHistory)}.
        Insights JSON: {"insights": [{"title": str, "description": str, "action": str, "severity": "low/medium/high"}]}
      `;

      let aiInsights = { insights: [] };
      try {
        const aiResult = await model.generateContent({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1000 },
          safetySettings,
        });
        const rawResponse = aiResult.response.text().replace(/```json\s*|\s*```/g, '').trim();
        aiInsights = JSON.parse(rawResponse);
      } catch (aiError) {
        logger.error(`AI audit failed for claim ${claimId}: ${aiError.message}`);
        aiInsights = {
          insights: [
            {
              title: 'AI Audit Error',
              description: 'Unable to generate detailed insights.',
              action: 'Review manually using fraud score.',
              severity: 'medium',
            },
          ],
        };
      }

      // Update claim with insights (append to reasons)
      claim.evaluation.aiAnalysis.reasons = [
        ...claim.evaluation.aiAnalysis.reasons,
        ...aiInsights.insights.map(i => `${i.title}: ${i.description}`),
      ];
      await claim.save();

      results.push({
        claimId,
        success: true,
        fraudScore,
        insights: aiInsights.insights,
      });
    }

    logger.info(`Admin ${adminId} audited ${claimIds.length} claims with AI`);
    res.json({
      success: true,
      message: 'Claim audit completed',
      data: results,
    });
  } catch (error) {
    logger.error(`auditClaimsWithAI error: ${error.message}`);
    next(error);
  }
};

// @desc    Get claim history (Admin only)
// @route   GET /api/admin/claims/:id/history
// @access  Private (Admin)
export const getClaimHistory = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { id } = req.params; // claimId
    const claim = await Claim.findById(id)
      .populate('claimDetails.userId', 'personalInfo.email insuranceStatus')
      .populate('policyId', 'premiumDetails.finalAmount');
    if (!claim) {
      logger.error(`Claim not found: ${id}`);
      return res.status(404).json({ success: false, error: 'Claim not found' });
    }

    const history = {
      statusChanges: claim.statusHistory.history.map(h => ({
        status: h.status,
        date: h.date,
        notes: h.notes,
        inAppMessage: h.inAppMessage,
        updatedBy: h.updatedBy,
      })),
      evaluations: {
        aiAnalysis: {
          fraudScore: claim.evaluation.aiAnalysis.fraudScore,
          isValid: claim.evaluation.aiAnalysis.isValid,
          confidenceScore: claim.evaluation.aiAnalysis.confidenceScore,
          reasons: claim.evaluation.aiAnalysis.reasons,  // Full for admin
        },
        manualReview: claim.evaluation.manualReview,
        revenueDropPercent: claim.evaluation.revenueDropPercent,
        lostDays: claim.evaluation.lostDays,
        baselineDaily: claim.evaluation.baselineDaily,
        payoutAmount: claim.evaluation.payoutAmount,
        coveredReason: claim.evaluation.coveredReason,
        doubleDipCheck: claim.evaluation.doubleDipCheck,
      },
      payouts: {
        mPesaTransactionId: claim.evaluation.mPesaTransactionId,
        payoutDate: claim.evaluation.payoutDate,
        repayAmount: claim.evaluation.repayAmount,
        reinstated: claim.evaluation.reinstated,
      },
      evidenceUpdates: claim.evidence.files.map(f => ({
        url: f.url,
        type: f.type,
        description: f.description,
        uploadedAt: f.uploadedAt,
      })),
    };

    logger.info(`Admin ${adminId} retrieved history for claim ${id}`);
    res.json({
      success: true,
      data: {
        claimId: id,
        userId: claim.claimDetails.userId._id,
        userEmail: claim.claimDetails.userId.personalInfo.email,
        policyCap: claim.policyId?.premiumDetails.monthlyCap || 65000,
        history,
      },
    });
  } catch (error) {
    logger.error(`getClaimHistory error: ${error.message}`);
    next(error);
  }
};

// @desc    Flag high-risk creators (Admin only; based on claims + analytics)
// @route   GET /api/admin/claims/high-risk-creators
// @access  Private (Admin)
export const flagHighRiskCreators = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { startDate, endDate, minClaims = 3, fraudThreshold = 50 } = req.query;

    const match = {};
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) match.createdAt.$lte = new Date(endDate);
    }

    const highRiskAggregation = await Claim.aggregate([
      { $match: { ...match, 'evaluation.aiAnalysis.fraudScore': { $lt: fraudThreshold } } },  // Low fraud scores
      {
        $group: {
          _id: '$claimDetails.userId',
          claimCount: { $sum: 1 },
          rejectedCount: { $sum: { $cond: [{ $eq: ['$statusHistory.history.status', 'Rejected'] }, 1, 0] } },
          totalPayout: { $sum: '$evaluation.payoutAmount' },
          avgFraudScore: { $avg: '$evaluation.aiAnalysis.fraudScore' },
        },
      },
      { $match: { claimCount: { $gte: Number(minClaims) } } },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
          pipeline: [
            { $lookup: { from: 'analytics', localField: '_id', foreignField: 'userId', as: 'analytics' } },
            { $unwind: { path: '$analytics', preserveNullAndEmptyArrays: true } },
          ],
        },
      },
      { $unwind: '$user' },
      {
        $project: {
          userId: '$_id',
          email: '$user.personalInfo.email',
          claimCount: 1,
          rejectedCount: 1,
          totalPayout: 1,
          avgFraudScore: 1,
          platforms: '$user.platformInfo.youtube',
          revenueVolatility: '$user.analytics.youtube.trends.revenueVolatility',
          riskAlertsCount: { $size: '$user.analytics.youtube.riskAlerts' },
        },
      },
    ]);

    // AI-driven risk assessment
    const results = [];
    for (const creator of highRiskAggregation) {
      const prompt = `
        Assess CCI creator risk. User ID: ${creator.userId}, Claims: ${creator.claimCount}, Rejects: ${creator.rejectedCount}, Payouts KSh ${creator.totalPayout}, Avg Fraud: ${creator.avgFraudScore}.
        Platforms: ${JSON.stringify(creator.platforms)}, Volatility: ${creator.revenueVolatility}%, Alerts: ${creator.riskAlertsCount}.
        Insights JSON: {"insights": [{"title": str, "description": str, "action": str, "severity": "low/medium/high"}]}
      `;

      let aiInsights = { insights: [] };
      try {
        const result = await model.generateContent({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 800 },
          safetySettings,
        });
        const rawResponse = result.response.text().replace(/```json\s*|\s*```/g, '').trim();
        aiInsights = JSON.parse(rawResponse);
      } catch (aiError) {
        logger.error(`AI risk assessment failed for creator ${creator.userId}: ${aiError.message}`);
        aiInsights = {
          insights: [
            {
              title: 'AI Assessment Error',
              description: 'Unable to generate risk insights.',
              action: 'Manual review based on claim count and fraud scores.',
              severity: 'medium',
            },
          ],
        };
      }

      results.push({
        ...creator,
        aiInsights: aiInsights.insights,
      });
    }

    logger.info(`Admin ${adminId} flagged ${results.length} high-risk creators`);
    res.json({
      success: true,
      highRiskCreators: results,
    });
  } catch (error) {
    logger.error(`flagHighRiskCreators error: ${error.message}`);
    next(error);
  }
};