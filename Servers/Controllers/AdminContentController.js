// controllers/adminClaimsController.js
import Claim from '../Models/Claim.js';
import User from '../Models/User.js';
import { sendEmail } from '../Services/EmailServices.js';
import logger from '../Utilities/Logger.js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

// Initialize Gemini AI
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) throw new Error('Gemini API key is not configured');
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: process.env.MODEL_GEMINI });

// @desc    Bulk review claims (Admin only)
// @route   POST /api/admin/claims/bulk-review
// @access  Private (Admin)
export const bulkReviewClaims = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { reviews } = req.body; // Array of { claimId, isValid, notes, payoutAmount }

    if (!Array.isArray(reviews) || reviews.length === 0) {
      logger.warn(`Invalid reviews array for admin ${adminId}`);
      return res.status(400).json({ success: false, error: 'Reviews array is required and cannot be empty' });
    }

    const results = [];
    for (const review of reviews) {
      const { claimId, isValid, notes, payoutAmount } = review;
      const claim = await Claim.findById(claimId);
      if (!claim) {
        results.push({ claimId, success: false, error: 'Claim not found' });
        continue;
      }

      if (typeof isValid !== 'boolean' || !notes) {
        results.push({ claimId, success: false, error: 'isValid and notes are required' });
        continue;
      }

      try {
        claim.evaluation.manualReview = { reviewerId: adminId, notes, isValid };
        claim.evaluation.payoutAmount = isValid ? Number(payoutAmount) || claim.evaluation.verifiedEarningsLoss : 0;
        claim.evaluation.evaluationDate = new Date();
        const newStatus = isValid ? 'Approved' : 'Rejected';
        await claim.updateStatus(newStatus, adminId, notes);

        const user = await User.findById(claim.claimDetails.userId);
        await sendEmail({
          to: user.personalInfo.email,
          subject: `Claim ${newStatus} - CCI`,
          text: `Your claim (ID: ${claimId}) has been ${newStatus.toLowerCase()}. ${notes}`,
        });

        results.push({ claimId, success: true, message: `Claim ${newStatus.toLowerCase()}` });
      } catch (error) {
        results.push({ claimId, success: false, error: error.message });
      }
    }

    logger.info(`Admin ${adminId} bulk reviewed ${reviews.length} claims`);
    res.json({
      success: true,
      message: 'Bulk claim reviews completed',
      data: results,
    });
  } catch (error) {
    logger.error(`Error in bulkReviewClaims: ${error.message}`);
    next(error);
  }
};

// @desc    Audit claims with AI (Admin only)
// @route   POST /api/admin/claims/audit
// @access  Private (Admin)
export const auditClaimsWithAI = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { claimIds } = req.body; // Array of claim IDs

    if (!Array.isArray(claimIds) || claimIds.length === 0) {
      logger.warn(`Invalid claimIds array for admin ${adminId}`);
      return res.status(400).json({ success: false, error: 'Claim IDs array is required and cannot be empty' });
    }

    const results = [];
    for (const claimId of claimIds) {
      const claim = await Claim.findById(claimId).populate('claimDetails.userId');
      if (!claim) {
        results.push({ claimId, success: false, error: 'Claim not found' });
        continue;
      }

      const evidenceData = claim.evidence.files.map(file => ({
        url: file.url,
        type: file.type,
        description: file.description,
      }));
      const affectedContentData = claim.evidence.affectedContent.map(content => ({
        url: content.url || 'Not posted',
        description: content.description,
        mediaType: content.mediaType,
      }));

      const prompt = `
        You are an AI assistant for Content Creators Insurance (CCI). Audit the following claim for potential fraud, inconsistencies, or anomalies. Provide insights to ensure claim validity and fairness.

        **Claim Details**:
        - Claim ID: ${claimId}
        - Platform: ${claim.claimDetails.platform}
        - Incident Type: ${claim.claimDetails.incidentType}
        - Reported Earnings Loss: ${claim.claimDetails.reportedEarningsLoss} ${claim.claimDetails.currency}
        - Evidence Summary: ${claim.evidence.evidenceSummary}
        - Evidence Files: ${JSON.stringify(evidenceData)}
        - Affected Content: ${JSON.stringify(affectedContentData)}
        - User Monthly Earnings: ${claim.claimDetails.userId.financialInfo.monthlyEarnings} ${claim.claimDetails.userId.financialInfo.currency}
        - Platform Risk History: ${JSON.stringify(claim.claimDetails.userId.platformInfo.platforms.flatMap(p => p.riskHistory))}

        **Instructions**:
        - Check for fraud indicators (e.g., inconsistent evidence, exaggerated losses).
        - Evaluate evidence quality (e.g., missing screenshots, unclear notifications).
        - Compare reported earnings loss to user’s monthly earnings.
        - Provide insights in JSON format:
        {
          "insights": [
            {
              "title": "Insight title",
              "description": "Detailed description of the insight",
              "action": "Recommended action to address issue"
            },
            ...
          ]
        }
      `;

      const result = await model.generateContent({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1500,
        },
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
          },
        ],
      });

      let aiInsights = { insights: [] };
      try {
        const rawResponse = result.response.text().replace(/```json\s*|\s*```/g, '').trim();
        aiInsights = JSON.parse(rawResponse);
      } catch (error) {
        logger.error(`Failed to parse AI insights for claim ${claimId}: ${error.message}`);
        aiInsights = {
          insights: [
            {
              title: 'Default Insight',
              description: 'Unable to generate AI insights due to an error.',
              action: 'Manually audit claim for fraud or inconsistencies.',
            },
          ],
        };
      }

      results.push({ claimId, success: true, insights: aiInsights.insights });
    }

    logger.info(`Admin ${adminId} audited ${claimIds.length} claims with AI`);
    res.json({
      success: true,
      message: 'Claim audit completed',
      data: results,
    });
  } catch (error) {
    logger.error(`Error in auditClaimsWithAI: ${error.message}`);
    next(error);
  }
};

