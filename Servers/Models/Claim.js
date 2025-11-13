// Claim Schema (Simplified: CCI 4 Fields, Auto-Pulls, AI Fraud, 70% Payout)
import mongoose from 'mongoose';
import Premium from './Premium.js';
import User from './User.js';
import Analytics from './Analytics.js';  // For pulls

const { Schema } = mongoose;

// Sub-schema for Claim Details (CCI: 4 fields only, dropdowns)
const claimDetailsSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  platform: { type: String, enum: ['YouTube'], required: true, default: 'YouTube' },
  incidentType: {
    type: String,
    enum: ['Full suspension', 'Limited ads', 'Video demonetization'],  // CCI dropdown
    required: true
  },
  incidentDate: { type: Date, required: true },
  youTubeEmail: { type: String, trim: true, maxlength: 500, default: '' },  // Optional (text or upload ref)
  appealStatus: {
    type: String,
    enum: ['Not started', 'In progress', 'Rejected'],
    required: true
  }
});

// Sub-schema for Evidence (CCI: Optional, API-preferred)
const evidenceSchema = new Schema({
  files: [{
    url: { type: String, required: true },
    type: { 
      type: String, 
      enum: ['Screenshot', 'Video', 'Document', 'Email', 'Notification'], 
      required: true 
    },
    description: { 
      type: String, 
      trim: true, 
      maxlength: 500, 
      default: ''  // Optional
    },
    uploadedAt: { type: Date, default: Date.now }
  }],  // Optional
  evidenceSummary: {
    type: String,
    trim: true,
    minlength: [10, 'Brief summary needed'],
    maxlength: 200,
    default: ''  // Optional
  }
});

// Sub-schema for Evaluation (CCI: Auto-pull, AI fraud, 70% formula)
const evaluationSchema = new Schema({
  // Auto-pulled from Analytics/YouTube APIs
  revenueDropPercent: { type: Number, min: 0, max: 100 },  // ≥70% for 3+ days vs 7-day avg
  lostDays: { type: Number, min: 0, default: 0 },  // Auto-calculated duration of drop
  baselineDaily: { type: Number, min: 0 },  // Avg revenue (day-7 to day-1 pre-incident)
  verifiedEarningsLoss: { type: Number, min: 0 },  // 70% of baseline * lostDays
  coveredReason: {  // Auto-map from incidentType/API
    type: String,
    enum: ['AD_SUITS', 'POLICY_UPDATE', 'TEMP_SUSPEND', 'GLITCH', 'COPYRIGHT', 'OTHER_NOT_COVERED'],  // Added COPYRIGHT for mismatch flag
    default: 'OTHER_NOT_COVERED'
  },
  monetizationStatus: { type: String, enum: ['LIMITED', 'SUSPENDED', 'NONE'], default: 'NONE' },  // From YouTube Data API
  strikes: { type: Number, min: 0, default: 0 },  // Community guidelines strikes
  doubleDipCheck: { type: Boolean, default: false },  // Same event in last 30d
  aiAnalysis: {
    isValid: { type: Boolean, default: null },
    confidenceScore: { type: Number, min: 0, max: 100 },
    fraudScore: { type: Number, min: 0, max: 100, default: 0 },  // >75 auto-pay
    reasons: [{ type: String, trim: true }]  // Flags e.g., 'revenueSpike:20'
  },
  manualReview: {
    reviewerId: { type: Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, trim: true, maxlength: 1000 },
    isValid: { type: Boolean, default: null }
  },
  payoutAmount: { type: Number, min: 0 },  // Capped via Premium
  payoutDate: { type: Date },
  mPesaTransactionId: { type: String, trim: true },
  repayAmount: { type: Number, min: 0, default: 0 },  // 50% of payout if reinstated
  reinstated: { type: Boolean, default: false },  // Flag for post-claim reversal
  evaluationDate: { type: Date, default: Date.now }
});

// Sub-schema for Status History (CCI: In-app messages)
const statusHistorySchema = new Schema({
  history: [{
    status: {
      type: String,
      enum: ['Submitted', 'Under Review', 'AI Reviewed', 'Manual Review', 'Approved', 'Rejected', 'Paid', 'Reinstated'],
      required: true
    },
    date: { type: Date, default: Date.now },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    notes: { type: String, trim: true, maxlength: 500 },
    inAppMessage: { type: String, trim: true, default: '' }  // e.g., "Approved! KSh 23,520 incoming."
  }]
});

