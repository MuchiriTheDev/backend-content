// controllers/ContentController.js (CCI: Chat-Centric - Integrated Review, Gen, Research)
import Content from '../Models/Content.js';
import { ChatSession } from '../Models/Content.js';  // Import from same file if co-located
import User from '../Models/User.js';
import logger from '../Utilities/Logger.js';
import { deleteFromCloudinary, uploadToCloudinary } from '../Utilities/Cloudinary.js';
import upload from '../Utilities/Multer.js';  // For optional file in chat
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import fs from 'fs/promises';

// Initialize Gemini AI
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) throw new Error('Gemini API key is not configured');
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

// Middleware for optional file upload in chat (1 file)
export const uploadChatFile = upload.single('mediaFile');

// @desc    Chat with AI Assistant (CCI: Core - Handles prompts, review, gen, research)
export const contentChat = async (req, res, next) => {
  try {
    const { sessionId, message, deepResearchEnabled = false } = req.body;  // message: user prompt; deepResearchEnabled: toggle
    const userId = req.user.id;

    // Validate user
    const user = await User.findById(userId);
    if (!user || user.role !== 'Creator') {
      return res.status(403).json({ success: false, error: 'Unauthorized or user not found' });
    }
    const niche = user.platformInfo.youtube.contentType;  // Pull niche for personalization
    if (!niche) return res.status(400).json({ success: false, error: 'Niche not set in profile' });

    // Find or create session
    let session = sessionId ? await ChatSession.findOne({ _id: sessionId, userId }) : null;
    if (!session) {
      // Create new if no ID
      session = new ChatSession({
        userId,
        niche,
        messages: [],
      });
      await session.save();
    }

    // Upload optional file (for review/gen)
    let mediaUrl = '';
    if (req.file) {
      const { url } = await uploadToCloudinary(req.file, 'content/chat');
      await fs.unlink(req.file.path).catch(() => {});
      mediaUrl = url;
      logger.info(`Chat file uploaded for user ${userId}: ${url}`);
    }

    // Append user message
    const userMessage = {
      role: 'user',
      content: message || (req.file ? `Review/Enhance this ${req.file.mimetype.startsWith('image') ? 'image' : 'video'}` : ''),
      timestamp: new Date(),
      attachments: mediaUrl ? [mediaUrl] : [],
    };
    if (deepResearchEnabled) userMessage.deepResearch = { enabled: true, query: message };
    session.messages.push(userMessage);
    await session.save();

    // Intent Detection & Processing (Gemini classifies: review, gen, research, general)
    const context = session.messages.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n');  // Recent context
    const intentPrompt = `
      CCI AI. Niche: ${niche}. Context: ${context}. File: ${mediaUrl ? 'Uploaded media' : 'No file'}.
      Classify intent: 'review' (analyze risks), 'generate_image' (prompt-based image), 'enhance_image' (edit uploaded), 'deep_research' (web/X search), 'general_guidance' (tips).
      If review: Output risk JSON as before.
      If gen/enhance: Generate image (describe URL/base64).
      If deep_research: Summarize key facts/sources.
      If general: Actionable advice (50% protect, 50% grow).
      Response: JSON {"intent": str, "response": str, "analysis": {risk JSON if review}, "image": {url, prompt} if gen}
    `;

    const intentResult = await model.generateContent(intentPrompt, { generationConfig: { temperature: 0.7, maxOutputTokens: 1500 }, safetySettings });
    const intentResponse = JSON.parse(intentResult.response.text().replace(/```json\n?/, '').replace(/```\n?/, ''));

    let aiResponseContent = intentResponse.response;
    let embeddedAnalysis = null;
    let generatedImage = null;
    let researchResults = null;

    // Branch on intent
    if (intentResponse.intent === 'review' && mediaUrl) {
      // Create Content & Assess Risk
      const content = new Content({
        contentDetails: {
          userId,
          platform: 'YouTube',
          isInsuredPlatform: true,
          contentType: niche,
          description: message || 'Chat-reviewed content',  // From prompt
          mediaFiles: [{ url: mediaUrl, type: req.file.mimetype.startsWith('image') ? 'Image' : 'Video', description: '' }],
        },
        chatSessionId: session._id,
        submissionContext: 'ChatReview',
      });
      await content.save();
      embeddedAnalysis = await content.assessRisk();  // Triggers Gemini analysis
      aiResponseContent += `\n\nRisk Breakdown: Demonetization ${embeddedAnalysis.riskScores.demonetization}%, Suspension ${embeddedAnalysis.riskScores.suspension}%, Ban ${embeddedAnalysis.riskScores.ban}%. Overall: ${embeddedAnalysis.riskScores.overallRisk}%. Tips: ${embeddedAnalysis.nicheTips.join('; ')}.`;
      // Link back
      session.contentId = content._id;
      await session.save();
    } else if (intentResponse.intent.includes('image') && (message.includes('generate') || message.includes('enhance'))) {
      // Image Gen/Enhance
      const imagePrompt = message;  // User prompt
      const genPrompt = `Niche: ${niche}. ${imagePrompt}. Output: Descriptive URL or base64 for thumbnail/cleanup.`;
      const imageResult = await model.generateContent(genPrompt);
      const imageDesc = imageResult.response.text();  // Stub: Real Gemini image gen returns URL/base64
      generatedImage = { url: 'gemini-generated-url-placeholder', prompt: imagePrompt, type: intentResponse.intent === 'generate_image' ? 'Generated' : 'Enhanced' };
      // Store in session (or Content if linked)
      userMessage.attachments = [generatedImage.url];
      session.messages[session.messages.length - 1] = userMessage;  // Update
      aiResponseContent += `\n\nGenerated: ${generatedImage.url} (Download ready).`;
    } else if (intentResponse.intent === 'deep_research' && deepResearchEnabled) {
      // Deep Research (Use tools: web_search, x_keyword_search, etc.)
      // Stub: Simulate tool call; in real, integrate tools here
      const researchQuery = message;
      // Example tool call (in production: await web_search({query: researchQuery}))
      researchResults = {
        enabled: true,
        query: researchQuery,
        results: 'Stub: Deep research on "YouTube 2025 policies" - Key fact: Real content rule requires 80% original footage. Sources: [youtube.com/blog].',
        sources: ['youtube.com/blog/2025-policies'],
      };
      userMessage.deepResearch = researchResults;
      session.messages[session.messages.length - 1] = userMessage;
      aiResponseContent += `\n\nResearch Summary: ${researchResults.results}. Sources: ${researchResults.sources.join(', ')}.`;
    } else {
      // General Guidance (Protect + Grow)
      aiResponseContent += `\n\nProtect Tip: Check for ${niche}-specific flags. Growth: Collaborate with similar creators for +30% subs. What next?`;
    }

    // Append AI response
    session.messages.push({
      role: 'assistant',
      content: aiResponseContent,
      timestamp: new Date(),
      analysis: embeddedAnalysis || null,  // Embed if review
      deepResearch: researchResults || null,
    });
    session.lastActive = new Date();
    await session.save();

    logger.info(`Chat response for session ${session._id}, user ${userId}: Intent ${intentResponse.intent}`);
    return res.json({
      success: true,
      sessionId: session._id,
      messages: session.messages.slice(-10),  // Last 10 for UI
      response: aiResponseContent,
      analysis: embeddedAnalysis,
      image: generatedImage,
      research: researchResults,
    });
  } catch (error) {
    logger.error(`Chat error for user ${req.user.id}: ${error.message}`);
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    return res.status(500).json({ success: false, error: 'Chat processing failed—try rephrasing.' });
  }
};

