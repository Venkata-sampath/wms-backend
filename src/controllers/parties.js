import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";

/**
 * @api {GET} /api/parties/lookup
 * @description Queries master data to check if a party exists by GSTIN within the tenant warehouse scope.
 * @access Tenant User, Tenant Admin, Super Admin
 *
 * @query {string} gstin - The 15-character Goods and Services Tax Identification Number to look up.
 *
 * @returns {200} JSON - { found: boolean, party: { id: string, name: string, gstin: string, address: string } | null }
 * @returns {400} JSON - { found: false, party: null, error: "GSTIN must be exactly 15 characters." }
 * @returns {401} JSON - { error: string }
 */
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
