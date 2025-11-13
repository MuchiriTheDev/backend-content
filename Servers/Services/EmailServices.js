// services/emailService.js
import nodemailer from 'nodemailer';
import logger from '../Utilities/Logger.js';
import dotenv from 'dotenv';
dotenv.config();

// Create reusable transporter object
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  pool: true,
  maxConnections: 5,
  maxMessages: 100
});

// Verify transporter setup
transporter.verify((error, success) => {
  if (error) {
    logger.error(`Email transporter verification failed: ${error.message}`);
  } else {
    logger.info('Email transporter ready');
  }
});

/**
 * Send email with optional attachments
 * @param {Object} options - Email options
 * @param {string|string[]} options.to - Recipient email(s)
 * @param {string} options.subject - Email subject
 * @param {string} [options.text] - Plain text body
 * @param {string} [options.html] - HTML body
 * @param {Array} [options.attachments] - Array of attachment objects
 * @param {string} options.attachments[].filename - Attachment filename
 * @param {string|Buffer} options.attachments[].content - Attachment content
 * @param {string} [options.attachments[].contentType] - Attachment content type
 * @param {string} [options.attachments[].path] - Path to file (alternative to content)
 * @returns {Promise} Nodemailer sendMail result
 */
export const sendEmail = async ({ to, subject, text, html, attachments = [] }) => {
  try {
    // Validate input
    if (!to || !subject || (!text && !html && !attachments.length)) {
      throw new Error('Missing required email fields: need subject, and either text, html, or attachments');
    }

    // Process attachments
    const processedAttachments = attachments.map(attachment => {
      // Handle buffer content
      if (attachment.content instanceof Buffer) {
        return {
          filename: attachment.filename || 'attachment',
          content: attachment.content,
          contentType: attachment.contentType || 'application/octet-stream'
        };
      }
      
      // Handle string content
      if (typeof attachment.content === 'string') {
        return {
          filename: attachment.filename || 'attachment.txt',
          content: attachment.content,
          contentType: attachment.contentType || 'text/plain'
        };
      }
      
      // Handle path
      if (attachment.path) {
        return {
          filename: attachment.filename || attachment.path.split('/').pop(),
          path: attachment.path
        };
      }
      
      return attachment;
    });

    // Email options
    const mailOptions = {
      from: `"CCI Support" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text,
      html,
      attachments: processedAttachments
    };

    // Send email
    const info = await transporter.sendMail(mailOptions);
    logger.info(`Email sent to ${to} with ${attachments.length} attachments: ${info.messageId}`);
    return info;
  } catch (error) {
    logger.error(`Failed to send email to ${to}: ${error.message}`);
    throw error;
  }
};

// Enhanced verification email with optional attachments
export const sendVerificationEmail = async (email, token, attachments = []) => {
  const verificationLink = `${process.env.FRONTEND_URL}/verify/${token}`;
  const subject = 'Verify Your CCI Account';
  const text = `Please verify your account by clicking this link: ${verificationLink}`;
  const html = `
    <h2>Welcome to CCI!</h2>
    <p>Please verify your account by clicking the link below:</p>
    <a href="${verificationLink}">Verify Email</a>
    <p>This link expires in 24 hours.</p>
  `;

  return sendEmail({ to: email, subject, text, html, attachments });
};

// Enhanced password reset email with optional attachments
export const sendPasswordResetEmail = async (email, token, attachments = []) => {
  const resetLink = `${process.env.FRONTEND_URL}/reset-password/${token}`;
  const subject = 'Reset Your CCI Password';
  const text = `Click here to reset your password: ${resetLink}`;
  const html = `
    <h2>Password Reset Request</h2>
    <p>You requested a password reset. Click the link below to proceed:</p>
    <a href="${resetLink}">Reset Password</a>
    <p>This link expires in 1 hour.</p>
  `;

  return sendEmail({ to: email, subject, text, html, attachments });
};

// New function specifically for sending claim reports
export const sendClaimReportEmail = async (email, reportData, format = 'docx') => {
  const subject = 'CCI Claim Report';
  const text = 'Please find attached your claim report.';
  const html = `
    <h2>CCI Claim Report</h2>
    <p>Please find attached your claim report.</p>
    <p>You can also download it from your dashboard.</p>
  `;

  let attachment;
  if (format === 'docx') {
    attachment = {
      filename: 'claim_report.docx',
      content: reportData,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
  } else if (format === 'pdf') {
    attachment = {
      filename: 'claim_report.pdf',
      content: reportData,
      contentType: 'application/pdf'
    };
  } else {
    attachment = {
      filename: 'claim_report.json',
      content: JSON.stringify(reportData, null, 2),
      contentType: 'application/json'
    };
  }

  return sendEmail({ to: email, subject, text, html, attachments: [attachment] });
};

export default sendEmail;