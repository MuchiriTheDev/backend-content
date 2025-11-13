// controllers/adminPremiumController.js
import Claim from '../Models/Claim.js';
import Content from '../Models/Content.js';
import Premium from '../Models/Premium.js';
import User from '../Models/User.js';
import { sendEmail } from '../Services/EmailServices.js';
import logger from '../Utilities/Logger.js';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel } from 'docx';

// @desc    Bulk adjust premiums (Admin only)
// @route   POST /api/admin/premiums/bulk-adjust
// @access  Private (Admin)
export const bulkAdjustPremiums = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { adjustments } = req.body; // Array of { premiumId, adjustmentPercentage, reason }

    if (!Array.isArray(adjustments) || adjustments.length === 0) {
      logger.warn(`Invalid adjustments array for admin ${adminId}`);
      return res.status(400).json({ success: false, error: 'Adjustments array is required and cannot be empty' });
    }

    const results = [];
    for (const adjustment of adjustments) {
      const { premiumId, adjustmentPercentage, reason } = adjustment;
      const premium = await Premium.findById(premiumId);
      if (!premium) {
        results.push({ premiumId, success: false, error: 'Premium not found' });
        continue;
      }

      const user = await User.findById(premium.premiumDetails.userId);
      if (!user) {
        results.push({ premiumId, success: false, error: 'Associated user not found' });
        continue;
      }

      try {
        const newFinalAmount = await premium.adjustPremium(adjustmentPercentage, reason, adminId);
        user.financialInfo.premium.percentage = premium.premiumDetails.finalPercentage;
        user.financialInfo.premium.amount = newFinalAmount;
        user.financialInfo.premium.lastCalculated = new Date();
        await user.save();

        await sendEmail({
          to: user.personalInfo.email,
          subject: 'CCI Premium Adjusted',
          text: `Dear ${user.personalInfo.firstName},\n\nYour premium has been adjusted by ${adjustmentPercentage}% due to: ${reason}. New premium: KES ${newFinalAmount}.`,
          html: `<p>Dear ${user.personalInfo.firstName},</p><p>Your premium has been adjusted by ${adjustmentPercentage}% due to: ${reason}. New premium: KES ${newFinalAmount}.</p>`,
        });

        results.push({ premiumId, success: true, message: 'Premium adjusted successfully' });
      } catch (error) {
        results.push({ premiumId, success: false, error: error.message });
      }
    }

    logger.info(`Admin ${adminId} bulk adjusted ${adjustments.length} premiums`);
    res.json({
      success: true,
      message: 'Bulk premium adjustments completed',
      data: results,
    });
  } catch (error) {
    logger.error(`Error in bulkAdjustPremiums: ${error.message}`);
    next(error);
  }
};

// @desc    Send payment reminders (Admin only)
// @route   POST /api/admin/premiums/reminders
// @access  Private (Admin)
export const sendPaymentReminders = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { premiumIds } = req.body; // Array of premium IDs

    if (!Array.isArray(premiumIds) || premiumIds.length === 0) {
      logger.warn(`Invalid premiumIds array for admin ${adminId}`);
      return res.status(400).json({ success: false, error: 'Premium IDs array is required and cannot be empty' });
    }

    const results = [];
    for (const premiumId of premiumIds) {
      const premium = await Premium.findById(premiumId);
      if (!premium) {
        results.push({ premiumId, success: false, error: 'Premium not found' });
        continue;
      }

      if (premium.paymentStatus.status === 'Paid') {
        results.push({ premiumId, success: false, error: 'Premium already paid' });
        continue;
      }

      const user = await User.findById(premium.premiumDetails.userId);
      if (!user) {
        results.push({ premiumId, success: false, error: 'Associated user not found' });
        continue;
      }

      try {
        await sendEmail({
          to: user.personalInfo.email,
          subject: 'CCI Premium Payment Reminder',
          text: `Dear ${user.personalInfo.firstName},\n\nYour premium of KES ${premium.premiumDetails.finalAmount} is due by ${premium.paymentStatus.dueDate.toDateString()}. Please pay to maintain coverage.`,
          html: `<p>Dear ${user.personalInfo.firstName},</p><p>Your premium of KES ${premium.premiumDetails.finalAmount} is due by ${premium.paymentStatus.dueDate.toDateString()}. Please pay to maintain coverage.</p>`,
        });

        premium.paymentStatus.remindersSent = (premium.paymentStatus.remindersSent || 0) + 1;
        await premium.save();

        results.push({ premiumId, success: true, message: 'Payment reminder sent' });
      } catch (emailError) {
        results.push({ premiumId, success: false, error: 'Failed to send reminder email' });
      }
    }

    loggerquery: logger.info(`Admin ${adminId} sent payment reminders for ${premiumIds.length} premiums`);
    res.json({
      success: true,
      message: 'Payment reminders sent',
      data: results,
    });
  } catch (error) {
    logger.error(`Error in sendPaymentReminders: ${error.message}`);
    next(error);
  }
};