// @desc    Get My Chat Sessions (CCI: List active sessions instead of content)
export const getMySessions = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const sessions = await ChatSession.find({ userId, sessionStatus: 'Active' })
      .sort({ lastActive: -1 })
      .populate('contentId', 'riskAssessment.riskScores');  // Optional linked content risks

    logger.info(`Retrieved ${sessions.length} sessions for user ${userId}`);
    return res.json({ success: true, sessions });
  } catch (error) {
    logger.error(`Error in getMySessions for user ${req.user.id}: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Failed to retrieve sessions' });
  }
};

// @desc    Get Session Details (Messages + Linked Content)
export const getSessionById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const session = await ChatSession.findById(id)
      .populate('userId', 'personalInfo.email')
      .populate('contentId', 'riskAssessment generatedImages');  // Full linked data

    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    if (session.userId._id.toString() !== req.user.id.toString() && req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    logger.info(`Session ${id} retrieved by user ${req.user.id}`);
    return res.json({ success: true, session });
  } catch (error) {
    logger.error(`Error in getSessionById for session ${req.params.id}: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Failed to retrieve session' });
  }
};

// @desc    Close/Delete Session (CCI: End chat)
export const deleteSession = async (req, res, next) => {
  try {
    const { id } = req.params;
    const session = await ChatSession.findById(id);

    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    if (session.userId.toString() !== req.user.id.toString()) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    // Delete linked generated images (Cloudinary)
    if (session.contentId) {
      const content = await Content.findById(session.contentId);
      if (content && content.generatedImages.length > 0) {
        const deletePromises = content.generatedImages.map(async (img) => {
          const publicId = img.url.split('/').pop().split('.')[0];
          await deleteFromCloudinary(publicId).catch(() => {});
        });
        await Promise.all(deletePromises);
      }
    }

    await ChatSession.findByIdAndDelete(id);
    logger.info(`Session ${id} deleted by user ${req.user.id}`);
    return res.json({ success: true, message: 'Session closed and deleted' });
  } catch (error) {
    logger.error(`Error in deleteSession for session ${req.params.id}: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Failed to delete session' });
  }
};

// @desc    Get All Sessions (Admin only)
export const getAllSessions = async (req, res, next) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ success: false, error: 'Admin access required' });

    const { niche, status, startDate, endDate } = req.query;
    const query = {};

    if (niche) query.niche = niche;
    if (status) query.sessionStatus = status;
    if (startDate || endDate) {
      query.lastActive = {};
      if (startDate) query.lastActive.$gte = new Date(startDate);
      if (endDate) query.lastActive.$lte = new Date(endDate);
    }

    const sessions = await ChatSession.find(query)
      .populate('userId', 'personalInfo.email personalInfo.fullName')
      .populate('contentId', 'riskAssessment.riskScores')
      .sort({ lastActive: -1 });

    logger.info(`Admin ${req.user.id} retrieved ${sessions.length} sessions`);
    return res.json({ success: true, sessions });
  } catch (error) {
    logger.error(`Error in getAllSessions for admin ${req.user.id}: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Failed to retrieve sessions' });
  }
};

// @desc    Get Content Analytics (Admin only - Updated for new schema)
export const getContentAnalytics = async (req, res, next) => {
  try {
    if (req.user.role !== 'Admin') {
      logger.error(`Unauthorized analytics access by user ${req.user.id}`);
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { startDate, endDate } = req.query;
    const match = {};
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) match.createdAt.$lte = new Date(endDate);
    }

    // Updated queries for new schema (focus on chat-linked content)
    const totalContent = await Content.countDocuments(match);
    const riskBreakdown = await Content.aggregate([
      { $match: match },
      { $group: { _id: '$riskAssessment.riskLevel', count: { $sum: 1 } } },
    ]);
    const avgOverallRisk = await Content.aggregate([
      { $match: { ...match, 'riskAssessment.riskScores.overallRisk': { $exists: true } } },
      { $group: { _id: null, avgRisk: { $avg: '$riskAssessment.riskScores.overallRisk' } } },
    ]);
    const chatLinkedContent = await Content.aggregate([
      { $match: { ...match, chatSessionId: { $exists: true } } },
      { $group: { _id: null, count: { $sum: 1 }, highRisk: { $sum: { $cond: [{ $gt: ['$riskAssessment.riskScores.overallRisk', 70] }, 1, 0] } } } },
    ]);
    const imageGenCount = await Content.aggregate([
      { $match: match },
      { $group: { _id: null, totalGens: { $sum: { $size: '$generatedImages' } } } },
    ]);
    const nicheBreakdown = await Content.aggregate([
      { $match: match },
      { $group: { _id: '$contentDetails.contentType', count: { $sum: 1 }, avgRisk: { $avg: '$riskAssessment.riskScores.overallRisk' } } },
    ]);
    const submissionContextBreakdown = await Content.aggregate([
      { $match: match },
      { $group: { _id: '$submissionContext', count: { $sum: 1 } } },
    ]);

    // AI-driven insights (Updated prompt for chat/gen/research focus)
    const prompt = `
      CCI AI Analytics. Analyze content/chat data: Total Content: ${totalContent}, Risk Breakdown: ${JSON.stringify(riskBreakdown)}, Avg Overall Risk: ${avgOverallRisk[0]?.avgRisk?.toFixed(2) || 0}, Chat-Linked: ${chatLinkedContent[0]?.count || 0} (High-Risk: ${chatLinkedContent[0]?.highRisk || 0}), Image Gens: ${imageGenCount[0]?.totalGens || 0}, Niche Breakdown: ${JSON.stringify(nicheBreakdown)}, Context Breakdown: ${JSON.stringify(submissionContextBreakdown)}.
      Insights: Chat effectiveness for reviews, gen usage trends, research toggles. JSON: {"insights": [{"title": str, "description": str, "action": str}]}
    `;

    const result = await model.generateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 1500 },
      safetySettings,
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
            action: 'Manually review chat/session data for trends.',
          },
        ],
      };
    }

    logger.info(`Admin ${req.user.id} retrieved content analytics with ${aiInsights.insights.length} AI insights`);
    return res.json({
      success: true,
      analytics: {
        totalContent,
        riskBreakdown,
        averageOverallRisk: avgOverallRisk[0]?.avgRisk?.toFixed(2) || 0,
        chatLinkedContent: chatLinkedContent[0] || { count: 0, highRisk: 0 },
        imageGenCount: imageGenCount[0]?.totalGens || 0,
        nicheBreakdown,
        submissionContextBreakdown,
        aiInsights,
      },
    });
  } catch (error) {
    logger.error(`Error in getContentAnalytics for admin ${req.user?.id}: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Failed to retrieve analytics' });
  }
};