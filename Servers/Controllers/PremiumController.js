import Premium from "../Models/Premium.js";
import User from "../Models/User.js";
import { sendEmail } from "../Services/EmailServices.js";
import logger from "../Utilities/Logger.js";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { sendVerificationEmail } from '../Services/EmailServices.js';

// @desc    Estimate premium for a user (Creator or Admin)
// @route   POST /api/premiums/estimate
// @access  Private (Creator/Admin)
export const estimatePremium = async (req, res, next) => {
  try {
    const { userId: targetUserId } = req.body;
    const estimatorRole = req.user.role === 'Admin' ? 'Admin' : 'Creator';
    const estimatorId = req.user.userId;

    let userId;
    if (!targetUserId) {
      if (estimatorRole !== 'Admin') {
        userId = req.user.userId;
      } else {
        return res.status(400).json({ success: false, error: 'User ID required for admin estimate' });
      }
    } else {
      userId = targetUserId;
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (estimatorRole === 'Creator' && user._id.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ success: false, error: 'Creators can only estimate their own premium' });
    }

    // Enhanced return to include factors and riskExplanation from schema
    const estimation = await Premium.estimatePremium(userId, estimatorRole, estimatorId);
    const premium = await Premium.findOne({ 'premiumDetails.userId': userId });
    const latestEstimation = premium?.estimationHistory?.creatorEstimations?.slice(-1)[0] || 
                             premium?.estimationHistory?.adminEstimations?.slice(-1)[0] || 
                             { factors: {}, riskExplanation: 'CCI Basic Estimate: 2-5% of earnings' };

    logger.info(
      `Premium estimated for user ${userId} by ${estimatorRole} ${estimatorId}: ${estimation.estimatedPercentage}% (KES ${estimation.estimatedAmount})`
    );
    res.status(200).json({
      success: true,
      estimation: {
        estimatedPercentage: estimation.estimatedPercentage,
        estimatedAmount: estimation.estimatedAmount,
        contentRisk: latestEstimation.factors?.contentRiskPercentage || 0,
        riskExplanation: latestEstimation.riskExplanation,
        factors: latestEstimation.factors,
      },
    });
  } catch (error) {
    console.log(error);
    logger.error(`Error in estimatePremium: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

// @desc    Calculate or recalculate a user's premium (Admin only)
// @route   POST /api/premiums/calculate
// @access  Private (Admin)
export const calculatePremium = async (req, res, next) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { userId } = req.body;
    const adminId = req.user.userId;

    const user = await User.findById(userId);
    if (!user || user.insuranceStatus.status !== 'Approved') {
      return res.status(400).json({ success: false, error: 'User not found or insurance not approved' });
    }

    let premium = await Premium.findOne({ 'premiumDetails.userId': userId });
    if (!premium) {
      // Align with schema defaults: basePercentage 2, finalAmount min 1000
      premium = new Premium({
        premiumDetails: {
          userId,
          basePercentage: 2, // Align with schema default
          currency: 'KSh',
          adjustmentFactors: {
            earningsPercentage: 0,
            audienceSizePercentage: 0,
            contentRiskPercentage: 0,
            platformVolatility: 0,
            infractionPercentage: 0,
          },
          finalPercentage: 2,
          finalAmount: Math.max((2 / 100) * (user.financialInfo.monthlyEarnings || 0), 1000), // Align min with schema
        },
        paymentStatus: { status: 'Pending' },
      });
    }

    const result = await premium.recalculatePremium(adminId);

    user.financialInfo.premium = {
      amount: premium.premiumDetails.finalAmount,
      lastCalculated: new Date(),
      discountApplied: premium.premiumDetails.discount.percentage > 0,
      insuranceId: premium._id,
    };
    await user.save();

    await sendEmail({
      to: user.personalInfo.email,
      subject: 'Your CCI Premium Calculated',
      text: `Your monthly premium has been calculated: ${premium.premiumDetails.finalPercentage}% (KSh ${premium.premiumDetails.finalAmount}) due by ${premium.paymentStatus.dueDate}. ${
        premium.premiumDetails.discount.preventiveServiceDiscount > 0
          ? `A ${premium.premiumDetails.discount.preventiveServiceDiscount}% discount was applied for content reviews.`
          : ''
      }`,
    });

    logger.info(
      `Premium calculated for user ${userId} by admin ${adminId}: ${premium.premiumDetails.finalPercentage}% (KSh ${premium.premiumDetails.finalAmount})`
    );
    res.status(200).json({
      success: true,
      premium: {
        ...premium.premiumDetails,
        contentRisk: result.factors?.contentRiskPercentage || 0, // Align with schema
        riskExplanation: premium.premiumDetails.adjustmentFactors.riskExplanation,
      },
    });
  } catch (error) {
    logger.error(`Error in calculatePremium: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

// @desc    Get current user's premium
// @route   GET /api/premiums/my-premium
// @access  Private (Creator)
export const getMyPremium = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const premium = await Premium.findOne({ 'premiumDetails.userId': userId });

    if (!premium) {
      return res.status(404).json({ success: false, error: 'Premium not found' });
    }

    res.status(200).json({ success: true, premium: premium });
  } catch (error) {
    logger.error(`Error in getMyPremium: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getPremiumByUserId = async (req, res, next) => {
  try {
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }
    const adminId = req.user.userId;
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    } 
    
    const premium = await Premium.findOne({ 'premiumDetails.userId': userId });

    if (!premium) {
      return res.status(404).json({ success: false, error: 'Premium not found' });
    }

    res.status(200).json({ success: true, premium: premium });

  } catch (error) {
    logger.error(`Error in getPremiumByUserId: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ success: false, error: error.message });
  }

}

