import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";

/**
 * @api {GET} /api/stock-owners
 * @description Retrieves a list of all stock owners for the authenticated warehouse, optionally filtered by a specific client ID.
 * @access Tenant User, Tenant Admin
 *
 * @query {string} [client_id] - Optional client UUID to filter stock owners.
 *
 * @returns {200} JSON - { stock_owners: Array<Object> }
 * @returns {401|500} JSON - { error: string }
 */
export async function getStockOwnersHandler(request, env) {
  const url = new URL(request.url);
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  try {
    const clientId = url.searchParams.get("client_id");
    let query = `
      SELECT so.*, c.name AS client_name, c.code AS client_code
      FROM stock_owners so
      JOIN clients c ON so.client_id = c.id
      WHERE so.warehouse_id = ?
    `;
    const params = [auth.context.warehouse_id];

    if (clientId) {
      query += " AND so.client_id = ?";
      params.push(clientId);
    }

    query += " ORDER BY so.name ASC";

    const rows = await env.DB.prepare(query)
      .bind(...params)
      .all();

    return new Response(JSON.stringify({ stock_owners: rows.results }), {
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

/**
 * @api {POST} /api/stock-owners
 * @description Creates a new custom stock owner profile linked to a client within the warehouse tenant.
 * @access Tenant Admin Only
 *
 * @body {string} client_id - Parent client UUID.
 * @body {string} name - Name of the stock owner.
 * @body {string} code - Unique stock owner code/tag.
 * @body {string} [gstin] - GST Identification Number.
 * @body {string} [contact_person] - Contact person name.
 * @body {string} [phone] - Contact phone number.
 * @body {string} [email] - Contact email address.
 *
 * @returns {201} JSON - { success: true, message: string, stock_owner_id: string }
 * @returns {400|401|403|404|409|500} JSON - { error: string }
 */
export async function createStockOwnerHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  // Security Check: Enforce Admin privilege
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error:
          "Operation Forbidden: Admin access required to create stock owners.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const payload = await request.json();
    const clientId = String(payload.client_id || "").trim();
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

    if (!clientId || !name || !code) {
      return new Response(
        JSON.stringify({
          error: "Client, Stock Owner Name, and Unique Code are required.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Verify parent client exists in this warehouse tenant
    const clientExists = await env.DB.prepare(
      "SELECT id FROM clients WHERE id = ? AND warehouse_id = ?",
    )
      .bind(clientId, auth.context.warehouse_id)
      .first();

    if (!clientExists) {
      return new Response(
        JSON.stringify({
          error: "Selected Client does not exist in this warehouse.",
        }),
        { status: 404, headers: corsHeaders },
      );
    }

    // Code uniqueness check within warehouse tenant
    const codeExists = await env.DB.prepare(
      "SELECT id FROM stock_owners WHERE warehouse_id = ? AND code = ?",
    )
      .bind(auth.context.warehouse_id, code)
      .first();

    if (codeExists) {
      return new Response(
        JSON.stringify({
          error: `Stock Owner code '${code}' already exists in this warehouse.`,
        }),
        { status: 409, headers: corsHeaders },
      );
    }

    const newOwnerId = "so_" + crypto.randomUUID();

    // Exactly 11 columns <-> 11 values (10 '?' placeholders + 1 literal)
    await env.DB.prepare(
      `INSERT INTO stock_owners (id, client_id, warehouse_id, name, code, gstin, contact_person, phone, email, status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
      .bind(
        newOwnerId,
        clientId,
        auth.context.warehouse_id,
        name,
        code,
        gstin,
        contactPerson,
        phone,
        email,
        auth.context.user_id,
      )
      .run();

    return new Response(
      JSON.stringify({
        success: true,
        message: "Stock Owner created successfully.",
        stock_owner_id: newOwnerId,
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
