import { corsHeaders } from "../utils/response.js";
import { hashPassword } from "../utils/crypto.js";
import { getTenantContext } from "../middleware/authMiddleware.js";

/**
 * @api {POST} /api/super/warehouses
 * @description Provisions a new warehouse tenant along with an initial warehouse admin user account.
 * @access Super Admin Only
 *
 * @body {string} company_name - Legal or commercial name of the company/warehouse.
 * @body {string} [initial_status="trial"] - Initial subscription status ("active", "trial", or "suspended").
 * @body {string} admin_username - Username for the primary warehouse admin.
 * @body {string} admin_password - Password for the primary warehouse admin.
 * @body {string} [gstin] - GST Identification Number of the warehouse.
 * @body {string} [address] - Physical address of the warehouse.
 *
 * @returns {201} JSON - { message: string, warehouse_id: string, admin_user_id: string }
 * @returns {400|403|409|500} JSON - { error: string }
 */
export async function onboardWarehouseHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success || auth.context.role !== "super_admin") {
    return new Response(
      JSON.stringify({ error: "Forbidden: Super Admin access required." }),
      {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const {
      company_name,
      initial_status,
      admin_username,
      admin_password,
      gstin,
      address,
    } = await request.json();

    // Validate inputs (status can be 'active' or 'trial')
    if (!company_name || !admin_username || !admin_password) {
      return new Response(
        JSON.stringify({
          error: "Missing required onboarding parameters.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const warehouseId = "wh_" + crypto.randomUUID();
    const adminUserId = "usr_" + crypto.randomUUID();

    // FIXED: Changed adminPassword to admin_password to match the destructured variable above
    const adminPasswordHash = await hashPassword(admin_password);
    const subscriptionMode = initial_status || "trial";
    const gstinValue = gstin ? String(gstin).trim().toUpperCase() : null;
    const addressValue = address ? String(address).trim() : null;

    // Batch statement ensures BOTH the warehouse entry and its master account insert together perfectly
    await env.DB.batch([
      env.DB.prepare(
        `
        INSERT INTO warehouses (id, company_name, gstin, address, subscription_status)
        VALUES (?, ?, ?, ?, ?)
      `,
      ).bind(
        warehouseId,
        company_name,
        gstinValue,
        addressValue,
        subscriptionMode,
      ),

      env.DB.prepare(
        `
        INSERT INTO users (id, warehouse_id, username, password_hash, role, is_active)
        VALUES (?, ?, ?, ?, 'admin', 1)
      `,
      ).bind(adminUserId, warehouseId, admin_username, adminPasswordHash),
    ]);

    return new Response(
      JSON.stringify({
        message:
          "New warehouse tenant and administrator provisioned successfully.",
        warehouse_id: warehouseId,
        admin_user_id: adminUserId,
      }),
      {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    if (error.message.includes("UNIQUE constraint failed")) {
      return new Response(
        JSON.stringify({
          error: "The provided admin username is already registered.",
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        error: `Onboarding execution error: ${error.message}`,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * @api {POST} /api/super/warehouses/subscription
 * @description Updates the subscription status state for a targeted warehouse tenant.
 * @access Super Admin Only
 *
 * @body {string} target_warehouse_id - Unique UUID of the target warehouse.
 * @body {string} set_status - New subscription status state ("active", "suspended", or "trial").
 *
 * @returns {200} JSON - { message: string }
 * @returns {400|403|404|500} JSON - { error: string }
 */
export async function toggleSubscriptionHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success || auth.context.role !== "super_admin") {
    return new Response(
      JSON.stringify({ error: "Forbidden: Super Admin access required." }),
      {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const { target_warehouse_id, set_status } = await request.json(); // set_status can be: 'active', 'suspended', 'trial'

    const validStatuses = ["active", "suspended", "trial"];
    if (!target_warehouse_id || !validStatuses.includes(set_status)) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid target parameters or unknown subscription status string.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const result = await env.DB.prepare(
      `
  UPDATE warehouses
  SET subscription_status = ?
  WHERE id = ?
`,
    )
      .bind(set_status, target_warehouse_id)
      .run();

    if (result.meta.changes === 0) {
      return new Response(
        JSON.stringify({ error: "Warehouse target profile not found." }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        message: `Warehouse subscription state updated to '${set_status}' successfully.`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: `Subscription mutation failure: ${error.message}`,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * @api {GET} /api/superadmin/warehouses
 * @description Retrieves a complete directory list of all registered warehouse tenant structures on the platform.
 * @access Super Admin Only
 *
 * @returns {200} JSON - Array of warehouse records.
 * @returns {403|500} JSON - { error: string }
 */
export async function listWarehousesHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success || auth.context.role !== "super_admin") {
    return new Response(
      JSON.stringify({ error: "Forbidden: Super Admin access required." }),
      {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    // Query the D1 database for all registered tenant structures
    const rows = await env.DB.prepare(
      `SELECT id, company_name, gstin, address, subscription_status, created_at FROM warehouses ORDER BY created_at DESC`,
    ).all();

    // Cloudflare D1 returns rows under the '.results' array property
    return new Response(JSON.stringify(rows.results || []), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: `Failed to retrieve warehouses: ${error.message}`,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}
