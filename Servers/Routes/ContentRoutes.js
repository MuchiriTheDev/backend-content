// routes/content.js (CCI: Chat-Centric - Sessions, Chat, Analytics)
import express from 'express';
import {
  contentChat,  // Core: POST for prompts/review/gen/research
  getMySessions,  // GET creator sessions
  getSessionById,  // GET single session
  deleteSession,  // DELETE session
  getAllSessions,  // GET admin all sessions
  getContentAnalytics,  // GET admin analytics
  uploadChatFile  // Middleware for optional file in chat
} from '../Controllers/ContentController.js';
import authMiddleware from '../Middlewares/Authenticator.js';
import { adminMiddleware } from '../Middlewares/Admin.js';

const contentRouter = express.Router();

// Creator Routes (Private: Auth required)
contentRouter.post('/chat', authMiddleware, uploadChatFile, contentChat);  // Unified: Prompts, review, gen, research
contentRouter.get('/my-sessions', authMiddleware, getMySessions);  // List active sessions (replaces /my-content)
contentRouter.get('/sessions/:id', authMiddleware, getSessionById);  // Single session details
contentRouter.delete('/sessions/:id', authMiddleware, deleteSession);  // Close/delete session (replaces /delete-content)

// Admin Routes (Private: Auth + Admin)
contentRouter.get('/all-sessions', authMiddleware, adminMiddleware, getAllSessions);  // All sessions (replaces /all)
contentRouter.get('/analytics', authMiddleware, adminMiddleware, getContentAnalytics);  // Analytics

export default contentRouter;