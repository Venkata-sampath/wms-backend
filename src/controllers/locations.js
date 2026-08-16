import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";

// =========================================================================
// ENDPOINT: Get Locations with Dynamic Status
// =========================================================================
export async function getLocationsHandler(request, env) {
  const url = new URL(request.url);
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  if (auth.context.role === "super_admin") {
    return new Response(JSON.stringify({ error: "Access Denied" }), {
      status: 403,
      headers: corsHeaders,
    });
  }

  try {
    const specificLocationId = url.searchParams.get("id");

    if (specificLocationId) {
      const contents = await env.DB.prepare(
        `SELECT item_code, item_description, quantity 
             FROM inventory 
             WHERE warehouse_id = ? AND location_id = ? AND quantity > 0`,
      )
        .bind(auth.context.warehouse_id, specificLocationId)
        .all();

      return new Response(
        JSON.stringify({
          location_id: specificLocationId,
          items: contents.results,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }

    // Optimized Query: Calculates 'Free' or 'Occupied' on-the-fly
    const query = `
          SELECT l.id, l.status,
            CASE 
              WHEN l.status = 'unavailable' THEN 'Unavailable'
              WHEN EXISTS (
                SELECT 1 FROM inventory i 
                WHERE i.warehouse_id = l.warehouse_id 
                  AND i.location_id = l.id 
                  AND i.quantity > 0
              ) THEN 'Occupied'
              ELSE 'Free'
            END as calculated_status
          FROM locations l
          WHERE l.warehouse_id = ?
          ORDER BY l.id ASC
        `;

    const list = await env.DB.prepare(query)
      .bind(auth.context.warehouse_id)
      .all();

    return new Response(JSON.stringify({ locations: list.results }), {
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
// ENDPOINT: Toggle Location Status (Admin Only)
// =========================================================================
export async function toggleLocationStatusHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success)
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });

  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({ error: "Forbidden: Admin access required." }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const { locationId, newStatus } = await request.json();

    await env.DB.prepare(
      "UPDATE locations SET status = ? WHERE id = ? AND warehouse_id = ?",
    )
      .bind(newStatus, locationId, auth.context.warehouse_id)
      .run();

    return new Response(
      JSON.stringify({ success: true, message: "Status updated." }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

// =========================================================================
// ENDPOINT: Create New Storage Location (ROLE GATED: ADMIN ONLY)
// =========================================================================
export async function createLocationHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  // STRICT ROLE GATE: Only the tenant master 'admin' can append the structural layout
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Forbidden: Only Warehouse Admins can create new locations.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const payload = await request.json();
    const locationId = String(payload.locationId || "")
      .trim()
      .toUpperCase();

    if (!locationId || locationId.length < 2) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid input: Location Identifier naming label is required.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Check if this location text identifier already exists inside this warehouse
    const existing = await env.DB.prepare(
      "SELECT id FROM locations WHERE id = ? AND warehouse_id = ?",
    )
      .bind(locationId, auth.context.warehouse_id)
      .first();

    if (existing) {
      return new Response(
        JSON.stringify({
          error:
            "Conflict: This location label already exists in your warehouse setup.",
        }),
        { status: 409, headers: corsHeaders },
      );
    }

    // Insert into the locations index
    await env.DB.prepare(
      "INSERT INTO locations (id, warehouse_id, status) VALUES (?, ?, 'available')",
    )
      .bind(locationId, auth.context.warehouse_id)
      .run();

    return new Response(
      JSON.stringify({
        success: true,
        message: `Location '${locationId}' successfully initialized.`,
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
