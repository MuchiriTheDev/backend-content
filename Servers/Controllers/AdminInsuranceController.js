// controllers/adminInsuranceController.js
import User from '../Models/User.js';
import Premium from '../Models/Premium.js';
import Claim from '../Models/Claim.js';
import Content from '../Models/Content.js';
import { sendEmail } from '../Services/EmailServices.js';
import logger from '../Utilities/Logger.js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

// @desc    Bulk review insurance applications
// @route   POST /api/admin/insurance/bulk-review
// @access  Private (Admin)
export const bulkReviewApplications = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { reviews } = req.body; // Array of { userId, action, rejectionReason }

    if (!Array.isArray(reviews) || reviews.length === 0) {
      return res.status(400).json({ success: false, error: 'Reviews array is required and cannot be empty' });
    }

    const results = [];
    for (const review of reviews) {
      const { userId, action, rejectionReason } = review;
      const user = await User.findById(userId);
      if (!user || user.role !== 'Creator' || user.insuranceStatus.status !== 'Pending') {
        results.push({ userId, success: false, error: 'Invalid user or non-pending application' });
        continue;
      }

      if (action === 'approve') {
        let premium = await Premium.findOne({ 'premiumDetails.userId': userId });
        if (!premium) {
          premium = new Premium({
            premiumDetails: {
              userId,
              basePercentage: 2,
              currency: 'KES',
              adjustmentFactors: {},
              finalPercentage: 2,
              finalAmount: Math.max((2 / 100) * (user.financialInfo.monthlyEarnings || 0), 100),
            },
            paymentStatus: { status: 'Pending' },
          });
        }
        await premium.recalculatePremium(adminId);
        await premium.save();

        const coveragePeriod = user.insuranceStatus.coveragePeriod;
        const policyStartDate = new Date();
        const policyEndDate = new Date(policyStartDate.getTime() + coveragePeriod * 30 * 24 * 60 * 60 * 1000);

        user.insuranceStatus = {
          ...user.insuranceStatus,
          status: 'Approved',
          approvedAt: new Date(),
          policyStartDate,
          policyEndDate,
        };
        user.financialInfo.premium = {
          percentage: premium.premiumDetails.finalPercentage,
          amount: premium.premiumDetails.finalAmount,
          lastCalculated: new Date(),
          discountApplied: premium.premiumDetails.discount.percentage > 0,
          insuranceId: premium._id,
        };
        user.applicationProgress = { step: 'Completed', lastUpdated: new Date() };
        await user.save();

        await sendEmail({
          to: user.personalInfo.email,
          subject: 'CCI Insurance Application Approved',
          text: `Dear ${user.personalInfo.firstName},\n\nYour application has been approved! Coverage: ${coveragePeriod} months, Premium: KES ${premium.premiumDetails.finalAmount}.`,
          html: `<p>Dear ${user.personalInfo.firstName},</p><p>Your application has been approved! Coverage: ${coveragePeriod} months, Premium: KES ${premium.premiumDetails.finalAmount}.</p>`,
        });

        results.push({ userId, success: true, message: 'Application approved' });
      } else if (action === 'reject') {
        if (!rejectionReason) {
          results.push({ userId, success: false, error: 'Rejection reason required' });
          continue;
        }
        user.insuranceStatus = {
          ...user.insuranceStatus,
          status: 'Rejected',
          rejectionReason,
        };
        user.applicationProgress = { step: 'Completed', lastUpdated: new Date() };
        await user.save();
        await Premium.deleteOne({ 'premiumDetails.userId': userId });

        await sendEmail({
          to: user.personalInfo.email,
          subject: 'CCI Insurance Application Rejected',
          text: `Dear ${user.personalInfo.firstName},\n\nYour application was rejected. Reason: ${rejectionReason}.`,
          html: `<p>Dear ${user.personalInfo.firstName},</p><p>Your application was rejected. Reason: ${rejectionReason}.</p>`,
        });

        results.push({ userId, success: true, message: 'Application rejected' });
      } else {
        results.push({ userId, success: false, error: 'Invalid action' });
      }
    }

    logger.info(`Admin ${adminId} bulk reviewed ${reviews.length} applications`);
    res.json({
      success: true,
      message: 'Bulk review completed',
      data: results,
    });
  } catch (error) {
    logger.error(`Error in bulkReviewApplications: ${error.message}`);
    next(error);
  }
};

