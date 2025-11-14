// Analytics Schema (Enhanced: CCI Ties, Revenue Drop Detection, Auto-Pulls)
import mongoose from 'mongoose';
import User from './User.js';
import Content from './Content.js';

const { Schema } = mongoose;

const analyticsSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true, unique: true },
  youtube: {
    lastPullDate: { type: Date, default: Date.now },
    metrics: {
      subscriberCount: { type: Number, min: 0, default: 0 },
      viewCount: { type: Number, min: 0, default: 0 },
      videoCount: { type: Number, min: 0, default: 0 },
      watchHours90d: { type: Number, min: 0, default: 0 },  // CCI: For eligibility
      avgDailyRevenue90d: { type: Number, min: 0, default: 0 },  // CCI: Baseline for claims
      estimatedDailyEarnings: { type: Number, min: 0, default: 0 },
      estimatedEarningsRate: { type: Number, min: 0, default: 150 },  // KSh/1k views (Kenya avg)
      earningsHistory: [{  // Last 90 days for CCI baseline
        date: { type: Date, required: true },
        amount: { type: Number, min: 0, required: true },  // Daily revenue
        views: { type: Number, min: 0 },
        dropPercent: { type: Number, min: 0, default: 0 }  // For claim triggers
      }],
      // Computed monthly (views + API-based)
      estimateMonthlyEarnings: { type: Number, min: 0, default: 0 },
    },
    riskAlerts: [{
      type: { type: String, enum: ['Policy Change', 'High Risk Video', 'Low Engagement', 'Demonetization Warning', 'Revenue Drop'], required: true },  // Added CCI drop
      severity: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Low' },
      date: { type: Date, default: Date.now },
      description: { type: String, trim: true, required: true },
      linkedContent: { type: Schema.Types.ObjectId, ref: 'Content' },
      isResolved: { type: Boolean, default: false },  // For dashboard
    }],
    trends: {  // For charts + CCI insights
      subsGrowth: { type: Number, default: 0 },  // % monthly
      viewsGrowth: { type: Number, default: 0 },
      engagementRate: { type: Number, min: 0, max: 100, default: 0 },  // Avg views/video
      revenueVolatility: { type: Number, min: 0, max: 100, default: 0 },  // % std dev for premium adjust
    },
  },
  otherPlatforms: [{
    platform: { type: String, enum: ['TikTok', 'Instagram', 'X', 'Facebook'] },
    metrics: { audienceSize: Number, engagementRate: Number },
    lastPullDate: Date,
  }],
}, { timestamps: true });

// Indexes
analyticsSchema.index({ userId: 1, 'youtube.lastPullDate': -1 });
analyticsSchema.index({ 'youtube.riskAlerts.severity': 1 });
analyticsSchema.index({ 'youtube.earningsHistory.date': -1 });
analyticsSchema.index({ 'youtube.riskAlerts.type': 1 });  // Quick CCI alerts

