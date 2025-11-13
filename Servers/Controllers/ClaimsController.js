// src/controllers/ClaimController.js
import User from '../Models/User.js';
import Premium from '../Models/Premium.js';
import Claim from '../Models/Claim.js';
import Analytics from '../Models/Analytics.js';
import { sendEmail } from '../Services/EmailServices.js';
import logger from '../Utilities/Logger.js';
import upload from '../Utilities/Multer.js';
import fs from 'fs/promises';
import { uploadToCloudinary, deleteFromCloudinary } from '../Utilities/Cloudinary.js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, VerticalAlign } from 'docx';
import { Parser } from 'json2csv';
import { isValidObjectId } from 'mongoose';
import validator from 'validator';

// Initialize Gemini AI (for fallback AI in manual review or analytics; primary fraud in schema method)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  logger.error('Gemini API key is not configured');
  throw new Error('Gemini API key is not configured');
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: process.env.MODEL_GEMINI });

// Common AI safety settings
const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

// Multer middleware for file uploads (max 5 files, 10MB each; optional for claims)
export const uploadClaimFiles = upload.array('evidenceFiles', 5);

// @desc    Submit a new claim (CCI: 4 fields + optional evidence)
// @route   POST /api/claims
// @access  Private (Creator)
export const submitClaim = async (req, res) => {
  try {
    logger.info(`Submitting claim for user ${req.user.id}`);

    // Validate request body (CCI: 4 core fields)
    if (!req.body) {
      logger.error('Request body is undefined');
      return res.status(400).json({ success: false, error: 'Request body is missing' });
    }

    const {
      incidentType,
      incidentDate,
      youTubeEmail = '',
      appealStatus,
      evidenceSummary = '',  // Optional
    } = req.body;

    // Validate required fields
    const requiredFields = { incidentType, incidentDate, appealStatus };
    const missingFields = Object.keys(requiredFields).filter(key => !requiredFields[key]);
    if (missingFields.length > 0) {
      logger.error(`Missing fields: ${missingFields.join(', ')}`);
      return res.status(400).json({ success: false, error: `Missing required fields: ${missingFields.join(', ')}` });
    }

    // Validate data types
    if (!validator.isDate(incidentDate)) {
      return res.status(400).json({ success: false, error: 'Invalid incident date format (use YYYY-MM-DD)' });
    }
    if (!['Full suspension', 'Limited ads', 'Video demonetization'].includes(incidentType)) {
      return res.status(400).json({ success: false, error: 'Invalid incident type' });
    }
    if (!['Not started', 'In progress', 'Rejected'].includes(appealStatus)) {
      return res.status(400).json({ success: false, error: 'Invalid appeal status' });
    }

    // Validate user and active policy
    const user = await User.findById(req.user.id).populate('financialInfo.premium.insuranceId');
    if (!user || user.role !== 'Creator') {
      logger.error(`User check failed: ${req.user.id}`);
      return res.status(403).json({ success: false, error: 'Unauthorized or user not found' });
    }
    if (user.insuranceStatus.status !== 'Approved' || new Date() > user.insuranceStatus.policyEndDate) {
      return res.status(400).json({ success: false, error: 'No active insurance policy' });
    }
    const premium = user.financialInfo.premium.insuranceId;
    if (!premium) {
      return res.status(400).json({ success: false, error: 'No associated premium found' });
    }

    // Process optional evidence files
    let evidenceFiles = [];
    if (req.files?.length > 0) {
      evidenceFiles = await Promise.all(
        req.files.map(async (file, index) => {
          logger.info(`Uploading evidence file: ${file.originalname}`);
          const { url } = await uploadToCloudinary(file, 'claims/evidence');
          await fs.unlink(file.path).catch(err => logger.error(`Failed to delete temp file ${file.path}: ${err.message}`));
          return {
            url,
            type: req.body[`fileType_${index}`] || (
              file.mimetype.startsWith('image/') ? 'Screenshot' :
              file.mimetype === 'application/pdf' ? 'Document' :
              file.mimetype.startsWith('video/') ? 'Video' :
              file.mimetype.includes('text') ? 'Email' : 'Notification'
            ),
            description: req.body[`fileDescription_${index}`] || `Evidence file ${index + 1}`,
            uploadedAt: new Date(),
          };
        })
      );
    }

    // Create claim
    const claim = new Claim({
      claimDetails: {
        userId: req.user.id,
        platform: 'YouTube',  // Fixed for MVP
        incidentType,
        incidentDate: new Date(incidentDate),
        youTubeEmail,
        appealStatus,
      },
      policyId: premium._id,
      evidence: {
        files: evidenceFiles,
        evidenceSummary,
      },
    });

    await claim.save();

    // Auto-process verification (CCI: API pull + fraud + payout)
    const verificationResult = await claim.verifyClaim();

    // Update user claim history
    await User.findByIdAndUpdate(req.user.id, {
      $push: {
        'claimHistory.claims': {
          claimId: claim._id,
          status: verificationResult.status,
          dateSubmitted: claim.createdAt,
          payoutAmount: verificationResult.payout || 0,
        },
      },
    });

    // Send confirmation email with status
    const inAppMessage = claim.statusHistory.history[claim.statusHistory.history.length - 1]?.inAppMessage || 'Claim submitted for review.';
    await sendEmail({
      to: user.personalInfo.email,
      subject: `Claim ${verificationResult.status} - CCI`,
      text: `Your claim (ID: ${claim._id}) has been ${verificationResult.status.toLowerCase()}. ${inAppMessage} Payout: KSh ${verificationResult.payout || 0}.`,
    });

    logger.info(`Claim ${claim._id} submitted and verified for ${req.user.id}: ${verificationResult.status}`);
    return res.status(201).json({
      success: true,
      claimId: claim._id,
      status: verificationResult.status,
      message: 'Claim submitted and processed successfully',
      payout: verificationResult.payout || 0,
      fraudScore: verificationResult.fraudScore || 0,
    });
  } catch (error) {
    logger.error(`submitClaim error: ${error.message}`);
    if (req.files) {
      await Promise.all(
        req.files.map(file => fs.unlink(file.path).catch(err => logger.error(`Failed to delete temp file ${file.path}: ${err.message}`)))
      );
    }
    return res.status(500).json({ success: false, error: 'Server error submitting claim' });
  }
};

