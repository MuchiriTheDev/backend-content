// controllers/adminController.js
import User from '../Models/User.js';
import Premium from '../Models/Premium.js';
import Claim from '../Models/Claim.js';
import Content from '../Models/Content.js';
import logger from '../Utilities/Logger.js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { sendVerificationEmail, sendEmail } from '../Services/EmailServices.js';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';
import { Parser } from 'json2csv';

// Initialize Gemini AI
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) throw new Error('Gemini API key is not configured');
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: process.env.MODEL_GEMINI });


// @desc    Get all users with details
// @route   GET /api/admin/users
// @access  Private (Admin)
export const getAllUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, status, search } = req.query;
    const query = {};
    console.log('Status:', status);

    if (status) {
      query['insuranceStatus.status'] = status;
    }
    if (search) {
      query.$or = [
        { 'personalInfo.firstName': { $regex: search, $options: 'i' } },
        { 'personalInfo.lastName': { $regex: search, $options: 'i' } },
        { 'personalInfo.email': { $regex: search, $options: 'i' } },
        { 'role': { $regex: search, $options: 'i' } },
      ];
    }

    const users = await User.find(query)
      .select('-auth.password -auth.resetPasswordToken -auth.resetPasswordExpire')
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    const total = await User.countDocuments(query);

    const usersWithDetails = await Promise.all(
      users.map(async (user) => {
        const premium = await Premium.findOne({ 'premiumDetails.userId': user._id }).lean();
        const claims = await Claim.find({ 'claimDetails.userId': user._id })
          .select('claimDetails.incidentType statusHistory')
          .lean();
        const contentReviews = await Content.find({ 'contentDetails.userId': user._id })
          .select('contentDetails.platform riskAssessment.riskLevel')
          .lean();

        return {
          ...user,
          premium: premium?.premiumDetails || null,
          claimsCount: claims.length,
          contentReviewsCount: contentReviews.length,
          recentRiskLevel: contentReviews.length
            ? contentReviews[contentReviews.length - 1].riskAssessment.riskLevel
            : 'N/A'
        };
      })
    );

    logger.info(`Admin ${req.user.id} retrieved ${usersWithDetails.length} users (page ${page})`);
    res.json({
      success: true,
      data: usersWithDetails,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    logger.error(`Error in getAllUsers: ${error.message}`);
    next(error);
  }
};

// @desc    Get specific user details
// @route   GET /api/admin/users/:id
// @access  Private (Admin)
export const getUserDetails = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-auth.password -auth.resetPasswordToken -auth.resetPasswordExpire')
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const premium = await Premium.findOne({ 'premiumDetails.userId': user._id }).lean();
    const claims = await Claim.find({ 'claimDetails.userId': user._id })
    const contentReviews = await Content.find({ 'contentDetails.userId': user._id })
      .select('contentDetails.platform contentDetails.contentType riskAssessment')
      .lean();

    logger.info(`Admin ${req.user.id} retrieved details for user ${req.params.id}`);
    res.json({
      success: true,
      data: {
        user,
        premium: premium?.premiumDetails || null,
        claims: claims.map((claim) => ({
          id: claim._id,
          incidentType: claim.claimDetails.incidentType,
          status: claim.statusHistory.history[claim.statusHistory.history.length - 1].status,
          payoutAmount: claim.evaluation?.payoutAmount || 0
        })),
        contentReviews: contentReviews.map((content) => ({
          platform: content.contentDetails.platform,
          contentType: content.contentDetails.contentType,
          riskLevel: content.riskAssessment.riskLevel,
          lastAssessed: content.riskAssessment.lastAssessed
        }))
      }
    });
  } catch (error) {
    logger.error(`Error in getUserDetails: ${error.message}`);
    next(error);
  }
};

