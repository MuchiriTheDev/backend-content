// User Schema (Updated: Removed auto-reject from pre-save; fraud check moved to controller)
import mongoose from 'mongoose';
import logger from '../Utilities/Logger.js';
// import bcrypt from 'bcryptjs';  // Uncomment if fallback auth needed

const { Schema } = mongoose;

// Sub-schema for Personal Information (Light for onboard, insurance-gated extras)
const personalInfoSchema = new Schema({
  fullName: { type: String, required: true, trim: true },  // From YouTube or input
  nationalId: {  // Added for CCI verification (NDVS/M-Pesa match)
    type: String,
    trim: true,
    match: [/^\d{8}$/, 'Invalid Kenyan National ID (8 digits)'],
    default: '',  // Optional for analytics onboard; required during insurance apply
  },
  phoneNumber: { 
    type: String,
    trim: true,
    match: [/^\+254\d{9}$/, 'Valid Kenyan phone required for M-Pesa later'],
    default: ''  // Optional for pure analytics onboard
  },
  email: { 
    type: String, 
    lowercase: true, 
    trim: true, 
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    default: ''  // Optional
  },
  dateOfBirth: { type: Date, default: null },  // Optional
  country: { type: String, default: 'Kenya', enum: ['Kenya'], required: true },
});

// Sub-schema for Platform Information (YouTube focus, auto-pulls for analytics)
const platformInfoSchema = new Schema({
  youtube: {  // Required for MVP
    id: { type: String, required: true },  // Channel ID from OAuth (removed unique – handle in controller)
    accessToken: { type: String, required: true },      // For pulls
    refreshToken: String,
    profile: {
      name: String,  // Channel title
      picture: String,  // Thumbnail
    },
    channel: {  // Auto-fetched via YouTube API
      title: { type: String, required: true },
      description: String,
      subscriberCount: { type: Number, min: 0, default: 0 },
      viewCount: { type: Number, min: 0, default: 0 },
      videoCount: { type: Number, min: 0, default: 0 },
      uploadPlaylistId: String,
      videos: [{  // Recent for dashboard/analytics
        id: String,
        title: String,
        publishedAt: Date,
        viewCount: { type: Number, min: 0 },
      }],
    },
    username: { type: String, required: true, trim: true },
    accountLink: { type: String, required: true, trim: true },  // Channel URL
    audienceSize: { type: Number, min: 0, default: 0 },  // Subs
    contentType: {  // Niche for CCI
      type: String, 
      enum: ['Comedy', 'Education', 'Vlogs', 'Gaming', 'Music', 'Other', 'Tech', 'Beauty', 'Fitness', 'Travel', 'Food', 'Sports'], 
      default: undefined  // Set during onboard or apply
    },
    // Auto-pulled for analytics/eligibility
    avgDailyRevenue90d: { type: Number, min: 0, default: 0 },
    watchHours90d: { type: Number, min: 0, default: 0 },
    pastDemonetization: { type: Boolean, default: false },  // Checkbox for CCI
    isVerified: { type: Boolean, default: true },  // Via OAuth
    verificationMethod: { type: String, enum: ['API'], default: 'API' },
    riskHistory: [{
      violationType: { type: String, enum: ['Demonetization', 'Suspension', 'Ban'], trim: true },
      date: { type: Date, default: Date.now },
      description: { type: String, trim: true },
    }],
  },
  otherPlatforms: [{  // Stub for future multi-platform analytics
    name: { type: String, enum: ['TikTok', 'Instagram', 'X', 'Facebook', 'Other'] },
    username: String,
    accountLink: String,
    audienceSize: Number,
    contentType: String,
    isVerified: Boolean,
    verificationMethod: String,
    riskHistory: [{}],
  }],
});