// @desc    Update claim evidence (before final review; optional)
// @route   PUT /api/claims/:id/evidence
// @access  Private (Creator)
export const updateClaimEvidence = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid claim ID' });
    }

    const claim = await Claim.findById(id).populate('claimDetails.userId');
    if (!claim) {
      return res.status(404).json({ success: false, error: 'Claim not found' });
    }

    if (claim.claimDetails.userId._id.toString() !== req.user.id.toString()) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    // Only allow before manual review or if under review
    const currentStatus = claim.statusHistory.history[claim.statusHistory.history.length - 1].status;
    if (['Approved', 'Rejected', 'Paid', 'Reinstated'].includes(currentStatus)) {
      return res.status(400).json({ success: false, error: 'Cannot update evidence after final decision' });
    }

    const { evidenceSummary } = req.body;

    // Process new optional files
    let evidenceFiles = claim.evidence.files;
    if (req.files?.length > 0) {
      const newFiles = await Promise.all(
        req.files.map(async (file, index) => {
          const { url } = await uploadToCloudinary(file, 'claims/evidence');
          await fs.unlink(file.path).catch(err => logger.error(`Failed to delete temp file ${file.path}: ${err.message}`));
          return {
            url,
            type: req.body[`fileType_${index}`] || (
              file.mimetype.startsWith('image/') ? 'Screenshot' :
              file.mimetype === 'application/pdf' ? 'Document' :
              file.mimetype.startsWith('video/') ? 'Video' :
              file.mimetype.includes('text') ? 'Email' : 'Notification'
            ),
            description: req.body[`fileDescription_${index}`] || `Additional evidence ${index + 1}`,
            uploadedAt: new Date(),
          };
        })
      );
      evidenceFiles = [...evidenceFiles, ...newFiles];
    }

    // Update evidence
    claim.evidence.files = evidenceFiles;
    claim.evidence.evidenceSummary = evidenceSummary || claim.evidence.evidenceSummary;

    await claim.save();

    // Re-run verification if under review
    if (currentStatus === 'Under Review') {
      const reVerification = await claim.verifyClaim();
      logger.info(`Re-verified claim ${id} after evidence update: ${reVerification.status}`);
    }

    logger.info(`Evidence updated for claim ${id} by ${req.user.id}`);
    return res.json({
      success: true,
      message: 'Evidence updated successfully',
      evidence: claim.evidence,
    });
  } catch (error) {
    logger.error(`updateClaimEvidence error: ${error.message}`);
    if (req.files) {
      await Promise.all(
        req.files.map(file => fs.unlink(file.path).catch(err => logger.error(`Failed to delete temp file ${file.path}: ${err.message}`)))
      );
    }
    return res.status(500).json({ success: false, error: 'Server error updating evidence' });
  }
};

