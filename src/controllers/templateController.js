const axios = require("axios");
const WabaAccount = require("../models/WabaAccount");
const PhoneNumber = require("../models/PhoneNumber");
const Campaign = require("../models/Campaign");
const Analytics = require("../models/Analytics");
const Reply = require("../models/Reply");
const MediaMap = require("../models/MediaMap");
const { clearTemplateCache } = require("../integrations/whatsappAPI");

/**
 * Helper: Fetch Meta template_analytics safely in batches of up to 10 template IDs
 */
const fetchMetaTemplateAnalytics = async ({
  apiVersion,
  wabaId,
  accessToken,
  templateIds,
  startVal,
  endVal,
}) => {
  const statsByTemplateId = {};
  if (!templateIds || templateIds.length === 0) return statsByTemplateId;

  // Clamp timestamps to valid past/present window (Meta rejects future timestamps or ranges > 90 days)
  const nowSec = Math.floor(Date.now() / 1000);
  const safeEnd = Math.min(endVal || nowSec, nowSec);
  const ninetyDaysSec = 90 * 24 * 60 * 60;
  const safeStart = Math.max(
    startVal || safeEnd - 30 * 24 * 60 * 60,
    safeEnd - ninetyDaysSec
  );

  if (safeStart >= safeEnd) return statsByTemplateId;

  // Batch up to 10 template IDs per request per Meta Graph API limits
  const batchSize = 10;
  const batches = [];
  for (let i = 0; i < templateIds.length; i += batchSize) {
    batches.push(templateIds.slice(i, i + batchSize));
  }

  await Promise.allSettled(
    batches.map(async (batchIds) => {
      const params = new URLSearchParams({
        start: String(safeStart),
        end: String(safeEnd),
        granularity: "DAILY",
        metric_types: "SENT,DELIVERED,READ",
        template_ids: JSON.stringify(batchIds),
      });
      const url = `https://graph.facebook.com/${apiVersion}/${wabaId}/template_analytics?${params.toString()}`;
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000,
      });

      const entries = res.data?.data || [];
      entries.forEach((entry) => {
        // Format A: entry.data_points (Graph API v18-v20 template_analytics)
        if (Array.isArray(entry.data_points)) {
          entry.data_points.forEach((dp) => {
            const tId = dp.template_id || entry.id;
            if (!tId) return;
            if (!statsByTemplateId[tId]) {
              statsByTemplateId[tId] = {
                sent: 0,
                delivered: 0,
                read: 0,
                cost: 0,
                daily: [],
              };
            }
            const sent = Number(dp.sent || 0);
            const delivered = Number(dp.delivered || 0);
            const read = Number(dp.read || 0);
            let cost = 0;
            if (Array.isArray(dp.cost)) {
              const amtObj = dp.cost.find((c) => c.type === "amount_spent");
              if (amtObj && amtObj.value) cost = Number(amtObj.value);
            }
            statsByTemplateId[tId].sent += sent;
            statsByTemplateId[tId].delivered += delivered;
            statsByTemplateId[tId].read += read;
            statsByTemplateId[tId].cost += cost;
            if (dp.start) {
              statsByTemplateId[tId].daily.push({
                timestamp: dp.start * 1000,
                dateKey: new Date(dp.start * 1000).toISOString().slice(0, 10),
                sent,
                delivered,
                read,
              });
            }
          });
        }

        // Format B: entry.analytics (legacy message_template_analytics)
        if (entry.id && Array.isArray(entry.analytics)) {
          const tId = entry.id;
          if (!statsByTemplateId[tId]) {
            statsByTemplateId[tId] = {
              sent: 0,
              delivered: 0,
              read: 0,
              cost: 0,
              daily: [],
            };
          }
          entry.analytics.forEach((dayPoint) => {
            let sent = 0;
            let delivered = 0;
            let read = 0;
            if (Array.isArray(dayPoint.stats)) {
              dayPoint.stats.forEach((s) => {
                if (s.metric_type === "SENT") sent += Number(s.value || 0);
                if (s.metric_type === "DELIVERED")
                  delivered += Number(s.value || 0);
                if (s.metric_type === "READ") read += Number(s.value || 0);
              });
            }
            statsByTemplateId[tId].sent += sent;
            statsByTemplateId[tId].delivered += delivered;
            statsByTemplateId[tId].read += read;
            if (dayPoint.date_start) {
              statsByTemplateId[tId].daily.push({
                timestamp: dayPoint.date_start * 1000,
                dateKey: new Date(dayPoint.date_start * 1000)
                  .toISOString()
                  .slice(0, 10),
                sent,
                delivered,
                read,
              });
            }
          });
        }
      });
    })
  );

  return statsByTemplateId;
};

