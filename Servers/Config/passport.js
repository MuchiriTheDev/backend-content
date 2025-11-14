import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { CastError } from 'mongoose'; // Add this import for handling CastError
import User from '../Models/User.js';
import Analytics from '../Models/Analytics.js';

const callbackURL = process.env.CALLBACK_URL || 'http://localhost:5000/api/auth/youtube/callback';

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL || 'http://localhost:5000/api/auth/youtube/callback',
  scope: [
    'profile',
    'email',
    'https://www.googleapis.com/auth/youtube.readonly',  // Readonly for channels/videos
    'https://www.googleapis.com/auth/yt-analytics.readonly',  // Analytics metrics
    'https://www.googleapis.com/auth/yt-analytics-monetary.readonly'  // Earnings data (CCI required)
  ],
  accessType: 'offline',
  prompt: 'consent'  // Forces permission screen
}, async (accessToken, refreshToken, profile, done) => {
  try {
    console.log('OAuth callback received');

    // === STEP 1: VERIFY GRANTED SCOPES ===
    let grantedScopes = [];
    try {
      const tokenInfo = await axios.get('https://www.googleapis.com/oauth2/v3/tokeninfo', {
        params: { access_token: accessToken }
      });
      grantedScopes = tokenInfo.data.scope?.split(' ') || [];
      console.log('Granted scopes:', grantedScopes);
    } catch (err) {
      console.warn('Failed to fetch token info:', err.message);
    }

    const hasYouTubeScope = grantedScopes.includes('https://www.googleapis.com/auth/youtube.readonly');
    const hasAnalyticsScope = grantedScopes.includes('https://www.googleapis.com/auth/yt-analytics.readonly');
    const hasMonetaryScope = grantedScopes.includes('https://www.googleapis.com/auth/yt-analytics-monetary.readonly');

    if (!hasYouTubeScope) {
      return done(new Error('Missing required YouTube readonly scope. Please re-authorize.'));
    }

    if (!hasAnalyticsScope || !hasMonetaryScope) {
      console.warn('Analytics/monetary scopes missing; some features (e.g., earnings data) will be limited to estimates. Full access recommended for CCI.');
      // Proceed without error – use fallbacks in Analytics
    }

    // === STEP 2: Find or Create User ===
    let user = await User.findOne({ 'platformInfo.youtube.id': profile.id });  // Align: Use youtube.id (channel ID)
    const isNewUser = !user;

    if (isNewUser) {
      const fullName = `${profile.name.givenName || ''} ${profile.name.familyName || ''}`.trim() || profile.displayName || 'Unknown User';
      user = new User({
        personalInfo: { 
          fullName, 
          email: profile.emails[0]?.value || '', 
          phoneNumber: '', 
          dateOfBirth: null, 
          country: 'Kenya' 
        },
        platformInfo: { 
          youtube: { 
            id: profile.id,  // Temp profile.id; update to channel.id below
            accessToken, 
            refreshToken: refreshToken || '', 
            profile: { 
              name: profile.displayName || '', 
              picture: profile.photos[0]?.value || '' 
            }, 
            username: profile.displayName || '', 
            accountLink: `https://youtube.com/@${profile.id}`,  // Temp; update below
            audienceSize: 0,  // Set from channel
            contentType: undefined,  // Set in onboard
            avgDailyRevenue90d: 0,
            watchHours90d: 0,
            pastDemonetization: false,
            isVerified: false,  // Set post-OAuth
            verificationMethod: 'API',
            riskHistory: [],
            channel: {  // Placeholder; fetch below
              title: '',
              description: '',
              subscriberCount: 0,
              viewCount: 0,
              videoCount: 0,
              uploadPlaylistId: '',
              videos: []
            }
          }, 
          otherPlatforms: [] 
        },
        financialInfo: { 
          monthlyEarnings: 0,
          currency: 'KSh',
          paymentMethod: { 
            type: 'M-Pesa', 
            details: { 
              mobileNumber: '', 
              accountNumber: '', 
              bankName: '' 
            } 
          },
          premium: { 
            amount: 0, 
            lastCalculated: null, 
            discountApplied: false, 
            insuranceId: null 
          },
          analyticsId: null
        },
        claimHistory: { claims: [] },
        insuranceStatus: { 
          status: 'NotApplied',
          termsAndAccuracy: {
            hasProvidedAccurateInfo: false,
            hasAgreedToTerms: false,
            termsAgreedAt: null
          },
          fraudScore: 0
        },
        auth: { 
          youtubeId: profile.id  // Align: youtubeId in auth
        },
        applicationProgress: { 
          step: 'OnboardOAuth'  // Align enum
        },
        role: 'Creator',
        isVerified: false,
        onboarded: false,
      });
    } else {
      // Update tokens for existing
      user.platformInfo.youtube.accessToken = accessToken;
      user.platformInfo.youtube.refreshToken = refreshToken || user.platformInfo.youtube.refreshToken;
    }

    // === STEP 3: Fetch Channel (Uses youtube.readonly) ===
    let channel;
    try {
      const res = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
        params: { 
          part: 'snippet,contentDetails,statistics', 
          mine: true, 
          access_token: accessToken 
        }
      });
      channel = res.data.items[0];
      if (!channel) throw new Error('No channel found');
    } catch (err) {
      return done(new Error('Failed to fetch channel. Ensure YouTube Data API is enabled and scope is granted.'));
    }

    // Update channel details (align schema)
    user.platformInfo.youtube.id = channel.id;  // Channel ID
    user.platformInfo.youtube.channel = {
      title: channel.snippet.title || 'Untitled',
      description: channel.snippet.description || '',
      subscriberCount: parseInt(channel.statistics.subscriberCount) || 0,
      viewCount: parseInt(channel.statistics.viewCount) || 0,
      videoCount: parseInt(channel.statistics.videoCount) || 0,
      uploadPlaylistId: channel.contentDetails.relatedPlaylists.uploads || '',
      videos: []  // Fetch below
    };
    user.platformInfo.youtube.username = channel.snippet.title || profile.displayName || '';
    user.platformInfo.youtube.accountLink = `https://www.youtube.com/channel/${channel.id}`;
    user.platformInfo.youtube.audienceSize = parseInt(channel.statistics.subscriberCount) || 0;

    // === STEP 4: Fetch Recent Videos ===
    try {
      const videosRes = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
        params: { 
          part: 'snippet,contentDetails', 
          playlistId: channel.contentDetails.relatedPlaylists.uploads, 
          maxResults: 5, 
          access_token: accessToken 
        }
      });
      user.platformInfo.youtube.channel.videos = (videosRes.data.items || []).map(item => ({
        id: item.snippet.resourceId.videoId,
        title: item.snippet.title || '',
        publishedAt: new Date(item.snippet.publishedAt),
        viewCount: 0  // Stub; fetch per-video stats later if needed
      }));
    } catch (err) {
      console.warn('Failed to fetch videos:', err.message);
      user.platformInfo.youtube.channel.videos = [];
    }

    await user.save();

    // === STEP 5: Analytics Setup ===
    let analytics = await Analytics.findOne({ userId: user._id });
    if (!analytics) {
      analytics = new Analytics({ userId: user._id });
      await analytics.save();
    }

    // Update analytics if scopes granted
    try {
      await analytics.updateFromYouTube(accessToken);
    } catch (err) {
      if (err.name === 'CastError') {
        console.warn('CastError in analytics update (likely NaN in dropPercent): Cleaning NaN values and retrying save');
        // Clean NaN values in earningsHistory
        if (analytics.youtube && analytics.youtube.metrics && analytics.youtube.metrics.earningsHistory) {
          analytics.youtube.metrics.earningsHistory.forEach((entry) => {
            if (entry.dropPercent !== undefined && isNaN(entry.dropPercent)) {
              entry.dropPercent = 0;
            }
          });
        }
        // Optionally clean other potential NaN fields if known (e.g., growthPercent, etc.)
        // For example:
        // if (analytics.youtube.metrics.growthPercent !== undefined && isNaN(analytics.youtube.metrics.growthPercent)) {
        //   analytics.youtube.metrics.growthPercent = 0;
        // }
        await analytics.save();
      } else if (err.response?.status === 401 || err.response?.status === 403) {
        console.warn('Analytics scopes limited: Using fallback estimates');
        // Fallback calc (align Analytics method)
        const { viewCount, videoCount } = user.platformInfo.youtube.channel;
        const avgDailyViews = videoCount > 0 ? viewCount / videoCount / 30 : 0;  // Approx daily
        const dailyEarnings = (avgDailyViews / 1000) * 150;  // Base rate
        analytics.youtube.metrics.estimatedDailyEarnings = dailyEarnings;
        analytics.youtube.metrics.estimateMonthlyEarnings = dailyEarnings * 30;
        analytics.youtube.metrics.avgDailyRevenue90d = dailyEarnings;
        analytics.youtube.metrics.watchHours90d = 0;  // Stub
        // Ensure earningsHistory is initialized without NaN if needed
        if (!analytics.youtube.metrics.earningsHistory) {
          analytics.youtube.metrics.earningsHistory = [];
        } else {
          analytics.youtube.metrics.earningsHistory.forEach((entry) => {
            if (entry.dropPercent !== undefined && isNaN(entry.dropPercent)) {
              entry.dropPercent = 0;
            }
          });
        }
        await analytics.save();
      } else {
        throw err;
      }
    }

    // Link back (align schema)
    user.financialInfo.analyticsId = analytics._id;
    user.financialInfo.monthlyEarnings = analytics.youtube.metrics.estimateMonthlyEarnings || 0;
    await user.save();

    // === STEP 6: Generate JWT ===
    const token = jwt.sign(
      { userId: user._id, youtubeId: user.platformInfo.youtube.id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('OAuth success:', { userId: user._id, scopes: grantedScopes });
    done(null, { 
      id: user._id, 
      token, 
      youtubeId: user.platformInfo.youtube.id, 
      login: !isNewUser  // For frontend: returning vs new
    });

  } catch (err) {
    console.error('OAuth error:', err.message);
    done(err, null);
  }
}));

passport.serializeUser((obj, done) => done(null, obj.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

export default passport;