// @desc    Get all claims for the current user
// @route   GET /api/claims/my-claims
// @access  Private (Creator)
export const getMyClaims = async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, page = 1, limit = 10 } = req.query;  // No platform filter (YouTube only)

    const query = { 'claimDetails.userId': userId };
    if (status) {
      query['statusHistory.history'] = { $elemMatch: { status } };
    }

    const claims = await Claim.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('-evaluation.aiAnalysis.reasons')  // Hide sensitive fraud reasons
      .populate('claimDetails.userId', 'personalInfo.fullName')  // Basic user info
      .lean();

    const total = await Claim.countDocuments(query);

    return res.json({
      success: true,
      claims,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error(`getMyClaims error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Server error fetching claims' });
  }
};

// @desc    Get a single claim by ID
// @route   GET /api/claims/:id
// @access  Private (Creator/Admin)
export const getClaimById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid claim ID' });
    }

    const claim = await Claim.findById(id)
      .populate('claimDetails.userId', 'personalInfo.fullName insuranceStatus')
      .populate('policyId', 'premiumDetails.finalAmount')
      .lean();
    if (!claim) {
      return res.status(404).json({ success: false, error: 'Claim not found' });
    }

    if (req.user.role !== 'Admin' && claim.claimDetails.userId._id.toString() !== req.user.id.toString()) {
      logger.error(`Unauthorized access to claim ${id} by ${req.user.id}`);
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    // Hide fraud reasons for creators
    if (req.user.role !== 'Admin') {
      claim.evaluation.aiAnalysis.reasons = undefined;
    }

    return res.json({ success: true, claim });
  } catch (error) {
    logger.error(`getClaimById error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Server error fetching claim' });
  }
};

// @desc    AI evaluate a claim (Enhance fraud scan with Gemini if needed)
// @route   POST /api/claims/:id/evaluate-ai
// @access  Private (Admin)
export const evaluateClaimAI = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid claim ID' });
    }

    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const claim = await Claim.findById(id).populate('claimDetails.userId policyId');
    if (!claim) {
      return res.status(404).json({ success: false, error: 'Claim not found' });
    }

    // Primary: Use schema's scanFraud (AI/ML stub)
    const fraudScore = await claim.scanFraud();

    // Optional: Gemini for confidence/reasons enhancement (if fraudScore 50-75)
    let aiResult = {
      isValid: fraudScore > 75,
      confidenceScore: fraudScore,
      reasons: claim.evaluation.aiAnalysis.reasons,
    };

    if (fraudScore >= 50 && fraudScore <= 75) {
      // Enhance with Gemini for manual review nudge
      const evidenceData = claim.evidence.files.map(file => `${file.type}: ${file.url} (${file.description})`).join('; ');
      const prompt = `
        Enhance fraud analysis for CCI claim. Current fraudScore: ${fraudScore}. Evidence: ${evidenceData}. User earnings baseline: KSh ${claim.evaluation.baselineDaily}/day. Drop: ${claim.evaluation.revenueDropPercent}%. Covered reason: ${claim.evaluation.coveredReason}.
        Output JSON: {"confidenceScore": 0-100, "reasons": [strings], "isValid": bool}
      `;

      const generationConfig = { temperature: 0.7, maxOutputTokens: 500 };
      const result = await model.generateContent(prompt, { generationConfig, safetySettings });
      const geminiEnhance = JSON.parse(result.response.text().replace(/```json\n?/, '').replace(/```\n?/, ''));
      aiResult = {
        ...aiResult,
        confidenceScore: geminiEnhance.confidenceScore || fraudScore,
        reasons: [...aiResult.reasons, ...(geminiEnhance.reasons || [])],
        isValid: geminiEnhance.isValid !== undefined ? geminiEnhance.isValid : aiResult.isValid,
      };
    }

    // Update claim evaluation
    claim.evaluation.aiAnalysis = {
      ...claim.evaluation.aiAnalysis,
      ...aiResult,
    };
    await claim.save();
    await claim.updateStatus('AI Reviewed', req.user.id, `AI fraud score: ${fraudScore}`);

    logger.info(`Claim ${id} AI evaluated: fraudScore ${fraudScore}`);
    return res.json({ success: true, message: 'Claim evaluated by AI', aiResult });
  } catch (error) {
    logger.error(`evaluateClaimAI error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Server error evaluating claim with AI' });
  }
};

// @desc    Manually review a claim (for fraud 50-75)
// @route   POST /api/claims/:id/review-manual
// @access  Private (Admin)
export const reviewClaimManual = async (req, res) => {
  try {
    const { id } = req.params;
    const { isValid, notes } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid claim ID' });
    }

    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    if (typeof isValid !== 'boolean' || !notes) {
      return res.status(400).json({ success: false, error: 'isValid and notes are required' });
    }

    const claim = await Claim.findById(id).populate('claimDetails.userId');
    if (!claim) {
      return res.status(404).json({ success: false, error: 'Claim not found' });
    }

    // Set manual review
    claim.evaluation.manualReview = {
      reviewerId: req.user.id,
      notes,
      isValid,
    };

    const newStatus = isValid ? 'Approved' : 'Rejected';
    const payout = isValid ? await claim.calculatePayout() : 0;
    await claim.updateStatus(newStatus, req.user.id, notes, isValid ? `Approved after review! KSh ${payout} incoming.` : 'Rejected after review.');

    if (isValid) {
      await claim.processPayout(payout);
    }

    // Notify user
    const user = claim.claimDetails.userId;
    const message = `Your claim (ID: ${id}) has been ${newStatus.toLowerCase()}. ${notes}`;
    await sendEmail({
      to: user.personalInfo.email,
      subject: `Claim ${newStatus} - CCI`,
      text: message,
    });

    logger.info(`Claim ${id} manually reviewed: ${newStatus}`);
    return res.json({ success: true, message: `Claim ${newStatus.toLowerCase()}`, claim });
  } catch (error) {
    logger.error(`reviewClaimManual error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Server error reviewing claim' });
  }
};