// @desc    Audit premiums with AI (Admin only)
// @route   POST /api/admin/premiums/audit
// @access  Private (Admin)
export const auditPremiumsWithAI = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { premiumIds } = req.body; // Array of premium IDs

    if (!Array.isArray(premiumIds) || premiumIds.length === 0) {
      logger.warn(`Invalid premiumIds array for admin ${adminId}`);
      return res.status(400).json({ success: false, error: 'Premium IDs array is required and cannot be empty' });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: proces.env.MODEL_GEMINI });

    const results = [];
    for (const premiumId of premiumIds) {
      const premium = await Premium.findById(premiumId);
      if (!premium) {
        results.push({ premiumId, success: false, error: 'Premium not found' });
        continue;
      }

      const user = await User.findById(premium.premiumDetails.userId);
      if (!user) {
        results.push({ premiumId, success: false, error: 'Associated user not found' });
        continue;
      }

      const prompt = `
        You are an AI assistant for Content Creators Insurance (CCI). Audit the following premium for fairness, anomalies, and optimization opportunities. Provide insights on premium pricing, payment compliance, and risk alignment.

        **Premium Data**:
        - User ID: ${premium.premiumDetails.userId}
        - Final Percentage: ${premium.premiumDetails.finalPercentage}%
        - Final Amount: KES ${premium.premiumDetails.finalAmount}
        - Monthly Earnings: KES ${user.financialInfo.monthlyEarnings}
        - Payment Status: ${premium.paymentStatus.status}
        - Discount Applied: ${premium.premiumDetails.discount.preventiveServiceDiscount}%
        - Platform Count: ${user.platformInfo.platforms.length}
        - Platforms: ${JSON.stringify(user.platformInfo.platforms.map(p => ({ name: p.name, audienceSize: p.audienceSize })))}

        **Instructions**:
        - Check if the premium is fair relative to earnings and risks.
        - Identify anomalies (e.g., unusually high/low premiums, payment issues).
        - Suggest optimizations (e.g., adjust percentage, apply discounts, review content).
        - Provide insights in JSON format:
        {
          "insights": [
            {
              "title": "Insight title",
              "description": "Detailed description of the insight",
              "action": "Recommended action to optimize premium"
            },
            ...
          ]
        }
      `;

      const result = await model.generateContent({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1500,
        },
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
          },
        ],
      });

      let aiInsights = { insights: [] };
      try {
        const rawResponse = result.response.text().replace(/```json\s*|\s*```/g, '').trim();
        aiInsights = JSON.parse(rawResponse);
      } catch (error) {
        logger.error(`Failed to parse AI insights for premium ${premiumId}: ${error.message}`);
        aiInsights = {
          insights: [
            {
              title: 'Default Insight',
              description: 'Unable to generate AI insights due to an error.',
              action: 'Manually review premium data for fairness and anomalies.',
            },
          ],
        };
      }

      results.push({ premiumId, success: true, insights: aiInsights.insights });
    }

    logger.info(`Admin ${adminId} audited ${premiumIds.length} premiums with AI`);
    res.json({
      success: true,
      message: 'Premium audit completed',
      data: results,
    });
  } catch (error) {
    logger.error(`Error in auditPremiumsWithAI: ${error.message}`);
    next(error);
  }
};

