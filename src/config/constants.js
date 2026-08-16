// src/config/constants.js
// Shared constants referenced across multiple controllers/jobs.
// Kept intentionally small/non-invasive: only values that were repeated
// as raw string literals in the original index.js are centralized here.
// Everything else is left as-is inside each controller to avoid changing
// behavior during the refactor.

export const ROLES = {
  SUPER_ADMIN: "super_admin",
  WAREHOUSE_ADMIN: "warehouse_admin",
  OPERATOR: "operator",
};

export const SUBSCRIPTION_STATUS = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
};

export const BILLING_STATUS = {
  PENDING: "pending",
  PAID: "paid",
};