// @desc    Submit an appeal for a rejected claim (Update appealStatus + re-verify)
// @route   POST /api/claims/:id/appeal
// @access  Private (Creator)
export const submitAppeal = async (req, res) => {
  try {
    const { id } = req.params;
    const { appealStatus, appealNotes = '' } = req.body;  // Update status + notes

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid claim ID' });
    }

    if (!['In progress', 'Rejected'].includes(appealStatus)) {
      return res.status(400).json({ success: false, error: 'Appeal status must be "In progress" or "Rejected"' });
    }

    const claim = await Claim.findById(id).populate('claimDetails.userId');
    if (!claim) {
      return res.status(404).json({ success: false, error: 'Claim not found' });
    }

    if (claim.claimDetails.userId._id.toString() !== req.user.id.toString()) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const currentStatus = claim.statusHistory.history[claim.statusHistory.history.length - 1].status;
    if (currentStatus !== 'Rejected') {
      return res.status(400).json({ success: false, error: 'Only rejected claims can be appealed' });
    }

    // Update appeal status and notes (as evidence summary addendum)
    claim.claimDetails.appealStatus = appealStatus;
    claim.evidence.evidenceSummary += `\nAppeal Notes: ${appealNotes}`;

    // Process optional new files for appeal
    if (req.files?.length > 0) {
      const newFiles = await Promise.all(
        req.files.map(async (file, index) => {
          const { url } = await uploadToCloudinary(file, 'claims/evidence');
          await fs.unlink(file.path).catch(err => logger.error(`Failed to delete temp file ${file.path}: ${err.message}`));
          return {
            url,
            type: req.body[`fileType_${index}`] || (
              file.mimetype.startsWith('image/') ? 'Screenshot' :
              file.mimetype === 'application/pdf' ? 'Document' :
              file.mimetype.startsWith('video/') ? 'Video' :
              file.mimetype.includes('text') ? 'Email' : 'Notification'
            ),
            description: req.body[`fileDescription_${index}`] || `Appeal evidence ${index + 1}`,
            uploadedAt: new Date(),
          };
        })
      );
      claim.evidence.files = [...claim.evidence.files, ...newFiles];
    }

    await claim.save();

    // Re-run verification
    const reVerification = await claim.verifyClaim();

    // Notify admin
    await sendEmail({
      to: process.env.ADMIN_EMAIL || 'admin@cci.com',
      subject: `Appeal for Claim ${id}`,
      text: `User ${req.user.id} appealed claim ${id}. New status: ${appealStatus}. Notes: ${appealNotes}. Re-verified: ${reVerification.status}`,
    });

    logger.info(`Appeal submitted for claim ${id} by ${req.user.id}: ${reVerification.status}`);
    return res.json({
      success: true,
      message: 'Appeal submitted and re-processed',
      status: reVerification.status,
      payout: reVerification.payout || 0,
    });
  } catch (error) {
    logger.error(`submitAppeal error: ${error.message}`);
    if (req.files) {
      await Promise.all(
        req.files.map(file => fs.unlink(file.path).catch(err => logger.error(`Failed to delete temp file ${file.path}: ${err.message}`)))
      );
    }
    return res.status(500).json({ success: false, error: 'Server error submitting appeal' });
  }
};