// @desc    Get premium history (Admin only)
// @route   GET /api/admin/premiums/:id/history
// @access  Private (Admin)
export const getPremiumHistory = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { id } = req.params; // premiumId

    const premium = await Premium.findById(id);
    if (!premium) {
      logger.error(`Premium not found: ${id}`);
      return res.status(404).json({ success: false, error: 'Premium not found' });
    }

    const user = await User.findById(premium.premiumDetails.userId);
    if (!user) {
      logger.error(`User not found for premium ${id}: ${premium.premiumDetails.userId}`);
      return res.status(404).json({ success: false, error: 'Associated user not found' });
    }

    const history = {
      calculationHistory: premium.calculationHistory || [],
      paymentAttempts: premium.paymentStatus.attempts || [],
      remindersSent: premium.paymentStatus.remindersSent || 0,
      lastRenewedAt: premium.lastRenewedAt,
      renewalCount: premium.renewalCount,
    };

    logger.info(`Admin ${adminId} retrieved history for premium ${id}`);
    res.json({
      success: true,
      data: {
        premiumId: id,
        userId: premium.premiumDetails.userId,
        userEmail: user.personalInfo.email,
        history,
      },
    });
  } catch (error) {
    logger.error(`Error in getPremiumHistory: ${error.message}`);
    next(error);
  }
};
// ... existing imports (User, Premium, Claim, Content, GoogleGenerativeAI, Document, Table, etc.)
// ... existing endpoints (bulkAdjustPremiums, sendPaymentReminders, auditPremiumsWithAI, getPremiumHistory)