// Main Claim Schema
const claimSchema = new Schema({
  claimDetails: { type: claimDetailsSchema, required: true },
  policyId: { type: Schema.Types.ObjectId, ref: 'Premium', required: true },
  evidence: { type: evidenceSchema, default: () => ({}) },  // Optional
  evaluation: { type: evaluationSchema, default: () => ({}) },
  statusHistory: { 
    type: statusHistorySchema, 
    default: () => ({ history: [{ status: 'Submitted', date: new Date() }] })
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  resolutionDeadline: { type: Date }
}, {
  timestamps: true
});

// Indexes
claimSchema.index({ 'claimDetails.userId': 1, createdAt: -1 });
claimSchema.index({ 'statusHistory.history.status': 1 });
claimSchema.index({ resolutionDeadline: 1 });
claimSchema.index({ 'evaluation.doubleDipCheck': 1 });  // For quick duplicate checks

// Pre-save: CCI flow (active policy, YouTube, optional evidence) - Moved heavy checks to methods for perf
claimSchema.pre('save', function (next) {
  if (this.isNew) {
    this.resolutionDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);  // 7 days (SLA: 80% in 10, target 7)
    this.evaluation.evaluationDate = new Date();
  }
  this.updatedAt = new Date();
  next();
});

// Update status (with CCI message)
claimSchema.methods.updateStatus = async function (newStatus, updatedBy, notes = '', message = '') {
  this.statusHistory.history.push({
    status: newStatus,
    updatedBy,
    notes,
    inAppMessage: message,
    date: new Date()
  });
  await this.save();
  return this.statusHistory.history[this.statusHistory.history.length - 1];  // Return latest for response
};

// Auto-pull data (enhanced: from Analytics + YouTube stubs; calc lostDays dynamically)
claimSchema.methods.autoPullData = async function () {
  const analytics = await Analytics.findOne({ userId: this.claimDetails.userId });
  if (!analytics) throw new Error('No analytics data');
  
  // Enhanced drop detection (vs 7-day pre-incident avg)
  const incidentDate = this.claimDetails.incidentDate;
  const history = analytics.youtube.metrics.earningsHistory.filter(h => h.date < incidentDate).slice(-7);  // 7 days pre-incident
  const baselineAvg = history.length > 0 ? history.reduce((sum, h) => sum + h.amount, 0) / history.length : analytics.youtube.metrics.avgDailyRevenue90d;
  
  // Post-incident drop (last 3+ days)
  const postHistory = analytics.youtube.metrics.earningsHistory.filter(h => h.date >= incidentDate).slice(0, 10);  // Up to 10 days check
  const recentAvg = postHistory.length > 0 ? postHistory.reduce((sum, h) => sum + h.amount, 0) / postHistory.length : 0;
  const drop = baselineAvg > 0 ? Math.max(0, ((baselineAvg - recentAvg) / baselineAvg) * 100) : 0;
  const lostDays = postHistory.filter(h => h.amount < (baselineAvg * 0.3)).length;  // Days <30% of baseline (≥3 for qual)
  
  this.evaluation.revenueDropPercent = drop;
  this.evaluation.baselineDaily = baselineAvg;
  this.evaluation.lostDays = Math.max(3, lostDays);  // Min 3 for eligibility
  this.evaluation.monetizationStatus = 'LIMITED';  // Stub; real: YouTube Data API
  this.evaluation.strikes = 0;  // Stub; real: API pull
  
  await this.save();
  return { drop, lostDays, baselineAvg };
};

// Payout formula (CCI: 70% * lostDays, cap monthly)
claimSchema.methods.calculatePayout = async function () {
  const baseline = this.evaluation.baselineDaily || 0;
  const payoutDaily = baseline * 0.70;
  const premium = await Premium.findById(this.policyId);
  const monthlyCap = premium?.premiumDetails.monthlyCap || 65000;
  const total = Math.min(payoutDaily * this.evaluation.lostDays, monthlyCap);
  this.evaluation.payoutAmount = total;
  this.evaluation.verifiedEarningsLoss = total;
  await this.save();
  return total;
};

