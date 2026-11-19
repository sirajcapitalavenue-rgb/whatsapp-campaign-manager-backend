// backend/src/routes/contactRoutes.js

const express = require("express");
const {
  createContactList,
  getAllContactLists,
  bulkAddContacts,
  getContactsInList,
  updateContactList,
  deleteContactList,
  updateContact, // <-- 1. IMPORT
  deleteContact, // <-- 1. IMPORT
  getContactStats, // <-- NEW IMPORT
  getContactAnalytics, // <-- NEW IMPORT
  getContactAnalyticsDashboard, // <-- NEW IMPORT
  getUnsubscribedContacts, // <-- NEW IMPORT
  getContactDetails, // <-- NEW IMPORT
  bulkDeleteContacts,
  getListStatusCounts,
} = require("../controllers/contactController");

const {
  getDashboardSummary,
  getEngagementTrends,
  getTopPerformers,
} = require("../controllers/dashboardController");

const { protect, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

// --- ANALYTICS ROUTE (Place before dynamic ID routes to avoid conflict) ---
router.get("/analytics", protect, getContactAnalytics);
router.get("/dashboard", protect, getContactAnalyticsDashboard);
router.get("/dashboard/summary", protect, getDashboardSummary);
router.get("/dashboard/trends", protect, getEngagementTrends);
router.get("/dashboard/top-performers", protect, getTopPerformers);
router.get("/unsubscribed", protect, getUnsubscribedContacts);
router.post(
  "/migrate-stats",
  protect,
  authorize("admin"),
  require("../controllers/contactController").migrateContactStats,
); // <-- NEW ROUTE

// --- BULK DELETE ROUTE ---
router.post(
  "/bulk-delete",
  protect,
  authorize("admin", "manager"),
  bulkDeleteContacts,
);

// --- CONTACT DETAILS ROUTE ---
router.get("/:contactId/details", protect, getContactDetails);

router
  .route("/lists")
  .get(protect, getAllContactLists)
  .post(protect, authorize("admin", "manager"), createContactList);

// --- 2. THIS IS THE NEW ROUTE for pasted data ---
router.post(
  "/lists/:listId/bulk-add",
  protect,
  authorize("admin", "manager"),
  bulkAddContacts,
);

// --- 3. ADD PUT AND DELETE METHOD TO THIS ROUTE ---
// This route now handles updating AND deleting a specific list
router
  .route("/lists/:listId")
  .put(protect, authorize("admin", "manager"), updateContactList)
  .delete(protect, authorize("admin", "manager"), deleteContactList);

// --- 4. NEW ROUTE to get all contacts in a list ---
router.get("/lists/:listId/contacts", protect, getContactsInList);
router.get("/lists/:listId/status-counts", protect, getListStatusCounts);

// --- 5. NEW ROUTE for a single contact ---
// This route handles updating or deleting a specific contact by its ID
router
  .route("/contacts/:contactId")
  .put(protect, authorize("admin", "manager"), updateContact)
  .delete(protect, authorize("admin", "manager"), deleteContact);

// --- 6. NEW ROUTE for contact stats ---
router.get("/contacts/:contactId/stats", protect, getContactStats);

module.exports = router;