// @desc    Generate premium report with AI insights
// @route   POST /api/admin/premiums/report
// @access  Private (Admin)
export const generatePremiumReport = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const admin = await User.findById(adminId);
    if (!admin || admin.role !== 'Admin') {
      logger.error(`Unauthorized report access by user ${adminId}`);
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const { startDate, endDate, platform, paymentStatus } = req.body;

    // Validate date range if both dates are provided
    if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
      logger.warn(`Invalid date range for premium report by admin ${adminId}`);
      return res.status(400).json({ success: false, error: 'End date cannot be before start date' });
    }

    // Build query for premiums
    const query = {};
    if (paymentStatus) {
      query['paymentStatus.status'] = paymentStatus;
    }
    if (startDate || endDate) {
      query['paymentStatus.dueDate'] = {};
      if (startDate) {
        query['paymentStatus.dueDate'].$gte = new Date(startDate);
      }
      if (endDate) {
        query['paymentStatus.dueDate'].$lte = new Date(endDate);
      }
      // If only startDate is provided, set endDate to now
      if (startDate && !endDate) {
        query['paymentStatus.dueDate'].$lte = new Date();
      }
    }

    // Fetch premiums
    const premiums = await Premium.find(query)
      .select('premiumDetails paymentStatus calculationHistory adjustmentHistory createdAt updatedAt')
      .lean();

    // Enrich premium data with user, claims, and content reviews
    const reportData = await Promise.all(
      premiums.map(async (premium) => {
        const user = await User.findById(premium.premiumDetails.userId)
          .select('personalInfo.email personalInfo.firstName personalInfo.lastName platformInfo financialInfo')
          .lean();
        const claims = await Claim.find({ 'claimDetails.userId': premium.premiumDetails.userId })
          .select('statusHistory claimDetails.incidentType evaluation')
          .lean();
        const contentReviews = await Content.find({ 'contentDetails.userId': premium.premiumDetails.userId })
          .select('riskAssessment.riskLevel contentDetails.platform')
          .lean();

        // Filter platforms if specified
        const userPlatforms = platform
          ? user?.platformInfo.platforms.filter((p) => p.name === platform).map((p) => p.name) || []
          : user?.platformInfo.platforms.map((p) => p.name) || [];

        return {
          premiumId: premium._id,
          userId: premium.premiumDetails.userId,
          email: user?.personalInfo.email || 'N/A',
          name: user ? `${user.personalInfo.firstName} ${user.personalInfo.lastName}` : 'N/A',
          paymentStatus: premium.paymentStatus.status,
          dueDate: premium.paymentStatus.dueDate?.toISOString() || 'N/A',
          paymentDate: premium.paymentStatus.paymentDate?.toISOString() || 'N/A',
          finalAmount: premium.premiumDetails.finalAmount || 0,
          finalPercentage: premium.premiumDetails.finalPercentage || 0,
          discountApplied: premium.premiumDetails.discount.percentage || 0,
          discountReason: premium.premiumDetails.discount.reason || 'None',
          manualAdjustments: premium.premiumDetails.adjustmentHistory?.length || 0,
          platforms: userPlatforms.join(', ') || 'None',
          monthlyEarnings: user?.financialInfo.monthlyEarnings || 0,
          claimCount: claims.length,
          approvedClaims: claims.filter((c) =>
            c.statusHistory.history.some((h) => h.status === 'Approved')
          ).length,
          contentReviewCount: contentReviews.length,
          highRiskContentCount: contentReviews.filter((c) => c.riskAssessment.riskLevel === 'High').length,
        };
      })
    );

    // Filter out premiums with no matching platforms if platform filter is applied
    const filteredReportData = platform
      ? reportData.filter((data) => data.platforms.length > 0)
      : reportData;

    // Generate AI insights
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: process.env.MODEL_GEMINI });
    const aiInsights = await generatePremiumAiInsights(filteredReportData, model);

    // Determine metadata date range description
    let dateRangeDescription;
    if (!startDate && !endDate) {
      dateRangeDescription = 'All time';
    } else if (startDate && !endDate) {
      dateRangeDescription = `${startDate} to Now`;
    } else if (!startDate && endDate) {
      dateRangeDescription = `Up to ${endDate}`;
    } else {
      dateRangeDescription = `${startDate} to ${endDate}`;
    }

    // Create DOCX document
    const doc = await createPremiumReportDocument(filteredReportData, aiInsights, {
      startDate: startDate || 'All time',
      endDate: endDate || 'Now',
      platform: platform || 'All platforms',
      paymentStatus: paymentStatus || 'All statuses',
      adminEmail: admin.personalInfo.email,
      dateRangeDescription, // Pass the descriptive date range
    });

    // Convert to buffer
    const buffer = await Packer.toBuffer(doc);

    // Send the DOCX file as response
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename=CCI_Premium_Report.docx');
    res.send(buffer);

    logger.info(`Admin ${adminId} generated premium report with ${aiInsights.insights.length} AI insights`);
  } catch (error) {
    logger.error(`Error in generatePremiumReport: ${error.message}`);
    next(error);
  }
};

