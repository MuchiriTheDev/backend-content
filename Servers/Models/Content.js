// Content Schema (Simplified: CCI AI Creator Assistant - Integrated with Chat)
import mongoose from 'mongoose';
import User from './User.js';
// import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';  // For AI

const { Schema } = mongoose;

// Sub-schema for Content Details (Optional: Auto-created from chat uploads)
const contentDetailsSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  platform: {
    type: String,
    enum: ['YouTube'], 
    required: true,
    default: 'YouTube'
  },
  isInsuredPlatform: { type: Boolean, default: true },
  contentType: {  // Full CCI niche enum - pulled from User for chat personalization
    type: String, 
    enum: ['Comedy', 'Education', 'Vlogs', 'Gaming', 'Music', 'Other', 'Tech', 'Beauty', 'Fitness', 'Travel', 'Food', 'Sports'], 
    required: true 
  },
  title: { type: String, trim: true, maxlength: 200 },  // Optional; can be extracted from chat/desc
  description: { type: String, trim: true, maxlength: 1000 },  // From chat or upload
  mediaFiles: [{
    url: { type: String, required: true },  // Uploaded file URL
    type: { 
      type: String, 
      enum: ['Video', 'Image'], 
      required: true,
      default: 'Video'
    },
    description: { type: String, trim: true, maxlength: 500 }  // Brief from chat
  }]
});

// Sub-schema for Risk Scores (CCI: 0-100 scales, triggered in chat)
const riskScoresSchema = new Schema({
  demonetization: { type: Number, min: 0, max: 100, default: 0 },  // Yellow icon/ad suitability
  suspension: { type: Number, min: 0, max: 100, default: 0 },  // Temp ban/glitch
  ban: { type: Number, min: 0, max: 100, default: 0 },  // Permanent
  overallRisk: { type: Number, min: 0, max: 100, default: 0 },  // Weighted avg
});

// Sub-schema for Reasons (CCI: Per-category explanations + tips)
const reasonsSchema = new Schema({
  category: { type: String, enum: ['Demonetization', 'Suspension', 'Ban'], required: true },
  score: { type: Number, min: 0, max: 100, required: true },
  explanation: { type: String, trim: true, maxlength: 500, required: true },  // e.g., "Reused clips detected"
  nicheTip: { type: String, trim: true, maxlength: 200 },  // Personalized: "For Comedy: Add original punchline"
});

// Sub-schema for AI-Generated/Enhanced Images (CCI: Prompt-based in chat)
const generatedImageSchema = new Schema({
  url: { type: String, required: true },  // Cloudinary/Gemini output URL
  prompt: { type: String, required: true },  // User input: "Generate funny thumbnail"
  type: { type: String, enum: ['Generated', 'Enhanced'], required: true },  // New or cleaned up
  createdAt: { type: Date, default: Date.now },
});

// Sub-schema for Risk Assessment (CCI: Scales + reasons + tips; chat-triggered)
const riskAssessmentSchema = new Schema({
  riskLevel: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Low' },
  confidenceScore: { type: Number, min: 0, max: 100, default: 50 },
  fraudScore: { type: Number, min: 0, max: 100, default: 0 },  // Legacy, for compatibility
  aiModelVersion: { type: String, trim: true, default: 'gemini-1.5' },
  platformPolicyVersion: { type: String, trim: true, default: 'YouTube 2025' },
  risks: [{
    type: { type: String, enum: ['Demonetization', 'Suspension', 'Ban', 'Yellow Icon'], required: true },
    probability: { type: Number, min: 0, max: 100, required: true },
    weight: { type: Number, min: 0, default: 0 },
    description: { type: String, trim: true, maxlength: 500, required: true }
  }],
  isSafe: { type: Boolean, default: true },
  reasons: [reasonsSchema],  // Enhanced array of objects
  nicheTips: [{ type: String, trim: true }],  // Overall tips array
  mediaAnalysis: {
    type: { type: String, enum: ['Video', 'Image', 'None'], default: 'Video' },
    description: { type: String, trim: true, maxlength: 1000 },
    analysisNotes: { type: String, trim: true, maxlength: 1000, default: 'CCI: AI scan for 2025 policies' }
  },
  lastAssessed: { type: Date, default: Date.now },
  // New: Risk scores
  riskScores: { type: riskScoresSchema, default: () => ({}) },
});

