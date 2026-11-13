// backend/src/integrations/whatsappAPI.js

const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
// We no longer import wabaConfig, as credentials are passed in.

const API_VERSION = "v20.0";

// Memory cache for template structures to prevent redundant API fetches
const templateCache = {};
// Memory cache for recovered Media IDs when a campaign's headerMediaId has expired
const recoveredMediaCache = {};

/**
 * Sends a simple text message.
 * @param {string} to - The recipient's phone number.
 * @param {string} text - The text message to send.
 * @param {string} accessToken - The Access Token of the WABA.
 * @param {string} phoneNumberId - The Phone Number ID to send from.
 */
/**
 * Sends a simple text message.
 * @param {string} to - The recipient's phone number.
 * @param {string} text - The text message to send.
 * @param {string} accessToken - The Access Token of the WABA.
 * @param {string} phoneNumberId - The Phone Number ID to send from.
 * @param {string} [contextMessageId] - The WAMID of the message to reply to.
 */
const sendTextMessage = async (
  to,
  text,
  accessToken,
  phoneNumberId,
  contextMessageId = null
) => {
  const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "text",
    text: { preview_url: false, body: text },
  };

  if (contextMessageId) {
    data.context = { message_id: contextMessageId };
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  try {
    const response = await axios.post(url, data, { headers });
    return response.data;
  } catch (error) {
    console.error(
      "❌ Error sending WhatsApp text message:",
      error.response ? error.response.data : error.message
    );
    throw new Error("Failed to send WhatsApp text message.");
  }
};

/**
 * Sends a reaction message.
 * @param {string} to - The recipient's phone number.
 * @param {string} messageId - The WAMID of the message to react to.
 * @param {string} emoji - The emoji to react with.
 * @param {string} accessToken - The Access Token of the WABA.
 * @param {string} phoneNumberId - The Phone Number ID to send from.
 */
const sendReactionMessage = async (
  to,
  messageId,
  emoji,
  accessToken,
  phoneNumberId
) => {
  const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "reaction",
    reaction: {
      message_id: messageId,
      emoji: emoji,
    },
  };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  try {
    const response = await axios.post(url, data, { headers });
    return response.data;
  } catch (error) {
    console.error(
      "❌ Error sending WhatsApp reaction:",
      error.response ? error.response.data : error.message
    );
    throw new Error("Failed to send WhatsApp reaction.");
  }
};