// @desc    Get filtered templates for a WABA with Analytics (merged from Meta + MongoDB)
// @route   GET /api/templates/:wabaId
// @access  Private (Admin/Manager)
const getTemplates = async (req, res) => {
  try {
    const { wabaId } = req.params;
    const {
      name,
      category,
      language,
      status,
      limit = 200,
      start,
      end,
      days,
    } = req.query;

    // 1. Find WABA to get Access Token
    const waba = await WabaAccount.findOne({ businessAccountId: wabaId });
    if (!waba) {
      return res.status(404).json({ success: false, error: "WABA not found" });
    }

    const accessToken = waba.accessToken;
    const apiVersion = process.env.FACEBOOK_API_VERSION || "v20.0";

    // 2. Fetch Templates from Meta
    const fields =
      "name,status,category,language,components,last_updated_time,quality_score,rejected_reason";
    const templatesUrl = `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates?limit=${limit}&fields=${fields}`;

    const templatesResponse = await axios.get(templatesUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    let templates = templatesResponse.data?.data || [];

    // 3. Determine Date Filter for DB & Meta Analytics
    // If days === "all" or "0", do not restrict DB stats by date so all historical campaign data is shown
    const isAllTime = days === "all" || days === "0" || (!start && !end && !days);
    const startVal = start ? parseInt(start, 10) : null;
    const endVal = end ? parseInt(end, 10) : null;

    // 4. Aggregate Campaign + Analytics + Reply stats from MongoDB for this WABA
    const phones = await PhoneNumber.find({ wabaAccount: waba._id }).select("_id");
    const phoneIds = phones.map((p) => p._id);

    const campaignQuery = {
      ...(phoneIds.length > 0 ? { phoneNumber: { $in: phoneIds } } : {}),
    };

    if (!isAllTime && startVal && endVal) {
      const startDate = new Date(startVal * 1000);
      const endDate = new Date(endVal * 1000);
      campaignQuery.$or = [
        { sentAt: { $gte: startDate, $lte: endDate } },
        { createdAt: { $gte: startDate, $lte: endDate } },
      ];
    }

    const campaigns = await Campaign.find(campaignQuery).select(
      "_id templateName replyCount headerImageUrl createdAt sentAt"
    );

    const campaignIds = campaigns.map((c) => c._id);
    const campaignToTemplateMap = {};
    const dbStatsByTemplateName = {};
    const campaignHeaderImageByTemplate = {};

    campaigns.forEach((c) => {
      if (!c.templateName) return;
      campaignToTemplateMap[String(c._id)] = c.templateName;
      if (!dbStatsByTemplateName[c.templateName]) {
        dbStatsByTemplateName[c.templateName] = {
          sent: 0,
          delivered: 0,
          read: 0,
          failed: 0,
          skipped: 0,
          replies: 0,
          campaignsCount: 0,
        };
      }
      dbStatsByTemplateName[c.templateName].replies += Number(c.replyCount || 0);
      dbStatsByTemplateName[c.templateName].campaignsCount += 1;

      if (
        c.headerImageUrl &&
        c.headerImageUrl.startsWith("http") &&
        !campaignHeaderImageByTemplate[c.templateName]
      ) {
        campaignHeaderImageByTemplate[c.templateName] = c.headerImageUrl;
      }
    });

    if (campaignIds.length > 0) {
      const analyticsCounts = await Analytics.aggregate([
        { $match: { campaign: { $in: campaignIds } } },
        {
          $group: {
            _id: { campaign: "$campaign", status: "$status" },
            count: { $sum: 1 },
          },
        },
      ]);

      analyticsCounts.forEach((row) => {
        const tName = campaignToTemplateMap[String(row._id.campaign)];
        if (!tName || !dbStatsByTemplateName[tName]) return;
        const st = row._id.status;
        const count = row.count || 0;

        if (st === "sent") {
          dbStatsByTemplateName[tName].sent += count;
        } else if (st === "delivered") {
          dbStatsByTemplateName[tName].sent += count;
          dbStatsByTemplateName[tName].delivered += count;
        } else if (st === "read") {
          dbStatsByTemplateName[tName].sent += count;
          dbStatsByTemplateName[tName].delivered += count;
          dbStatsByTemplateName[tName].read += count;
        } else if (st === "failed") {
          dbStatsByTemplateName[tName].failed += count;
        } else if (st === "skipped") {
          dbStatsByTemplateName[tName].skipped += count;
        }
      });
    }

    // Also look up MediaMap for template header preview images
    const mediaMaps = await MediaMap.find({
      templateName: { $in: templates.map((t) => t.name) },
    }).sort({ cardIndex: 1 });
    const mediaMapByTemplate = {};
    mediaMaps.forEach((m) => {
      if (m.url && m.url.startsWith("http") && !mediaMapByTemplate[m.templateName]) {
        mediaMapByTemplate[m.templateName] = m.url;
      }
    });

    // 5. Optionally fetch Meta template_analytics for the first 30 templates
    const templateIdsForMeta = templates.slice(0, 30).map((t) => t.id);
    const metaStatsMap = await fetchMetaTemplateAnalytics({
      apiVersion,
      wabaId,
      accessToken,
      templateIds: templateIdsForMeta,
      startVal,
      endVal,
    });

    // 6. Merge Meta + MongoDB stats onto each template
    templates = templates.map((t) => {
      const metaStat = metaStatsMap[t.id] || {
        sent: 0,
        delivered: 0,
        read: 0,
        cost: 0,
      };
      const dbStat = dbStatsByTemplateName[t.name] || {
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        skipped: 0,
        replies: 0,
        campaignsCount: 0,
      };

      const totalSent = Math.max(metaStat.sent, dbStat.sent);
      const totalDelivered = Math.max(
        metaStat.delivered,
        dbStat.delivered > 0 ? dbStat.delivered : dbStat.sent
      );
      const totalRead = Math.max(metaStat.read, dbStat.read);

      const denominator = totalDelivered > 0 ? totalDelivered : totalSent;
      const readRatePct =
        denominator > 0
          ? Math.min(100, Math.round((totalRead / denominator) * 100))
          : 0;
      const deliveryRatePct =
        totalSent > 0
          ? Math.min(100, Math.round((totalDelivered / totalSent) * 100))
          : 0;

      // Resolve preview image URL for HEADER if available
      const headerComp = (t.components || []).find((c) => c.type === "HEADER");
      const metaHandleUrl =
        headerComp?.example?.header_handle?.[0]?.startsWith("http")
          ? headerComp.example.header_handle[0]
          : null;
      const headerImageUrl =
        mediaMapByTemplate[t.name] ||
        campaignHeaderImageByTemplate[t.name] ||
        metaHandleUrl ||
        null;

      return {
        ...t,
        headerImageUrl,
        messages_sent: totalSent,
        messages_delivered: totalDelivered,
        messages_read: totalRead,
        messages_failed: dbStat.failed,
        messages_skipped: dbStat.skipped,
        unique_replies: dbStat.replies,
        campaigns_count: dbStat.campaignsCount,
        delivery_rate: `${deliveryRatePct}%`,
        read_rate: `${readRatePct}%`,
        read_rate_num: readRatePct,
        amount_spent: metaStat.cost > 0 ? `$${metaStat.cost.toFixed(2)}` : null,
      };
    });

    // 7. Apply Filter Params
    if (name) {
      const lowerName = name.toLowerCase();
      templates = templates.filter((t) =>
        t.name.toLowerCase().includes(lowerName)
      );
    }

    if (category) {
      const cats = category.split(",");
      templates = templates.filter((t) => cats.includes(t.category));
    }

    if (language) {
      const langs = language.split(",");
      templates = templates.filter((t) => langs.includes(t.language));
    }

    if (status) {
      const statArr = status.split(",");
      templates = templates.filter((t) => {
        if (statArr.includes(t.status)) return true;
        if (
          statArr.includes("ACTIVE_PENDING") &&
          t.status === "APPROVED" &&
          (!t.quality_score || t.quality_score === "UNKNOWN")
        )
          return true;
        return false;
      });
    }

    res
      .status(200)
      .json({ success: true, count: templates.length, data: templates });
  } catch (error) {
    const metaError = error.response?.data?.error;
    console.error("Error fetching templates:", metaError || error.message);

    if (metaError) {
      return res.status(401).json({
        success: false,
        error: metaError.message || "Meta API Error",
        details: metaError,
      });
    }

    res.status(500).json({
      success: false,
      error: "Failed to fetch templates",
      details: error.message,
    });
  }
};

// @desc    Get detailed analytics for a specific template (Meta + MongoDB daily breakdown & summary)
// @route   GET /api/templates/:wabaId/analytics
// @access  Private (Admin/Manager)
const getTemplateAnalytics = async (req, res) => {
  try {
    const { wabaId } = req.params;
    const { templateId, templateName, start, end, days } = req.query;

    if (!templateId && !templateName) {
      return res
        .status(400)
        .json({ success: false, error: "Missing templateId or templateName" });
    }

    const waba = await WabaAccount.findOne({ businessAccountId: wabaId });
    if (!waba) {
      return res.status(404).json({ success: false, error: "WABA not found" });
    }

    const accessToken = waba.accessToken;
    const apiVersion = process.env.FACEBOOK_API_VERSION || "v20.0";

    const isAllTime = days === "all" || days === "0";
    const startVal = start ? parseInt(start, 10) : null;
    const endVal = end ? parseInt(end, 10) : null;

    // 1. Fetch Meta analytics for this templateId
    let metaStat = { sent: 0, delivered: 0, read: 0, cost: 0, daily: [] };
    if (templateId) {
      const metaMap = await fetchMetaTemplateAnalytics({
        apiVersion,
        wabaId,
        accessToken,
        templateIds: [templateId],
        startVal,
        endVal,
      });
      if (metaMap[templateId]) {
        metaStat = metaMap[templateId];
      }
    }

    // 2. Fetch MongoDB Campaign + Analytics + Reply breakdown if templateName is known
    let resolvedTemplateName = templateName;
    if (!resolvedTemplateName && templateId) {
      try {
        const tRes = await axios.get(
          `https://graph.facebook.com/${apiVersion}/${templateId}?fields=name`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        resolvedTemplateName = tRes.data?.name;
      } catch (e) {}
    }

    let dbSummary = {
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      skipped: 0,
      replies: 0,
      campaignsCount: 0,
    };
    const dailyMap = {}; // dateKey (YYYY-MM-DD) -> { dateKey, name, sent, delivered, read, replies, failed }

    // Seed dailyMap with Meta daily points if any
    metaStat.daily.forEach((dp) => {
      dailyMap[dp.dateKey] = {
        dateKey: dp.dateKey,
        name: new Date(dp.timestamp).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        sent: dp.sent,
        delivered: dp.delivered,
        read: dp.read,
        replies: 0,
        failed: 0,
      };
    });

    if (resolvedTemplateName) {
      const phones = await PhoneNumber.find({ wabaAccount: waba._id }).select(
        "_id"
      );
      const phoneIds = phones.map((p) => p._id);

      const campaignQuery = {
        templateName: resolvedTemplateName,
        ...(phoneIds.length > 0 ? { phoneNumber: { $in: phoneIds } } : {}),
      };

      if (!isAllTime && startVal && endVal) {
        const startDate = new Date(startVal * 1000);
        const endDate = new Date(endVal * 1000);
        campaignQuery.$or = [
          { sentAt: { $gte: startDate, $lte: endDate } },
          { createdAt: { $gte: startDate, $lte: endDate } },
        ];
      }

      const campaigns = await Campaign.find(campaignQuery).select(
        "_id name replyCount sentAt createdAt"
      );
      const campaignIds = campaigns.map((c) => c._id);

      dbSummary.campaignsCount = campaigns.length;
      dbSummary.replies = campaigns.reduce(
        (acc, c) => acc + Number(c.replyCount || 0),
        0
      );

      if (campaignIds.length > 0) {
        const campaignDateById = {};
        campaigns.forEach((c) => {
          const refDate = c.sentAt || c.createdAt || new Date();
          campaignDateById[String(c._id)] = new Date(refDate);
        });

        const analyticsRows = await Analytics.find({
          campaign: { $in: campaignIds },
        }).select("campaign status createdAt updatedAt");

        analyticsRows.forEach((row) => {
          const st = row.status;
          if (st === "sent") {
            dbSummary.sent += 1;
          } else if (st === "delivered") {
            dbSummary.sent += 1;
            dbSummary.delivered += 1;
          } else if (st === "read") {
            dbSummary.sent += 1;
            dbSummary.delivered += 1;
            dbSummary.read += 1;
          } else if (st === "failed") {
            dbSummary.failed += 1;
          } else if (st === "skipped") {
            dbSummary.skipped += 1;
          }

          if (["sent", "delivered", "read", "failed"].includes(st)) {
            const d =
              row.createdAt ||
              campaignDateById[String(row.campaign)] ||
              new Date();
            const dateObj = new Date(d);
            const dateKey = dateObj.toISOString().slice(0, 10);
            if (!dailyMap[dateKey]) {
              dailyMap[dateKey] = {
                dateKey,
                name: dateObj.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                }),
                sent: 0,
                delivered: 0,
                read: 0,
                replies: 0,
                failed: 0,
              };
            }
            if (st === "sent") {
              dailyMap[dateKey].sent += 1;
            } else if (st === "delivered") {
              dailyMap[dateKey].sent += 1;
              dailyMap[dateKey].delivered += 1;
            } else if (st === "read") {
              dailyMap[dateKey].sent += 1;
              dailyMap[dateKey].delivered += 1;
              dailyMap[dateKey].read += 1;
            } else if (st === "failed") {
              dailyMap[dateKey].failed += 1;
            }
          }
        });

        // Also count incoming replies per day for these campaigns
        const incomingReplies = await Reply.find({
          campaign: { $in: campaignIds },
          direction: "incoming",
        }).select("timestamp createdAt");

        if (incomingReplies.length > dbSummary.replies) {
          dbSummary.replies = incomingReplies.length;
        }

        incomingReplies.forEach((rep) => {
          const d = new Date(rep.timestamp || rep.createdAt || new Date());
          const dateKey = d.toISOString().slice(0, 10);
          if (!dailyMap[dateKey]) {
            dailyMap[dateKey] = {
              dateKey,
              name: d.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              }),
              sent: 0,
              delivered: 0,
              read: 0,
              replies: 0,
              failed: 0,
            };
          }
          dailyMap[dateKey].replies += 1;
        });
      }
    }

    const graphData = Object.values(dailyMap).sort((a, b) =>
      a.dateKey.localeCompare(b.dateKey)
    );

    const totalSent = Math.max(metaStat.sent, dbSummary.sent);
    const totalDelivered = Math.max(
      metaStat.delivered,
      dbSummary.delivered > 0 ? dbSummary.delivered : dbSummary.sent
    );
    const totalRead = Math.max(metaStat.read, dbSummary.read);
    const denominator = totalDelivered > 0 ? totalDelivered : totalSent;
    const readRate =
      denominator > 0
        ? Math.min(100, Math.round((totalRead / denominator) * 100))
        : 0;
    const deliveryRate =
      totalSent > 0
        ? Math.min(100, Math.round((totalDelivered / totalSent) * 100))
        : 0;
    const replyRate =
      denominator > 0
        ? Math.min(100, Math.round((dbSummary.replies / denominator) * 100))
        : 0;

    res.status(200).json({
      success: true,
      data: graphData,
      summary: {
        sent: totalSent,
        delivered: totalDelivered,
        read: totalRead,
        failed: dbSummary.failed,
        skipped: dbSummary.skipped,
        replies: dbSummary.replies,
        campaignsCount: dbSummary.campaignsCount,
        readRate,
        deliveryRate,
        replyRate,
        amountSpent:
          metaStat.cost > 0 ? `$${metaStat.cost.toFixed(2)}` : null,
        costPerDelivered:
          metaStat.cost > 0 && totalDelivered > 0
            ? `$${(metaStat.cost / totalDelivered).toFixed(4)}`
            : null,
      },
    });
  } catch (error) {
    console.error(
      "Error in getTemplateAnalytics:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      error: "Failed to fetch analytics",
      details: error.message,
    });
  }
};

