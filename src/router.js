import {
  loginHandler,
  registerOperatorHandler,
  toggleUserStatusHandler,
  getUsersHandler,
} from "./controllers/auth.js";
import {
  onboardWarehouseHandler,
  toggleSubscriptionHandler,
  listWarehousesHandler,
} from "./controllers/superAdmin.js";
import {
  getBillingHandler,
  createBillHandler,
  uploadBillingAttachmentHandler,
  deleteBillingAttachmentHandler,
  markBillPaidHandler,
  getBillDetailHandler,
  updateBillHandler,
  deleteBillHandler,
} from "./controllers/billing.js";
import {
  getLocationsHandler,
  toggleLocationStatusHandler,
  createLocationHandler,
} from "./controllers/locations.js";
import {
  getInventoryHandler,
  adjustInventoryHandler,
} from "./controllers/inventory.js";
import {
  getClientsHandler,
  createClientHandler,
} from "./controllers/clients.js";
import {
  getStockOwnersHandler,
  createStockOwnerHandler,
} from "./controllers/stockOwners.js";
import {
  validateOpeningStockHandler,
  importOpeningStockHandler,
} from "./controllers/openingStock.js";
import {
  getTransactionsHandler,
  getTransactionDetailHandler,
} from "./controllers/transactions.js";
import { lookupPartyHandler } from "./controllers/parties.js";
import {
  uploadInboundHandler,
  ocrWebhookHandler,
  commitInboundHandler,
  getPendingInboundHandler,
  getStagedInboundHandler,
  deleteInboundShipmentHandler,
} from "./controllers/inbound.js";
import {
  uploadOutboundHandler,
  getPendingOutboundHandler,
  getStagedOutboundHandler,
  verifyOutboundHandler,
  commitOutboundHandler,
  deleteOutboundShipmentHandler,
} from "./controllers/outbound.js";
import {
  getPendingPickingTasksHandler,
  getCompletedPickingTasksHandler,
  completePickingTaskHandler,
} from "./controllers/picking.js";
import {
  getPendingPutawayTasksHandler,
  getCompletedPutawayTasksHandler,
  completePutawayTaskHandler,
} from "./controllers/putaway.js";