// @desc    Mark claim as reinstated (Post-appeal success)
// @route   POST /api/claims/:id/reinstate
// @access  Private (Admin)
export const reinstateClaim = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid claim ID' });
    }

    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const claim = await Claim.findById(id).populate('claimDetails.userId');
    if (!claim) {
      return res.status(404).json({ success: false, error: 'Claim not found' });
    }

    if (claim.statusHistory.history[claim.statusHistory.history.length - 1].status !== 'Paid') {
      return res.status(400).json({ success: false, error: 'Claim must be paid before reinstatement' });
    }

    await claim.handleReinstatement(req.user.id);

    const user = claim.claimDetails.userId;
    await sendEmail({
      to: user.personalInfo.email,
      subject: 'Claim Reinstated - Repayment Due - CCI',
      text: `Your claim (ID: ${id}) has been reinstated. Repay KSh ${claim.evaluation.repayAmount} within 30 days.`,
    });

    logger.info(`Claim ${id} reinstated by admin ${req.user.id}`);
    return res.json({ success: true, message: 'Claim reinstated; repayment triggered' });
  } catch (error) {
    logger.error(`reinstateClaim error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Server error reinstating claim' });
  }
};

// @desc    Get all claims (Admin only)
// @route   GET /api/claims/all
// @access  Private (Admin)
export const getAllClaims = async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { status, startDate, endDate, page = 1, limit = 20 } = req.query;
    const query = {};

    if (status) {
      query['statusHistory.history'] = { $elemMatch: { status } };
    }
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const claims = await Claim.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate('claimDetails.userId', 'personalInfo.fullName')
      .populate('policyId', 'premiumDetails.finalAmount')
      .lean();

    const total = await Claim.countDocuments(query);

    return res.json({
      success: true,
      claims,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error(`getAllClaims error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Server error fetching claims' });
  }
};

// @desc    Get claims nearing deadline (7 days)
// @route   GET /api/claims/pending-deadline
// @access  Private (Admin)
export const getPendingDeadlineClaims = async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const now = new Date();
    const claims = await Claim.find({
      resolutionDeadline: { $gte: now, $lte: new Date(now.getTime() + 24 * 60 * 60 * 1000) },  // Next 24h for urgency
      'statusHistory.history': { $elemMatch: { status: { $in: ['Under Review', 'Manual Review'] } } },
    })
      .sort({ resolutionDeadline: 1 })
      .populate('claimDetails.userId', 'personalInfo.fullName')
      .lean();

    return res.json({ success: true, claims });
  } catch (error) {
    logger.error(`getPendingDeadlineClaims error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Server error fetching pending claims' });
  }
};

// @desc    Delete a claim (before review starts)
// @route   DELETE /api/claims/:id
// @access  Private (Creator)
export const deleteClaim = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid claim ID' });
    }

    const claim = await Claim.findById(id).populate('claimDetails.userId');
    if (!claim) {
      return res.status(404).json({ success: false, error: 'Claim not found' });
    }

    if (claim.claimDetails.userId._id.toString() !== req.user.id.toString()) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const currentStatus = claim.statusHistory.history[claim.statusHistory.history.length - 1].status;
    if (currentStatus !== 'Submitted') {
      return res.status(400).json({ success: false, error: 'Cannot delete claim after processing started' });
    }

    // Delete Cloudinary files
    if (claim.evidence.files.length > 0) {
      const deletePromises = claim.evidence.files.map(async (file) => {
        const publicId = file.url.split('/').pop().split('.')[0];
        await deleteFromCloudinary(publicId).catch(err =>
          logger.error(`Failed to delete Cloudinary file ${publicId}: ${err.message}`)
        );
      });
      await Promise.all(deletePromises);
    }

    await Claim.findByIdAndDelete(id);
    await User.findByIdAndUpdate(claim.claimDetails.userId._id, {
      $pull: { 'claimHistory.claims': { claimId: id } },
    });

    logger.info(`Claim ${id} deleted by ${req.user.id}`);
    return res.json({ success: true, message: 'Claim and associated files deleted successfully' });
  } catch (error) {
    logger.error(`deleteClaim error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Server error deleting claim' });
  }
};

