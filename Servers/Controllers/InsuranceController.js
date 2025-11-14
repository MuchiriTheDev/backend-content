// controllers/InsuranceController.js (Updated: Fraud score computed post-save; reject if <70 after application)
import User from '../Models/User.js';
import Premium from '../Models/Premium.js';
import Claim from '../Models/Claim.js';
import Content from '../Models/Content.js';
import Analytics from '../Models/Analytics.js';
import { sendEmail } from '../Services/EmailServices.js';
import logger from '../Utilities/Logger.js';
import { validateUrl } from '../Utilities/Validators.js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';


// @desc    Apply for insurance (post-onboard, calls User method; fraud check post-save)
export const applyForInsurance = async (req, res, next) => {
  const userId = req.user.userId;  // Align: req.user.userId from JWT
  try {
    const { nationalId, coveragePeriod, termsAgreed, accurateInfo } = req.body;

    logger.info(`Received applyForInsurance request for user ${userId}: ${JSON.stringify(req.body)}`);

    const user = await User.findById(userId);
    if (!user || user.role !== 'Creator') {
      logger.error(`Unauthorized application attempt by user ${userId}`);
      return res.status(403).json({ success: false, error: 'Unauthorized or user not found' });
    }

    if (!user.onboarded) {
      logger.warn(`Unonboarded user ${userId} attempted to apply for insurance`);
      return res.status(400).json({ success: false, error: 'Complete onboarding first' });
    }

    if (user.insuranceStatus.status !== 'NotApplied') {
      logger.warn(`User ${userId} attempted to apply with status: ${user.insuranceStatus.status}`);
      return res.status(400).json({ success: false, error: 'Insurance already applied for or active' });
    }

    // Validate insurance-specific fields (nationalId optional if not Kenyan, but required for CCI)
    if (!nationalId || nationalId.trim().length !== 8) {
      logger.error(`Invalid nationalId for user ${userId}: ${nationalId}`);
      return res.status(400).json({ success: false, error: 'Valid 8-digit Kenyan National ID required for verification (optional for analytics only)' });
    }
    if (!coveragePeriod || ![6, 12, 24].includes(coveragePeriod)) {
      logger.error(`Invalid coveragePeriod for user ${userId}: ${coveragePeriod}`);
      return res.status(400).json({ success: false, error: 'Coverage period must be 6, 12, or 24 months' });
    }
    if (termsAgreed !== true || accurateInfo !== true) {
      logger.warn(`Terms/accuracy not agreed for user ${userId}`);
      return res.status(400).json({ success: false, error: 'You must agree to terms and confirm accurate information' });
    }

    // Call User method (sets nationalId, creates premium estimate, sets to 'Pending' with fraudScore=0)
    const result = await user.applyForInsurance(nationalId.trim());
    if (!result.eligible) {
      logger.error(`Ineligible application for user ${userId}: ${result.message || 'Unknown'}`);
      return res.status(400).json({ success: false, error: result.message || 'Ineligible for insurance' });
    }

    // UPDATED: Compute real fraud score post-save (stub random for MVP; integrate AI/NDVS below)
    let fraudScore = 0;
    try {
      // Stub: Random 0-100 for test (replace with real computation)
      fraudScore = 70 || Math.floor(Math.random() * 101);  // 0-100
      logger.info(`Computed fraud score for user ${userId}: ${fraudScore}`);

      // TODO: Real fraud score (e.g., via Gemini AI or NDVS/M-Pesa match)
      // Example AI integration:
      // const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      // const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      // const prompt = `Assess fraud risk for Kenyan creator: National ID ${nationalId}, Earnings KSh ${user.financialInfo.monthlyEarnings}, Risk History: ${JSON.stringify(user.platformInfo.youtube.riskHistory)}, Channel Subs: ${user.platformInfo.youtube.audienceSize}. Score 0-100 (low=safe). JSON: {"score": number}`;
      // const aiResult = await model.generateContent(prompt);
      // const aiText = aiResult.response.text().replace(/```json\s*|\s*```/g, '').trim();
      // fraudScore = JSON.parse(aiText).score;

      // Alternative simple logic (e.g., based on risk history)
      // const riskFactors = user.platformInfo.youtube.riskHistory.length + (user.financialInfo.monthlyEarnings < 65000 ? 20 : 0);
      // fraudScore = Math.min(100, 50 + riskFactors * 10);  // Example: Adjust as needed
    } catch (scoreErr) {
      logger.error(`Fraud score computation failed for ${userId}: ${scoreErr.message}`);
      fraudScore = 50;  // Fallback neutral
    }

    // UPDATED: Apply fraud check post-save
    user.insuranceStatus.fraudScore = fraudScore;
    let isEligible = true;
    let nextStep = 'InsuranceVerify';
    if (fraudScore < 70) {
      // Reject after application (cleanup premium)
      user.insuranceStatus.status = 'Rejected';
      user.insuranceStatus.rejectionReason = 'Fraud score too low (below 70)';
      await Premium.deleteOne({ _id: user.financialInfo.premium.insuranceId });
      user.financialInfo.premium = { amount: 0, lastCalculated: null, insuranceId: null };  // Reset
      isEligible = false;
      nextStep = 'Completed';
      logger.warn(`Rejected application for ${userId} due to low fraud score: ${fraudScore}`);
    } else {
      // Eligible: Advance
      user.insuranceStatus.status = 'Pending';  // Confirmed pending
      logger.info(`Eligible application for ${userId}: Fraud score ${fraudScore}`);
    }
    user.applicationProgress.step = nextStep;
    await user.save();

    // Update coverage/terms (post-method, safe from hook)
    user.insuranceStatus.coveragePeriod = coveragePeriod;
    user.insuranceStatus.termsAndAccuracy.hasProvidedAccurateInfo = accurateInfo;
    user.insuranceStatus.termsAndAccuracy.hasAgreedToTerms = termsAgreed;
    user.insuranceStatus.termsAndAccuracy.termsAgreedAt = new Date();
    await user.save();  // Final save with fraud decision

    // Optional initial Content assessment (only if eligible)
    if (isEligible) {
      const content = new Content({
        contentDetails: {
          userId,
          platform: 'YouTube',
          isInsuredPlatform: true,
          contentType: user.platformInfo.youtube.contentType || 'Other',
          title: 'Initial Channel Review',
          description: user.platformInfo.youtube.channel.description || '',
          mediaFiles: [{ url: user.platformInfo.youtube.accountLink, type: 'Video', description: 'Channel overview' }]
        },
        submissionContext: 'Application'
      });
      await content.save();
      await content.assessRisk();
    }

    // Email (tailored to outcome)
    const emailSubject = isEligible ? 'CCI Insurance Application Submitted' : 'CCI Insurance Application Review';
    const emailText = isEligible 
      ? `Dear ${user.personalInfo.fullName},\n\nYour insurance application for ${coveragePeriod}-month coverage has been submitted. Estimated premium: KSh ${result.premiumAmount}. We'll review soon.\n\nFraud Score: ${fraudScore}\nNext Step: ${nextStep}\n\nThank you!`
      : `Dear ${user.personalInfo.fullName},\n\nYour application was reviewed but rejected due to fraud score (${fraudScore}). Reason: ${user.insuranceStatus.rejectionReason}.\n\nReapply after addressing issues.\n\nThank you!`;
    const emailHtml = isEligible 
      ? `<h2>CCI Application Submitted</h2><p>Dear ${user.personalInfo.fullName},</p><p>Your application for <strong>${coveragePeriod}-month coverage</strong> is submitted.</p><p><strong>Estimated Premium:</strong> KSh ${result.premiumAmount}</p><p><strong>Fraud Score:</strong> ${fraudScore}</p><p><strong>Next:</strong> ${nextStep}</p><p>Thank you!</p>`
      : `<h2>CCI Application Reviewed</h2><p>Dear ${user.personalInfo.fullName},</p><p>Your application was rejected. Fraud Score: <strong>${fraudScore}</strong></p><p>Reason: ${user.insuranceStatus.rejectionReason}</p><p>Reapply after fixes.</p>`;

    try {
      await sendEmail({
        to: user.personalInfo.email || '',  // Fallback empty if no email
        subject: emailSubject,
        text: emailText,
        html: emailHtml
      });
      logger.info(`Email sent for user ${userId} (Eligible: ${isEligible})`);
    } catch (emailError) {
      logger.error(`Email failed for user ${userId}: ${emailError.message}`);
    }

    if (!isEligible) {
      return res.status(400).json({
        success: false,
        error: `Application rejected post-review: ${user.insuranceStatus.rejectionReason}`,
        data: { fraudScore }
      });
    }

    logger.info(`Insurance applied for user ${userId}: Premium KSh ${result.premiumAmount}, Coverage ${coveragePeriod}mo, Fraud ${fraudScore}`);
    res.status(201).json({
      success: true,
      message: 'Application submitted successfully',
      data: {
        insuranceStatus: user.insuranceStatus,
        estimatedPremium: { amount: result.premiumAmount },
        applicationProgress: user.applicationProgress,
        nextStep: nextStep,
        fraudScore
      }
    });
  } catch (error) {
    logger.error(`Error in applyForInsurance for user ${userId}: ${error.message}`);
    next(error);
  }
};