// Enhanced updateFromYouTube: Fetch + Estimate Model (CCI: 90d baseline, drop detection)
analyticsSchema.methods.updateFromYouTube = async function (accessToken) {
  // Real impl: Use YouTube Analytics API (axios/youtube-api v3)
  // Stub for MVP: Mock from User, enhance with drop calc
  const user = await User.findById(this.userId).select('platformInfo.youtube.channel');
  const { viewCount, subscriberCount, videoCount } = user.platformInfo.youtube.channel;

  // Avg Daily Views (fallback)
  const avgDailyViews = videoCount > 0 ? viewCount / videoCount : 0;

  // CPM Adjustment: Base 150 KSh + boosts (CCI Kenya-tuned)
  const subsBoost = (subscriberCount / 1000) * 5;
  const engagementMultiplier = subscriberCount > 0 ? (avgDailyViews / subscriberCount) * 0.1 : 0;
  const adjustedRate = Math.min(150 + subsBoost + (150 * engagementMultiplier), 250);  // Cap 250

  // Daily/Monthly Earnings
  const estimatedDaily = (avgDailyViews / 1000) * adjustedRate;
  this.youtube.metrics.estimatedDailyEarnings = estimatedDaily;
  this.youtube.metrics.estimateMonthlyEarnings = estimatedDaily * 30;
  this.youtube.metrics.avgDailyRevenue90d = estimatedDaily;  // Stub 90d avg (real: API sum/90)
  this.youtube.metrics.watchHours90d = 4000;  // Stub (real: API)

  // Earnings History: Push daily, calc drop vs 7-day avg (CCI trigger ≥70%)
  const today = new Date();
  const recentHistory = this.youtube.metrics.earningsHistory.slice(-7).map(h => h.amount);
  const sevenDayAvg = recentHistory.length > 0 ? recentHistory.reduce((a, b) => a + b, 0) / recentHistory.length : estimatedDaily;
  const dropPercent = Math.max(0, ((sevenDayAvg - estimatedDaily) / sevenDayAvg) * 100);
  this.youtube.metrics.earningsHistory.push({
    date: today,
    amount: estimatedDaily,
    views: avgDailyViews,
    dropPercent
  });
  if (this.youtube.metrics.earningsHistory.length > 90) {  // CCI: 90d window
    this.youtube.metrics.earningsHistory = this.youtube.metrics.earningsHistory.slice(-90);
  }

  // Risk Alerts: CCI-specific (e.g., drop ≥70% → Claim nudge)
  if (dropPercent >= 70) {
    this.youtube.riskAlerts.push({
      type: 'Revenue Drop',
      severity: 'High',
      description: 'Sudden earnings drop detected—eligible for CCI claim? Check demonetization.',
      isResolved: false
    });
  }
  // DEMO: Removed low engagement alert for earnings <65000 to allow 0 threshold
  // if (this.youtube.metrics.estimateMonthlyEarnings < 65000) {  // CCI threshold
  //   this.youtube.riskAlerts.push({
  //     type: 'Low Engagement',
  //     severity: 'Medium',
  //     description: 'Earnings below CCI eligibility—optimize content for growth.',
  //     isResolved: false
  //   });
  // }

  // Trends: Volatility for premium (std dev of last 30 earnings)
  const last30 = this.youtube.metrics.earningsHistory.slice(-30).map(h => h.amount);
  const mean = last30.reduce((a, b) => a + b, 0) / last30.length;
  const variance = last30.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / last30.length;
  this.youtube.trends.revenueVolatility = Math.sqrt(variance) / mean * 100 || 0;

  this.youtube.lastPullDate = today;
  await this.save();

  // Sync to User (CCI eligibility)
  await User.findByIdAndUpdate(this.userId, { 
    'financialInfo.monthlyEarnings': this.youtube.metrics.estimateMonthlyEarnings,
    'platformInfo.youtube.avgDailyRevenue90d': this.youtube.metrics.avgDailyRevenue90d,
    'platformInfo.youtube.watchHours90d': this.youtube.metrics.watchHours90d,
    'financialInfo.analyticsId': this._id 
  });
};

// Get monthly earnings (for Premium/Claims)
analyticsSchema.methods.getMonthlyEarnings = function () {
  return this.youtube.metrics.estimateMonthlyEarnings || 0;
};

// Detect revenue drop (for auto-claim nudge)
analyticsSchema.methods.detectRevenueDrop = function () {
  const history = this.youtube.metrics.earningsHistory.slice(-7);
  if (history.length < 3) return { drop: 0, eligible: false };
  const recentAvg = history.slice(-3).reduce((sum, h) => sum + h.amount, 0) / 3;
  const baselineAvg = history.slice(0, -3).reduce((sum, h) => sum + h.amount, 0) / (history.length - 3) || recentAvg;
  const drop = Math.max(0, ((baselineAvg - recentAvg) / baselineAvg) * 100);
  return { drop, eligible: drop >= 70 };  // CCI threshold
};

const Analytics = mongoose.model('Analytics', analyticsSchema);

export default Analytics;