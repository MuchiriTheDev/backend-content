import axios from 'axios';
import User from '../Models/User.js';
import Analytics from '../Models/Analytics.js';
import logger from '../Utilities/Logger.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// === TOKEN REFRESH ===
const refreshAccessToken = async (refreshToken, clientId, clientSecret) => {
  try {
    const res = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    return res.data.access_token;
  } catch (err) {
    logger.error(`Token refresh failed: ${err.response?.data?.error || err.message}`);
    throw new Error('Re-authenticate required');
  }
};

// === SAFE API CALL === (Enhanced logging for debugging)
const safeApiCall = async (url, params, user, refreshToken) => {
  if (!user?.platformInfo?.youtube?.accessToken) {
    throw new Error('Invalid user token configuration');
  }
  let token = user.platformInfo.youtube.accessToken;
  try {
    const res = await axios.get(url, {
      params: { ...params, access_token: token },
      timeout: 15000
    });
    return res.data;
  } catch (err) {
    logger.warn(`API call failed for ${url}: ${err.message}`); // Added for trace
    if (err.response?.status === 401 && refreshToken) {
      logger.warn('401 detected. Refreshing token...');
      token = await refreshAccessToken(refreshToken, process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
      user.platformInfo.youtube.accessToken = token;
      await user.save();
      const retryRes = await axios.get(url, { params: { ...params, access_token: token }, timeout: 15000 });
      return retryRes.data;
    }
    throw err;
  }
};

// === FETCH COMMENTS WITH REALITY CHECK === (Unchanged, but safeApiCall now guarded)
const fetchCommentsWithCheck = async (videoId, user, refreshToken) => {
  const result = {
    comments: [],
    totalFetched: 0,
    reportedCount: 0,
    isReal: false,
    blockReason: null
  };

  try {
    // First: Get reported count from video stats
    const vRes = await safeApiCall(
      'https://www.googleapis.com/youtube/v3/videos',
      { part: 'statistics', id: videoId },
      user,
      refreshToken
    );
    result.reportedCount = parseInt(vRes.items?.[0]?.statistics?.commentCount || 0);

    if (result.reportedCount === 0) {
      result.isReal = true; // No comments expected
      return result;
    }

    // Second: Try to fetch actual comments
    let pageToken = '';
    do {
      const cRes = await safeApiCall(
        'https://www.googleapis.com/youtube/v3/commentThreads',
        {
          part: 'snippet',
          videoId,
          maxResults: 100,
          pageToken,
          textFormat: 'plainText'
        },
        user,
        refreshToken
      );
      const comments = cRes.items?.map(i => i.snippet.topLevelComment?.snippet?.textDisplay) || []; // Extra ? for safety
      result.comments.push(...comments);
      result.totalFetched += comments.length;
      pageToken = cRes.nextPageToken || '';
    } while (pageToken && result.comments.length < 100);

    result.comments = result.comments.slice(0, 100);

    // === REALITY CHECK ===
    if (result.totalFetched > 0) {
      result.isReal = true;
    } else {
      // Try to get error reason from last failed call
      try {
        await safeApiCall(
          'https://www.googleapis.com/youtube/v3/commentThreads',
          { part: 'snippet', videoId, maxResults: 1 },
          user,
          refreshToken
        );
      } catch (err) {
        const reason = err.response?.data?.error?.errors?.[0]?.reason;
        result.blockReason = reason || 'unknown';
      }
    }
  } catch (err) {
    const status = err.response?.status;
    const reason = err.response?.data?.error?.errors?.[0]?.reason;
    result.blockReason = reason || `HTTP_${status}`;
    logger.warn(`Comment fetch failed for ${videoId} | Reason: ${result.blockReason}`);
  }

  // === ALERT IF MISMATCH ===
  if (result.reportedCount > 0 && result.totalFetched === 0) {
    logger.warn(`COMMENT REALITY ALERT: Video ${videoId} reports ${result.reportedCount} comments, but 0 are accessible. Reason: ${result.blockReason || 'unknown'}`);
  }

  return result;
};

// === GET ALL VIDEOS WITH COMMENT REALITY === (Enhanced: Log failing videoId + double-guard)
const getAllVideosWithComments = async (user, refreshToken) => {
  const { id: channelId, uploadPlaylistId } = user.platformInfo.youtube;
  let playlistId = uploadPlaylistId;

  if (!playlistId) {
    const ch = await safeApiCall(
      'https://www.googleapis.com/youtube/v3/channels',
      { part: 'contentDetails', id: channelId },
      user,
      refreshToken
    );
    playlistId = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (playlistId) {
      user.platformInfo.youtube.uploadPlaylistId = playlistId;
      await user.save();
    }
  }

  if (!playlistId) throw new Error('Upload playlist not found');

  const videos = [];
  let nextPageToken = '';

  do {
    const res = await safeApiCall(
      'https://www.googleapis.com/youtube/v3/playlistItems',
      {
        part: 'snippet,contentDetails',
        playlistId,
        maxResults: 50,
        pageToken: nextPageToken
      },
      user,
      refreshToken
    );

    for (const item of res.items || []) {
      const videoId = item.contentDetails?.videoId;
      if (!videoId) continue;

      let video = null;
      try {
        const vRes = await safeApiCall(
          'https://www.googleapis.com/youtube/v3/videos',
          { part: 'statistics,snippet,status', id: videoId },
          user,
          refreshToken
        );
        video = vRes.items?.[0] || null;

        // ENHANCED FIXED: Log + double-guard to prevent any status access crash
        if (!video) {
          logger.warn(`Skipping video ${videoId}: No details returned from API`);
          continue;
        }
        if (!video.status || video.status.uploadStatus !== 'processed') {  // !video.status catches missing/undefined status
          logger.debug(`Skipping video ${videoId}: Status invalid (${video.status?.uploadStatus || 'missing'})`);
          continue;
        }
      } catch (err) {
        logger.warn(`Video details fetch failed for ${videoId}: ${err.message}`);
        continue;  // Skip gracefully
      }

      const stats = video.statistics || {};
      const videoData = {
        id: videoId,
        title: item.snippet?.title || 'Untitled',  // Fallback for missing snippet
        thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
        publishedAt: item.snippet?.publishedAt || new Date().toISOString(),
        views: parseInt(stats.viewCount || 0),
        likes: parseInt(stats.likeCount || 0),
        commentCount: parseInt(stats.commentCount || 0),
        niche: user.platformInfo.youtube.contentType || 'Unknown',
        comments: [],
        commentReality: { isReal: false, reportedCount: 0, fetchedCount: 0, blockReason: null }
      };

      // === REAL COMMENT FETCH + ALERT ===
      try {
        const commentResult = await fetchCommentsWithCheck(videoId, user, refreshToken);
        videoData.comments = commentResult.comments;
        videoData.commentReality = {
          isReal: commentResult.isReal,
          reportedCount: commentResult.reportedCount,
          fetchedCount: commentResult.totalFetched,
          blockReason: commentResult.blockReason
        };
      } catch (commentErr) {
        logger.warn(`Comment fetch failed for ${videoId}: ${commentErr.message}`);
        // Don't crash—set defaults
      }

      videos.push(videoData);
    }

    nextPageToken = res.nextPageToken || '';
  } while (nextPageToken && videos.length < 50);

  return videos;
};
// === 1. MAIN ANALYTICS REPORT === (Added auth guard + user check)
export const getYouTubeAnalyticsReport = async (req, res) => {
  // FIXED: Block anonymous/unauth access
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Please log in' });
  }

  try {
    const { userId } = req.user;
    let user = await User.findById(userId).select('platformInfo.youtube');
    // FIXED: Explicit user null check
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (!user?.platformInfo?.youtube?.accessToken) {
      return res.status(400).json({ success: false, error: 'YouTube not connected' });
    }

    const { refreshToken, id: channelId } = user.platformInfo.youtube;

    // === Monetization ===
    let isMonetized = false;
    try {
      const chRes = await safeApiCall(
        'https://www.googleapis.com/youtube/v3/channels',
        { part: 'contentOwnerDetails', id: channelId },
        user,
        refreshToken
      );
      isMonetized = !!chRes.items?.[0]?.contentOwnerDetails?.contentOwner;
    } catch {
      logger.warn('Monetization check failed');
    }

    // === Analytics (6 months) ===
    const today = new Date();
    const startDate = new Date(today.getTime() - 180 * 24 * 60 * 60 * 1000);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = today.toISOString().split('T')[0];

    const metrics = isMonetized
      ? 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,likes,dislikes,comments,shares,estimatedRevenue'
      : 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,likes,dislikes,comments,shares';

    let rawData = { columnHeaders: [], rows: [] };
    try {
      rawData = await safeApiCall(
        'https://youtubeanalytics.googleapis.com/v2/reports',
        { ids: `channel==${channelId}`, startDate: startDateStr, endDate: endDateStr, metrics, dimensions: 'day' },
        user,
        refreshToken
      );
    } catch (err) {
      logger.error(`Analytics API failed: ${err.message}`);
    }

    const rows = rawData.rows || [];
    const getIdx = (name) => rawData.columnHeaders?.findIndex(h => h.name === name) ?? -1;

    const totals = rows.reduce((acc, row) => {
      acc.views += parseInt(row[getIdx('views')] || 0);
      acc.subsGained += parseInt(row[getIdx('subscribersGained')] || 0);
      acc.likes += parseInt(row[getIdx('likes')] || 0);
      acc.comments += parseInt(row[getIdx('comments')] || 0);
      acc.shares += parseInt(row[getIdx('shares')] || 0);
      if (isMonetized) acc.revenue += parseFloat(row[getIdx('estimatedRevenue')] || 0);
      return acc;
    }, { views: 0, subsGained: 0, likes: 0, comments: 0, shares: 0, revenue: 0 });

    const engagementRate = totals.views > 0 ? ((totals.likes + totals.comments + totals.shares) / totals.views * 100).toFixed(2) : 0;
    const estimatedRevenueKSh = isMonetized ? Math.round(totals.revenue * 130) : 0;

    // === Fetch Videos + Real Comments ===
    let videos = [];
    let allComments = [];
    let fakeCommentVideos = 0;

    try {
      videos = await getAllVideosWithComments(user, refreshToken);
      allComments = videos.flatMap(v => v.comments.map(text => ({ videoId: v.id, text })));
      fakeCommentVideos = videos.filter(v => !v.commentReality.isReal && v.commentReality.reportedCount > 0).length;

      if (fakeCommentVideos > 0) {
        logger.warn(`COMMENT REALITY ALERT: ${fakeCommentVideos} videos have fake/inaccessible comments`);
      }
    } catch (err) {
      logger.error(`Video fetch failed: ${err.message}`);
    }

    // === AI Analysis (ONLY ON REAL COMMENTS) ===
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: process.env.MODEL_GEMINI });

    let contentTips = [];
    let commentAnalysis = {
      total: allComments.length,
      positive: 0,
      negative: 0,
      neutral: 0,
      examples: { positive: [], negative: [] },
      lessons: [],
      improvement: [],
      fakeCommentAlert: fakeCommentVideos > 0 ? `${fakeCommentVideos} videos report comments but none are accessible` : null
    };

    if (allComments.length > 0) {
      try {
        const commentTexts = allComments.slice(0, 50).map(c => `"${c.text}"`).join(' | ');
        const prompt = `
You are CCI AI Coach for Kenyan YouTube creators.

Channel: ${totals.views} views, ${totals.subsGained} subs gained, ${engagementRate}% engagement
Monetized: ${isMonetized ? 'Yes' : 'No'}

Recent Comments: ${commentTexts}

TASKS:
1. Sentiment: Count positive, negative, neutral.
2. Examples: 3 positive + 3 negative.
3. Lessons: 3 key lessons.
4. Improvement: 3 actions.
5. Tips: EXACTLY 5 tips. {tip, action, benefit, nicheFit}

JSON ONLY.
        `;

        const result = await model.generateContent(prompt);
        console.log('AI Response:', result.response.text()); // Log raw response for debugging
        const jsonStr = result.response.text().replace(/```/g, '').trim();
        const ai = JSON.parse(jsonStr.match(/\{[\s\S]*\}/)?.[0] || '{}');

        contentTips = ai.tips?.slice(0, 5) || [];
        commentAnalysis = {
          ...commentAnalysis,
          ...ai.sentiment,
          examples: ai.examples || commentAnalysis.examples,
          lessons: ai.lessons || [],
          improvement: ai.improvement || []
        };
      } catch (err) {
        logger.error(`AI failed: ${err.message}`);
      }
    }

    if (contentTips.length === 0) {
      contentTips = [
        { tip: "Reply to every comment", action: "Use phone notifications", benefit: "+40% engagement", nicheFit: "All" },
        { tip: "Ask questions in video", action: "End with CTA", benefit: "More comments", nicheFit: "Vlogs" },
        { tip: "Fix audio quality", action: "Use lav mic", benefit: "Less negative feedback", nicheFit: "All" },
        { tip: "Post at 6 PM EAT", action: "Schedule uploads", benefit: "Peak Kenyan traffic", nicheFit: "Kenya" },
        { tip: "Apply to YPP", action: "Hit 1K subs + 4K hrs", benefit: "Earn money", nicheFit: "All" }
      ];
    }

    // === Trends ===
    const recent7 = rows.slice(-7).reduce((sum, r) => sum + parseInt(r[getIdx('views')] || 0), 0);
    const prior = totals.views - recent7;
    const viewsGrowth = prior > 0 ? ((recent7 - prior / 3) / (prior / 3) * 100).toFixed(1) : 0;

    const viewsHistory = rows.map(r => ({ date: r[0], views: parseInt(r[getIdx('views')] || 0) })).slice(-30);
    const earningsHistory = rows.map(r => ({ date: r[0], amount: isMonetized ? parseFloat(r[getIdx('estimatedRevenue')] || 0) * 130 : 0 })).slice(-30);

    // === Save ===
    user.platformInfo.youtube.channel.subscriberCount = totals.subsGained;
    await user.save();

    await Analytics.findOneAndUpdate(
      { userId },
      {
        $set: {
          'youtube.metrics': { viewCount: totals.views, subscriberCount: totals.subsGained },
          'youtube.lastPullDate': new Date(),
          'youtube.earningsHistory': earningsHistory,
          'youtube.viewsHistory': viewsHistory,
          'youtube.trends': { viewsGrowth, engagementRate },
          'youtube.commentAnalysis': commentAnalysis
        }
      },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      data: {
        performance: {
          totalViews: totals.views,
          estimatedRevenueKSh,
          engagementRate,
          subscribersGained: totals.subsGained,
          subGrowthRate: 0
        },
        contentTips,
        commentAnalysis,
        viewsHistory,
        earningsHistory,
        videos: videos.slice(0, 10).map(v => ({
          ...v,
          commentReality: v.commentReality // ← ALERT IN RESPONSE
        })),
        monetized: isMonetized,
        revenueSource: isMonetized ? 'YouTube Partner Program' : 'Not Monetized'
      }
    });
  } catch (error) {
    logger.error(`Analytics error: ${error.message}`);
    console.log(error)
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// === REST OF ENDPOINTS (Added auth guards + user checks) ===
export const getUserVideos = async (req, res) => {
  // FIXED: Block anonymous
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Please log in' });
  }

  try {
    const { userId } = req.user;
    let user = await User.findById(userId).select('platformInfo.youtube');
    // FIXED: Explicit user null check
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (!user?.platformInfo?.youtube?.accessToken) {
      return res.status(400).json({ success: false, error: 'YouTube not connected' });
    }

    const videos = await getAllVideosWithComments(user, user.platformInfo.youtube.refreshToken);
    res.json({
      success: true,
      data: {
        videos: videos.map(v => ({ ...v, commentReality: v.commentReality })),
        total: videos.length
      }
    });
  } catch (error) {
    logger.error(`getUserVideos error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Failed to fetch videos' });
  }
};

export const getVideoDetails = async (req, res) => {
  // FIXED: Block anonymous
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Please log in' });
  }

  try {
    const { videoId } = req.params;
    const { userId } = req.user;
    let user = await User.findById(userId).select('platformInfo.youtube');
    // FIXED: Explicit user null check
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (!user?.platformInfo?.youtube?.accessToken) {
      return res.status(400).json({ success: false, error: 'YouTube not connected' });
    }

    const videos = await getAllVideosWithComments(user, user.platformInfo.youtube.refreshToken);
    const video = videos.find(v => v.id === videoId);
    if (!video) return res.status(404).json({ success: false, error: 'Video not found' });

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    let aiAnalysis = { summary: {}, comments: [] };

    if (video.comments.length > 0) {
      try {
        const commentTexts = video.comments.slice(0, 50).map(c => `"${c}"`).join(' | ');
        const prompt = `
You are CCI AI Coach. Analyze comments for this Kenyan YouTube video.

Niche: ${video.niche}
Video: "${video.title}"

Comments:
${commentTexts}

TASK:
1. For each comment: {text, sentiment: "Positive"/"Negative"/"Neutral", nicheFit: "Strong"/"Weak"/"None", reason}
2. Summary: {positive, negative, neutral, total, nicheAlignment: 0-100}

JSON ONLY.
        `;

        const result = await model.generateContent(prompt);
        const jsonStr = result.response.text().replace(/```/g, '').trim();
        aiAnalysis = JSON.parse(jsonStr.match(/\{[\s\S]*\}/)?.[0] || '{}');
      } catch (err) {
        logger.error(`AI analysis failed for video ${videoId}: ${err.message}`);
      }
    }

    res.json({
      success: true,
      data: {
        video: { ...video, commentReality: video.commentReality },
        aiAnalysis
      }
    });
  } catch (error) {
    logger.error(`getVideoDetails error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

export const getAnalyticsTrends = async (req, res) => {
  
  // FIXED: Block anonymous
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Please log in' });
  }

  try {
    const { userId } = req.user;
    const analytics = await Analytics.findOne({ userId });
    if (!analytics?.youtube?.earningsHistory?.length) {
      return res.status(404).json({ success: false, error: 'No historical data' });
    }

    const trends = analytics.youtube.earningsHistory.slice(-30).map((e, i) => ({
      day: `Day ${i + 1}`,
      earnings: e.amount
    }));

    res.json({ success: true, data: { trends } });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
};