// @desc    Manage contract renewals
// @route   POST /api/admin/insurance/renewals
// @access  Private (Admin)
export const manageContractRenewals = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { userIds, action } = req.body; // action: 'remind' or 'renew'

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, error: 'User IDs array is required' });
    }

    const results = [];
    for (const userId of userIds) {
      const user = await User.findById(userId);
      if (!user || user.insuranceStatus.status !== 'Approved') {
        results.push({ userId, success: false, error: 'Invalid user or no active contract' });
        continue;
      }

      if (action === 'remind') {
        user.insuranceStatus.renewalRemindedAt = new Date();
        await user.save();
        await sendEmail({
          to: user.personalInfo.email,
          subject: 'CCI Insurance Renewal Reminder',
          text: `Dear ${user.personalInfo.firstName},\n\nYour insurance contract is nearing its end date (${user.insuranceStatus.policyEndDate.toDateString()}). Please renew to continue coverage.`,
          html: `<p>Dear ${user.personalInfo.firstName},</p><p>Your contract ends on ${user.insuranceStatus.policyEndDate.toDateString()}. Please renew to continue coverage.</p>`,
        });
        results.push({ userId, success: true, message: 'Renewal reminder sent' });
      } else if (action === 'renew') {
        const coveragePeriod = user.insuranceStatus.coveragePeriod;
        const newEndDate = new Date(
          user.insuranceStatus.policyEndDate.getTime() + coveragePeriod * 30 * 24 * 60 * 60 * 1000
        );
        user.insuranceStatus.policyEndDate = newEndDate;
        user.insuranceStatus.lastRenewedAt = new Date();
        user.insuranceStatus.renewalRemindedAt = null;
        await user.save();

        const premium = await Premium.findOne({ 'premiumDetails.userId': userId });
        if (premium) {
          await premium.recalculatePremium(adminId);
          await premium.save();
        }

        await sendEmail({
          to: user.personalInfo.email,
          subject: 'CCI Insurance Contract Renewed',
          text: `Dear ${user.personalInfo.firstName},\n\nYour contract has been renewed until ${newEndDate.toDateString()}.`,
          html: `<p>Dear ${user.personalInfo.firstName},</p><p>Your contract has been renewed until ${newEndDate.toDateString()}.</p>`,
        });
        results.push({ userId, success: true, message: 'Contract renewed' });
      } else {
        results.push({ userId, success: false, error: 'Invalid action' });
      }
    }

    logger.info(`Admin ${adminId} managed renewals for ${userIds.length} contracts`);
    res.json({
      success: true,
      message: 'Contract renewals processed',
      data: results,
    });
  } catch (error) {
    logger.error(`Error in manageContractRenewals: ${error.message}`);
    next(error);
  }
};

// @desc    Get contract by ID
// @route   GET /api/admin/insurance/contract/:id
// @access  Private (Admin)
export const getContractById = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { id } = req.params; // userId of the contract

    const admin = await User.findById(adminId);
    if (!admin || admin.role !== 'Admin') {
      logger.error(`Unauthorized access attempt by user ${adminId} to contract ${id}`);
      return res.status(403).json({ success: false, error: 'Unauthorized: Admin access required' });
    }

    const user = await User.findById(id).select(
      'personalInfo insuranceStatus platformInfo role financialInfo applicationProgress'
    );
    console.log(user)
    if (!user || user.role !== 'Creator') {
      logger.error(`Contract not found for user ${id}`);
      return res.status(404).json({ success: false, error: 'Contract or user not found' });
    }

    const premium = await Premium.findOne({ 'premiumDetails.userId': id });
    const claims = await Claim.find({ 'claimDetails.userId': id }).select(
      'claimDetails.incidentType statusHistory evaluation'
    );
    const contentReviews = await Content.find({ 'contentDetails.userId': id }).select(
      'contentDetails.platform riskAssessment'
    );

    logger.info(`Admin ${adminId} retrieved contract for user ${id}`);
    res.json({
      success: true,
      data: {
        userId: user._id,
        personalInfo: user.personalInfo,
        insuranceStatus: user.insuranceStatus,
        platformInfo: user.platformInfo,
        financialInfo: user.financialInfo,
        premium: premium ? premium.premiumDetails : null,
        claims: claims.map((claim) => ({
          id: claim._id,
          incidentType: claim.claimDetails.incidentType,
          status: claim.statusHistory.history[claim.statusHistory.history.length - 1].status,
          payoutAmount: claim.evaluation?.payoutAmount || 0,
        })),
        contentReviews: contentReviews.map((content) => ({
          platform: content.contentDetails.platform,
          riskLevel: content.riskAssessment.riskLevel,
          lastAssessed: content.riskAssessment.lastAssessed,
        })),
        applicationProgress: user.applicationProgress,
      },
    });
  } catch (error) {
    logger.error(`Error in getContractById for contract ${req.params.id}: ${error.message}`);
    next(error);
  }
};