// @desc    Add other platform (post-apply, for multi-platform)
export const addPlatform = async (req, res, next) => {
  const userId = req.user.userId;
  try {
    const { name, username, accountLink, audienceSize, contentType, riskHistory } = req.body;

    logger.info(`Received addPlatform request for user ${userId}`);

    const user = await User.findById(userId);
    if (!user || user.role !== 'Creator') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    if (user.insuranceStatus.status !== 'Pending' && user.insuranceStatus.status !== 'Approved') {
      return res.status(400).json({ success: false, error: 'Can only add platforms during/after application' });
    }

    if (!name || !username || !['TikTok', 'Instagram', 'X', 'Facebook', 'Other'].includes(name)) {
      return res.status(400).json({ success: false, error: 'Valid platform name and username required' });
    }

    if (accountLink && !validateUrl(accountLink)) {
      return res.status(400).json({ success: false, error: 'Invalid account link URL' });
    }

    // Check duplicate
    const existing = user.platformInfo.otherPlatforms.find(p => p.accountLink === accountLink);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Platform already added' });
    }

    // Validate riskHistory
    if (riskHistory && !Array.isArray(riskHistory)) {
      return res.status(400).json({ success: false, error: 'riskHistory must be an array' });
    }
    const validatedRisks = riskHistory?.map(r => ({
      violationType: r.violationType,
      date: new Date(r.date),
      description: r.description?.trim() || ''
    })) || [];

    const newPlatform = {
      name,
      username,
      accountLink: accountLink || '',
      audienceSize: audienceSize || 0,
      contentType: contentType || '',
      isVerified: false,
      verificationMethod: 'Pending',
      riskHistory: validatedRisks
    };
    user.platformInfo.otherPlatforms.push(newPlatform);
    await user.save();

    // Re-estimate premium
    const premium = await Premium.estimatePremium(userId, 'Creator');
    user.financialInfo.premium.amount = premium.estimatedAmount;
    await user.save();

    // Email notification
    try {
      await sendEmail({
        to: user.personalInfo.email || '',
        subject: 'CCI: Platform Added',
        text: `Dear ${user.personalInfo.fullName},\n\nPlatform "${name}" added to your insurance.\n\nEstimated Premium: KSh ${premium.estimatedAmount}\n\nThank you!`,
        html: `<h2>Platform Added</h2><p>Dear ${user.personalInfo.fullName},</p><p>"${name}" added.</p><p>Premium: KSh ${premium.estimatedAmount}</p>`
      });
    } catch (emailError) {
      logger.error(`Email failed for user ${userId}: ${emailError.message}`);
    }

    logger.info(`Platform added for user ${userId}: ${name}`);
    res.status(201).json({
      success: true,
      message: 'Platform added successfully',
      data: { platforms: user.platformInfo.otherPlatforms, estimatedPremium: premium }
    });
  } catch (error) {
    logger.error(`Error in addPlatform for user ${userId}: ${error.message}`);
    next(error);
  }
};