// --- NEW FUNCTION: Upload Media to Meta ---
const uploadMedia = async (file, accessToken, phoneNumberId) => {
  try {
    const uploadUrl = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/media`;
    const formData = new FormData();
    formData.append("messaging_product", "whatsapp");
    formData.append("file", fs.createReadStream(file.path), {
      filename: file.originalname,
      contentType: file.mimetype,
    });

    const uploadHeaders = {
      ...formData.getHeaders(),
      Authorization: `Bearer ${accessToken}`,
    };

    const response = await axios.post(uploadUrl, formData, {
      headers: uploadHeaders,
    });
    return response.data.id; // Return the Media ID
  } catch (error) {
    console.error(
      "❌ Error uploading media to Meta:",
      error.response ? error.response.data : error.message
    );
    throw new Error("Failed to upload media to WhatsApp.");
  } finally {
    // Clean up the local file
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  }
};

/**
 * Sends an approved template message.
 * @param {string} to - The recipient's phone number.
 * @param {string} templateName - The name of the template.
 * @param {string} languageCode - The language code (e.g., "en").
 * @param {object} options - Options like headerImageUrl, bodyVariables, buttons.
 * @param {string} accessToken - The Access Token of the WABA.
 * @param {string} phoneNumberId - The Phone Number ID to send from.
 */
// --- UPDATED: Send Template (Supports Media ID) ---
const sendTemplateMessage = async (
  to,
  templateName,
  languageCode,
  options = {},
  accessToken,
  phoneNumberId
) => {
  const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;

  const components = [];

  // Logic: Handle carousel template format or default media header
  let carouselComponent = null;
  if (templateCache[templateName]) {
    carouselComponent = templateCache[templateName];
  } else {
    try {
      const PhoneNumber = require("../models/PhoneNumber");
      const phone = await PhoneNumber.findOne({ phoneNumberId }).populate("wabaAccount");
      const waba = phone ? phone.wabaAccount : null;
      if (waba) {
        const tRes = await axios.get(
          `https://graph.facebook.com/${API_VERSION}/${waba.businessAccountId}/message_templates`,
          {
            params: { name: templateName },
            headers: { Authorization: `Bearer ${accessToken}` }
          }
        );
        const templateDef = tRes.data?.data?.find((t) => t.name === templateName);
        if (templateDef) {
          const carouselComp = templateDef.components?.find((c) => c.type === "CAROUSEL");
          if (carouselComp) {
            const cards = await Promise.all(
              carouselComp.cards.map(async (card, idx) => {
                const cardComponents = [];
                const header = card.components?.find((cc) => cc.type === "HEADER");
                let imgUrl = header?.example?.header_handle?.[0] || "";

                // Look up or dynamically cache the original Cloudinary URL using templateName and cardIndex
                try {
                  const MediaMap = require("../models/MediaMap");
                  let map = await MediaMap.findOne({ templateName, cardIndex: idx });
                  if (map) {
                    const originalUrl = imgUrl;
                    imgUrl = map.url;
                    console.log(`Resolved card #${idx} for template "${templateName}" to Cloudinary URL: ${imgUrl} (original: ${originalUrl})`);
                  } else if (imgUrl && (imgUrl.includes("scontent") || imgUrl.includes("fbcdn"))) {
                    console.log(`Dynamically caching card #${idx} for template "${templateName}" to Cloudinary...`);
                    const downloadRes = await axios.get(imgUrl, { responseType: "arraybuffer" });
                    const buffer = Buffer.from(downloadRes.data, "binary");

                    const { uploadToCloudinary } = require("./cloudinary");
                    const { Readable } = require("stream");
                    const bufferStream = new Readable();
                    bufferStream.push(buffer);
                    bufferStream.push(null);

                    const filename = `template_card_auto_${Date.now()}`;
                    const cloudResult = await uploadToCloudinary(bufferStream, filename, "whatsapp_templates");
                    
                    map = await MediaMap.findOneAndUpdate(
                      { templateName, cardIndex: idx },
                      { url: cloudResult.secure_url, handle: imgUrl },
                      { upsert: true, new: true }
                    );
                    imgUrl = map.url;
                    console.log(`✅ Auto-cached template card to Cloudinary: ${imgUrl}`);
                  }
                } catch (mapErr) {
                  console.error("Error looking up or caching MediaMap:", mapErr.message);
                }

                cardComponents.push({
                  type: "header",
                  parameters: [{ type: "image", image: { link: imgUrl } }]
                });

                // Extract and supply button parameters if dynamic URL button is present
                const buttonsComp = card.components?.find((cc) => cc.type === "BUTTONS");
                if (buttonsComp) {
                  buttonsComp.buttons.forEach((btn, btnIdx) => {
                    if (btn.type === "URL" && btn.url && btn.url.includes("{{1}}")) {
                      const suffix = btn.example?.[0] || "";
                      cardComponents.push({
                        type: "button",
                        sub_type: "url",
                        index: String(btnIdx),
                        parameters: [{ type: "text", text: suffix }]
                      });
                    } else if (btn.type === "QUICK_REPLY") {
                      cardComponents.push({
                        type: "button",
                        sub_type: "quick_reply",
                        index: String(btnIdx),
                        parameters: [{ type: "payload", payload: `${btn.text} (Card ${idx + 1})` }]
                      });
                    }
                  });
                }

                return {
                  card_index: idx,
                  components: cardComponents
                };
              })
            );

            carouselComponent = {
              type: "carousel",
              cards: cards
            };
            templateCache[templateName] = carouselComponent;
          }
        }
      }
    } catch (err) {
      console.error("Error fetching template structure for carousel:", err.message);
    }
  }

  if (carouselComponent) {
    components.push(carouselComponent);
  } else if (options.headerMediaId || options.headerImageUrl) {
    const headerFormat = options.headerMediaType ? options.headerMediaType.toLowerCase() : "image";
    const recoveryKey = options.headerMediaId ? `${phoneNumberId}:${options.headerMediaId}` : null;
    const cachedRecovery = recoveryKey ? recoveredMediaCache[recoveryKey] : null;

    if (cachedRecovery) {
      components.push({
        type: "header",
        parameters: [{ type: headerFormat, [headerFormat]: cachedRecovery }],
      });
    } else if (options.headerMediaId) {
      components.push({
        type: "header",
        parameters: [{ type: headerFormat, [headerFormat]: { id: options.headerMediaId } }],
      });
    } else if (options.headerImageUrl) {
      components.push({
        type: "header",
        parameters: [{ type: headerFormat, [headerFormat]: { link: options.headerImageUrl } }],
      });
    }
  }

  if (
    options.bodyVariables &&
    options.bodyVariables.length > 0 &&
    options.bodyVariables.every((v) => v)
  ) {
    components.push({
      type: "body",
      parameters: options.bodyVariables.map((variable) => ({
        type: "text",
        text: variable,
      })),
    });
  }

  if (options.buttons && options.buttons.length > 0) {
    options.buttons.forEach((button, index) => {
      if (button.type === "URL") {
        components.push({
          type: "button",
          sub_type: "url",
          index: String(index),
          parameters: [{ type: "text", text: button.url.split("/").pop() }],
        });
      }
    });
  }

  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length > 0 && { components: components }),
    },
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };

  try {
    const response = await axios.post(url, data, { headers, timeout: 15000 });
    return response.data;
  } catch (error) {
    const metaDetails = error.response?.data?.error?.error_data?.details || "";
    const headerCompIndex = components.findIndex((c) => c.type === "header");

    // If headerMediaId expired or does not exist for this phoneNumberId, attempt automatic recovery
    if (
      options.headerMediaId &&
      headerCompIndex !== -1 &&
      metaDetails.includes("does not exist or has expired")
    ) {
      const headerFormat = options.headerMediaType
        ? options.headerMediaType.toLowerCase()
        : "image";
      const recoveryKey = `${phoneNumberId}:${options.headerMediaId}`;
      const Campaign = require("../models/Campaign");

      console.warn(
        `⚠️ Media ID ${options.headerMediaId} expired/invalid for template "${templateName}". Attempting auto-recovery...`,
      );

      // 1. Try options.headerImageUrl if present
      if (options.headerImageUrl && options.headerImageUrl.startsWith("http")) {
        try {
          const mediaParam = { link: options.headerImageUrl };
          components[headerCompIndex] = {
            type: "header",
            parameters: [{ type: headerFormat, [headerFormat]: mediaParam }],
          };
          const retryRes = await axios.post(url, data, { headers, timeout: 15000 });
          recoveredMediaCache[recoveryKey] = mediaParam;
          console.log(`✅ Auto-recovered header media using campaign headerImageUrl.`);
          return retryRes.data;
        } catch (retryErr) {
          console.warn("⚠️ Fallback headerImageUrl also failed:", retryErr.message);
        }
      }

      // 2. Try valid headerMediaId or headerImageUrl from sibling campaigns using the same templateName
      try {
        const siblingCampaigns = await Campaign.find({
          templateName,
          _id: { $ne: options.campaignId },
        })
          .sort({ createdAt: -1 })
          .limit(10);

        const triedValues = new Set([String(options.headerMediaId)]);
        for (const sib of siblingCampaigns) {
          const candidates = [];
          if (sib.headerMediaId && !triedValues.has(String(sib.headerMediaId))) {
            triedValues.add(String(sib.headerMediaId));
            candidates.push({ param: { id: sib.headerMediaId }, dbUpdate: { headerMediaId: sib.headerMediaId } });
          }
          if (sib.headerImageUrl && sib.headerImageUrl.startsWith("http") && !triedValues.has(sib.headerImageUrl)) {
            triedValues.add(sib.headerImageUrl);
            candidates.push({ param: { link: sib.headerImageUrl }, dbUpdate: { headerImageUrl: sib.headerImageUrl } });
          }

          for (const cand of candidates) {
            try {
              components[headerCompIndex] = {
                type: "header",
                parameters: [{ type: headerFormat, [headerFormat]: cand.param }],
              };
              const retryRes = await axios.post(url, data, { headers, timeout: 15000 });
              recoveredMediaCache[recoveryKey] = cand.param;
              if (options.campaignId) {
                await Campaign.findByIdAndUpdate(options.campaignId, cand.dbUpdate);
              }
              console.log(
                `✅ Auto-recovered header media from sibling campaign "${sib.name}":`,
                cand.param,
              );
              return retryRes.data;
            } catch (candErr) {
              // Continue trying next candidate
            }
          }
        }
      } catch (sibErr) {
        console.warn("⚠️ Error checking sibling campaigns for media recovery:", sibErr.message);
      }

      // 3. Try recovering from MediaMap or the template's HEADER example handle on Meta
      try {
        const PhoneNumber = require("../models/PhoneNumber");
        const MediaMap = require("../models/MediaMap");
        const phone = await PhoneNumber.findOne({ phoneNumberId }).populate("wabaAccount");
        const waba = phone ? phone.wabaAccount : null;

        let sourceUrl = null;
        const mappedMedia = await MediaMap.findOne({ templateName }).sort({ _id: -1 });
        if (mappedMedia && mappedMedia.url && mappedMedia.url.startsWith("http")) {
          sourceUrl = mappedMedia.url;
        } else if (waba) {
          const tRes = await axios.get(
            `https://graph.facebook.com/${API_VERSION}/${waba.businessAccountId}/message_templates`,
            {
              params: { name: templateName },
              headers: { Authorization: `Bearer ${accessToken}` },
            },
          );
          const templateDef = tRes.data?.data?.find((t) => t.name === templateName);
          const headerComp = templateDef?.components?.find((c) => c.type === "HEADER");
          const handleUrl = headerComp?.example?.header_handle?.[0];
          if (handleUrl && handleUrl.startsWith("http")) {
            sourceUrl = handleUrl;
          }
        }

        if (sourceUrl) {
          console.log(`🔄 Downloading template header media from ${sourceUrl} to re-upload to Meta...`);
          const downloadRes = await axios.get(sourceUrl, { responseType: "arraybuffer", timeout: 15000 });
          const buffer = Buffer.from(downloadRes.data, "binary");
          const mimeType =
            downloadRes.headers["content-type"] ||
            (headerFormat === "video"
              ? "video/mp4"
              : headerFormat === "document"
                ? "application/pdf"
                : "image/jpeg");
          const ext = headerFormat === "video" ? "mp4" : headerFormat === "document" ? "pdf" : "jpg";

          const uploadForm = new FormData();
          uploadForm.append("messaging_product", "whatsapp");
          uploadForm.append("file", buffer, {
            filename: `recovered_header.${ext}`,
            contentType: mimeType,
          });

          const uploadRes = await axios.post(
            `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/media`,
            uploadForm,
            {
              headers: {
                ...uploadForm.getHeaders(),
                Authorization: `Bearer ${accessToken}`,
              },
              timeout: 30000,
            },
          );

          if (uploadRes.data?.id) {
            const newMediaId = uploadRes.data.id;
            const mediaParam = { id: newMediaId };
            components[headerCompIndex] = {
              type: "header",
              parameters: [{ type: headerFormat, [headerFormat]: mediaParam }],
            };
            const retryRes = await axios.post(url, data, { headers, timeout: 15000 });
            recoveredMediaCache[recoveryKey] = mediaParam;
            if (options.campaignId) {
              await Campaign.findByIdAndUpdate(options.campaignId, { headerMediaId: newMediaId });
            }
            console.log(`✅ Re-uploaded & recovered fresh Meta Media ID: ${newMediaId}`);
            return retryRes.data;
          }
        }
      } catch (metaRecoverErr) {
        console.warn("⚠️ Template header handle recovery failed:", metaRecoverErr.message);
      }
    }

    console.error(
      "❌ Error sending WhatsApp template message:",
      error.response ? error.response.data : error.message
    );
    throw error;
  }
};