// Helper function to generate AI insights for premium report
async function generatePremiumAiInsights(reportData, model) {
  const prompt = `
    You are an AI assistant for Content Creators Insurance (CCI). Analyze the following premium report data and provide actionable insights to optimize premium pricing, improve payment compliance, reduce risks, and drive business growth.

    **Report Data**:
    - Total Premiums: ${reportData.length}
    - Payment Status Breakdown: ${JSON.stringify(
      reportData.reduce((acc, r) => ({ ...acc, [r.paymentStatus]: (acc[r.paymentStatus] || 0) + 1 }), {})
    )}
    - Platforms: ${JSON.stringify([...new Set(reportData.flatMap((r) => r.platforms.split(', ').filter(Boolean)))])}
    - Total Premium Amount (KES): ${reportData.reduce((sum, r) => sum + r.finalAmount, 0).toFixed(2)}
    - Average Premium Percentage: ${(
      reportData.reduce((sum, r) => sum + r.finalPercentage, 0) / (reportData.length || 1)
    ).toFixed(2)}%
    - Total Discounts Applied: ${reportData.filter((r) => r.discountApplied > 0).length}
    - Total Manual Adjustments: ${reportData.reduce((sum, r) => sum + r.manualAdjustments, 0)}
    - Total Claims: ${reportData.reduce((sum, r) => sum + r.claimCount, 0)}
    - Approved Claims: ${reportData.reduce((sum, r) => sum + r.approvedClaims, 0)}
    - Total Content Reviews: ${reportData.reduce((sum, r) => sum + r.contentReviewCount, 0)}
    - High-Risk Content: ${reportData.reduce((sum, r) => sum + r.highRiskContentCount, 0)}
    - Average Monthly Earnings (KES): ${(
      reportData.reduce((sum, r) => sum + r.monthlyEarnings, 0) / (reportData.length || 1)
    ).toFixed(2)}

    **Instructions**:
    - Identify premiums at risk of non-payment (e.g., frequent overdue statuses, multiple failed attempts).
    - Suggest premium pricing optimizations (e.g., adjust base percentages, increase discounts for low-risk creators).
    - Highlight high-risk platforms or creators for targeted interventions.
    - Recommend strategies to improve payment compliance (e.g., automated reminders, flexible payment plans).
    - Propose business growth opportunities (e.g., target new platforms, offer bundled insurance products).
    - Provide insights in JSON format:
    {
      "insights": [
        {
          "title": "Insight title",
          "description": "Detailed description of the insight",
          "action": "Recommended action to improve outcomes",
          "priority": "high/medium/low"
        },
        ...
      ]
    }
  `;

  try {
    const result = await model.generateContent({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1500,
      },
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
      ],
    });

    const rawResponse = result.response.text().replace(/```json\s*|\s*```/g, '').trim();
    return JSON.parse(rawResponse);
  } catch (error) {
    logger.error(`Failed to generate AI insights for premium report: ${error.message}`);
    return {
      insights: [
        {
          title: 'Default Insight',
          description: 'Unable to generate AI insights due to an error.',
          action: 'Manually review premium data for pricing fairness and payment trends.',
          priority: 'medium',
        },
      ],
    };
  }
}