// @desc    Update user details
// @route   PUT /api/admin/users/:id
// @access  Private (Admin)
export const updateUser = async (req, res, next) => {
  try {
    const { personalInfo, platformInfo, financialInfo, isVerified, role } = req.body;

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (personalInfo) {
      user.personalInfo = { ...user.personalInfo, ...personalInfo };
    }
    if (platformInfo) {
      user.platformInfo = { ...user.platformInfo, ...platformInfo };
    }
    if (financialInfo) {
      user.financialInfo = { ...user.financialInfo, ...financialInfo };
    }
    if (typeof isVerified === 'boolean') {
      user.isVerified = isVerified;
    }
    if (role && ['Creator', 'Admin'].includes(role)) {
      user.role = role;
    }

    await user.save();

    logger.info(`Admin ${req.user.id} updated user ${req.params.id}`);
    res.json({
      success: true,
      message: 'User updated successfully',
      data: {
        id: user._id,
        personalInfo: user.personalInfo,
        platformInfo: user.platformInfo,
        financialInfo: user.financialInfo,
        isVerified: user.isVerified,
        role: user.role
      }
    });
  } catch (error) {
    logger.error(`Error in updateUser: ${error.message}`);
    next(error);
  }
};

// @desc    Deactivate user
// @route   DELETE /api/admin/users/:id
// @access  Private (Admin)
export const deactivateUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    user.insuranceStatus.status = 'Surrendered';
    user.insuranceStatus.surrenderedAt = new Date();
    user.isVerified = false;
    await user.save();

    await Premium.deleteOne({ 'premiumDetails.userId': user._id });

    logger.info(`Admin ${req.user.id} deactivated user ${req.params.id}`);
    res.json({
      success: true,
      message: 'User deactivated successfully'
    });
  } catch (error) {
    logger.error(`Error in deactivateUser: ${error.message}`);
    next(error);
  }
};

// @desc    Resend verification email
// @route   POST /api/admin/users/:id/resend-verification
// @access  Private (Admin)
export const resendVerificationEmail = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (user.isVerified) {
      return res.status(400).json({ success: false, error: 'User is already verified' });
    }

    const verificationToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    await sendVerificationEmail(user.personalInfo.email, verificationToken);

    logger.info(`Admin ${req.user.id} resent verification email for user ${req.params.id}`);
    res.json({
      success: true,
      message: 'Verification email resent successfully'
    });
  } catch (error) {
    logger.error(`Error in resendVerificationEmail: ${error.message}`);
    next(error);
  }
};



