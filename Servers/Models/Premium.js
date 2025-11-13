// Premium Schema (Full Rewrite: Insurance-Only, Created on Apply)
import mongoose from 'mongoose';
import User from './User.js';
// import logger from '../Utilities/Logger.js';  // Uncomment when ready

const { Schema } = mongoose;

// Define the Premium schema (CCI: 2-5% of earnings, monthly, post-apply only)
const premiumSchema = new Schema({
  premiumDetails: {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    applicationDate: { type: Date, default: Date.now },  // Timestamp of insurance apply
    basePercentage: { type: Number, min: 0, required: true, default: 2 },  // 2% base
    currency: { type: String, default: 'KSh', trim: true },
    adjustmentFactors: {
      earningsPercentage: { type: Number, min: 0, default: 0 },  // From analytics pull
      audienceSizePercentage: { type: Number, min: 0, default: 0 },
      contentRiskPercentage: { type: Number, min: 0, default: 0 },  // From Content assess
      platformVolatility: { type: Number, min: 0, max: 100, default: 0 },  // YouTube-specific
      infractionPercentage: { type: Number, min: 0, default: 0 },
      riskExplanation: { type: String, trim: true, default: '' },
    },
    discount: {
      percentage: { type: Number, min: 0, max: 100, default: 0 },
      reason: { type: String, trim: true, default: '' },
      preventiveServiceDiscount: {
        type: Number, min: 0, max: 15, default: 0,  // For AI content reviews
      },
    },
    finalPercentage: { type: Number, min: 2, max: 5, default: 2 },  // Locked to CCI range
    finalAmount: { type: Number, min: 1000, max: 5000, required: true },  // KSh 1k-5k
    monthlyCap: { type: Number, default: 65000 },  // Payout coverage limit
    manualAdjustment: {
      percentage: { type: Number, default: 0 },
      reason: { type: String, trim: true, default: '' },
      adjustedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      adjustedAt: { type: Date, default: null },
    },
    adjustmentHistory: [{
      percentage: { type: Number, required: true },
      reason: { type: String, trim: true, required: true },
      adjustedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      adjustedAt: { type: Date, default: Date.now },
      newFinalAmount: { type: Number, min: 0, required: true },
      newFinalPercentage: { type: Number, min: 0, required: true },
    }],
  },
  estimationHistory: {
    creatorEstimations: [{
      date: { type: Date, default: Date.now },
      estimatedPercentage: { type: Number, min: 0 },
      estimatedAmount: { type: Number, min: 0 },
      factors: {
        earningsPercentage: { type: Number, min: 0 },
        audienceSizePercentage: { type: Number, min: 0 },
        contentRiskPercentage: { type: Number, min: 0 },
        platformVolatility: { type: Number, min: 0, max: 100 },
        infractionPercentage: { type: Number, min: 0 },
      },
      riskExplanation: { type: String, trim: true },
    }],
    adminEstimations: [{
      date: { type: Date, default: Date.now },
      estimatedPercentage: { type: Number, min: 0 },
      estimatedAmount: { type: Number, min: 0 },
      factors: {
        earningsPercentage: { type: Number, min: 0 },
        audienceSizePercentage: { type: Number, min: 0 },
        contentRiskPercentage: { type: Number, min: 0 },
        platformVolatility: { type: Number, min: 0, max: 100 },
        infractionPercentage: { type: Number, min: 0 },
      },
      riskExplanation: { type: String, trim: true },
      estimatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    }],
  },
  calculationHistory: {
    calculations: [{
      date: { type: Date, default: Date.now },
      basePercentage: { type: Number, min: 0 },
      adjustmentFactors: {
        earningsPercentage: { type: Number, min: 0 },
        audienceSizePercentage: { type: Number, min: 0 },
        contentRiskPercentage: { type: Number, min: 0 },
        platformVolatility: { type: Number, min: 0, max: 100 },
        infractionPercentage: { type: Number, min: 0 },
        riskExplanation: { type: String, trim: true },
      },
      discount: {
        percentage: { type: Number, min: 0, max: 100 },
        reason: { type: String, trim: true },
      },
      finalPercentage: { type: Number, min: 0 },
      finalAmount: { type: Number, min: 0 },
      calculatedBy: { type: Schema.Types.Mixed },
      manualAdjustment: {
        percentage: { type: Number },
        reason: { type: String, trim: true },
      },
    }],
  },
  paymentStatus: {
    status: { type: String, enum: ['Pending', 'Paid', 'Overdue', 'Failed'], default: 'Pending' },
    dueDate: { type: Date, required: true },
    paymentDate: { type: Date, default: null },
    paymentMethod: {
      type: { type: String, enum: ['M-Pesa'], default: 'M-Pesa' },  // CCI: M-Pesa only
      details: { type: String, trim: true, default: '' },
    },
    transactionId: { type: String, trim: true, default: '' },
    attempts: [{
      date: { type: Date, default: Date.now },
      status: { type: String, enum: ['Success', 'Failed'] },
      errorMessage: { type: String, trim: true },
    }],
  },
  billingCycle: { type: String, enum: ['Monthly'], default: 'Monthly' },
  renewalCount: { type: Number, default: 0 },
  lastRenewedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  nextCalculationDate: { type: Date, default: null },
}, { timestamps: true });