// @desc    Create a new Message Template
// @route   POST /api/templates
// @access  Private (Admin/Manager)
const createTemplate = async (req, res) => {
  try {
    const { wabaId, name, category, language, components } = req.body;

    if (!wabaId || !name || !category || !language || !components) {
      return res
        .status(400)
        .json({ success: false, error: "Missing required fields" });
    }

    const waba = await WabaAccount.findOne({ businessAccountId: wabaId });
    if (!waba) {
      return res.status(404).json({ success: false, error: "WABA not found" });
    }

    const accessToken = waba.accessToken;
    const apiVersion = process.env.FACEBOOK_API_VERSION || "v20.0";

    const payload = {
      name,
      category,
      allow_category_change: true,
      language,
      components,
    };

    const url = `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`;
    const response = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    res.status(201).json({ success: true, data: response.data });
  } catch (error) {
    console.error(
      "Error creating template:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      error:
        error.response?.data?.error?.message || "Failed to create template",
    });
  }
};

// @desc    Edit an existing Message Template
// @route   PUT /api/templates/:templateId
// @access  Private (Admin/Manager)
const editTemplate = async (req, res) => {
  try {
    const { templateId } = req.params;
    const { wabaId, components } = req.body;

    if (!wabaId || !components) {
      return res
        .status(400)
        .json({ success: false, error: "Missing wabaId or components" });
    }

    const waba = await WabaAccount.findOne({ businessAccountId: wabaId });
    if (!waba) {
      return res.status(404).json({ success: false, error: "WABA not found" });
    }

    const accessToken = waba.accessToken;
    const apiVersion = process.env.FACEBOOK_API_VERSION || "v20.0";

    const url = `https://graph.facebook.com/${apiVersion}/${templateId}`;

    const payload = {
      components: components,
    };

    const response = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Clear local cache so the newly edited template structure will be fetched from Meta on the next send
    clearTemplateCache();

    res.status(200).json({ success: true, data: response.data });
  } catch (error) {
    console.error(
      "Error editing template:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      error: error.response?.data?.error?.message || "Failed to edit template",
    });
  }
};

module.exports = {
  getTemplates,
  getTemplateAnalytics,
  createTemplate,
  editTemplate,
};