// @desc    Pay a premium
// @route   POST /api/premiums/pay
// @access  Private (Creator)
export const payPremium = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { paymentMethod, paymentDetails } = req.body;

    if (!paymentMethod || !paymentDetails) {
      return res.status(400).json({ success: false, error: 'Payment method and details are required' });
    }

    const premium = await Premium.findOne({ 'premiumDetails.userId': userId });
    if (!premium) {
      return res.status(404).json({ success: false, error: 'Premium not found' });
    }

    if (premium.paymentStatus.status === 'Paid') {
      return res.status(400).json({ success: false, error: 'Premium already paid' });
    }

    const user1 = await User.findById(userId);
    if (!user1) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (user1.insuranceStatus.status !== 'Approved') {
      return res.status(400).json({ success: false, error: 'Insurance not approved' });
    }
    
    // Simulate payment gateway (replace with real integration, e.g., M-Pesa, Stripe)
    const paymentSuccess = Math.random() > 0.2; // 80% success rate for testing
    const transactionId = `txn_${Date.now()}`;

    if (paymentSuccess) {
      premium.paymentStatus.status = 'Paid';
      premium.paymentStatus.paymentDate = new Date();
      premium.paymentStatus.paymentMethod.type = paymentMethod; // Align with schema: type is enum string
      premium.paymentStatus.paymentMethod.details = paymentDetails; // details as string
      premium.paymentStatus.transactionId = transactionId;
      premium.paymentStatus.attempts.push({ status: 'Success', date: new Date() });
      premium.renewalCount += 1;
      premium.lastRenewedAt = new Date();
    } else {
      premium.paymentStatus.attempts.push({
        status: 'Failed',
        errorMessage: 'Payment gateway error',
        date: new Date(),
      });
      premium.paymentStatus.status = 'Failed';
    }

    await premium.save();

    const user = await User.findById(userId);
    await sendEmail({
      to: user.personalInfo.email,
      subject: `CCI Premium Payment ${paymentSuccess ? 'Successful' : 'Failed'}`,
      text: paymentSuccess
        ? `Your premium payment of ${premium.premiumDetails.finalPercentage}% (KSh ${premium.premiumDetails.finalAmount}) was successful. Transaction ID: ${transactionId}.`
        : `Your premium payment attempt failed. Please try again or contact support.`,
    });

    logger.info(
      `Premium payment ${paymentSuccess ? 'succeeded' : 'failed'} for user ${userId}: ${premium.premiumDetails.finalPercentage}% (KSh ${premium.premiumDetails.finalAmount}), Transaction: ${transactionId}`
    );
    res.status(200).json({
      success: paymentSuccess,
      message: paymentSuccess ? 'Payment successful' : 'Payment failed',
      transactionId: paymentSuccess ? transactionId : null,
    });
  } catch (error) {
    logger.error(`Error in payPremium: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

// @desc    Apply content review discount (Creator)
// @route   PUT /api/premiums/discount
// @access  Private (Creator)
export const applyContentReviewDiscount = async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const premium = await Premium.findOne({ 'premiumDetails.userId': userId });
    if (!premium) {
      return res.status(404).json({ success: false, error: 'Premium not found' });
    }

    const discountApplied = await premium.checkContentReviewDiscount();
    if (!discountApplied) {
      return res.status(400).json({
        success: false,
        error: 'Not eligible for discount. Submit at least 3 content reviews in the last 30 days.',
      });
    }

    const user = await User.findById(userId);
    user.financialInfo.premium.discountApplied = true;
    user.financialInfo.premium.amount = premium.premiumDetails.finalAmount;
    await user.save();

    await sendEmail({
      to: user.personalInfo.email,
      subject: 'CCI Premium Discount Applied',
      text: `A discount of ${premium.premiumDetails.discount.preventiveServiceDiscount}% has been applied to your premium for submitting content reviews. New premium: ${premium.premiumDetails.finalPercentage}% (KSh ${premium.premiumDetails.finalAmount}).`,
    });

    logger.info(
      `Content review discount applied for user ${userId}: ${premium.premiumDetails.discount.preventiveServiceDiscount}% (New amount: KSh ${premium.premiumDetails.finalAmount})`
    );
    res.status(200).json({
      success: true,
      message: 'Content review discount applied',
      premium: premium.premiumDetails,
    });
  } catch (error) {
    logger.error(`Error in applyContentReviewDiscount: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ success: false, error: error.message });
  }
};
// @desc    Manually adjust premium (Admin only)
// @route   PUT /api/premiums/:id/adjust
// @access  Private (Admin)
export const adjustPremium = async (req, res, next) => {
  try {
    // Validate admin role
    if (req.user.role !== 'Admin') {
      logger.error(`Unauthorized attempt to adjust premium by user ${req.user.userId}`);
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { id } = req.params;
    const { adjustmentPercentage, reason } = req.body;

    // Validate input
    if (adjustmentPercentage === undefined || !reason) {
      logger.warn(`Missing adjustment percentage or reason for premium ${id}`);
      return res.status(400).json({ success: false, error: 'Adjustment percentage and reason are required' });
    }

    // Fetch premium
    const premium = await Premium.findById(id);
    if (!premium) {
      logger.error(`Premium not found: ${id}`);
      return res.status(404).json({ success: false, error: 'Premium not found' });
    }

    // Fetch user
    const user = await User.findById(premium.premiumDetails.userId);
    if (!user) {
      logger.error(`User not found for premium ${id}: userId ${premium.premiumDetails.userId}`);
      return res.status(404).json({ success: false, error: 'Associated user not found' });
    }

    // Adjust premium
    const newFinalAmount = await premium.adjustPremium(adjustmentPercentage, reason, req.user.userId);

    // Update user's financial info (align with schema: amount, not percentage directly)
    user.financialInfo.premium.amount = newFinalAmount;
    user.financialInfo.premium.lastCalculated = new Date();
    await user.save();

    // Send notification email (align with schema: fullName, currency KSh)
    try {
      await sendEmail({
        to: user.personalInfo.email,
        subject: 'CCI Premium Adjusted',
        text: `Dear ${user.personalInfo.fullName},\n\nYour premium amount has been adjusted by ${adjustmentPercentage}% due to: ${reason}. New premium amount: KSh ${newFinalAmount} (${premium.premiumDetails.finalPercentage.toFixed(2)}% of earnings).\n\nThank you for choosing CCI!`,
        html: `
          <h2>CCI Premium Adjusted</h2>
          <p>Dear ${user.personalInfo.fullName},</p>
          <p>Your premium amount has been adjusted by <strong>${adjustmentPercentage}%</strong> due to: ${reason}.</p>
          <p><strong>New Premium Amount:</strong> KSh ${newFinalAmount} (${premium.premiumDetails.finalPercentage.toFixed(2)}% of earnings)</p>
          <p>Thank you for choosing CCI!</p>
        `,
      });
      logger.info(`Adjustment email sent to ${user.personalInfo.email} for premium ${id}`);
    } catch (emailError) {
      logger.error(`Failed to send adjustment email to ${user.personalInfo.email}: ${emailError.message}`);
    }

    logger.info(
      `Premium ${id} adjusted for user ${premium.premiumDetails.userId} by admin ${req.user.userId}: ${adjustmentPercentage}% (New amount: KSh ${newFinalAmount}, ${premium.premiumDetails.finalPercentage.toFixed(2)}%)`
    );
    res.status(200).json({
      success: true,
      message: 'Premium adjusted successfully',
      premium: premium.premiumDetails,
    });
  } catch (error) {
    logger.error(`Error in adjustPremium for premium ${req.params.id}: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
// @desc    Get all premiums (Admin only)
// @route   GET /api/premiums/all
// @access  Private (Admin)
export const getAllPremiums = async (req, res, next) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { status, startDate, endDate, userId } = req.query;
    const query = {};

    if (status) query['paymentStatus.status'] = status;
    if (userId) query['premiumDetails.userId'] = userId;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const premiums = await Premium.find(query)
      .populate('premiumDetails.userId', 'personalInfo.email personalInfo.fullName') // Align with schema: fullName
      .sort({ 'paymentStatus.dueDate': 1 });

    res.status(200).json({ success: true, premiums });
  } catch (error) {
    logger.error(`Error in getAllPremiums: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

// @desc    Get overdue premiums (Admin only)
// @route   GET /api/premiums/overdue
// @access  Private (Admin)
export const getOverduePremiums = async (req, res, next) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const now = new Date();
    const premiums = await Premium.find({
      'paymentStatus.status': { $in: ['Pending', 'Failed'] },
      'paymentStatus.dueDate': { $lt: now },
    })
      .populate('premiumDetails.userId', 'personalInfo.email personalInfo.fullName') // Align with schema: fullName
      .sort({ 'paymentStatus.dueDate': 1 });

    for (const premium of premiums) {
      if (premium.paymentStatus.status !== 'Overdue') {
        premium.paymentStatus.status = 'Overdue';
        await premium.save();

        const user = await User.findById(premium.premiumDetails.userId);
        if (!user) {
          logger.error(`User not found for overdue premium ${premium._id}: userId ${premium.premiumDetails.userId}`);
          continue;
        }
        // await sendEmail({
        //   to: user.personalInfo.email,
        //   subject: 'CCI Overdue Premium Payment',
        //   text: `Your premium of ${premium.premiumDetails.finalPercentage}% (KSh ${premium.premiumDetails.finalAmount}) is overdue since ${premium.paymentStatus.dueDate}. Please pay immediately to avoid service interruption.`,
        // });
      }
    }

    logger.info(`Fetched ${premiums.length} overdue premiums`);
    res.status(200).json({ success: true, premiums });
  } catch (error) {
    logger.error(`Error in getOverduePremiums: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

// @desc    Retry failed payment (Creator or Admin)
// @route   POST /api/premiums/retry-payment
// @access  Private (Creator/Admin)
export const retryPayment = async (req, res, next) => {
  try {
    const { userId: targetUserId } = req.body;
    const isAdmin = req.user.role === 'Admin';

    let userId;
    if (!targetUserId) {
      if (!isAdmin) {
        userId = req.user.userId;
      } else {
        return res.status(400).json({ success: false, error: 'User ID required for admin retry' });
      }
    } else {
      userId = targetUserId;
    }

    if (!isAdmin && userId !== req.user.userId) {
      return res.status(403).json({ success: false, error: 'Creators can only retry their own payments' });
    }

    const premium = await Premium.findOne({ 'premiumDetails.userId': userId });
    if (!premium) {
      return res.status(404).json({ success: false, error: 'Premium not found' });
    }

    if (premium.paymentStatus.status === 'Paid') {
      return res.status(400).json({ success: false, error: 'Premium already paid' });
    }

    // Simulate payment retry (replace with real gateway)
    const paymentSuccess = Math.random() > 0.2; // 80% success rate for testing
    const transactionId = `txn_${Date.now()}`;

    if (paymentSuccess) {
      premium.paymentStatus.status = 'Paid';
      premium.paymentStatus.paymentDate = new Date();
      premium.paymentStatus.transactionId = transactionId;
      premium.paymentStatus.attempts.push({ status: 'Success', date: new Date() });
      premium.renewalCount += 1;
      premium.lastRenewedAt = new Date();
    } else {
      premium.paymentStatus.attempts.push({
        status: 'Failed',
        errorMessage: 'Retry failed',
        date: new Date(),
      });
      premium.paymentStatus.status = 'Failed';
    }

    await premium.save();

    const user = await User.findById(userId);
    await sendEmail({
      to: user.personalInfo.email,
      subject: `CCI Premium Payment Retry ${paymentSuccess ? 'Successful' : 'Failed'}`,
      text: paymentSuccess
        ? `Your premium payment retry of ${premium.premiumDetails.finalPercentage}% (KSh ${premium.premiumDetails.finalAmount}) was successful. Transaction ID: ${transactionId}.`
        : `Your premium payment retry failed. Please try again or contact support.`,
    });

    logger.info(
      `Premium payment retry ${paymentSuccess ? 'succeeded' : 'failed'} for user ${userId}: ${premium.premiumDetails.finalPercentage}% (KSh ${premium.premiumDetails.finalAmount}), Transaction: ${transactionId}`
    );
    res.status(200).json({
      success: paymentSuccess,
      message: paymentSuccess ? 'Payment retry successful' : 'Payment retry failed',
      transactionId: paymentSuccess ? transactionId : null,
    });
  } catch (error) {
    logger.error(`Error in retryPayment: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ success: false, error: error.message });
  }
};


// @desc    Get premium analytics with AI insights (Admin only)
// @route   GET /api/premiums/analytics
// @access  Private (Admin)
export const getPremiumAnalytics = async (req, res, next) => {
  try {
    if (req.user.role !== 'Admin') {
      logger.error(`Unauthorized analytics access by user ${req.user.userId}`);
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { startDate, endDate } = req.query;
    const match = {};
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) match.createdAt.$lte = new Date(endDate);
    }

    // Gather analytics data
    const totalPremiums = await Premium.countDocuments(match);
    const statusBreakdown = await Premium.aggregate([
      { $match: match },
      { $group: { _id: '$paymentStatus.status', count: { $sum: 1 } } },
    ]);
    const avgPremium = await Premium.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          avgPercentage: { $avg: '$premiumDetails.finalPercentage' },
          avgAmount: { $avg: '$premiumDetails.finalAmount' },
        },
      },
    ]);
    const totalRevenue = await Premium.aggregate([
      { $match: { ...match, 'paymentStatus.status': 'Paid' } },
      { $group: { _id: null, total: { $sum: '$premiumDetails.finalAmount' } } },
    ]);
    const discountImpact = await Premium.aggregate([
      { $match: { ...match, 'premiumDetails.discount.preventiveServiceDiscount': { $gt: 0 } } },
      { $group: { _id: null, totalDiscount: { $sum: '$premiumDetails.discount.preventiveServiceDiscount' } } },
    ]);
    const overdueCount = await Premium.countDocuments({
      ...match,
      'paymentStatus.status': { $in: ['Pending', 'Failed'] },
      'paymentStatus.dueDate': { $lt: new Date() },
    });
    const retrySuccessRate = await Premium.aggregate([
      { $match: match },
      { $unwind: '$paymentStatus.attempts' },
      {
        $group: {
          _id: null,
          totalAttempts: { $sum: 1 },
          successfulAttempts: { $sum: { $cond: [{ $eq: ['$paymentStatus.attempts.status', 'Success'] }, 1, 0] } },
        },
      },
    ]);
    // Align platformPremiums aggregate with schema: handle youtube and otherPlatforms
    const platformPremiums = await Premium.aggregate([
      { $match: match },
      {
        $lookup: {
          from: 'users',
          localField: 'premiumDetails.userId',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      // Add youtube as a platform
      {
        $addFields: {
          platforms: [
            {
              name: 'YouTube',
              totalAmount: '$premiumDetails.finalAmount',
              count: 1,
              avgPercentage: '$premiumDetails.finalPercentage'
            },
            ...'$user.platformInfo.otherPlatforms'
          ]
        }
      },
      { $unwind: '$platforms' },
      { $replaceRoot: { newRoot: { $mergeObjects: [ '$platforms', { totalAmount: '$premiumDetails.finalAmount', count: 1, avgPercentage: '$premiumDetails.finalPercentage' } ] } } },
      {
        $group: {
          _id: '$name',
          totalAmount: { $sum: '$totalAmount' },
          count: { $sum: 1 },
          avgPercentage: { $avg: '$avgPercentage' },
        },
      },
    ]);

    // AI-driven insights (fix model name)
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: process.env.MODEL_GEMINI || 'gemini-1.5-flash' });
    const prompt = `
      You are an AI assistant for Content Creators Insurance (CCI). Analyze the following premium analytics data and provide actionable insights to optimize payment compliance, premium pricing, discount strategies, and risk management. Focus on trends, platform-specific impacts, and revenue opportunities.

      **Analytics Data**:
      - Total Premiums: ${totalPremiums}
      - Status Breakdown: ${JSON.stringify(statusBreakdown)}
      - Average Premium: ${avgPremium[0]?.avgPercentage?.toFixed(2) || 0}% (KSh ${avgPremium[0]?.avgAmount?.toFixed(2) || 0})
      - Total Revenue (KSh): ${totalRevenue[0]?.total?.toFixed(2) || 0}
      - Total Discount Impact (%): ${discountImpact[0]?.totalDiscount?.toFixed(2) || 0}
      - Overdue Premiums: ${overdueCount}
      - Retry Success Rate: ${retrySuccessRate[0]?.successfulAttempts || 0}/${retrySuccessRate[0]?.totalAttempts || 0}
      - Platform Premiums: ${JSON.stringify(platformPremiums)}

      **Instructions**:
      - Analyze payment trends (e.g., high overdue rates, retry failures).
      - Evaluate discount effectiveness (e.g., impact on retention, revenue loss).
      - Suggest premium pricing adjustments based on platform risks or earnings.
      - Recommend strategies to reduce overdue payments (e.g., reminders, incentives).
      - Identify high-risk platforms for targeted interventions.
      - Provide insights in JSON format:
      {
        "insights": [
          {
            "title": "Insight title",
            "description": "Detailed description of the insight",
            "action": "Recommended action to improve outcomes"
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
            action: 'Manually review premium data for payment and pricing trends.',
          },
        ],
      };
    }

    logger.info(`Admin ${req.user.userId} retrieved premium analytics with ${aiInsights.insights.length} AI insights`);
    res.status(200).json({
      success: true,
      analytics: {
        totalPremiums,
        statusBreakdown,
        averagePremium: {
          percentage: avgPremium[0]?.avgPercentage?.toFixed(2) || 0,
          amount: avgPremium[0]?.avgAmount?.toFixed(2) || 0,
        },
        totalRevenue: totalRevenue[0]?.total?.toFixed(2) || 0,
        totalDiscountImpact: discountImpact[0]?.totalDiscount?.toFixed(2) || 0,
        overdueCount,
        retrySuccessRate: retrySuccessRate[0]?.totalAttempts
          ? ((retrySuccessRate[0].successfulAttempts / retrySuccessRate[0].totalAttempts) * 100).toFixed(2)
          : 0,
        platformPremiums,
        aiInsights,
      },
    });
  } catch (error) {
    logger.error(`Error in getPremiumAnalytics: ${error.message}, Stack: ${error.stack}`);
    res.status(500).json({ success: false, error: error.message });
  }
};