// @desc    Get analytics and AI insights
// @route   GET /api/admin/analytics
// @access  Private (Admin)
export const getAnalytics = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const match = {};
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) match.createdAt.$lte = new Date(endDate);
    }

    // Basic counts
    const totalUsers = await User.countDocuments(match);
    const verifiedUsers = await User.countDocuments({ ...match, isVerified: true });
    const statusBreakdown = await User.aggregate([
      { $match: match },
      { $group: { _id: '$insuranceStatus.status', count: { $sum: 1 } } },
    ]);
    const roleBreakdown = await User.aggregate([
      { $match: match },
      { $group: { _id: '$role', count: { $sum: 1 } } },
    ]);
    const totalClaims = await Claim.countDocuments(match);
    const approvedClaims = await Claim.countDocuments({
      ...match,
      'statusHistory.history.status': 'Approved',
    });
    const totalContentReviews = await Content.countDocuments(match);
    const highRiskContent = await Content.countDocuments({
      ...match,
      'riskAssessment.riskLevel': 'High',
    });

    // Platform-specific metrics
    const platformBreakdown = await User.aggregate([
      { $match: match },
      { $unwind: '$platformInfo.platforms' },
      { $group: { _id: '$platformInfo.platforms.name', userCount: { $sum: 1 } } },
    ]);
    const contentByPlatform = await Content.aggregate([
      { $match: match },
      { $group: { _id: '$contentDetails.platform', count: { $sum: 1 } } },
    ]);
    const claimsByPlatform = await Claim.aggregate([
      { $match: match },
      { $group: { _id: '$claimDetails.platform', count: { $sum: 1 } } },
    ]);

    // Time-based trends (last 12 months)
    const twelveMonthsAgo = new Date(new Date().setMonth(new Date().getMonth() - 12));
    const userGrowth = await User.aggregate([
      { $match: { createdAt: { $gte: twelveMonthsAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          newUsers: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const applicationTrends = await User.aggregate([
      {
        $match: {
          'insuranceStatus.appliedAt': { $gte: twelveMonthsAgo },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$insuranceStatus.appliedAt' } },
          applications: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const contentReviewTrends = await Content.aggregate([
      { $match: { createdAt: { $gte: twelveMonthsAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          reviews: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // High-risk users (based on content or claims)
    const highRiskUsers = await User.aggregate([
      {
        $lookup: {
          from: 'contents',
          localField: '_id',
          foreignField: 'contentDetails.userId',
          as: 'content',
        },
      },
      {
        $lookup: {
          from: 'claims',
          localField: '_id',
          foreignField: 'claimDetails.userId',
          as: 'claims',
        },
      },
      {
        $project: {
          userId: '$_id',
          email: '$personalInfo.email',
          highRiskContentCount: {
            $sum: {
              $map: {
                input: '$content',
                as: 'c',
                in: { $cond: [{ $eq: ['$$c.riskAssessment.riskLevel', 'High'] }, 1, 0] },
              },
            },
          },
          claimCount: { $size: '$claims' },
        },
      },
      {
        $match: {
          $or: [{ highRiskContentCount: { $gte: 3 } }, { claimCount: { $gte: 2 } }],
        },
      },
      {
        $project: {
          userId: 1,
          email: 1,
          highRiskContentCount: 1,
          claimCount: 1,
        },
      },
      { $limit: 10 }, // Limit to top 10 for performance
    ]);

    // Operational metrics
    const avgApplicationProcessingTime = await User.aggregate([
      {
        $match: {
          'insuranceStatus.status': { $in: ['Approved', 'Rejected'] },
          'insuranceStatus.appliedAt': { $exists: true },
          'insuranceStatus.approvedAt': { $exists: true },
        },
      },
      {
        $project: {
          processingTime: {
            $divide: [
              { $subtract: ['$insuranceStatus.approvedAt', '$insuranceStatus.appliedAt'] },
              1000 * 60 * 60 * 24, // Convert to days
            ],
          },
        },
      },
      { $group: { _id: null, avgProcessingTime: { $avg: '$processingTime' } } },
    ]);
    const claimResolutionRate = await Claim.aggregate([
      {
        $match: {
          resolutionDeadline: { $exists: true },
          'statusHistory.history.status': { $in: ['Approved', 'Rejected', 'Paid'] },
        },
      },
      {
        $project: {
          resolvedOnTime: {
            $cond: [
              {
                $lte: [
                  { $arrayElemAt: ['$statusHistory.history.date', -1] },
                  '$resolutionDeadline',
                ],
              },
              1,
              0,
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalResolved: { $sum: 1 },
          resolvedOnTime: { $sum: '$resolvedOnTime' },
        },
      },
    ]);

    // AI-driven insights
    const prompt = `
      You are an AI assistant for Content Creators Insurance (CCI). Analyze the following analytics data and provide actionable insights to improve user engagement, reduce risks, and optimize operational efficiency.

      **Analytics Data**:
      - Total Users: ${totalUsers}
      - Verified Users: ${verifiedUsers}
      - Status Breakdown: ${JSON.stringify(statusBreakdown)}
      - Role Breakdown: ${JSON.stringify(roleBreakdown)}
      - Total Claims: ${totalClaims}
      - Approved Claims: ${approvedClaims}
      - Total Content Reviews: ${totalContentReviews}
      - High-Risk Content: ${highRiskContent}
      - Platform Breakdown: ${JSON.stringify(platformBreakdown)}
      - Content by Platform: ${JSON.stringify(contentByPlatform)}
      - Claims by Platform: ${JSON.stringify(claimsByPlatform)}
      - User Growth (Last 12 Months): ${JSON.stringify(userGrowth)}
      - Application Trends: ${JSON.stringify(applicationTrends)}
      - Content Review Trends: ${JSON.stringify(contentReviewTrends)}
      - High-Risk Users: ${JSON.stringify(highRiskUsers)}
      - Avg Application Processing Time (days): ${avgApplicationProcessingTime[0]?.avgProcessingTime?.toFixed(2) || 0}
      - Claim Resolution Rate: ${claimResolutionRate[0]?.resolvedOnTime || 0}/${claimResolutionRate[0]?.totalResolved || 0}

      **Instructions**:
      - Identify high-risk user segments or platforms with frequent issues.
      - Suggest ways to improve user engagement (e.g., target unverified users, prompt content reviews).
      - Recommend operational improvements (e.g., reduce application processing time, improve claim resolution).
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
      logger.error(`Failed to parse AI insights: ${error.message}`);
      aiInsights = {
        insights: [
          {
            title: 'Default Insight',
            description: 'Unable to generate AI insights due to an error.',
            action: 'Manually review analytics for user engagement and risk trends.',
            priority: 'medium',
          },
        ],
      };
    }

    logger.info(`Admin ${req.user.id} retrieved analytics with ${aiInsights.insights.length} AI insights`);
    res.json({
      success: true,
      data: {
        analytics: {
          totalUsers,
          verifiedUsers,
          statusBreakdown,
          roleBreakdown,
          totalClaims,
          approvedClaims,
          totalContentReviews,
          highRiskContent,
          platformBreakdown,
          contentByPlatform,
          claimsByPlatform,
          userGrowth,
          applicationTrends,
          contentReviewTrends,
          highRiskUsers,
          avgApplicationProcessingTime: avgApplicationProcessingTime[0]?.avgProcessingTime?.toFixed(2) || 0,
          claimResolutionRate: {
            resolvedOnTime: claimResolutionRate[0]?.resolvedOnTime || 0,
            totalResolved: claimResolutionRate[0]?.totalResolved || 0,
          },
        },
        aiInsights,
      },
    });
  } catch (error) {
    logger.error(`Error in getAnalytics: ${error.message}`);
    next(error);
  }
};

// @desc    Generate user report with AI insights (Admin only)
// @route   GET /api/admin/users/report
// @access  Private (Admin)
export const generateUserReport = async (req, res, next) => {
  try {
    if (req.user.role !== 'Admin') {
      logger.error(`Unauthorized report access by user ${req.user.id}`);
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const admin = await User.findById(req.user.id);
    const { startDate, endDate, platform, status } = req.query;
    const query = {};

    if (platform) {
      query['platformInfo.platforms.name'] = platform;
    }
    if (status) {
      query['insuranceStatus.status'] = status;
    }
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    // Fetch user data
    const users = await User.find(query)
      .select('personalInfo.email personalInfo.firstName personalInfo.lastName insuranceStatus platformInfo financialInfo')
      .lean();

    // Enrich user data with premium and claim info
    const reportData = await Promise.all(
      users.map(async (user) => {
        const premium = await Premium.findOne({ 'premiumDetails.userId': user._id }).lean();
        const claims = await Claim.find({ 'claimDetails.userId': user._id }).select('statusHistory').lean();
        const contentReviews = await Content.find({ 'contentDetails.userId': user._id })
          .select('riskAssessment.riskLevel')
          .lean();

        return {
          userId: user._id,
          email: user.personalInfo.email,
          name: `${user.personalInfo.firstName} ${user.personalInfo.lastName}`,
          insuranceStatus: user.insuranceStatus.status,
          platforms: user.platformInfo.platforms.map((p) => p.name).join(', '),
          monthlyEarnings: user.financialInfo.monthlyEarnings || 0,
          premiumAmount: premium?.premiumDetails?.finalAmount || 0,
          claimCount: claims.length,
          contentReviewCount: contentReviews.length,
          highRiskContentCount: contentReviews.filter((c) => c.riskAssessment.riskLevel === 'High').length,
        };
      })
    );

    // Generate AI insights
    const aiInsights = await generateUserAiInsights(reportData);

    // Create DOCX document
    const doc = await createUserReportDocument(reportData, aiInsights, {
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
      subject: 'CCI User Report with AI Insights',
      text: `Please find attached the user report with AI insights for ${startDate || 'all time'} to ${endDate || 'now'}.`,
      attachments: [
        {
          filename: 'CCI_User_Report.docx',
          content: buffer,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      ],
    });

    // Send the DOCX file as response
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename=CCI_User_Report.docx');
    res.send(buffer);

    logger.info(`Admin ${req.user.id} generated user report with ${aiInsights.insights.length} AI insights`);
  } catch (error) {
    logger.error(`Error in generateUserReport: ${error.message}`);
    next(error);
  }
};

// Helper function to generate AI insights for user report
async function generateUserAiInsights(reportData) {
  const prompt = `
    You are an AI assistant for Content Creators Insurance (CCI). Analyze the following user report data and provide actionable insights to improve user engagement, reduce risks, and optimize operational efficiency.

    **Report Data**:
    - Total Users: ${reportData.length}
    - Insurance Status Breakdown: ${JSON.stringify(
      reportData.reduce((acc, r) => ({ ...acc, [r.insuranceStatus]: (acc[r.insuranceStatus] || 0) + 1 }), {})
    )}
    - Platforms: ${JSON.stringify([...new Set(reportData.flatMap((r) => r.platforms.split(', ')))])}
    - Total Premium Amount (KES): ${reportData.reduce((sum, r) => sum + r.premiumAmount, 0).toFixed(2)}
    - Total Claims: ${reportData.reduce((sum, r) => sum + r.claimCount, 0)}
    - Total Content Reviews: ${reportData.reduce((sum, r) => sum + r.contentReviewCount, 0)}
    - High-Risk Content: ${reportData.reduce((sum, r) => sum + r.highRiskContentCount, 0)}
    - Average Monthly Earnings (KES): ${(
      reportData.reduce((sum, r) => sum + r.monthlyEarnings, 0) / (reportData.length || 1)
    ).toFixed(2)}

    **Instructions**:
    - Identify users at risk of surrendering insurance (e.g., low engagement, high-risk content).
    - Suggest targeted interventions (e.g., verification reminders, content review prompts).
    - Highlight operational bottlenecks (e.g., slow application approvals, high rejection rates).
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
    logger.error(`Failed to generate AI insights for user report: ${error.message}`);
    return {
      insights: [
        {
          title: 'Default Insight',
          description: 'Unable to generate AI insights due to an error.',
          action: 'Manually review user data for engagement and risk trends.',
          priority: 'medium',
        },
      ],
    };
  }
}

// Helper function to create DOCX document for user report
async function createUserReportDocument(users, aiInsights, metadata) {
  // Create user table rows
  const userRows = users.map((user) => new TableRow({
    children: [
      new TableCell({ children: [new Paragraph(user.userId.toString().slice(-6))] }),
      new TableCell({ children: [new Paragraph(user.email)] }),
      new TableCell({ children: [new Paragraph(user.name)] }),
      new TableCell({ children: [new Paragraph(user.insuranceStatus)] }),
      new TableCell({ children: [new Paragraph(user.platforms)] }),
      new TableCell({ children: [new Paragraph(`KES ${user.monthlyEarnings.toFixed(2)}`)] }),
      new TableCell({ children: [new Paragraph(`KES ${user.premiumAmount.toFixed(2)}`)] }),
      new TableCell({ children: [new Paragraph(user.claimCount.toString())] }),
      new TableCell({ children: [new Paragraph(user.contentReviewCount.toString())] }),
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
            text: 'User Report with AI Insights',
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
            text: `Total Users: ${users.length}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Total Premium Amount: KES ${users
              .reduce((sum, u) => sum + u.premiumAmount, 0)
              .toFixed(2)}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Total Claims: ${users.reduce((sum, u) => sum + u.claimCount, 0)}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Total Content Reviews: ${users.reduce((sum, u) => sum + u.contentReviewCount, 0)}`,
            spacing: { after: 200 },
          }),

          // Users table
          new Paragraph({
            text: 'User Details',
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
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Email')],
                    width: { size: 2500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Name')],
                    width: { size: 2000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Insurance Status')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Platforms')],
                    width: { size: 2000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Monthly Earnings')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Premium Amount')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Claims')],
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Content Reviews')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                ],
              }),
              ...userRows,
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
};