// Sub-schema for Financial Information (Analytics-first, insurance optional)
const financialInfoSchema = new Schema({
  monthlyEarnings: { 
    type: Number, 
    min: 0,  // Allow 0 for non-earning analytics users
    default: 0,  // Auto-computed from YouTube Analytics API
    set: function(v) { return Math.max(v, 0); },  // Prevent direct set
  },
  currency: { type: String, default: 'KSh', trim: true },
  paymentMethod: {
    type: { type: String, enum: ['M-Pesa', 'Bank', 'PayPal', 'Other'], default: 'M-Pesa' },
    details: {
      mobileNumber: { 
        type: String, 
        trim: true,
        default: ''  // Populated during insurance apply
      },
      accountNumber: { type: String, trim: true, default: '' },
      bankName: { type: String, trim: true, default: '' },
    },
  },
  premium: {  // Optional: Populated on insurance apply
    amount: { type: Number, min: 0, default: 0 },
    lastCalculated: { type: Date, default: null },
    discountApplied: { type: Boolean, default: false },
    insuranceId: { type: Schema.Types.ObjectId, ref: 'Premium', default: null },
  },
  analyticsId: { type: Schema.Types.ObjectId, ref: 'Analytics', default: null },  // Core for dashboard
});

// Sub-schema for Claim History (Insurance-only, but stubbed)
const claimHistorySchema = new Schema({
  claims: [{
    claimId: { type: Schema.Types.ObjectId, ref: 'Claim' },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
    dateSubmitted: { type: Date, default: Date.now },
    payoutAmount: { type: Number, min: 0 },
  }],
});

// Sub-schema for Insurance Status (Optional, activated on apply)
const insuranceStatusSchema = new Schema({
  status: {
    type: String,
    enum: ['NotApplied', 'Pending', 'Approved', 'Rejected', 'Surrendered'],
    default: 'NotApplied',
  },
  appliedAt: { type: Date, default: null },  // Renamed from applyDate for clarity
  approvedAt: { type: Date, default: null },
  surrenderedAt: { type: Date, default: null },
  rejectionReason: { type: String, trim: true, default: '' },
  policyStartDate: { type: Date, default: null },
  policyEndDate: { type: Date, default: null },
  renewalRemindedAt: { type: Date, default: null },
  lastRenewedAt: { type: Date, default: null },
  coveragePeriod: {
    type: Number,
    enum: [6, 12, 24],
    default: 6,
    required: function () { return this.status === 'Approved'; },
  },
  termsAndAccuracy: {
    hasProvidedAccurateInfo: { type: Boolean, required: true, default: false },
    hasAgreedToTerms: { type: Boolean, required: true, default: false },
    termsAgreedAt: { type: Date, required: function () { return this.hasAgreedToTerms === true; }, default: null },
  },
  fraudScore: { type: Number, min: 0, max: 100, default: 0 },  // For insurance verification (>70 approve)
});

// Main User Schema
const userSchema = new Schema({
  personalInfo: { type: personalInfoSchema, required: true },
  platformInfo: { type: platformInfoSchema, required: true },
  financialInfo: { type: financialInfoSchema, required: true },
  claimHistory: { type: claimHistorySchema, default: () => ({ claims: [] }) },
  insuranceStatus: { type: insuranceStatusSchema, default: () => ({}) },
  // Auth: OAuth primary
  auth: {
    youtubeId: String,  // Quick lookup
    password: { type: String, select: false },  // Fallback optional
    resetPasswordToken: { type: String, default: '' },
    resetPasswordExpire: { type: Date, default: null },
  },
  applicationProgress: {
    step: { 
      type: String, 
      enum: [
        // Onboarding steps (analytics focus)
        'OnboardOAuth', 'OnboardPersonal', 'OnboardPlatform', 'OnboardFinancial', 'Onboarded',
        // Insurance apply steps (post-onboard)
        'InsuranceApply', 'InsuranceVerify', 'InsuranceApproved'
      ], 
      default: 'OnboardOAuth' 
    },
    lastUpdated: { type: Date, default: Date.now },
  },
  role: { type: String, enum: ['Creator', 'Admin'], default: 'Creator' },
  isVerified: { type: Boolean, default: false },
  onboarded: { type: Boolean, default: false },  // True post-general onboard
}, {
  timestamps: true,
});

