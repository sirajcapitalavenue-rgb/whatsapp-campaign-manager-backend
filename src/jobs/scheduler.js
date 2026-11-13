// backend/src/jobs/scheduler.js

const cron = require("node-cron");
const Campaign = require("../models/Campaign");
const Enquiry = require("../models/Enquiry");
const { sendCampaign, isCampaignActive } = require("../services/campaignService");
const Log = require("../models/Log");
const { getIO } = require("../socketManager");

// Automatically recover any recent campaigns that were in "sending" status when the backend restarted
const resumeInterruptedCampaigns = async () => {
  try {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);

    // 1. Mark stale "sending" campaigns (older than 12 hours) as "paused" so old abandoned campaigns don't auto-run
    const staleCampaigns = await Campaign.find({
      status: "sending",
      createdAt: { $lt: twelveHoursAgo },
    });
    for (const stale of staleCampaigns) {
      if (!isCampaignActive(stale._id)) {
        console.log(
          `⏸️ Marking stale sending campaign "${stale.name}" (${stale._id}) as paused.`,
        );
        stale.status = "paused";
        await stale.save();
      }
    }

    // 2. Auto-resume only recent active campaigns (created within the last 12 hours)
    const sendingCampaigns = await Campaign.find({
      status: "sending",
      createdAt: { $gte: twelveHoursAgo },
    });
    for (const campaign of sendingCampaigns) {
      if (!isCampaignActive(campaign._id)) {
        console.log(
          `🔄 Auto-resuming interrupted campaign "${campaign.name}" (${campaign._id})...`,
        );
        await Log.create({
          level: "info",
          message: `Auto-resuming interrupted campaign "${campaign.name}" after server restart.`,
          campaign: campaign._id,
        });
        sendCampaign(campaign._id).catch((err) => {
          console.error(
            `Error auto-resuming campaign ${campaign._id}:`,
            err.message,
          );
        });
      }
    }
  } catch (error) {
    console.error("Error checking for interrupted campaigns:", error);
  }
};

const startScheduler = () => {
  console.log('⏰ Starting all schedulers...');

  // Recover any interrupted "sending" campaigns shortly after server boot
  setTimeout(resumeInterruptedCampaigns, 5000);

  // ---------------------------------------------------------
  // 1. CAMPAIGN SCHEDULER (Runs every 1 minute)
  // ---------------------------------------------------------
  cron.schedule("* * * * *", async () => {
    // console.log("🕒 Checking for scheduled campaigns...");
    try {
      const io = getIO();
      const campaignsToSend = await Campaign.find({
        status: "scheduled",
        scheduledFor: { $lte: new Date() },
      });

      for (const campaign of campaignsToSend) {
        console.log(`Found campaign to send: ${campaign.name}`);

        campaign.status = "sending";
        await campaign.save();

        io.emit("campaignsUpdated");

        await Log.create({
          level: "info",
          message: `Scheduler picked up campaign "${campaign.name}" and set status to 'sending'.`,
          campaign: campaign._id,
        });

        sendCampaign(campaign._id).catch(async (error) => {
          console.error(`Error sending campaign ${campaign._id}:`, error);
          const failedCampaign = await Campaign.findById(campaign._id);
          if (failedCampaign) {
            failedCampaign.status = "failed";
            await failedCampaign.save();
            io.emit("campaignsUpdated");
          }

          await Log.create({
            level: "error",
            message: `Campaign "${campaign.name}" failed during execution. Reason: ${error.message}`,
            campaign: campaign._id,
          });
        });
      }

      // Also check if any "sending" campaign lost its in-memory worker and auto-resume it
      await resumeInterruptedCampaigns();
    } catch (error) {
      console.error("Error in campaign scheduler:", error);
    }
  });

  // ---------------------------------------------------------
  // 2. INACTIVITY TIMEOUT SCHEDULER (Runs every 1 minute)
  // Ends conversation if inactive for 15 minutes
  // ---------------------------------------------------------
  cron.schedule("* * * * *", async () => {
    // console.log("💤 Checking for inactive enquiries...");
    try {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      
      // Find enquiries that are active (not END) and haven't been updated in 15 mins
      const inactiveEnquiries = await Enquiry.find({
        conversationState: { $ne: "END" },
        updatedAt: { $lt: fifteenMinutesAgo }
      });

      if (inactiveEnquiries.length > 0) {
        console.log(`Found ${inactiveEnquiries.length} inactive enquiries. Ending them silently.`);
        
        for (const enquiry of inactiveEnquiries) {
          enquiry.conversationState = "END";
          enquiry.endedAt = new Date();
          // We do NOT set endMessageSent=true because we didn't send one.
          await enquiry.save();

          await Log.create({
            level: "info",
            message: `Enquiry for ${enquiry.phoneNumber} ended due to inactivity (15 mins).`,
          });
        }
      }
    } catch (error) {
      console.error("Error in inactivity scheduler:", error);
    }
  });
};

module.exports = {
  startScheduler,
};