// @desc    Get claim analytics with AI insights (Admin only)
// @route   GET /api/claims/analytics
// @access  Private (Admin)
export const getClaimAnalytics = async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      logger.error(`Unauthorized analytics access by ${req.user.id}`);
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { startDate, endDate } = req.query;
    const match = {};
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) match.createdAt.$lte = new Date(endDate);
    }

    // Gather analytics (aligned to schema fields)
    const [totalClaims, statusBreakdown, avgPayout, avgFraudScore, approvalRate, rejectionRate] = await Promise.all([
      Claim.countDocuments(match),
      Claim.aggregate([
        { $match: match },
        { $unwind: '$statusHistory.history' },
        { $group: { _id: '$statusHistory.history.status', count: { $sum: 1 } } },
      ]),
      Claim.aggregate([
        { $match: { ...match, 'evaluation.payoutAmount': { $gt: 0 } } },
        { $group: { _id: null, avgPayout: { $avg: '$evaluation.payoutAmount' } } },
      ]),
      Claim.aggregate([
        { $match: { ...match, 'evaluation.aiAnalysis.fraudScore': { $exists: true } } },
        { $group: { _id: null, avgFraudScore: { $avg: '$evaluation.aiAnalysis.fraudScore' } } },
      ]),
      Claim.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            approved: { $sum: { $cond: [{ $eq: ['$statusHistory.history.status', 'Approved'] }, 1, 0] } },
          },
        },
      ]),
      Claim.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            rejected: { $sum: { $cond: [{ $eq: ['$statusHistory.history.status', 'Rejected'] }, 1, 0] } },
          },
        },
      ]),
    ]);

    // AI insights (Gemini for high-level)
    const prompt = `
      Analyze CCI claim analytics for optimization. Focus on fraud (<1% target), auto-approval (80%), payout fairness.
      Total Claims: ${totalClaims}
      Status Breakdown: ${JSON.stringify(statusBreakdown)}
      Avg Payout (KSh): ${avgPayout[0]?.avgPayout?.toFixed(2) || 0}
      Avg Fraud Score: ${avgFraudScore[0]?.avgFraudScore?.toFixed(2) || 0}
      Approval Rate: ${approvalRate[0]?.total ? ((approvalRate[0].approved / approvalRate[0].total) * 100).toFixed(2) : 0}%
      Rejection Rate: ${rejectionRate[0]?.total ? ((rejectionRate[0].rejected / rejectionRate[0].total) * 100).toFixed(2) : 0}%
      Output JSON: {"insights": [{"title": str, "description": str, "action": str}]}
    `;

    let aiInsights = { insights: [] };
    try {
      const result = await model.generateContent(prompt, { generationConfig: { temperature: 0.7, maxOutputTokens: 1000 }, safetySettings });
      aiInsights = JSON.parse(result.response.text().replace(/```json\n?/, '').replace(/```\n?/, ''));
    } catch (error) {
      logger.error(`AI insights error: ${error.message}`);
    }

    logger.info(`Analytics retrieved by admin ${req.user.id}`);
    return res.json({
      success: true,
      analytics: {
        totalClaims,
        statusBreakdown,
        averagePayout: avgPayout[0]?.avgPayout?.toFixed(2) || 0,
        averageFraudScore: avgFraudScore[0]?.avgFraudScore?.toFixed(2) || 0,
        approvalRate: approvalRate[0]?.total ? ((approvalRate[0].approved / approvalRate[0].total) * 100).toFixed(2) : 0,
        rejectionRate: rejectionRate[0]?.total ? ((rejectionRate[0].rejected / rejectionRate[0].total) * 100).toFixed(2) : 0,
        aiInsights,
      },
    });
  } catch (error) {
    logger.error(`getClaimAnalytics error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Server error fetching analytics' });
  }
};

// @desc    Generate claim report (DOCX or CSV) with AI insights (Admin only)
// @route   GET /api/claims/report
// @access  Private (Admin)
export const generateClaimReport = async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      logger.error(`Unauthorized report access by ${req.user.id}`);
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const admin = await User.findById(req.user.id).lean();
    if (!admin) {
      logger.error(`Admin not found: ${req.user.id}`);
      return res.status(404).json({ success: false, error: 'Admin user not found' });
    }

    const { startDate, endDate, format = 'docx' } = req.query;  // No platform (YouTube only)
    const query = {};
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const claims = await Claim.find(query)
      .select('claimDetails.incidentType evaluation.payoutAmount evaluation.revenueDropPercent statusHistory.history createdAt')
      .populate('claimDetails.userId', 'personalInfo.email')
      .lean();

    if (!claims.length) {
      return res.status(404).json({ success: false, error: 'No claims found for the specified criteria' });
    }

    // Prepare report data (schema-aligned: no reportedLoss, use payout/drop)
    const report = claims.map(claim => ({
      claimId: claim._id.toString(),
      userEmail: claim.claimDetails.userId?.personalInfo.email || 'Unknown',
      incidentType: claim.claimDetails.incidentType,
      revenueDropPercent: claim.evaluation.revenueDropPercent || 0,
      payoutAmount: claim.evaluation.payoutAmount || 0,
      status: claim.statusHistory.history[claim.statusHistory.history.length - 1]?.status || 'Unknown',
      createdAt: claim.createdAt,
    }));

    // Generate AI insights
    const aiInsights = await generateAiInsights(report);

    if (format === 'csv') {
      // Generate CSV
      const fields = ['claimId', 'userEmail', 'incidentType', 'revenueDropPercent', 'payoutAmount', 'status', 'createdAt'];
      const parser = new Parser({ fields });
      const csv = parser.parse(report);

      // Send email with CSV
      await sendEmail({
        to: admin.personalInfo.email,
        subject: 'CCI Claim Report (CSV)',
        text: `Attached is the claim report for ${startDate || 'all time'} to ${endDate || 'now'}.`,
        attachments: [{
          filename: 'CCI_Claim_Report.csv',
          content: csv,
          contentType: 'text/csv',
        }],
      });

      // Send CSV response
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=CCI_Claim_Report.csv');
      return res.send(csv);
    }

    // Generate DOCX
    const doc = await createReportDocument(report, aiInsights, {
      startDate: startDate || 'All time',
      endDate: endDate || 'Now',
      adminEmail: admin.personalInfo.email,
    });

    const buffer = await Packer.toBuffer(doc);

    // Send email with DOCX
    await sendEmail({
      to: admin.personalInfo.email,
      subject: 'CCI Claim Report (DOCX)',
      text: `Attached is the claim report for ${startDate || 'all time'} to ${endDate || 'now'}.`,
      attachments: [{
        filename: 'CCI_Claim_Report.docx',
        content: buffer,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }],
    });

    // Send DOCX response
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename=CCI_Claim_Report.docx');
    return res.send(buffer);
  } catch (error) {
    logger.error(`generateClaimReport error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Server error generating report' });
  }
};