// @desc    Get claim history (Admin only)
// @route   GET /api/admin/claims/:id/history
// @access  Private (Admin)
export const getClaimHistory = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { id } = req.params; // claimId

    const claim = await Claim.findById(id).populate('claimDetails.userId', 'personalInfo.email');
    if (!claim) {
      logger.error(`Claim not found: ${id}`);
      return res.status(404).json({ success: false, error: 'Claim not found' });
    }

    const history = {
      statusChanges: claim.statusHistory.history.map(h => ({
        status: h.status,
        date: h.date,
        notes: h.notes,
        updatedBy: h.updatedBy,
      })),
      evaluations: {
        aiAnalysis: claim.evaluation.aiAnalysis,
        manualReview: claim.evaluation.manualReview,
      },
      appeals: claim.evaluation.manualReview?.notes?.includes('Appeal submitted') ? [{ reason: claim.evaluation.manualReview.notes }] : [],
      evidenceUpdates: claim.evidence.files.map(f => ({ url: f.url, uploadedAt: f.uploadedAt })),
    };

    logger.info(`Admin ${adminId} retrieved history for claim ${id}`);
    res.json({
      success: true,
      data: {
        claimId: id,
        userId: claim.claimDetails.userId._id,
        userEmail: claim.claimDetails.userId.personalInfo.email,
        history,
      },
    });
  } catch (error) {
    logger.error(`Error in getClaimHistory: ${error.message}`);
    next(error);
  }
};

// @desc    Flag high-risk creators (Admin only)
// @route   GET /api/admin/claims/high-risk-creators
// @access  Private (Admin)
export const flagHighRiskCreators = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { startDate, endDate, minClaims = 3 } = req.query;

    const match = {};
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) match.createdAt.$lte = new Date(endDate);
    }

    const highRiskCreators = await Claim.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$claimDetails.userId',
          claimCount: { $sum: 1 },
          rejectedCount: { $sum: { $cond: [{ $eq: ['$statusHistory.history.status', 'Rejected'] }, 1, 0] } },
          totalPayout: { $sum: '$evaluation.payoutAmount' },
        },
      },
      {
        $match: { claimCount: { $gte: Number(minClaims) } },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
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
          platforms: '$user.platformInfo.platforms',
        },
      },
    ]);

    // AI-driven risk assessment
    const results = [];
    for (const creator of highRiskCreators) {
      const prompt = `
        You are an AI assistant for Content Creators Insurance (CCI). Assess the risk profile of a creator based on their claim history and platform data. Provide insights to mitigate risks or adjust their insurance terms.

        **Creator Data**:
        - User ID: ${creator.userId}
        - Claim Count: ${creator.claimCount}
        - Rejected Claims: ${creator.rejectedCount}
        - Total Payout (KES): ${creator.totalPayout}
        - Platforms: ${JSON.stringify(creator.platforms.map(p => ({ name: p.name, audienceSize: p.audienceSize })))}

        **Instructions**:
        - Evaluate risk based on claim frequency, rejection rate, and platform activity.
        - Suggest actions (e.g., content reviews, premium adjustments, account suspension).
        - Provide insights in JSON format:
        {
          "insights": [
            {
              "title": "Insight title",
              "description": "Detailed description of the insight",
              "action": "Recommended action to mitigate risk"
            },
            ...
          ]
        }
      `;

      const result = await model.generateContent({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1500,
        },
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
          },
        ],
      });

      let aiInsights = { insights: [] };
      try {
        const rawResponse = result.response.text().replace(/```json\s*|\s*```/g, '').trim();
        aiInsights = JSON.parse(rawResponse);
      } catch (error) {
        logger.error(`Failed to parse AI insights for creator ${creator.userId}: ${error.message}`);
        aiInsights = {
          insights: [
            {
              title: 'Default Insight',
              description: 'Unable to generate AI insights due to an error.',
              action: 'Manually review creator’s claim history for risk patterns.',
            },
          ],
        };
      }

      results.push({
        userId: creator.userId,
        email: creator.email,
        claimCount: creator.claimCount,
        rejectedCount: creator.rejectedCount,
        totalPayout: creator.totalPayout,
        platforms: creator.platforms,
        aiInsights,
      });
    }

    logger.info(`Admin ${adminId} flagged ${results.length} high-risk creators`);
    res.json({
      success: true,
      highRiskCreators: results,
    });
  } catch (error) {
    logger.error(`Error in flagHighRiskCreators: ${error.message}`);
    next(error);
  }
};