// Indexes
premiumSchema.index({ 'premiumDetails.userId': 1, 'paymentStatus.dueDate': 1 });
premiumSchema.index({ 'paymentStatus.status': 1 });

// Pre-save: Set next calc date; dueDate set in createFromApplication
premiumSchema.pre('save', function (next) {
  if (this.isNew) {
    const now = new Date();
    this.nextCalculationDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);  // Monthly recalc
  }
  next();
});

// Method: Check for discounts (e.g., low fraud/AI reviews)
premiumSchema.methods.checkContentReviewDiscount = async function () {
  // Stub: Tie to Content reviews or fraud <1%
  const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const user = await User.findById(this.premiumDetails.userId);
  const fraudRate = user.insuranceStatus.fraudScore > 90 ? 0.5 : 1.5;  // Mock <1%
  let discountPct = 0;
  if (fraudRate < 1) {
    discountPct = 10;  // Example: Low fraud discount
    this.premiumDetails.discount.percentage = discountPct;
    this.premiumDetails.discount.reason = 'Low fraud + preventive AI discount';
    this.premiumDetails.discount.preventiveServiceDiscount = 5;
  }
  const monthlyEarnings = user.financialInfo.monthlyEarnings || 0;
  let adjustedPercentage = this.premiumDetails.basePercentage - (discountPct / 100);
  adjustedPercentage = Math.max(Math.min(adjustedPercentage, 5), 2);  // 2-5% lock
  this.premiumDetails.finalPercentage = adjustedPercentage;
  this.premiumDetails.finalAmount = Math.max(Math.min((adjustedPercentage / 100) * monthlyEarnings, 5000), 1000);
  await this.save();
  return fraudRate < 1;
};

// Static: Estimate (for preview) or create on apply
premiumSchema.statics.estimatePremium = async function (userId, estimatorRole = 'Creator', estimatorId = null) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');
  if (user.financialInfo.monthlyEarnings < 65000) {
    return { eligible: false, message: 'Min KSh 65k/mo required' };
  }
  const basePercentage = 2;
  const finalPercentage = basePercentage;  // Stub: Enhance with factors/AI later
  const finalAmount = Math.max(Math.min((finalPercentage / 100) * user.financialInfo.monthlyEarnings, 5000), 1000);
  const estimationData = {
    date: new Date(),
    estimatedPercentage: finalPercentage,
    estimatedAmount: finalAmount,
    factors: { earningsPercentage: 0, audienceSizePercentage: 0, contentRiskPercentage: 0, platformVolatility: 0, infractionPercentage: 0 },
    riskExplanation: 'CCI Basic Estimate: 2-5% of earnings',
  };
  let premium = await this.findOne({ 'premiumDetails.userId': userId });
  if (!premium) {
    premium = new this({
      premiumDetails: {
        userId,
        basePercentage,
        finalPercentage,
        finalAmount,
        applicationDate: new Date(),  // For estimates too
      },
      paymentStatus: { 
        status: 'Pending', 
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        paymentMethod: { type: 'M-Pesa' }
      },
    });
  }
  if (estimatorRole === 'Creator') {
    premium.estimationHistory.creatorEstimations.push(estimationData);
  } else if (estimatorRole === 'Admin') {
    premium.estimationHistory.adminEstimations.push({ ...estimationData, estimatedBy: estimatorId });
  }
  await premium.save();
  return { estimatedPercentage: finalPercentage, estimatedAmount: finalAmount, eligible: true };
};