/**
 * Uploads and sends a media file.
 * @param {string} to - The recipient's phone number.
 * @param {object} file - The file object from multer.
 * @param {string} accessToken - The Access Token of the WABA.
 * @param {string} phoneNumberId - The Phone Number ID to send from.
 */
const sendMediaMessage = async (to, file, accessToken, phoneNumberId) => {
  try {
    const uploadUrl = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/media`;
    const formData = new FormData();
    formData.append("messaging_product", "whatsapp");
    formData.append("file", fs.createReadStream(file.path), {
      filename: file.originalname,
      contentType: file.mimetype,
    });
    const uploadHeaders = {
      ...formData.getHeaders(),
      Authorization: `Bearer ${accessToken}`,
    };
    const uploadResponse = await axios.post(uploadUrl, formData, {
      headers: uploadHeaders,
    });
    const mediaId = uploadResponse.data.id;

    const sendUrl = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;
    let mediaType = "document";
    if (file.mimetype && typeof file.mimetype === "string") {
      // WhatsApp requires specific formats for "audio" and "video" types.
      // WebM is generally not supported for PTT/Voice Messages or native Video messages.
      // Force "document" for WebM to ensure delivery as a file attachment.
      if (file.mimetype.includes("webm")) {
        mediaType = "document";
      } else {
        mediaType = file.mimetype.split("/")[0];
      }
    }
    const sendData = {
      messaging_product: "whatsapp",
      to: to,
      type: mediaType,
      [mediaType]: { id: mediaId },
    };
    const sendHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
    const sendResponse = await axios.post(sendUrl, sendData, {
      headers: sendHeaders,
    });

    return { sendResponse: sendResponse.data, mediaId: mediaId };
  } catch (error) {
    console.error(
      "❌ Error sending WhatsApp media message:",
      error.response ? error.response.data : error.message
    );
    throw new Error("Failed to send WhatsApp media message.");
  } finally {
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  }
};

/**
 * Gets a temporary download URL for a media ID.
 * @param {string} mediaId - The media ID to fetch.
 * @param {string} accessToken - The Access Token of the WABA.
 * @returns {Promise<string>} The temporary download URL.
 */
const getMediaUrl = async (mediaId, accessToken) => {
  try {
    const url = `https://graph.facebook.com/${API_VERSION}/${mediaId}`;
    const headers = { Authorization: `Bearer ${accessToken}` };
    const response = await axios.get(url, { headers });
    return response.data.url;
  } catch (error) {
    console.error(
      "❌ Error fetching media URL:",
      error.response ? error.response.data : error.message
    );
    return null;
  }
};