// Enforce coverage (CCI reasons)
claimSchema.methods.enforceCoverage = function () {
  const covered = ['AD_SUITS', 'POLICY_UPDATE', 'TEMP_SUSPEND', 'GLITCH'];
  if (covered.includes(this.evaluation.coveredReason) && 
      this.evaluation.revenueDropPercent >= 70 && 
      this.evaluation.lostDays >= 3 &&
      this.evaluation.strikes < 3) {  // No perm ban
    return 'approve';
  }
  return 'reject';
};

// Fraud scan (enhanced: Pull from User/Analytics; weights from CCI doc)
claimSchema.methods.scanFraud = async function () {
  let score = 100;  // Start high
  const flags = {};
  
  const user = await User.findById(this.claimDetails.userId);
  const analytics = await Analytics.findOne({ userId: this.claimDetails.userId });
  
  // Revenue spike before drop (+200% in 48h pre-incident)
  const preHistory = analytics?.youtube.metrics.earningsHistory.filter(h => 
    h.date < this.claimDetails.incidentDate && 
    h.date > new Date(this.claimDetails.incidentDate.getTime() - 2 * 24 * 60 * 60 * 1000)
  ) || [];
  const preAvg = preHistory.length > 0 ? preHistory.reduce((sum, h) => sum + h.amount, 0) / preHistory.length : 0;
  const spike = preAvg > (this.evaluation.baselineDaily * 2) ? 20 : 0;
  flags.revenueSpike = spike;
  
  // Mass video upload (stub: >5 videos same day pre-drop)
  flags.massUpload = user.platformInfo.youtube.videos.length > 5 && user.platformInfo.youtube.videos.slice(-5).every(v => 
    Math.abs(v.publishedAt.getTime() - user.platformInfo.youtube.videos[0].publishedAt.getTime()) < 24 * 60 * 60 * 1000
  ) ? 15 : 0;
  
  // Traffic from 1 IP block (stub: future log analysis)
  flags.ipBlock = 0;  // Placeholder
  
  // API says copyright, user says glitch
  flags.copyrightMismatch = this.evaluation.coveredReason === 'COPYRIGHT' && this.incidentType !== 'Video demonetization' ? 25 : 0;
  
  // Appeal rejected
  flags.appealRejected = this.claimDetails.appealStatus === 'Rejected' ? 10 : 0;
  
  // Channel <6 mo old
  const channelAge = (new Date() - new Date(user.platformInfo.youtube.channel.publishedAt || Date.now())) / (1000 * 60 * 60 * 24 * 30);  // Months
  flags.newChannel = channelAge < 6 ? 10 : 0;
  
  // Name mismatch (M-Pesa vs ID)
  const mpesaName = user.financialInfo.paymentMethod.details.mobileNumber;  // Stub; real: Daraja pull
  flags.nameMismatch = user.personalInfo.fullName !== mpesaName ? 5 : 0;  // Simplified
  
  const totalPenalty = Object.values(flags).reduce((a, b) => a + b, 0);
  score -= totalPenalty;
  score = Math.max(0, score);
  
  this.evaluation.aiAnalysis.fraudScore = score;
  this.evaluation.aiAnalysis.isValid = score > 75;
  this.evaluation.aiAnalysis.confidenceScore = 90;  // Stub; real AI
  this.evaluation.aiAnalysis.reasons = Object.entries(flags).filter(([k, v]) => v > 0).map(([k, v]) => `${k}:${v}`);
  
  await this.save();
  return score;
};