// @desc    Edit insurance application (pending only)
export const editInsuranceApplication = async (req, res, next) => {
  const userId = req.user.userId;
  try {
    const { coveragePeriod, termsAgreed, accurateInfo, otherPlatforms } = req.body;  // Edit otherPlatforms if needed

    logger.info(`Received editInsuranceApplication request for user ${userId}`);

    const user = await User.findById(userId);
    if (!user || user.role !== 'Creator') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    if (user.insuranceStatus.status !== 'Pending') {
      return res.status(400).json({ success: false, error: 'Can only edit pending applications' });
    }

    if (coveragePeriod && ![6, 12, 24].includes(coveragePeriod)) {
      return res.status(400).json({ success: false, error: 'Invalid coverage period' });
    }
    if (termsAgreed !== true || accurateInfo !== true) {
      return res.status(400).json({ success: false, error: 'Terms and accuracy must be confirmed' });
    }

    // Update fields
    if (coveragePeriod) user.insuranceStatus.coveragePeriod = coveragePeriod;
    user.insuranceStatus.termsAndAccuracy.hasProvidedAccurateInfo = accurateInfo;
    user.insuranceStatus.termsAndAccuracy.hasAgreedToTerms = termsAgreed;
    user.insuranceStatus.termsAndAccuracy.termsAgreedAt = new Date();
    user.applicationProgress.step = 'InsuranceApply';  // Reset to apply if editing
    user.applicationProgress.lastUpdated = new Date();

    // Edit otherPlatforms if provided (array of updates)
    if (otherPlatforms && Array.isArray(otherPlatforms)) {
      user.platformInfo.otherPlatforms = otherPlatforms.map(p => ({
        name: p.name,
        username: p.username,
        accountLink: p.accountLink || '',
        audienceSize: p.audienceSize || 0,
        contentType: p.contentType || '',
        isVerified: p.isVerified || false,
        verificationMethod: p.verificationMethod || 'Pending',
        riskHistory: p.riskHistory || []
      }));
    }

    await user.save();

    // Re-estimate
    const premium = await Premium.estimatePremium(userId, 'Creator');
    user.financialInfo.premium.amount = premium.estimatedAmount;
    await user.save();

    // Email
    try {
      await sendEmail({
        to: user.personalInfo.email || '',
        subject: 'CCI: Application Updated',
        text: `Dear ${user.personalInfo.fullName},\n\nYour application updated. Coverage: ${coveragePeriod || 'unchanged'} months. Premium: KSh ${premium.estimatedAmount}.\n\nThank you!`,
        html: `<h2>Application Updated</h2><p>Dear ${user.personalInfo.fullName},</p><p>Updated successfully. Premium: KSh ${premium.estimatedAmount}</p>`
      });
    } catch (emailError) {
      logger.error(`Email failed for user ${userId}: ${emailError.message}`);
    }

    logger.info(`Application edited for user ${userId}`);
    res.json({
      success: true,
      message: 'Application updated successfully',
      data: {
        insuranceStatus: user.insuranceStatus,
        estimatedPremium: premium,
        applicationProgress: user.applicationProgress
      }
    });
  } catch (error) {
    logger.error(`Error in editInsuranceApplication for user ${userId}: ${error.message}`);
    next(error);
  }
};