/**
 * Sends an interactive button message.
 * @param {string} to - Recipient's phone number.
 * @param {string} text - The body text of the message.
 * @param {Array<object>} buttons - An array of button objects, e.g., [{ id: 'btn_1', title: 'Yes' }, { id: 'btn_2', title: 'No' }]
 */
const sendButtonMessage = async (
  to,
  text,
  buttons,
  accessToken,
  phoneNumberId
) => {
  const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: text,
      },
      action: {
        buttons: buttons.map((btn) => ({
          type: "reply",
          reply: {
            id: btn.id,
            title: btn.title,
          },
        })),
      },
    },
  };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  try {
    const response = await axios.post(url, data, { headers });
    return response.data;
  } catch (error) {
    console.error(
      "❌ Error sending WhatsApp button message:",
      error.response ? error.response.data : error.message
    );
    throw new Error("Failed to send WhatsApp button message.");
  }
};

/**
 * Sends an interactive list message.
 * @param {string} to - Recipient's phone number.
 * @param {string} text - The body text of the message.
 * @param {string} buttonText - The text on the button that opens the list (e.g., "Main Menu").
 * @param {Array<object>} sections - An array of sections, each with a title and rows.
 */
const sendListMessage = async (
  to,
  text,
  buttonText,
  sections,
  accessToken,
  phoneNumberId
) => {
  const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;
  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "list",
      body: {
        text: text,
      },
      action: {
        button: buttonText,
        sections: sections.map((section) => ({
          title: section.title,
          rows: section.rows.map((row) => ({
            id: row.id,
            title: row.title,
            description: row.description || undefined,
          })),
        })),
      },
    },
  };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  try {
    const response = await axios.post(url, data, { headers });
    return response.data;
  } catch (error) {
    console.error(
      "❌ Error sending WhatsApp list message:",
      error.response ? error.response.data : error.message
    );
    throw new Error("Failed to send WhatsApp list message.");
  }
};

const clearTemplateCache = (templateName) => {
  if (templateName) {
    delete templateCache[templateName];
    console.log(`Cleared template cache for: ${templateName}`);
  } else {
    for (const key in templateCache) {
      delete templateCache[key];
    }
    console.log("Cleared all template caches");
  }
};

module.exports = {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  getMediaUrl,
  sendButtonMessage, // <-- NEW
  sendListMessage, // <-- NEW
  uploadMedia,
  sendReactionMessage, // <-- NEW
  clearTemplateCache,
};