// Helper function to create DOCX document for premium report
async function createPremiumReportDocument(premiums, aiInsights, metadata) {
  // Create premium table rows
  const premiumRows = premiums.map((premium) => new TableRow({
    children: [
      new TableCell({ children: [new Paragraph(premium.premiumId.toString().slice(-6))] }),
      new TableCell({ children: [new Paragraph(premium.email)] }),
      new TableCell({ children: [new Paragraph(premium.name)] }),
      new TableCell({ children: [new Paragraph(premium.paymentStatus)] }),
      new TableCell({ children: [new Paragraph(premium.dueDate)] }),
      new TableCell({ children: [new Paragraph(premium.paymentDate)] }),
      new TableCell({ children: [new Paragraph(`KES ${premium.finalAmount.toFixed(2)}`)] }),
      new TableCell({ children: [new Paragraph(`${premium.finalPercentage.toFixed(2)}%`)] }),
      new TableCell({ children: [new Paragraph(`${premium.discountApplied}%`)] }),
      new TableCell({ children: [new Paragraph(premium.discountReason)] }),
      new TableCell({ children: [new Paragraph(premium.manualAdjustments.toString())] }),
      new TableCell({ children: [new Paragraph(premium.platforms)] }),
      new TableCell({ children: [new Paragraph(`KES ${premium.monthlyEarnings.toFixed(2)}`)] }),
      new TableCell({ children: [new Paragraph(premium.claimCount.toString())] }),
      new TableCell({ children: [new Paragraph(premium.approvedClaims.toString())] }),
      new TableCell({ children: [new Paragraph(premium.contentReviewCount.toString())] }),
    ],
  }));

  // Create insights sections
  const insightSections = aiInsights.insights.map((insight) => [
    new Paragraph({
      text: `${insight.title} (${insight.priority} priority)`,
      heading: HeadingLevel.HEADING_3,
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Description: ', bold: true }),
        new TextRun(insight.description),
      ],
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Recommended Action: ', bold: true }),
        new TextRun(insight.action),
      ],
      spacing: { after: 200 },
    }),
  ]).flat();

  // Create the document
  return new Document({
    sections: [
      {
        properties: {},
        children: [
          // Header
          new Paragraph({
            text: 'Content Creators Insurance (CCI)',
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 200 },
          }),
          new Paragraph({
            text: 'Premium Report with AI Insights',
            heading: HeadingLevel.HEADING_2,
            spacing: { after: 200 },
          }),

          // Report metadata
          new Paragraph({
            text: `Report Period: ${metadata.dateRangeDescription}`,
            spacing: { after: 100 },
          }),
          new Paragraph({
            text: `Platform: ${metadata.platform}`,
            spacing: { after: 100 },
          }),
          new Paragraph({
            text: `Payment Status: ${metadata.paymentStatus}`,
            spacing: { after: 100 },
          }),
          new Paragraph({
            text: `Generated on: ${new Date().toISOString()}`,
            spacing: { after: 100 },
          }),
          new Paragraph({
            text: `Generated for: ${metadata.adminEmail}`,
            spacing: { after: 200 },
          }),

          // Summary statistics
          new Paragraph({
            text: 'Summary Statistics',
            heading: HeadingLevel.HEADING_3,
            spacing: { after: 100 },
          }),
          new Paragraph({
            text: `Total Premiums: ${premiums.length}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Total Premium Amount: KES ${premiums
              .reduce((sum, p) => sum + p.finalAmount, 0)
              .toFixed(2)}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Average Premium Percentage: ${(
              premiums.reduce((sum, p) => sum + p.finalPercentage, 0) / (premiums.length || 1)
            ).toFixed(2)}%`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Total Discounts Applied: ${premiums.filter((p) => p.discountApplied > 0).length}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Total Manual Adjustments: ${premiums.reduce((sum, p) => sum + p.manualAdjustments, 0)}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Total Claims: ${premiums.reduce((sum, p) => sum + p.claimCount, 0)}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Approved Claims: ${premiums.reduce((sum, p) => sum + p.approvedClaims, 0)}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `Total Content Reviews: ${premiums.reduce((sum, p) => sum + p.contentReviewCount, 0)}`,
            spacing: { after: 50 },
          }),
          new Paragraph({
            text: `High-Risk Content: ${premiums.reduce((sum, p) => sum + p.highRiskContentCount, 0)}`,
            spacing: { after: 200 },
          }),

          // Premiums table
          new Paragraph({
            text: 'Premium Details',
            heading: HeadingLevel.HEADING_3,
            spacing: { after: 100 },
          }),
          new Table({
            rows: [
              // Header row
              new TableRow({
                children: [
                  new TableCell({
                    children: [new Paragraph('Premium ID')],
                    width: { size: 800, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Email')],
                    width: { size: 2000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Name')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Payment Status')],
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Due Date')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Payment Date')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Amount (KES)')],
                    width: { size: 1200, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Percentage')],
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Discount %')],
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Discount Reason')],
                    width: { size: 2000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Adjustments')],
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Platforms')],
                    width: { size: 1500, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Earnings (KES)')],
                    width: { size: 1200, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Claims')],
                    width: { size: 800, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Approved Claims')],
                    width: { size: 1000, type: WidthType.DXA },
                  }),
                  new TableCell({
                    children: [new Paragraph('Content Reviews')],
                    width: { size: 1200, type: WidthType.DXA },
                  }),
                ],
              }),
              ...premiumRows,
            ],
            width: { size: 100, type: WidthType.PERCENTAGE },
          }),

          // AI Insights section
          new Paragraph({
            text: 'AI-Generated Insights',
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 },
          }),
          ...insightSections,
        ],
      },
    ],
  });
}