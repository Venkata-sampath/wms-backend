import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";

/**
 * @api {GET} /api/inventory
 * @description Retrieves the live inventory snapshot (stock balances) for the authenticated tenant warehouse.
 * Includes detailed location mapping, client associations, batch data, and quantities.
 * @access Tenant Admin, Tenant User (Super Admins denied)
 *
 * @returns {200} JSON - { inventory: Array<Object> }
 * @returns {401|403|500} JSON - { error: string }
 */
export async function getInventoryHandler(request, env) {
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
    const inventoryBalances = await env.DB.prepare(
      `SELECT 
    i.id, i.shipment_line_item_id, i.inventory_source, i.source_reference_id, i.warehouse_id, i.location_id, 
    i.item_code, i.item_description, i.quantity, i.reserved_quantity, (i.quantity - i.reserved_quantity) AS available_quantity, i.uom, i.category, i.manufacturing_date, 
    i.expiry_date, i.batch_number, i.created_at, i.client_id, i.stock_owner_id,
    c.name AS client_name, c.code AS client_code,
    so.name AS stock_owner_name, so.code AS stock_owner_code,
    u_verified.username AS verified_by, u_putaway.username AS putaway_by
 FROM inventory i
 LEFT JOIN clients c ON i.client_id = c.id
 LEFT JOIN stock_owners so ON i.stock_owner_id = so.id
 LEFT JOIN inbound_line_items sli ON i.shipment_line_item_id = sli.id
 LEFT JOIN inbound_details sd ON sli.shipment_id = sd.id
 LEFT JOIN users u_verified ON sd.verified_by_user_id = u_verified.id
 LEFT JOIN putaway_task_items pti ON i.source_reference_id = pti.id AND i.inventory_source = 'putaway'
 LEFT JOIN putaway_tasks pt ON pti.putaway_task_id = pt.id
 LEFT JOIN users u_putaway ON pt.completed_by_user_id = u_putaway.id
 WHERE i.warehouse_id = ? AND i.quantity > 0
 ORDER BY i.location_id ASC, i.item_code ASC, i.created_at DESC`,
    )
      .bind(auth.context.warehouse_id)
      .all();

    return new Response(
      JSON.stringify({ inventory: inventoryBalances.results }),
      {
        status: 200,
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

/**
 * @api {POST} /api/inventory/adjust
 * @description Executes a physical stock reconciliation, overwriting system inventory balances with physical counts and logging the deltas into the ledger.
 * @access Tenant Admin, Tenant User (Viewers denied)
 *
 * @body {string} remarks - Mandatory audit reason for the manual adjustment (e.g., "cycle count variance").
 * @body {Array<Object>} items - List of adjustment payloads.
 * @body {string} items[].inventory_id - The unique ID of the specific inventory row.
 * @body {number} items[].physical_quantity - The newly counted absolute quantity (must be >= reserved_quantity).
 *
 * @returns {200} JSON - { success: true, message: string, adjustment_id: string, transaction_id: string, total_items: number }
 * @returns {400|401|403|404|500} JSON - { error: string }
 */
export async function adjustInventoryHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  if (auth.context.role === "viewer") {
    return new Response(
      JSON.stringify({
        error: "Operation Forbidden: Viewers cannot make adjustments.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const { remarks, items } = await request.json();

    if (!remarks || !String(remarks).trim()) {
      return new Response(
        JSON.stringify({
          error: "Audit remarks/reasons are mandatory for stock adjustments.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    if (!Array.isArray(items) || items.length === 0) {
      return new Response(
        JSON.stringify({
          error: "At least one inventory item must be selected for adjustment.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    const resolvedAdjustments = [];
    let primaryClientId = null;

    for (const item of items) {
      const invId = item.inventory_id;
      const physQty = Number(item.physical_quantity);

      if (!invId) {
        return new Response(
          JSON.stringify({
            error: "One or more items are missing an inventory identifier.",
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      if (isNaN(physQty) || !Number.isFinite(physQty) || physQty < 0) {
        return new Response(
          JSON.stringify({
            error: `Physical quantity for item (${item.item_code || invId}) must be a valid non-negative number.`,
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      const invRow = await env.DB.prepare(
        "SELECT * FROM inventory WHERE id = ? AND warehouse_id = ?",
      )
        .bind(invId, auth.context.warehouse_id)
        .first();

      if (!invRow) {
        return new Response(
          JSON.stringify({
            error: `Inventory record ${invId} not found in this warehouse.`,
          }),
          { status: 404, headers: corsHeaders },
        );
      }

      if (physQty < invRow.reserved_quantity) {
        return new Response(
          JSON.stringify({
            error: `Counted quantity (${physQty}) for SKU '${invRow.item_code}' at location '${invRow.location_id}' cannot be lower than the reserved quantity (${invRow.reserved_quantity}).`,
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      const systemQty = Number(invRow.quantity);
      const delta = physQty - systemQty;

      if (!primaryClientId) {
        primaryClientId = invRow.client_id;
      }

      resolvedAdjustments.push({
        invRow,
        physicalQuantity: physQty,
        systemQuantity: systemQty,
        delta,
      });
    }

    const adjustmentId = "adj_" + crypto.randomUUID();
    const transactionId = "txn_" + crypto.randomUUID();
    const batchStatements = [];

    // 1. Insert Adjustment Transaction Header
    batchStatements.push(
      env.DB.prepare(
        `INSERT INTO stock_adjustments (
              id, warehouse_id, client_id, remarks, created_by_user_id, created_at
            ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      ).bind(
        adjustmentId,
        auth.context.warehouse_id,
        primaryClientId,
        String(remarks).trim(),
        auth.context.user_id,
      ),
    );

    // 2. Insert Line Items and Update Live Balances
    for (const resolved of resolvedAdjustments) {
      const lineItemId = "saji_" + crypto.randomUUID();
      const { invRow, physicalQuantity, systemQuantity, delta } = resolved;

      // Insert into historical ledger (without inventory_id)
      batchStatements.push(
        env.DB.prepare(
          `INSERT INTO stock_adjustment_items (
                id, stock_adjustment_id, stock_owner_id, location_id,
                item_code, item_description, batch_number, uom, system_quantity,
                physical_quantity, delta_quantity, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        ).bind(
          lineItemId,
          adjustmentId,
          invRow.stock_owner_id,
          invRow.location_id,
          invRow.item_code,
          invRow.item_description,
          invRow.batch_number,
          invRow.uom,
          systemQuantity,
          physicalQuantity,
          delta,
        ),
      );

      // Apply delta to live inventory using the invRow.id (which is the inventory_id)
      batchStatements.push(
        env.DB.prepare(
          `UPDATE inventory SET quantity = quantity + ? WHERE id = ? AND warehouse_id = ?`,
        ).bind(delta, invRow.id, auth.context.warehouse_id),
      );
    }

    // 3. Write Transaction Register Record
    batchStatements.push(
      env.DB.prepare(
        `INSERT INTO transactions (
              id, warehouse_id, reference_id, client_id, transaction_type,
              status, created_by_user_id, completed_by_user_id, created_at, completed_at, remarks
            ) VALUES (?, ?, ?, ?, 'stock_adjustment', 'completed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
      ).bind(
        transactionId,
        auth.context.warehouse_id,
        adjustmentId,
        primaryClientId,
        auth.context.user_id,
        auth.context.user_id,
        String(remarks).trim(),
      ),
    );

    await env.DB.batch(batchStatements);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Batch stock adjustment completed successfully (${resolvedAdjustments.length} items updated).`,
        adjustment_id: adjustmentId,
        transaction_id: transactionId,
        total_items: resolvedAdjustments.length,
      }),
      {
        status: 200,
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