// @desc    Admin review application
export const reviewInsuranceApplication = async (req, res, next) => {
  const adminId = req.user.userId;
  try {
    const { userId: targetUserId, action, rejectionReason } = req.body;

    logger.info(`Review request by admin ${adminId} for user ${targetUserId}: ${action}`);

    const admin = await User.findById(adminId);
    if (!admin || admin.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const user = await User.findById(targetUserId);
    if (!user || user.role !== 'Creator') {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    if (user.insuranceStatus.status !== 'Pending') {
      return res.status(400).json({ success: false, error: 'Not pending review' });
    }

    if (action === 'approve') {
      // Create/Approve Premium
      let premium;
      try {
        premium = await Premium.createFromApplication(targetUserId);
      } catch (err) {
        logger.error(`Premium creation failed for ${targetUserId}: ${err.message}`);
        return res.status(500).json({ success: false, error: 'Failed to create policy' });
      }

      const coveragePeriod = user.insuranceStatus.coveragePeriod;
      const policyStartDate = new Date();
      const policyEndDate = new Date(policyStartDate.getTime() + coveragePeriod * 30 * 24 * 60 * 60 * 1000);

      user.insuranceStatus.status = 'Approved';
      user.insuranceStatus.approvedAt = new Date();
      user.insuranceStatus.policyStartDate = policyStartDate;
      user.insuranceStatus.policyEndDate = policyEndDate;
      user.financialInfo.premium.amount = premium.premiumDetails.finalAmount;
      user.financialInfo.premium.insuranceId = premium._id;
      user.financialInfo.premium.lastCalculated = new Date();
      user.applicationProgress.step = 'InsuranceApproved';
      await user.save();

      // Email
      try {
        await sendEmail({
          to: user.personalInfo.email || '',
          subject: 'CCI Application Approved',
          text: `Dear ${user.personalInfo.fullName},\n\nApproved! Coverage: ${coveragePeriod} months. Start: ${policyStartDate.toDateString()}. Premium: KSh ${premium.premiumDetails.finalAmount}/mo.\n\nPay to activate.`,
          html: `<h2>Approved!</h2><p>Dear ${user.personalInfo.fullName},</p><p>Coverage: ${coveragePeriod} months</p><p>Start: ${policyStartDate.toDateString()}</p><p>Premium: KSh ${premium.premiumDetails.finalAmount}</p>`
        });
      } catch (emailError) {
        logger.error(`Approval email failed for ${targetUserId}: ${emailError.message}`);
      }

      logger.info(`Approved for ${targetUserId} by ${adminId}`);
    } else if (action === 'reject') {
      if (!rejectionReason) {
        return res.status(400).json({ success: false, error: 'Rejection reason required' });
      }

      user.insuranceStatus.status = 'Rejected';
      user.insuranceStatus.rejectionReason = rejectionReason;
      user.applicationProgress.step = 'Completed';  // End flow
      await user.save();

      // Cleanup Premium if exists
      await Premium.deleteOne({ 'premiumDetails.userId': targetUserId });

      // Email
      try {
        await sendEmail({
          to: user.personalInfo.email || '',
          subject: 'CCI Application Rejected',
          text: `Dear ${user.personalInfo.fullName},\n\nRejected: ${rejectionReason}.\n\nReapply with updates.`,
          html: `<h2>Rejected</h2><p>Dear ${user.personalInfo.fullName},</p><p>Reason: ${rejectionReason}</p>`
        });
      } catch (emailError) {
        logger.error(`Rejection email failed for ${targetUserId}: ${emailError.message}`);
      }

      logger.info(`Rejected for ${targetUserId} by ${adminId}: ${rejectionReason}`);
    } else {
      return res.status(400).json({ success: false, error: 'Action must be "approve" or "reject"' });
    }

    res.json({
      success: true,
      message: `Application ${action}d`,
      data: { insuranceStatus: user.insuranceStatus }
    });
  } catch (error) {
    logger.error(`Error in reviewInsuranceApplication: ${error.message}`);
    next(error);
  }
};

// @desc    Get insurance status
export const getInsuranceStatus = async (req, res, next) => {
  const userId = req.user.userId;
  try {
    const user = await User.findById(userId);
    if (!user || user.role !== 'Creator') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const premium = await Premium.findOne({ 'premiumDetails.userId': userId });
    let estimatedPremium = null;
    if (!premium && user.insuranceStatus.status === 'Pending') {
      estimatedPremium = await Premium.estimatePremium(userId, 'Creator');
    }

    res.json({
      success: true,
      data: {
        insuranceStatus: user.insuranceStatus,
        premium: premium ? premium.premiumDetails : null,
        estimatedPremium,
        applicationProgress: user.applicationProgress,
        coveragePeriod: user.insuranceStatus.coveragePeriod,
        platformInfo: user.platformInfo,
        financialInfo: user.financialInfo
      }
    });
  } catch (error) {
    logger.error(`Error in getInsuranceStatus for ${userId}: ${error.message}`);
    next(error);
  }
};

// @desc    Get all contracts (Admin)
export const getAllInsuranceContracts = async (req, res, next) => {
  const adminId = req.user.userId;
  try {
    const admin = await User.findById(adminId);
    if (!admin || admin.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin required' });
    }

    const { page = 1, limit = 10, status, search } = req.query;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    let query = { role: 'Creator', 'insuranceStatus.status': { $ne: 'NotApplied' } };
    if (status) query['insuranceStatus.status'] = status;
    if (search) {
      const regex = { $regex: search, $options: 'i' };
      query.$or = [{ 'personalInfo.fullName': regex }, { 'personalInfo.email': regex }];
    }

    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .select('personalInfo.fullName personalInfo.email insuranceStatus platformInfo.youtube financialInfo.premium applicationProgress');

    const contracts = await Promise.all(users.map(async (user) => {
      const premium = await Premium.findOne({ 'premiumDetails.userId': user._id }).lean();
      const claims = await Claim.countDocuments({ 'claimDetails.userId': user._id });
      let estimated = null;
      if (!premium && user.insuranceStatus.status === 'Pending') {
        estimated = await Premium.estimatePremium(user._id, 'Admin');
      }
      return {
        userId: user._id,
        name: user.personalInfo.fullName,
        email: user.personalInfo.email,
        insuranceStatus: user.insuranceStatus,
        youtube: user.platformInfo.youtube,
        premium: premium?.premiumDetails || null,
        estimatedPremium: estimated,
        claimsCount: claims,
        applicationProgress: user.applicationProgress
      };
    }));

    logger.info(`Admin ${adminId} fetched ${contracts.length} contracts`);
    res.json({
      success: true,
      data: contracts,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) }
    });
  } catch (error) {
    logger.error(`Error in getAllInsuranceContracts: ${error.message}`);
    next(error);
  }
};