// New Static: Create Premium from Insurance Application (Gated)
premiumSchema.statics.createFromApplication = async function (userId) {
  const user = await User.findById(userId);
  if (!user || user.financialInfo.monthlyEarnings < 65000) {
    throw new Error('User ineligible: Min KSh 65k/mo earnings required for CCI');
  }
  if (user.insuranceStatus.fraudScore < 70) {
    throw new Error('Fraud score too low for approval');
  }
  // Call estimate to get base
  const estimate = await this.estimatePremium(userId, 'Admin', null);
  const { estimatedPercentage: finalPercentage, estimatedAmount: finalAmount } = estimate;
  const premium = new this({
    premiumDetails: {
      userId,
      basePercentage: 2,
      finalPercentage,
      finalAmount,
      monthlyCap: 65000,
      applicationDate: new Date(),
    },
    paymentStatus: { 
      status: 'Pending', 
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),  // 7-day grace for first pay
      paymentMethod: { type: 'M-Pesa', details: user.personalInfo.phoneNumber || '' }
    },
  });
  await premium.save();
  // logger.info(`CCI Premium created for user ${userId}: KSh ${finalAmount}/mo`);
  return premium;
};

// Method: Recalculate (e.g., on earnings update)
premiumSchema.methods.recalculatePremium = async function (adminId = null) {
  await this.checkContentReviewDiscount();
  const user = await User.findById(this.premiumDetails.userId);
  const monthlyEarnings = user.financialInfo.monthlyEarnings || 0;
  this.premiumDetails.finalAmount = Math.max(Math.min((this.premiumDetails.finalPercentage / 100) * monthlyEarnings, 5000), 1000);
  this.calculationHistory.calculations.push({
    date: new Date(),
    basePercentage: this.premiumDetails.basePercentage,
    adjustmentFactors: this.premiumDetails.adjustmentFactors,
    discount: this.premiumDetails.discount,
    finalPercentage: this.premiumDetails.finalPercentage,
    finalAmount: this.premiumDetails.finalAmount,
    calculatedBy: adminId || 'System',
  });
  this.paymentStatus.dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await this.save();
  return { finalPercentage: this.premiumDetails.finalPercentage, finalAmount: this.premiumDetails.finalAmount };
};

// Method: Manual adjust (Admin only)
premiumSchema.methods.adjustPremium = async function (adjustmentPercentage, reason, adminId) {
  const user = await User.findById(this.premiumDetails.userId);
  const monthlyEarnings = user.financialInfo.monthlyEarnings || 0;
  let newFinalAmount = this.premiumDetails.finalAmount * (1 + adjustmentPercentage / 100);
  newFinalAmount = Math.max(Math.min(newFinalAmount, 5000), 1000);
  let newFinalPercentage = monthlyEarnings > 0 ? (newFinalAmount / monthlyEarnings) * 100 : this.premiumDetails.finalPercentage;
  newFinalPercentage = Math.max(Math.min(newFinalPercentage, 5), 2);
  this.premiumDetails.finalAmount = newFinalAmount;
  this.premiumDetails.finalPercentage = newFinalPercentage;
  this.premiumDetails.manualAdjustment = { percentage: adjustmentPercentage, reason, adjustedBy: adminId, adjustedAt: new Date() };
  this.premiumDetails.adjustmentHistory.push({
    percentage: adjustmentPercentage,
    reason,
    adjustedBy: adminId,
    adjustedAt: new Date(),
    newFinalAmount,
    newFinalPercentage,
  });
  await this.save();
  return newFinalAmount;
};

const Premium = mongoose.model('Premium', premiumSchema);

export default Premium;