// Helper: Generate AI insights (Schema-aligned)
async function generateAiInsights(reportData) {
  const prompt = `
    Analyze CCI claim report for optimization. Total Claims: ${reportData.length}
    Total Payout (KSh): ${reportData.reduce((sum, r) => sum + r.payoutAmount, 0).toFixed(2)}
    Avg Drop %: ${reportData.reduce((sum, r) => sum + r.revenueDropPercent, 0) / reportData.length || 0}%
    Status Breakdown: ${JSON.stringify(reportData.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {}))}
    Output JSON: {"insights": [{"title": str, "description": str, "action": str, "priority": "high/medium/low"}]}
  `;

  try {
    const result = await model.generateContent(prompt, { generationConfig: { temperature: 0.7, maxOutputTokens: 1500 }, safetySettings });
    return JSON.parse(result.response.text().replace(/```json\s*|\s*```/g, '').trim());
  } catch (error) {
    logger.error(`generateAiInsights error: ${error.message}`);
    return {
      insights: [{
        title: 'Analysis Error',
        description: 'Unable to generate AI insights.',
        action: 'Manually review report.',
        priority: 'medium',
      }],
    };
  }
}

// Helper: Create DOCX document (Schema-aligned fields)
async function createReportDocument(claims, aiInsights, metadata) {
  // Create claim rows
  const claimRows = claims.map(claim => new TableRow({
    children: [
      new TableCell({
        children: [new Paragraph({ text: claim.claimId.slice(-6) })],
        width: { size: 3000, type: WidthType.DXA },
        verticalAlign: VerticalAlign.CENTER,
      }),
      new TableCell({
        children: [new Paragraph({ text: claim.userEmail })],
        width: { size: 3500, type: WidthType.DXA },
        verticalAlign: VerticalAlign.CENTER,
      }),
      new TableCell({
        children: [new Paragraph({ text: claim.incidentType })],
        width: { size: 4500, type: WidthType.DXA },
        verticalAlign: VerticalAlign.CENTER,
      }),
      new TableCell({
        children: [new Paragraph({ text: `${claim.revenueDropPercent?.toFixed(1) || 0}%` })],
        width: { size: 2500, type: WidthType.DXA },
        verticalAlign: VerticalAlign.CENTER,
      }),
      new TableCell({
        children: [new Paragraph({ text: `KSh ${claim.payoutAmount.toFixed(2)}` })],
        width: { size: 3500, type: WidthType.DXA },
        verticalAlign: VerticalAlign.CENTER,
      }),
      new TableCell({
        children: [new Paragraph({ text: claim.status })],
        width: { size: 3000, type: WidthType.DXA },
        verticalAlign: VerticalAlign.CENTER,
      }),
    ],
  }));

  // Create insight sections
  const insightSections = aiInsights.insights.map(insight => [
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
        new TextRun({ text: 'Action: ', bold: true }),
        new TextRun(insight.action),
      ],
      spacing: { after: 200 },
    }),
  ]).flat();

  // Create document
  return new Document({
    sections: [{
      properties: {},
      children: [
        // Header
        new Paragraph({
          text: 'Content Creators Insurance (CCI)',
          heading: HeadingLevel.HEADING_1,
          spacing: { after: 200 },
        }),
        new Paragraph({
          text: 'Claims Report with AI Insights',
          heading: HeadingLevel.HEADING_2,
          spacing: { after: 200 },
        }),
        // Metadata
        new Paragraph({
          text: `Period: ${metadata.startDate} to ${metadata.endDate}`,
          spacing: { after: 100 },
        }),
        new Paragraph({
          text: `Generated: ${new Date().toLocaleString()}`,
          spacing: { after: 100 },
        }),
        new Paragraph({
          text: `For: ${metadata.adminEmail}`,
          spacing: { after: 200 },
        }),
        // Summary
        new Paragraph({
          text: 'Summary',
          heading: HeadingLevel.HEADING_3,
          spacing: { after: 100 },
        }),
        new Paragraph({
          text: `Total Claims: ${claims.length}`,
          spacing: { after: 50 },
        }),
        new Paragraph({
          text: `Total Payout: KSh ${claims.reduce((sum, r) => sum + r.payoutAmount, 0).toFixed(2)}`,
          spacing: { after: 200 },
        }),
        // Claims table
        new Paragraph({
          text: 'Claims Details',
          heading: HeadingLevel.HEADING_3,
          spacing: { after: 100 },
        }),
        new Table({
          rows: [
            // Header row
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ text: 'Claim ID' })], width: { size: 3000, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER }),
                new TableCell({ children: [new Paragraph({ text: 'User Email' })], width: { size: 3500, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER }),
                new TableCell({ children: [new Paragraph({ text: 'Incident Type' })], width: { size: 4500, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER }),
                new TableCell({ children: [new Paragraph({ text: 'Revenue Drop %' })], width: { size: 2500, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER }),
                new TableCell({ children: [new Paragraph({ text: 'Payout (KSh)' })], width: { size: 3500, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER }),
                new TableCell({ children: [new Paragraph({ text: 'Status' })], width: { size: 3000, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER }),
              ],
            }),
            ...claimRows,
          ],
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),
        // Insights
        new Paragraph({
          text: 'AI Insights',
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 },
        }),
        ...insightSections,
      ],
    }],
  });
}