// Main Content Schema (CCI: Optional, auto-created/linked from chat)
const contentSchema = new Schema({
  contentDetails: { type: contentDetailsSchema, required: true },
  riskAssessment: { type: riskAssessmentSchema, default: () => ({}) },
  // New: Optional chat session link (one-to-one for context)
  chatSessionId: { type: Schema.Types.ObjectId, ref: 'ChatSession', default: null },
  // New: Generated images (from chat prompts)
  generatedImages: [generatedImageSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  submissionContext: {
    type: String,
    enum: ['Application', 'Claim', 'PreventiveReview', 'ChatReview', 'ImageGen'],  // Updated: Chat-integrated review
    required: true,
    default: 'ChatReview'  // Default to chat-triggered
  }
}, { timestamps: true });

// Indexes
contentSchema.index({ 'contentDetails.userId': 1, createdAt: -1 });
contentSchema.index({ 'riskAssessment.riskLevel': 1 });
contentSchema.index({ 'contentDetails.isInsuredPlatform': 1 });
contentSchema.index({ 'contentDetails.platform': 1 });
contentSchema.index({ 'riskAssessment.riskScores.overallRisk': 1 });  // Quick risk sort
contentSchema.index({ chatSessionId: 1 });  // Fast chat lookup
contentSchema.index({ 'generatedImages.createdAt': -1 });  // Recent gens first

// assessRisk (CCI: Now chat-triggered; fallback for legacy)
contentSchema.methods.assessRisk = async function () {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const content = this;
  const media = content.contentDetails.mediaFiles[0];
  const niche = content.contentDetails.contentType;
  const text = (content.contentDetails.title || '') + ' ' + (content.contentDetails.description || '');

  const prompt = `
    Analyze YouTube content for CCI (2025 policies: real content, no reused/hate/misinfo). Niche: ${niche}.
    Title: "${content.contentDetails.title}". Desc: "${text}". Media: ${media?.url || 'Text-only'}.
    Output JSON: {
      "riskScores": {
        "demonetization": 0-100,  // Yellow icon/ad suitability
        "suspension": 0-100,     // Temp ban/glitch
        "ban": 0-100,            // Permanent
        "overallRisk": 0-100     // Weighted avg (e.g., demonetization*0.4 + ...)
      },
      "reasons": [  // Per category
        {"category": "Demonetization", "score": 85, "explanation": "Reused clips—niche tip for ${niche}: Add original edit."}
      ],
      "nicheTips": ["Actionable for ${niche}: e.g., Boost views with X crosspost."]
    }
  `;

  try {
    const result = await model.generateContent(prompt);
    const aiResponse = JSON.parse(result.response.text().replace(/```json\n?/, '').replace(/```\n?/, ''));

    // Populate riskAssessment
    this.riskAssessment = {
      riskLevel: aiResponse.riskScores.overallRisk > 70 ? 'High' : aiResponse.riskScores.overallRisk > 30 ? 'Medium' : 'Low',
      confidenceScore: 90,  // From Gemini metadata if avail
      fraudScore: aiResponse.riskScores.overallRisk,  // Map to legacy
      risks: aiResponse.reasons.map(r => ({
        type: r.category,
        probability: r.score,
        weight: r.score / 100 * 25,  // Scale
        description: r.explanation,
      })),
      isSafe: aiResponse.riskScores.overallRisk < 50,
      reasons: aiResponse.reasons.map(r => r.explanation),
      nicheTips: aiResponse.nicheTips,
      mediaAnalysis: { 
        type: media ? media.type : 'None', 
        description: media ? `CCI: ${media.description || 'Pre-upload scan'}` : '',
        analysisNotes: 'CCI: Full AI analysis complete.' 
      },
      lastAssessed: new Date(),
      riskScores: aiResponse.riskScores,
    };

    await this.save();
    return this.riskAssessment;
  } catch (err) {
    // Fallback keyword stub (as in original)
    const highRiskKeywords = ['hate', 'violence', 'misinfo', 'spam', 'reused', 'fake'];
    const matches = highRiskKeywords.filter(kw => text.toLowerCase().includes(kw));
    if (matches.length > 0) {
      this.riskAssessment = {
        riskLevel: 'High',
        riskScores: { demonetization: 80, suspension: 40, ban: 60, overallRisk: 60 },
        reasons: [{ category: 'Demonetization', score: 80, explanation: `High risk: ${matches[0]} content detected.`, nicheTip: `For ${niche}: Avoid ${matches[0]}—try original twists.` }],
        nicheTips: [`${niche} tip: Engage audience with polls for +20% views.`],
        isSafe: false,
      };
    } else {
      this.riskAssessment = {
        riskLevel: 'Low',
        riskScores: { demonetization: 10, suspension: 5, ban: 0, overallRisk: 5 },
        reasons: [],
        nicheTips: [`${niche} tip: Boost engagement with X cross-post.`],
        isSafe: true,
      };
    }
    await this.save();
    return this.riskAssessment;
  }
};

const Content = mongoose.model('Content', contentSchema);
export default Content;

// ChatSession Model (CCI: Central for conversation, review, gen—prompt-based like Grok)
const messageSchema = new Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true },  // User prompt or AI response
  timestamp: { type: Date, default: Date.now },
  attachments: [{ type: String }],  // Image URLs from gen/enhance
  // New: Embedded analysis if review triggered
  analysis: {  // Optional: If message is review response
    type: {
      riskScores: riskScoresSchema,
      reasons: [reasonsSchema],
      nicheTips: [{ type: String }],
    },
    default: null,
  },
  // New: Deep research flag/results
  deepResearch: {
    enabled: { type: Boolean, default: false },
    results: { type: Schema.Types.Mixed, default: null },  // Tool outputs (e.g., web_search snippets)
  },
});

const chatSessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  niche: { type: String, required: true },  // From User.contentType
  contentId: { type: Schema.Types.ObjectId, ref: 'Content' },  // Optional: If linked to upload/review
  messages: [messageSchema],
  sessionStatus: { type: String, enum: ['Active', 'Closed'], default: 'Active' },
  lastActive: { type: Date, default: Date.now },
}, { timestamps: true });

// Pre-save: Update lastActive + auto-close inactive (e.g., >7d)
chatSessionSchema.pre('save', function(next) {
  if (this.isModified('messages') && this.messages.length > 0) {
    this.lastActive = new Date();
  }
  // Auto-close if >7 days inactive (optional cron, but stub here)
  const now = new Date();
  const inactiveDays = (now - this.lastActive) / (1000 * 60 * 60 * 24);
  if (inactiveDays > 7 && this.sessionStatus === 'Active') {
    this.sessionStatus = 'Closed';
  }
  next();
});

// Index for quick session lookup
chatSessionSchema.index({ userId: 1, lastActive: -1 });
chatSessionSchema.index({ niche: 1 });

const ChatSession = mongoose.model('ChatSession', chatSessionSchema);
export { ChatSession };