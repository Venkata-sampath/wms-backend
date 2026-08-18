import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";

/**
 * @api {GET} /api/transactions
 * @description Retrieves a registry list of all warehouse transactions (inbound, opening stock, outbound, and stock adjustments) for the authenticated warehouse.
 * @access Tenant User, Tenant Admin
 *
 * @returns {200} JSON - { transactions: Array<Object> }
 * @returns {401|500} JSON - { error: string }
 */
export async function getTransactionsHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success)
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });

  try {
    const registry = await env.DB.prepare(
      `SELECT
         t.id AS transaction_id, t.transaction_type, t.status, t.reference_id AS entity_id,
         t.warehouse_id, t.created_at, t.completed_at, t.client_id, c.name AS client_name, c.code AS client_code,
         COALESCE(sd.invoice_number, osd.eway_bill_number) AS invoice_number,
         sd.invoice_date, COALESCE(sd.vehicle_number, osd.vehicle_number) AS vehicle_number,
         COALESCE(u_inbound.username, u_os.username, u_outbound.username) AS verified_by
       FROM transactions t
       LEFT JOIN clients c ON t.client_id = c.id
       LEFT JOIN inbound_details sd ON sd.id = t.reference_id AND t.transaction_type = 'inbound'
       LEFT JOIN users u_inbound ON u_inbound.id = sd.verified_by_user_id
       LEFT JOIN opening_stock_imports osi ON osi.id = t.reference_id AND t.transaction_type = 'opening_stock'
       LEFT JOIN users u_os ON u_os.id = osi.uploaded_by_user_id
       LEFT JOIN outbound_details osd ON osd.id = t.reference_id AND t.transaction_type = 'outbound'
       LEFT JOIN users u_outbound ON u_outbound.id = osd.verified_by_user_id
       WHERE t.warehouse_id = ? AND t.transaction_type IN ('inbound', 'opening_stock', 'outbound', 'stock_adjustment')
       ORDER BY t.created_at DESC`,
    )
      .bind(auth.context.warehouse_id)
      .all();

    return new Response(JSON.stringify({ transactions: registry.results }), {
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
 * @api {GET} /api/transactions/:id
 * @description Retrieves unified transaction details based on the specific transaction type (inbound, opening stock, outbound, or stock adjustment).
 * @access Tenant User, Tenant Admin
 *
 * @param {string} id - The unique UUID of the transaction.
 *
 * @returns {200} JSON - Transaction record merged with specific module line items, headers, and parties.
 * @returns {400|401|404|500} JSON - { error: string }
 */
export async function getTransactionDetailHandler(request, env, matchParams) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  try {
    const transactionId = matchParams[1];
    const transaction = await env.DB.prepare(
      `SELECT t.*, c.name AS client_name, c.code AS client_code 
       FROM transactions t 
       LEFT JOIN clients c ON t.client_id = c.id 
       WHERE t.id = ? AND t.warehouse_id = ?`,
    )
      .bind(transactionId, auth.context.warehouse_id)
      .first();

    if (!transaction) {
      return new Response(JSON.stringify({ error: "Transaction not found." }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    const resolveParty = async (partyId) => {
      if (!partyId) return null;
      try {
        const party = await env.DB.prepare(
          `SELECT name, gstin, address FROM parties WHERE id = ? AND warehouse_id = ?`,
        )
          .bind(partyId, auth.context.warehouse_id)
          .first();
        return party || null;
      } catch (err) {
        return null;
      }
    };

    const detailLoaders = {
      inbound: async () => {
        const shipment = await env.DB.prepare(
          `SELECT sd.*, u.username AS verified_by, cl.name AS client_name, cl.code AS client_code
           FROM inbound_details sd
           LEFT JOIN users u ON u.id = sd.verified_by_user_id
           LEFT JOIN clients cl ON sd.client_id = cl.id
           WHERE sd.id = ? AND sd.warehouse_id = ?`,
        )
          .bind(transaction.reference_id, auth.context.warehouse_id)
          .first();

        const lineItems = await env.DB.prepare(
          "SELECT * FROM inbound_line_items WHERE shipment_id = ? ORDER BY rowid ASC",
        )
          .bind(transaction.reference_id)
          .all();

        const [seller, bill_to, ship_to] = shipment
          ? await Promise.all([
              resolveParty(shipment.seller_party_id),
              resolveParty(shipment.bill_to_party_id),
              resolveParty(shipment.ship_to_party_id),
            ])
          : [null, null, null];

        return {
          shipment_header: shipment || null,
          shipment_line_items: lineItems.results,
          parties: { seller, bill_to, ship_to },
        };
      },
      opening_stock: async () => {
        const importHeader = await env.DB.prepare(
          `SELECT osi.*, u.username AS uploaded_by, 
                  cl.name AS client_name, cl.code AS client_code,
                  so.name AS stock_owner_name, so.code AS stock_owner_code
           FROM opening_stock_imports osi
           LEFT JOIN users u ON u.id = osi.uploaded_by_user_id
           LEFT JOIN clients cl ON osi.client_id = cl.id
           LEFT JOIN stock_owners so ON osi.stock_owner_id = so.id
           WHERE osi.id = ? AND osi.warehouse_id = ?`,
        )
          .bind(transaction.reference_id, auth.context.warehouse_id)
          .first();

        const lineItems = await env.DB.prepare(
          `SELECT osli.*
           FROM opening_stock_line_items osli
           WHERE osli.opening_stock_import_id = ?
           ORDER BY osli.rowid ASC`,
        )
          .bind(transaction.reference_id)
          .all();

        return {
          import_header: importHeader || null,
          opening_stock_line_items: lineItems.results || [],
        };
      },
      outbound: async () => {
        const shipment = await env.DB.prepare(
          `SELECT osd.*, 
                  u_created.username AS created_by,
                  u_verified.username AS verified_by, 
                  cl.name AS client_name, 
                  cl.code AS client_code
           FROM outbound_details osd
           LEFT JOIN users u_created ON u_created.id = osd.created_by_user_id
           LEFT JOIN users u_verified ON u_verified.id = osd.verified_by_user_id
           LEFT JOIN clients cl ON osd.client_id = cl.id
           WHERE osd.id = ? AND osd.warehouse_id = ?`,
        )
          .bind(transaction.reference_id, auth.context.warehouse_id)
          .first();

        const lineItems = await env.DB.prepare(
          `SELECT osli.*, so.name AS stock_owner_name, so.code AS stock_owner_code
           FROM outbound_line_items osli
           LEFT JOIN stock_owners so ON osli.stock_owner_id = so.id
           WHERE osli.outbound_detail_id = ? 
           ORDER BY osli.rowid ASC`,
        )
          .bind(transaction.reference_id)
          .all();

        const pickingTasks = await env.DB.prepare(
          `SELECT pt.*, 
                  u_created.username AS created_by,
                  u_completed.username AS completed_by
           FROM picking_tasks pt
           LEFT JOIN users u_created ON u_created.id = pt.created_by_user_id
           LEFT JOIN users u_completed ON u_completed.id = pt.completed_by_user_id
           WHERE pt.outbound_shipment_detail_id = ? 
           ORDER BY pt.created_at ASC`,
        )
          .bind(transaction.reference_id)
          .all();

        return {
          shipment_header: shipment || null,
          outbound_shipment_line_items: lineItems.results || [],
          picking_tasks: pickingTasks.results || [],
        };
      },
      stock_adjustment: async () => {
        const adjHeader = await env.DB.prepare(
          `SELECT sa.*, u.username AS performed_by, cl.name AS client_name, cl.code AS client_code
               FROM stock_adjustments sa
               LEFT JOIN users u ON u.id = sa.created_by_user_id
               LEFT JOIN clients cl ON sa.client_id = cl.id
               WHERE sa.id = ? AND sa.warehouse_id = ?`,
        )
          .bind(transaction.reference_id, auth.context.warehouse_id)
          .first();

        let adjItems = [];
        if (adjHeader) {
          const itemsRes = await env.DB.prepare(
            `SELECT sai.*, so.name AS stock_owner_name, so.code AS stock_owner_code
                 FROM stock_adjustment_items sai
                 LEFT JOIN stock_owners so ON sai.stock_owner_id = so.id
                 WHERE sai.stock_adjustment_id = ?
                 ORDER BY sai.created_at ASC`,
          )
            .bind(adjHeader.id)
            .all();
          adjItems = itemsRes.results || [];
        }

        return {
          adjustment_header: adjHeader || null,
          adjustment_items: adjItems,
        };
      },
    };

    const loader = detailLoaders[transaction.transaction_type];
    if (!loader) {
      return new Response(
        JSON.stringify({
          error: `Unsupported transaction type: ${transaction.transaction_type}`,
        }),
        {
          status: 400,
          headers: corsHeaders,
        },
      );
    }

    const moduleDetail = await loader();
    return new Response(JSON.stringify({ transaction, ...moduleDetail }), {
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