// Indexes (Optimized for onboard/queries)
userSchema.index({ 'personalInfo.email': 1 });
userSchema.index({ 'personalInfo.nationalId': 1 });  // For NDVS quick lookup
userSchema.index({ 'platformInfo.youtube.id': 1 });  // Channel ID (non-unique – allow multi-channel if needed)
userSchema.index({ 'auth.youtubeId': 1 });  // Google user ID unique for auth
userSchema.index({ 'claimHistory.claims.status': 1 });
userSchema.index({ 'insuranceStatus.status': 1 });
userSchema.index({ 'insuranceStatus.coveragePeriod': 1 });
userSchema.index({ 'insuranceStatus.termsAndAccuracy.hasAgreedToTerms': 1 });
userSchema.index({ 'applicationProgress.step': 1 });

// Pre-save: Light validation for onboard; stub earnings for test (Removed fraud auto-reject)
userSchema.pre('save', async function (next) {
  // Stub password hash if used (fallback)
  // if (this.isModified('auth.password') && this.auth.password) {
  //   const salt = await bcrypt.genSalt(10);
  //   this.auth.password = await bcrypt.hash(this.auth.password, salt);
  // }

  // Onboard completion: Set onboarded, stub analytics pull
  if (this.isNew && this.applicationProgress.step === 'Onboarded') {
    this.onboarded = true;
    // Stub YouTube API pull for MVP test (real in controller)
    this.platformInfo.youtube.avgDailyRevenue90d = 4200;  // Example KSh/day (~$500/mo)
    this.platformInfo.youtube.watchHours90d = 4000;  // Example
    this.financialInfo.monthlyEarnings = this.platformInfo.youtube.avgDailyRevenue90d * 30;
    // Create stub Analytics doc if needed (controller)
  }

  // Note: Fraud score check removed from here; now handled in controller post-save to allow application first

  // Validate nationalId if insurance applied (warn, don't throw – controller handles)
  if (this.insuranceStatus?.status !== 'NotApplied' && !this.personalInfo?.nationalId) {
    logger.warn(`National ID missing for insurance user ${this._id} – skipping verification (handled in controller)`);
    // Don't throw – let controller enforce
  }

  next();
});

// Method: Password match stub (OAuth primary)
userSchema.methods.matchPassword = async function (enteredPassword) {
  // if (!this.auth.password) throw new Error('Use YouTube OAuth for auth');
  // return await bcrypt.compare(enteredPassword, this.auth.password);
  throw new Error('Use YouTube OAuth for auth');
};

// Updated Method: Apply for Insurance (Now requires/validates nationalId; sets initial fraudScore=0, no auto-advance/reject)
userSchema.methods.applyForInsurance = async function (nationalId = '') {
  // Pre-checks
  if (!this.onboarded) {
    throw new Error('Complete onboarding first for analytics access');
  }
  // DEMO: Lowered earnings threshold to 0
  if (this.financialInfo.monthlyEarnings < 0) {  
    throw new Error('Monthly earnings must be at least KSh 0 for CCI eligibility');
  }
  if (this.insuranceStatus.status !== 'NotApplied') {
    throw new Error('Insurance application already in progress or completed');
  }

  // Require and set nationalId
  if (!nationalId || nationalId.trim().length !== 8) {
    throw new Error('Valid 8-digit Kenyan National ID required for verification');
  }
  this.personalInfo.nationalId = nationalId.trim();

  this.applicationProgress.step = 'InsuranceApply';
  this.insuranceStatus.appliedAt = new Date();
  this.insuranceStatus.fraudScore = 0;  // Initial: 0; computed post-save in controller
  this.insuranceStatus.status = 'Pending';  // Always pending initially; fraud check after
  await this.save();

  // Create Premium via static (estimate only; finalize post-fraud)
  const PremiumModel = mongoose.model('Premium');
  const premium = await PremiumModel.createFromApplication(this._id);
  
  // Link back (amount is estimate; may adjust post-fraud)
  this.financialInfo.premium.amount = premium.premiumDetails.finalAmount;
  this.financialInfo.premium.insuranceId = premium._id;
  this.financialInfo.premium.lastCalculated = new Date();
  await this.save();

  return { 
    eligible: true,  // Always true here; final eligibility in controller
    fraudScore: 0,  // Placeholder; real computation post-save
    premiumAmount: premium.premiumDetails.finalAmount,
    nextStep: this.applicationProgress.step 
  };
};

const User = mongoose.model('User', userSchema);

export default User;