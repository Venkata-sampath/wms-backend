import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";

// =========================================================================
// ENDPOINT 2: Query if Party GSTIN already exists inside Master Data (SECURED)
// =========================================================================
export async function lookupPartyHandler(request, env) {
  const url = new URL(request.url);
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  const gstin = url.searchParams.get("gstin")?.trim().toUpperCase();

  if (!gstin || gstin.length !== 15) {
    return new Response(
      JSON.stringify({
        found: false,
        party: null,
        error: "GSTIN must be exactly 15 characters.",
      }),
      { status: 400, headers: corsHeaders },
    );
  }

  // Isolation: Look up party bound by tenant warehouse context
  const matchedParty = await env.DB.prepare(
    `
    SELECT id, name, gstin, address 
    FROM parties 
    WHERE gstin = ? AND (? = 'super_admin' OR warehouse_id = ?)
  `,
  )
    .bind(gstin, auth.context.role, auth.context.warehouse_id)
    .first();

  return new Response(
    JSON.stringify({ found: !!matchedParty, party: matchedParty || null }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}