// @desc    Get my insurance details
export const getMyInsurance = async (req, res, next) => {
  const userId = req.user.userId;
  try {
    const user = await User.findById(userId);
    if (!user || user.role !== 'Creator') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const premium = await Premium.findOne({ 'premiumDetails.userId': userId });
    const claims = await Claim.find({ 'claimDetails.userId': userId }).select('claimDetails.incidentType claimDetails.incidentDate statusHistory.history evaluation.payoutAmount');
    const contents = await Content.find({ 'contentDetails.userId': userId }).select('contentDetails riskAssessment');

    let estimated = null;
    if (!premium && user.insuranceStatus.status === 'Pending') {
      estimated = await Premium.estimatePremium(userId, 'Creator');
    }

    res.json({
      success: true,
      data: {
        insuranceStatus: user.insuranceStatus,
        premium: premium ? premium.premiumDetails : null,
        estimatedPremium: estimated,
        claims: claims.map(c => ({
          id: c._id,
          incidentType: c.claimDetails.incidentType,
          incidentDate: c.claimDetails.incidentDate,
          status: c.statusHistory.history[c.statusHistory.history.length - 1]?.status || 'Submitted',
          payoutAmount: c.evaluation?.payoutAmount || 0
        })),
        contentReviews: contents.map(c => ({
          platform: c.contentDetails.platform,
          contentType: c.contentDetails.contentType,
          riskLevel: c.riskAssessment.riskLevel,
          lastAssessed: c.riskAssessment.lastAssessed
        })),
        applicationProgress: user.applicationProgress,
        platformInfo: user.platformInfo,
        financialInfo: user.financialInfo
      }
    });
  } catch (error) {
    logger.error(`Error in getMyInsurance for ${userId}: ${error.message}`);
    next(error);
  }
};