// Full Verification Flow (CCI: Steps 1-5; call post-creation)
claimSchema.methods.verifyClaim = async function () {
  // Step 1: Auto-pull
  await this.autoPullData();
  if (this.evaluation.revenueDropPercent < 70 || this.evaluation.lostDays < 3) {
    const message = 'Not covered: No qualifying income loss (≥70% for 3+ days).';
    await this.updateStatus('Rejected', null, message, message);
    return { status: 'Rejected', reason: message };
  }

  // Step 2: Map coveredReason from incidentType (stub; real: API)
  const typeMap = {
    'Full suspension': 'TEMP_SUSPEND',
    'Limited ads': 'AD_SUITS',
    'Video demonetization': 'POLICY_UPDATE'
  };
  this.evaluation.coveredReason = typeMap[this.claimDetails.incidentType] || 'OTHER_NOT_COVERED';

  // Step 3: Coverage check
  const coverageResult = this.enforceCoverage();
  if (coverageResult === 'reject') {
    const message = `Not covered: ${this.evaluation.coveredReason} detected.`;
    await this.updateStatus('Rejected', null, message, message);
    return { status: 'Rejected', reason: message };
  }

  // Step 4: Double-dip check (same event last 30d)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentClaims = await Claim.find({
    'claimDetails.userId': this.claimDetails.userId,
    incidentDate: { $gte: thirtyDaysAgo },
    'statusHistory.history': { $elemMatch: { status: { $in: ['Approved', 'Paid'] } } },
    _id: { $ne: this._id }
  });
  const isDuplicate = recentClaims.some(c => 
    Math.abs(c.claimDetails.incidentDate.getTime() - this.claimDetails.incidentDate.getTime()) < 24 * 60 * 60 * 1000  // Same day
  );
  this.evaluation.doubleDipCheck = isDuplicate;
  if (isDuplicate) {
    const message = 'Not covered: Duplicate claim for same event.';
    await this.updateStatus('Rejected', null, message, message);
    return { status: 'Rejected', reason: message };
  }

  // Step 5: Fraud scan
  const fraudScore = await this.scanFraud();
  await this.calculatePayout();  // Always calc for reference
  const payout = this.evaluation.payoutAmount;

  const reviewMessage = 'Big drop detected. Verifying in 24h.';
  if (fraudScore > 75) {
    // Auto-approve & pay
    const approveDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);  // 7 days
    const approveMessage = `Claim approved! KSh ${Math.round(payout)} hits your M-Pesa on ${approveDate.toDateString()}.`;
    await this.updateStatus('Approved', null, '', approveMessage);
    await this.processPayout(payout);
    return { status: 'Paid', payout, fraudScore };
  } else if (fraudScore >= 50) {
    await this.updateStatus('Manual Review', null, '', reviewMessage);
    return { status: 'Under Review', needsManual: true, fraudScore };
  } else {
    const rejectMessage = 'Not covered: High fraud risk detected.';
    await this.updateStatus('Rejected', null, rejectMessage, rejectMessage);
    // Blacklist: Lower user fraudScore
    user.insuranceStatus.fraudScore = Math.max(0, user.insuranceStatus.fraudScore - 20);
    await user.save();
    return { status: 'Rejected', reason: rejectMessage, fraudScore };
  }
};

// Process Payout (M-Pesa Stub; real: Daraja STK Push)
claimSchema.methods.processPayout = async function (amount) {
  // Real: Integrate Daraja API for B2C/STK
  this.evaluation.payoutDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);  // 7 days from now
  this.evaluation.mPesaTransactionId = `TXN_${Date.now()}_${Math.round(Math.random() * 1000000)}`;  // Mock
  await this.updateStatus('Paid', null);
  
  // Update User claimHistory
  await User.findByIdAndUpdate(this.claimDetails.userId, {
    $push: { 
      'claimHistory.claims': { 
        claimId: this._id, 
        status: 'Paid', 
        dateSubmitted: this.createdAt, 
        payoutAmount: amount 
      } 
    }
  });
  
  // Compliance: Log for 80% SLA check
  console.log(`Payout processed: Claim ${this._id}, Amount: KSh ${amount}`);  // Replace with logger
  return this.evaluation.mPesaTransactionId;
};

// Handle Reinstatement (Post-claim: 50% repay within 30d)
claimSchema.methods.handleReinstatement = async function (reinstatedBy = null) {
  if (!this.reinstated && this.statusHistory.history.some(h => h.status === 'Paid')) {
    this.evaluation.reinstated = true;
    this.evaluation.repayAmount = this.evaluation.payoutAmount * 0.50;
    const repayDeadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const message = `Reinstated! Repay KSh ${Math.round(this.evaluation.repayAmount)} within 30 days (by ${repayDeadline.toDateString()}) to avoid blacklist.`;
    await this.updateStatus('Reinstated', reinstatedBy || null, 'Appeal successful', message);
    
    // Penalty: Adjust user fraudScore down
    const user = await User.findById(this.claimDetails.userId);
    user.insuranceStatus.fraudScore = Math.max(50, user.insuranceStatus.fraudScore - 10);  // Min 50
    await user.save();
    
    await this.save();
    return { repayAmount: this.evaluation.repayAmount, deadline: repayDeadline };
  }
  throw new Error('Not eligible for reinstatement or already handled');
};

const Claim = mongoose.model('Claim', claimSchema);

export default Claim;