export const routes = [
  // -------------------------------------------------------------------------
  // AUTHENTICATION & USERS
  // -------------------------------------------------------------------------
  { method: "POST", path: "/api/auth/login", handler: loginHandler },
  {
    method: "POST",
    path: "/api/auth/register-operator",
    handler: registerOperatorHandler,
  },
  {
    method: "POST",
    path: "/api/auth/toggle-user-status",
    handler: toggleUserStatusHandler,
  },
  { method: "GET", path: "/api/users", handler: getUsersHandler },

  // -------------------------------------------------------------------------
  // SUPER ADMIN (Including Aliases)
  // -------------------------------------------------------------------------
  {
    method: "POST",
    path: "/api/super/warehouses",
    handler: onboardWarehouseHandler,
  },
  {
    method: "POST",
    path: "/api/superadmin/warehouses",
    handler: onboardWarehouseHandler,
  },
  {
    method: "POST",
    path: "/api/super/warehouses/subscription",
    handler: toggleSubscriptionHandler,
  },
  {
    method: "POST",
    path: "/api/superadmin/warehouses/subscription",
    handler: toggleSubscriptionHandler,
  },
  {
    method: "GET",
    path: "/api/super/warehouses",
    handler: listWarehousesHandler,
  },
  {
    method: "GET",
    path: "/api/superadmin/warehouses",
    handler: listWarehousesHandler,
  },

  // -------------------------------------------------------------------------
  // BILLING
  // -------------------------------------------------------------------------
  { method: "GET", path: "/api/billing", handler: getBillingHandler },
  { method: "POST", path: "/api/billing", handler: createBillHandler },
  {
    method: "POST",
    pattern: /^\/api\/billing\/([^/]+)\/attachments$/,
    handler: uploadBillingAttachmentHandler,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/billing\/attachments\/([^/]+)$/,
    handler: deleteBillingAttachmentHandler,
  },
  {
    method: "POST",
    pattern: /^\/api\/billing\/([^/]+)\/mark-paid$/,
    handler: markBillPaidHandler,
  },
  {
    method: "GET",
    pattern: /^\/api\/billing\/([^/]+)$/,
    handler: getBillDetailHandler,
  },
  {
    method: "PUT",
    pattern: /^\/api\/billing\/([^/]+)$/,
    handler: updateBillHandler,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/billing\/([^/]+)$/,
    handler: deleteBillHandler,
  },

  // -------------------------------------------------------------------------
  // LOCATIONS
  // -------------------------------------------------------------------------
  { method: "GET", path: "/api/locations", handler: getLocationsHandler },
  { method: "POST", path: "/api/locations", handler: createLocationHandler },
  {
    method: "POST",
    path: "/api/locations/toggle-status",
    handler: toggleLocationStatusHandler,
  },

  // -------------------------------------------------------------------------
  // INVENTORY
  // -------------------------------------------------------------------------
  { method: "GET", path: "/api/inventory", handler: getInventoryHandler },
  {
    method: "POST",
    path: "/api/inventory/adjust",
    handler: adjustInventoryHandler,
  },

  // -------------------------------------------------------------------------
  // CLIENTS
  // -------------------------------------------------------------------------
  { method: "GET", path: "/api/clients", handler: getClientsHandler },
  { method: "POST", path: "/api/clients", handler: createClientHandler },

  // -------------------------------------------------------------------------
  // STOCK OWNERS
  // -------------------------------------------------------------------------
  { method: "GET", path: "/api/stock-owners", handler: getStockOwnersHandler },
  {
    method: "POST",
    path: "/api/stock-owners",
    handler: createStockOwnerHandler,
  },

  // -------------------------------------------------------------------------
  // OPENING STOCK
  // -------------------------------------------------------------------------
  {
    method: "POST",
    path: "/api/opening-stock/validate",
    handler: validateOpeningStockHandler,
  },
  {
    method: "POST",
    path: "/api/opening-stock/import",
    handler: importOpeningStockHandler,
  },

  // -------------------------------------------------------------------------
  // TRANSACTIONS
  // -------------------------------------------------------------------------
  { method: "GET", path: "/api/transactions", handler: getTransactionsHandler },
  {
    method: "GET",
    pattern: /^\/api\/transactions\/([^/]+)$/,
    handler: getTransactionDetailHandler,
  },

  // -------------------------------------------------------------------------
  // PARTIES
  // -------------------------------------------------------------------------
  { method: "GET", path: "/api/parties/lookup", handler: lookupPartyHandler },

  // -------------------------------------------------------------------------
  // INBOUND (AI Upload + Manual Entry share the commit handler)
  // -------------------------------------------------------------------------
  {
    method: "POST",
    path: "/api/inbound/upload",
    handler: uploadInboundHandler,
  },
  { method: "POST", path: "/api/ocr/webhook", handler: ocrWebhookHandler },
  {
    method: "POST",
    path: "/api/inbound/commit",
    handler: commitInboundHandler,
  },
  {
    method: "GET",
    path: "/api/inbound/pending",
    handler: getPendingInboundHandler,
  },
  {
    method: "GET",
    path: "/api/inbound/staged",
    handler: getStagedInboundHandler,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/inbound\/([^/]+)$/,
    handler: deleteInboundShipmentHandler,
  },

  // -------------------------------------------------------------------------
  // OUTBOUND (AI Upload + Manual Entry share verify/commit)
  // -------------------------------------------------------------------------
  {
    method: "POST",
    path: "/api/outbound/upload",
    handler: uploadOutboundHandler,
  },
  {
    method: "GET",
    path: "/api/outbound/pending",
    handler: getPendingOutboundHandler,
  },
  {
    method: "GET",
    path: "/api/outbound/staged",
    handler: getStagedOutboundHandler,
  },
  {
    method: "POST",
    path: "/api/outbound/verify",
    handler: verifyOutboundHandler,
  },
  {
    method: "POST",
    path: "/api/outbound/commit",
    handler: commitOutboundHandler,
  },
  {
    method: "DELETE",
    pattern: /^\/api\/outbound\/([^/]+)$/,
    handler: deleteOutboundShipmentHandler,
  },

  // -------------------------------------------------------------------------
  // PICKING
  // -------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/picking/pending",
    handler: getPendingPickingTasksHandler,
  },
  {
    method: "GET",
    path: "/api/picking/completed",
    handler: getCompletedPickingTasksHandler,
  },
  {
    method: "POST",
    path: "/api/picking/complete",
    handler: completePickingTaskHandler,
  },

  // -------------------------------------------------------------------------
  // PUTAWAY
  // -------------------------------------------------------------------------
  {
    method: "GET",
    path: "/api/putaway/pending",
    handler: getPendingPutawayTasksHandler,
  },
  {
    method: "GET",
    path: "/api/putaway/completed",
    handler: getCompletedPutawayTasksHandler,
  },
  {
    method: "POST",
    path: "/api/putaway/complete",
    handler: completePutawayTaskHandler,
  },
];