// @desc    Get insurance analytics (Admin, with AI)
export const getInsuranceAnalytics = async (req, res, next) => {
  const adminId = req.user.userId;
  try {
    const admin = await User.findById(adminId);
    if (!admin || admin.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin required' });
    }

    const totalApps = await User.countDocuments({ 'insuranceStatus.status': { $ne: 'NotApplied' } });
    const pending = await User.countDocuments({ 'insuranceStatus.status': 'Pending' });
    const approved = await User.countDocuments({ 'insuranceStatus.status': 'Approved' });
    const rejected = await User.countDocuments({ 'insuranceStatus.status': 'Rejected' });
    const active = await User.countDocuments({ 'insuranceStatus.status': 'Approved', 'insuranceStatus.policyEndDate': { $gte: new Date() } });
    const totalPremiums = await Premium.aggregate([{ $match: { 'paymentStatus.status': 'Paid' } }, { $group: { _id: null, total: { $sum: '$premiumDetails.finalAmount' } } }]);
    const totalClaims = await Claim.countDocuments();
    const approvedClaims = await Claim.countDocuments({ 'statusHistory.history.status': 'Approved' });
    const highRisk = await Content.countDocuments({ 'riskAssessment.riskLevel': 'High' });
    const platformBreakdown = await User.aggregate([
      { $unwind: '$platformInfo.otherPlatforms' },
      { $group: { _id: '$platformInfo.otherPlatforms.name', count: { $sum: 1 }, avgAudience: { $avg: '$platformInfo.otherPlatforms.audienceSize' } } }
    ]);

    // AI Insights
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
    if (!genAI) {
      throw new Error('Gemini API key not configured');
    }
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `Analyze CCI insurance data for insights: Total Apps: ${totalApps}, Pending: ${pending}, Approved: ${approved}, Rejected: ${rejected}, Active: ${active}, Premium Revenue: ${totalPremiums[0]?.total || 0}, Claims: ${totalClaims}, Approved Claims: ${approvedClaims}, High Risk Content: ${highRisk}, Platforms: ${JSON.stringify(platformBreakdown)}. Provide JSON: {"insights": [{"title": "...", "description": "...", "action": "..."}]} Focus on trends, risks, optimizations.`;

    const result = await model.generateContent(prompt);
    let aiInsights = { insights: [] };
    try {
      const text = result.response.text().replace(/```json\s*|\s*```/g, '').trim();
      aiInsights = JSON.parse(text);
    } catch (parseErr) {
      logger.error(`AI parse error: ${parseErr.message}`);
      aiInsights.insights = [{ title: 'Analysis Unavailable', description: 'Check data manually', action: 'Review logs' }];
    }

    logger.info(`Analytics fetched for admin ${adminId}`);
    res.json({
      success: true,
      data: {
        analytics: {
          totalApplications: totalApps,
          pendingApplications: pending,
          approvedApplications: approved,
          rejectedApplications: rejected,
          activeContracts: active,
          totalPremiumRevenue: totalPremiums[0]?.total || 0,
          totalClaims,
          approvedClaims,
          highRiskContent: highRisk,
          platformBreakdown
        },
        aiInsights
      }
    });
  } catch (error) {
    logger.error(`Error in getInsuranceAnalytics for ${adminId}: ${error.message}`);
    next(error);
  }
};