// @desc    Analyze contract with AI insights
// @route   POST /api/admin/insurance/contract/:id/analyze
// @access  Private (Admin)
export const analyzeContract = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { id } = req.params; // userId of the contract

    const admin = await User.findById(adminId);
    if (!admin || admin.role !== 'Admin') {
      logger.error(`Unauthorized analysis attempt by user ${adminId} for contract ${id}`);
      return res.status(403).json({ success: false, error: 'Unauthorized: Admin access required' });
    }

    const user = await User.findById(id);
    if (!user || user.role !== 'Creator') {
      logger.error(`Contract not found for user ${id}`);
      return res.status(404).json({ success: false, error: 'Contract or user not found' });
    }

    const premium = await Premium.findOne({ 'premiumDetails.userId': id });
    const claims = await Claim.find({ 'claimDetails.userId': id });
    const contentReviews = await Content.find({ 'contentDetails.userId': id });

    // Gather contract metrics
    const metrics = {
      insuranceStatus: user.insuranceStatus.status,
      coveragePeriod: user.insuranceStatus.coveragePeriod,
      policyEndDate: user.insuranceStatus.policyEndDate?.toISOString() || 'N/A',
      monthlyEarnings: user.financialInfo.monthlyEarnings || 0,
      premiumAmount: premium ? premium.premiumDetails.finalAmount : 0,
      premiumPercentage: premium ? premium.premiumDetails.finalPercentage : 0,
      discountApplied: premium ? premium.premiumDetails.discount.percentage : 0,
      totalClaims: claims.length,
      approvedClaims: claims.filter((c) =>
        c.statusHistory.history.some((h) => h.status === 'Approved')
      ).length,
      highRiskContent: contentReviews.filter((c) => c.riskAssessment.riskLevel === 'High').length,
      platformCount: user.platformInfo.platforms.length,
      platforms: user.platformInfo.platforms.map((p) => ({
        name: p.name,
        audienceSize: p.audienceSize,
        riskHistoryCount: p.riskHistory?.length || 0,
      })),
    };

    // AI-driven insights
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: process.env.MODEL_GEMINI });
    const prompt = `
      You are an AI assistant for Content Creators Insurance (CCI). Analyze the following contract data and provide actionable insights to optimize coverage, reduce risks, and improve user retention. Focus on premium fairness, claim patterns, content risks, and platform-specific trends.

      **Contract Data**:
      - Insurance Status: ${metrics.insuranceStatus}
      - Coverage Period: ${metrics.coveragePeriod} months
      - Policy End Date: ${metrics.policyEndDate}
      - Monthly Earnings: KES ${metrics.monthlyEarnings}
      - Premium Amount: KES ${metrics.premiumAmount}
      - Premium Percentage: ${metrics.premiumPercentage}%
      - Discount Applied: ${metrics.discountApplied}%
      - Total Claims: ${metrics.totalClaims}
      - Approved Claims: ${metrics.approvedClaims}
      - High-Risk Content Reviews: ${metrics.highRiskContent}
      - Platform Count: ${metrics.platformCount}
      - Platforms: ${JSON.stringify(metrics.platforms)}

      **Instructions**:
      - Evaluate premium fairness (e.g., is the premium too high/low for earnings or risks?).
      - Analyze claim frequency and suggest risk mitigation strategies.
      - Identify high-risk platforms or content types for preventive actions.
      - Recommend retention strategies (e.g., renewal incentives, premium adjustments).
      - Provide insights in JSON format:
      {
        "insights": [
          {
            "title": "Insight title",
            "description": "Detailed description of the insight",
            "action": "Recommended action to optimize contract"
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
      logger.error(`Failed to parse AI insights for contract ${id}: ${error.message}`);
      aiInsights = {
        insights: [
          {
            title: 'Default Insight',
            description: 'Unable to generate AI insights due to an error.',
            action: 'Manually review contract data for premium and risk trends.',
          },
        ],
      };
    }

    logger.info(`Admin ${adminId} analyzed contract for user ${id} with ${aiInsights.insights.length} insights`);
    res.json({
      success: true,
      data: {
        contract: {
          userId: user._id,
          insuranceStatus: user.insuranceStatus,
          premium: premium ? premium.premiumDetails : null,
          claimsCount: claims.length,
          contentReviewsCount: contentReviews.length,
        },
        aiInsights,
      },
    });
  } catch (error) {
    logger.error(`Error in analyzeContract for contract ${req.params.id}: ${error.message}`);
    next(error);
  }
};

// @desc    Update contract details
// @route   PUT /api/admin/insurance/contract/:id
// @access  Private (Admin)
export const updateContract = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { id } = req.params;
    const { coveragePeriod, platformData, financialInfo } = req.body;

    const admin = await User.findById(adminId);
    if (!admin || admin.role !== 'Admin') {
      logger.error(`Unauthorized update attempt by user ${adminId} for contract ${id}`);
      return res.status(403).json({ success: false, error: 'Unauthorized: Admin access required' });
    }

    const user = await User.findById(id);
    if (!user || user.role !== 'Creator' || user.insuranceStatus.status !== 'Approved') {
      logger.error(`Invalid contract for user ${id}`);
      return res.status(404).json({ success: false, error: 'Active contract not found' });
    }

    if (coveragePeriod && ![6, 12, 24].includes(coveragePeriod)) {
      return res.status(400).json({ success: false, error: 'Coverage period must be 6, 12, or 24 months' });
    }

    if (platformData) {
      user.platformInfo.platforms = platformData.map((p) => ({
        name: p.name,
        username: p.username,
        accountLink: p.accountLink || '',
        audienceSize: p.audienceSize || 0,
        contentType: p.contentType || '',
        riskHistory: p.riskHistory || [],
        isVerified: p.isVerified || false,
        verificationMethod: p.verificationMethod || 'Pending',
      }));
    }

    if (financialInfo) {
      user.financialInfo = {
        ...user.financialInfo,
        monthlyEarnings: financialInfo.monthlyEarnings || user.financialInfo.monthlyEarnings,
        currency: financialInfo.currency || 'KES',
        paymentMethod: financialInfo.paymentMethod || user.financialInfo.paymentMethod,
      };
    }

    if (coveragePeriod) {
      const policyStartDate = user.insuranceStatus.policyStartDate || new Date();
      user.insuranceStatus.coveragePeriod = coveragePeriod;
      user.insuranceStatus.policyEndDate = new Date(
        policyStartDate.getTime() + coveragePeriod * 30 * 24 * 60 * 60 * 1000
      );
    }

    await user.save();

    const premium = await Premium.findOne({ 'premiumDetails.userId': id });
    if (premium) {
      await premium.recalculatePremium(adminId);
      await premium.save();
      user.financialInfo.premium = {
        percentage: premium.premiumDetails.finalPercentage,
        amount: premium.premiumDetails.finalAmount,
        lastCalculated: new Date(),
        discountApplied: premium.premiumDetails.discount.percentage > 0,
        insuranceId: premium._id,
      };
      await user.save();
    }

    await sendEmail({
      to: user.personalInfo.email,
      subject: 'CCI Insurance Contract Updated',
      text: `Dear ${user.personalInfo.firstName},\n\nYour insurance contract has been updated. New coverage period: ${user.insuranceStatus.coveragePeriod} months.`,
      html: `<p>Dear ${user.personalInfo.firstName},</p><p>Your contract has been updated. New coverage period: ${user.insuranceStatus.coveragePeriod} months.</p>`,
    });

    logger.info(`Admin ${adminId} updated contract for user ${id}`);
    res.json({
      success: true,
      message: 'Contract updated successfully',
      data: {
        insuranceStatus: user.insuranceStatus,
        platformInfo: user.platformInfo,
        financialInfo: user.financialInfo,
        premium: premium ? premium.premiumDetails : null,
      },
    });
  } catch (error) {
    logger.error(`Error in updateContract for contract ${req.params.id}: ${error.message}`);
    next(error);
  }
};

// @desc    Terminate contract
// @route   POST /api/admin/insurance/contract/:id/terminate
// @access  Private (Admin)
export const terminateContract = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ success: false, error: 'Termination reason is required' });
    }

    const admin = await User.findById(adminId);
    if (!admin || admin.role !== 'Admin') {
      logger.error(`Unauthorized termination attempt by user ${adminId} for contract ${id}`);
      return res.status(403).json({ success: false, error: 'Unauthorized: Admin access required' });
    }

    const user = await User.findById(id);
    if (!user || user.role !== 'Creator' || user.insuranceStatus.status !== 'Approved') {
      logger.error(`Invalid contract for user ${id}`);
      return res.status(404).json({ success: false, error: 'Active contract not found' });
    }

    user.insuranceStatus = {
      ...user.insuranceStatus,
      status: 'Surrendered',
      surrenderedAt: new Date(),
      rejectionReason: reason,
    };
    user.applicationProgress = { step: 'Completed', lastUpdated: new Date() };
    await user.save();

    await Premium.deleteOne({ 'premiumDetails.userId': id });

    await sendEmail({
      to: user.personalInfo.email,
      subject: 'CCI Insurance Contract Terminated',
      text: `Dear ${user.personalInfo.firstName},\n\nYour insurance contract has been terminated. Reason: ${reason}.`,
      html: `<p>Dear ${user.personalInfo.firstName},</p><p>Your contract has been terminated. Reason: ${reason}.</p>`,
    });

    logger.info(`Admin ${adminId} terminated contract for user ${id}: ${reason}`);
    res.json({
      success: true,
      message: 'Contract terminated successfully',
      data: { insuranceStatus: user.insuranceStatus },
    });
  } catch (error) {
    logger.error(`Error in terminateContract for contract ${req.params.id}: ${error.message}`);
    next(error);
  }
};

// @desc    Get contract history
// @route   GET /api/admin/insurance/contract/:id/history
// @access  Private (Admin)
export const getContractHistory = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { id } = req.params;

    const admin = await User.findById(adminId);
    if (!admin || admin.role !== 'Admin') {
      logger.error(`Unauthorized history access by user ${adminId} for contract ${id}`);
      return res.status(403).json({ success: false, error: 'Unauthorized: Admin access required' });
    }

    const user = await User.findById(id);
    if (!user || user.role !== 'Creator') {
      logger.error(`Contract not found for user ${id}`);
      return res.status(404).json({ success: false, error: 'Contract or user not found' });
    }

    const premium = await Premium.findOne({ 'premiumDetails.userId': id });
    const claims = await Claim.find({ 'claimDetails.userId': id });
    const contentReviews = await Content.find({ 'contentDetails.userId': id });

    const history = {
      statusChanges: [
        { status: 'Applied', date: user.insuranceStatus.appliedAt },
        ...(user.insuranceStatus.approvedAt ? [{ status: 'Approved', date: user.insuranceStatus.approvedAt }] : []),
        ...(user.insuranceStatus.surrenderedAt ? [{ status: 'Surrendered', date: user.insuranceStatus.surrenderedAt }] : []),
        ...(user.insuranceStatus.rejectionReason ? [{ status: 'Rejected', reason: user.insuranceStatus.rejectionReason }] : []),
      ].filter(Boolean),
      renewals: user.insuranceStatus.lastRenewedAt
        ? [{ date: user.insuranceStatus.lastRenewedAt, coveragePeriod: user.insuranceStatus.coveragePeriod }]
        : [],
      premiumCalculations: premium?.calculationHistory || [],
      claims: claims.map((c) => ({
        id: c._id,
        incidentType: c.claimDetails.incidentType,
        status: c.statusHistory.history[c.statusHistory.history.length - 1].status,
        date: c.claimDetails.incidentDate,
      })),
      contentReviews: contentReviews.map((c) => ({
        platform: c.contentDetails.platform,
        riskLevel: c.riskAssessment.riskLevel,
        date: c.riskAssessment.lastAssessed,
      })),
    };

    logger.info(`Admin ${adminId} retrieved history for contract ${id}`);
    res.json({
      success: true,
      data: history,
    });
  } catch (error) {
    logger.error(`Error in getContractHistory for contract ${req.params.id}: ${error.message}`);
    next(error);
  }
};


// @desc    Generate insurance contract report with AI insights
// @route   GET /api/admin/insurance/report
// @access  Private (Admin)
export const generateContractReport = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const admin = await User.findById(adminId);
    if (!admin || admin.role !== 'Admin') {
      logger.error(`Unauthorized report access by user ${adminId}`);
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { startDate, endDate, platform, status } = req.query;
    const query = {};

    // Build query based on filters
    if (platform) {
      query['platformInfo.platforms.name'] = platform;
    }
    if (status) {
      query['insuranceStatus.status'] = status;
    }
    if (startDate || endDate) {
      query['insuranceStatus.appliedAt'] = {};
      if (startDate) query['insuranceStatus.appliedAt'].$gte = new Date(startDate);
      if (endDate) query['insuranceStatus.appliedAt'].$lte = new Date(endDate);
    }

    // Fetch users with insurance contracts
    const users = await User.find(query)
      .select(
        'personalInfo.email personalInfo.firstName personalInfo.lastName insuranceStatus platformInfo financialInfo'
      )
      .lean();

    // Enrich contract data with premium, claims, and content reviews
    const reportData = await Promise.all(
      users.map(async (user) => {
        const premium = await Premium.findOne({ 'premiumDetails.userId': user._id }).lean();
        const claims = await Claim.find({ 'claimDetails.userId': user._id }).select('statusHistory claimDetails.incidentType evaluation').lean();
        const contentReviews = await Content.find({ 'contentDetails.userId': user._id })
          .select('riskAssessment.riskLevel contentDetails.platform')
          .lean();

        return {
          userId: user._id,
          email: user.personalInfo.email,
          name: `${user.personalInfo.firstName} ${user.personalInfo.lastName}`,
          insuranceStatus: user.insuranceStatus.status,
          policyStartDate: user.insuranceStatus.policyStartDate?.toISOString() || 'N/A',
          policyEndDate: user.insuranceStatus.policyEndDate?.toISOString() || 'N/A',
          coveragePeriod: user.insuranceStatus.coveragePeriod || 'N/A',
          platforms: user.platformInfo.platforms.map((p) => p.name).join(', '),
          monthlyEarnings: user.financialInfo.monthlyEarnings || 0,
          premiumAmount: premium?.premiumDetails?.finalAmount || 0,
          premiumPercentage: premium?.premiumDetails?.finalPercentage || 0,
          discountApplied: premium?.premiumDetails?.discount.percentage || 0,
          claimCount: claims.length,
          approvedClaims: claims.filter((c) =>
            c.statusHistory.history.some((h) => h.status === 'Approved')
          ).length,
          contentReviewCount: contentReviews.length,
          highRiskContentCount: contentReviews.filter((c) => c.riskAssessment.riskLevel === 'High').length,
        };
      })
    );

    // Generate AI insights
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const aiInsights = await generateContractAiInsights(reportData);

    // Create DOCX document
    const doc = await createContractReportDocument(reportData, aiInsights, {
      startDate: startDate || 'All time',
      endDate: endDate || 'Now',
      platform: platform || 'All platforms',
      status: status || 'All statuses',
      adminEmail: admin.personalInfo.email,
    });

    // Convert to buffer
    const buffer = await Packer.toBuffer(doc);

    // Send email with DOCX attachment
    await sendEmail({
      to: admin.personalInfo.email,
      subject: 'CCI Insurance Contract Report with AI Insights',
      text: `Please find attached the insurance contract report with AI insights for ${startDate || 'all time'} to ${endDate || 'now'}.`,
      attachments: [
        {
          filename: 'CCI_Contract_Report.docx',
          content: buffer,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ],
    });

    // Send the DOCX file as response
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename=CCI_Contract_Report.docx');
    res.send(buffer);

    logger.info(`Admin ${adminId} generated contract report with ${aiInsights.insights.length} AI insights`);
  } catch (error) {
    logger.error(`Error in generateContractReport: ${error.message}`);
    next(error);
  }
};

// Helper function to generate AI insights for contract report
async function generateContractAiInsights(reportData) {
  const prompt = `
    You are an AI assistant for Content Creators Insurance (CCI). Analyze the following insurance contract report data and provide actionable insights to optimize contract management, reduce risks, and improve user retention.

    **Report Data**:
    - Total Contracts: ${reportData.length}
    - Insurance Status Breakdown: ${JSON.stringify(
      reportData.reduce((acc, r) => ({ ...acc, [r.insuranceStatus]: (acc[r.insuranceStatus] || 0) + 1 }), {})
    )}
    - Platforms: ${JSON.stringify([...new Set(reportData.flatMap((r) => r.platforms.split(', ')))])}
    - Total Premium Amount (KES): ${reportData.reduce((sum, r) => sum + r.premiumAmount, 0).toFixed(2)}
    - Average Premium Percentage: ${(
      reportData.reduce((sum, r) => sum + r.premiumPercentage, 0) / (reportData.length || 1)
    ).toFixed(2)}%
    - Total Discounts Applied: ${reportData.filter((r) => r.discountApplied > 0).length}
    - Total Claims: ${reportData.reduce((sum, r) => sum + r.claimCount, 0)}
    - Approved Claims: ${reportData.reduce((sum, r) => sum + r.approvedClaims, 0)}
    - Total Content Reviews: ${reportData.reduce((sum, r) => sum + r.contentReviewCount, 0)}
    - High-Risk Content: ${reportData.reduce((sum, r) => sum + r.highRiskContentCount, 0)}
    - Average Monthly Earnings (KES): ${(
      reportData.reduce((sum, r) => sum + r.monthlyEarnings, 0) / (reportData.length || 1)
    ).toFixed(2)}
    - Average Coverage Period (months): ${(
      reportData.reduce((sum, r) => sum + (r.coveragePeriod || 0), 0) / (reportData.length || 1)
    ).toFixed(1)}

    **Instructions**:
    - Identify contracts at risk of termination (e.g., nearing policy end, high claim frequency).
    - Suggest premium optimization strategies (e.g., adjust discounts, target high-risk creators).
    - Highlight high-risk platforms or content types for preventive interventions.
    - Recommend retention strategies (e.g., renewal reminders, personalized offers).
    - Provide insights in JSON format:
    {
      "insights": [
        {
          "title": "Insight title",
          "description": "Detailed description of the insight",
          "action": "Recommended action to improve outcomes",
          "priority": "high/medium/low"
        },
        ...
      ]
    }
  `;

  try {
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

    const rawResponse = result.response.text().replace(/```json\s*|\s*```/g, '').trim();
    return JSON.parse(rawResponse);
  } catch (error) {
    logger.error(`Failed to generate AI insights for contract report: ${error.message}`);
    return {
      insights: [
        {
          title: 'Default Insight',
          description: 'Unable to generate AI insights due to an error.',
          action: 'Manually review contract data for premium fairness and risk trends.',
          priority: 'medium',
        },
      ],
    };
  }
}

// Helper function to create DOCX document for contract report
async function createContractReportDocument(contracts, aiInsights, metadata) {
  // Create contract table rows
  const contractRows = contracts.map((contract) => new TableRow({
    children: [
      new TableCell({ children: [new Paragraph(contract.userId.toString().slice(-6))] }),
      new TableCell({ children: [new Paragraph(contract.email)] }),
      new TableCell({ children: [new Paragraph(contract.name)] }),
      new TableCell({ children: [new Paragraph(contract.insuranceStatus)] }),
      new TableCell({ children: [new Paragraph(contract.policyStartDate)] }),
      new TableCell({ children: [new Paragraph(contract.policyEndDate)] }),
      new TableCell({ children: [new Paragraph(contract.coveragePeriod.toString())] }),
      new TableCell({ children: [new Paragraph(contract.platforms)] }),
      new TableCell({ children: [new Paragraph(`KES ${contract.monthlyEarnings.toFixed(2)}`)] }),
      new TableCell({ children: [new Paragraph(`KES ${contract.premiumAmount.toFixed(2)}`)] }),
      new TableCell({ children: [new Paragraph(`${contract.premiumPercentage.toFixed(2)}%`)] }),
      new TableCell({ children: [new Paragraph(`${contract.discountApplied}%`)] }),
      new TableCell({ children: [new Paragraph(contract.claimCount.toString())] }),
      new TableCell({ children: [new Paragraph(contract.approvedClaims.toString())] }),
      new TableCell({ children: [new Paragraph(contract.contentReviewCount.toString())] }),
    ],
  }));

  // Create insights sections
  const insightSections = aiInsights.insights.map((insight) => [
    new Paragraph({
      text: `${insight.title} (${insight.priority} priority)`,
      heading: HeadingLevel.HEADING_3,
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Description: ', bold: true }),
        new TextRun(insight.description),
      ],
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Recommended Action: ', bold: true }),
        new TextRun(insight.action),
      ],
      spacing: { after: 200 },
    }),
  ]).flat();

  // Create the document
  return new Document({
    sections: [
      {
        properties: {},
        children: [
          // Header
          new Paragraph({
            text: 'Content Creators Insurance (CCI)',
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 200 },
          }),
          new Paragraph({
            text: 'Insurance Contract Report with AI Insights',
            heading: HeadingLevel.HEADING_2,
            spacing: { after: 200 },
          }),

          // Report metadata
          new Paragraph({
            text: `Report Period: ${metadata.startDate} to ${metadata.endDate}`,
            spacing: { after: 100 },
          }),
          new Paragraph({
            text: `Platform: ${metadata.platform}`,
            spacing: { after: 100 },
          }),
          new Paragraph({
            text: `Insurance Status: ${metadata.status}`,
            spacing: { after: 100 },
          }),
          new Paragraph({
            text: `Generated on: ${new Date().toISOString()}`,
            spacing: { after: 100 },
          }),
          new Paragraph({
            text: `Generated for: ${metadata.adminEmail}`,
            spacing: { after: 200 },
          }),

          // Summary statistics
          new Paragraph({
            text: 'Summary Statistics',
            heading: HeadingLevel.HEADING_3,
            spacing: { after: 100 },
          }),
          new Paragraph({
            text: `Total Contracts: ${contracts.length}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Total Premium Amount: KES ${contracts
              .reduce((sum, c) => sum + c.premiumAmount, 0)
              .toFixed(2)}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Average Premium Percentage: ${(
              contracts.reduce((sum, c) => sum + c.premiumPercentage, 0) / (contracts.length || 1)
            ).toFixed(2)}%`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Total Claims: ${contracts.reduce((sum, c) => sum + c.claimCount, 0)}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Approved Claims: ${contracts.reduce((sum, c) => sum + c.approvedClaims, 0)}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Total Content Reviews: ${contracts.reduce((sum, c) => sum + c.contentReviewCount, 0)}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `High-Risk Content: ${contracts.reduce((sum, c) => sum + c.highRiskContentCount, 0)}`,
            spacing: { after: 200 },
          }),

          // Contracts table
          new Paragraph({
            text: 'Contract Details',
            heading: HeadingLevel.HEADING_3,
            spacing: { after: 100 },
          }),
          new Table({
            rows: [
              // Header row
              new TableRow({
                children: [
                  new TableCell({
                    children: [new Paragraph('User ID')],
                    width: { size: 800, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Email')],
                    width: { size: 2000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Name')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Status')],
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Start Date')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('End Date')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Coverage (Months)')],
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Platforms')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Earnings')],
                    width: { size: 1200, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Premium')],
                    width: { size: 1200, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Premium %')],
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Discount %')],
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Claims')],
                    width: { size: 800, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Approved Claims')],
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Content Reviews')],
                    width: { size: 1200, type: WidthType.DXA },
                  }),
                ],
              }),
              ...contractRows,
            ],
            width: { size: 100, type: WidthType.PERCENTAGE },
          }),

          // AI Insights section
          new Paragraph({
            text: 'AI-Generated Insights',
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 },
          }),
          ...insightSections,
        ],
      },
    ],
  });
}