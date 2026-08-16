import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";

// =========================================================================
// GET /api/clients -> Fetch isolate tenant clients records
// =========================================================================
export async function getClientsHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  if (auth.context.role === "super_admin") {
    return new Response(
      JSON.stringify({
        error:
          "Access Denied: Super Admins lack workspace client assignments.",
      }),
      {
        status: 403,
        headers: corsHeaders,
      },
    );
  }

  try {
    const clientsRows = await env.DB.prepare(
      "SELECT * FROM clients WHERE warehouse_id = ? ORDER BY name ASC",
    )
      .bind(auth.context.warehouse_id)
      .all();

    return new Response(JSON.stringify({ clients: clientsRows.results }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}

// =========================================================================
// POST /api/clients -> Admin-gated Client Identity Provisioner
// =========================================================================
export async function createClientHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Operation Forbidden: Admin access required.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const payload = await request.json();
    const name = String(payload.name || "").trim();
    const code = String(payload.code || "")
      .trim()
      .toUpperCase();
    const gstin = payload.gstin
      ? String(payload.gstin).trim().toUpperCase()
      : null;
    const contactPerson = payload.contact_person
      ? String(payload.contact_person).trim()
      : null;
    const phone = payload.phone ? String(payload.phone).trim() : null;
    const email = payload.email ? String(payload.email).trim() : null;

    if (!name || !code) {
      return new Response(
        JSON.stringify({
          error: "Client Name and Unique Code are mandatory fields.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Check code uniqueness within this warehouse
    const existingCode = await env.DB.prepare(
      "SELECT id FROM clients WHERE warehouse_id = ? AND code = ?",
    )
      .bind(auth.context.warehouse_id, code)
      .first();

    if (existingCode) {
      return new Response(
        JSON.stringify({
          error: `Client code '${code}' is already in use in this warehouse.`,
        }),
        { status: 409, headers: corsHeaders },
      );
    }

    const newClientId = "cli_" + crypto.randomUUID();
    const defaultStockOwnerId = "so_" + crypto.randomUUID();

    // Atomic transaction: Provision Client and default Stock Owner concurrently
    await env.DB.batch([
      // FIXED: Exactly 11 columns <-> 11 values (8 '?' + 'active' + 1 '?' + NULL)
      env.DB.prepare(
        `INSERT INTO clients (id, warehouse_id, name, code, gstin, contact_person, phone, email, status, created_by_user_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
      ).bind(
        newClientId,
        auth.context.warehouse_id,
        name,
        code,
        gstin,
        contactPerson,
        phone,
        email,
        auth.context.user_id,
      ),

      // FIXED: Exactly 12 columns <-> 12 values (9 '?' + 'active' + 1 '?' + NULL)
      env.DB.prepare(
        `INSERT INTO stock_owners (id, client_id, warehouse_id, name, code, gstin, contact_person, phone, email, status, created_by_user_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
      ).bind(
        defaultStockOwnerId,
        newClientId,
        auth.context.warehouse_id,
        name,
        code,
        gstin,
        contactPerson,
        phone,
        email,
        auth.context.user_id,
      ),
    ]);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Client and Default Stock Owner onboarded successfully.",
        client_id: newClientId,
        default_stock_owner_id: defaultStockOwnerId,
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}
