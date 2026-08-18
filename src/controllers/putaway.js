import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";

/**
 * @api {GET} /api/putaway/pending
 * @description Retrieves all pending putaway tasks for the authenticated tenant warehouse along with associated inbound item lines.
 * @access Tenant User, Tenant Admin (Super Admins denied)
 *
 * @returns {200} JSON - { tasks: Array<Object> }
 * @returns {401|403|500} JSON - { error: string }
 */
export async function getPendingPutawayTasksHandler(request, env) {
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
    const tasksQuery = await env.DB.prepare(
      `SELECT t.id, t.shipment_id, t.created_at, d.invoice_number, c.code AS client_code, c.name AS client_name, u.username AS verified_by
       FROM putaway_tasks t
       LEFT JOIN inbound_details d ON t.shipment_id = d.id
       LEFT JOIN clients c ON d.client_id = c.id
       LEFT JOIN users u ON d.verified_by_user_id = u.id
       WHERE t.warehouse_id = ? AND t.status = 'pending'
       ORDER BY t.created_at DESC`,
    )
      .bind(auth.context.warehouse_id)
      .all();

    const pendingTasks = tasksQuery.results;

    if (pendingTasks.length === 0) {
      return new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const taskIds = pendingTasks.map((t) => t.id);
    const placeholders = taskIds.map(() => "?").join(",");

    const itemsQuery = await env.DB.prepare(
      `SELECT putaway_task_id, id, item_code, item_description, quantity_to_place, category, manufacturing_date, expiry_date, batch_number, shipment_line_item_id, uom
       FROM putaway_task_items 
       WHERE putaway_task_id IN (${placeholders})`,
    )
      .bind(...taskIds)
      .all();

    const allItems = itemsQuery.results;

    const responseData = pendingTasks.map((task) => {
      return {
        ...task,
        items: allItems.filter((item) => item.putaway_task_id === task.id),
      };
    });

    return new Response(JSON.stringify({ tasks: responseData }), {
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
 * @api {GET} /api/putaway/completed
 * @description Retrieves all completed putaway tasks for the authenticated tenant warehouse, enriched with client info, operators, completion timestamps, and location split allocations.
 * @access Tenant User, Tenant Admin (Super Admins denied)
 *
 * @returns {200} JSON - { tasks: Array<Object> }
 * @returns {401|403|500} JSON - { error: string }
 */
export async function getCompletedPutawayTasksHandler(request, env) {
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
    // Joined clients table to fetch client_code and client_name
    const tasksQuery = await env.DB.prepare(
      `SELECT t.id, t.shipment_id, t.created_at, d.invoice_number, c.code AS client_code, c.name AS client_name,
                  u1.username AS verified_by, u2.username AS completed_by, tx.completed_date_time AS completed_date_time
           FROM putaway_tasks t
           LEFT JOIN inbound_details d ON t.shipment_id = d.id
           LEFT JOIN clients c ON d.client_id = c.id
           LEFT JOIN users u1 ON d.verified_by_user_id = u1.id
           LEFT JOIN users u2 ON t.completed_by_user_id = u2.id
           LEFT JOIN transactions tx ON tx.transaction_type = 'inbound' AND tx.reference_id = t.shipment_id AND tx.warehouse_id = t.warehouse_id
           WHERE t.warehouse_id = ? AND t.status = 'completed'
           ORDER BY tx.completed_at DESC`,
    )
      .bind(auth.context.warehouse_id)
      .all();

    const completedTasks = tasksQuery.results;

    if (completedTasks.length === 0) {
      return new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const taskIds = completedTasks.map((t) => t.id);
    const placeholders = taskIds.map(() => "?").join(",");

    // UPDATED: Included batch_number in SELECT clause
    const itemsQuery = await env.DB.prepare(
      `SELECT putaway_task_id, id, item_code, item_description, quantity_to_place, category, manufacturing_date, expiry_date, batch_number, shipment_line_item_id, uom
           FROM putaway_task_items 
           WHERE putaway_task_id IN (${placeholders})`,
    )
      .bind(...taskIds)
      .all();

    const allItems = itemsQuery.results;
    const itemIds = allItems.map((i) => i.id);

    let allAllocations = [];
    if (itemIds.length > 0) {
      const itemPlaceholders = itemIds.map(() => "?").join(",");
      const allocQuery = await env.DB.prepare(
        `SELECT putaway_task_item_id, location_id, quantity 
             FROM putaway_task_item_allocations 
             WHERE putaway_task_item_id IN (${itemPlaceholders})`,
      )
        .bind(...itemIds)
        .all();
      allAllocations = allocQuery.results;
    }

    const responseData = completedTasks.map((task) => {
      const taskItems = allItems
        .filter((item) => item.putaway_task_id === task.id)
        .map((item) => {
          return {
            ...item,
            allocations: allAllocations
              .filter((a) => a.putaway_task_item_id === item.id)
              .map((a) => ({
                location_id: a.location_id,
                quantity: a.quantity,
              })),
          };
        });
      return {
        ...task,
        items: taskItems,
      };
    });

    return new Response(JSON.stringify({ tasks: responseData }), {
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
 * @api {POST} /api/putaway/complete
 * @description Finalizes an inbound putaway task by committing split storage location allocations into live inventory balances, recording allocation logs, and completing the task/inbound transaction.
 * @access Tenant User, Tenant Admin (Viewers denied)
 *
 * @body {string} putaway_task_id - Unique UUID of the pending putaway task.
 * @body {Array<Object>} allocations - Array of location split allocations.
 * @body {string} allocations[].item_code - Product/SKU code matching the task line item.
 * @body {string} allocations[].location_id - Target storage location identifier.
 * @body {number} allocations[].quantity - Quantity assigned to this storage location.
 * @body {string} [allocations[].item_description] - Optional description of the item.
 *
 * @returns {200} JSON - { success: true, message: string }
 * @returns {400|401|403|404|500} JSON - { error: string }
 */
export async function completePutawayTaskHandler(request, env) {
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
        error:
          "Operation Forbidden: Viewers cannot register physical warehouse stock actions.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  try {
    const payload = await request.json();
    const { putaway_task_id, allocations } = payload;

    if (
      !putaway_task_id ||
      !Array.isArray(allocations) ||
      allocations.length === 0
    ) {
      return new Response(
        JSON.stringify({
          error:
            "Missing required inputs: putaway_task_id and allocations array matching layout are required.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    const originalTask = await env.DB.prepare(
      `SELECT pt.id, pt.shipment_id, pt.client_id, sd.stock_owner_id 
   FROM putaway_tasks pt 
   JOIN inbound_details sd ON pt.shipment_id = sd.id 
   WHERE pt.id = ? AND pt.warehouse_id = ? AND pt.status = 'pending'`,
    )
      .bind(putaway_task_id, auth.context.warehouse_id)
      .first();

    if (!originalTask) {
      return new Response(
        JSON.stringify({
          error:
            "Task not found or has already been closed by another operating user.",
        }),
        { status: 404, headers: corsHeaders },
      );
    }

    const originalItems = await env.DB.prepare(
      `SELECT pti.id, pti.item_code, pti.quantity_to_place, pti.category, pti.manufacturing_date, 
          pti.expiry_date, pti.batch_number, pti.shipment_line_item_id, pti.uom, 
          sli.case_conversion_qty 
          FROM putaway_task_items pti
          LEFT JOIN inbound_line_items sli ON pti.shipment_line_item_id = sli.id
          WHERE pti.putaway_task_id = ?`,
    )
      .bind(putaway_task_id)
      .all();

    const expectedTotals = {};
    const batchMetaByItemCode = {};

    for (const targetItem of originalItems.results) {
      expectedTotals[targetItem.item_code] =
        (expectedTotals[targetItem.item_code] || 0) +
        targetItem.quantity_to_place;
      if (!(targetItem.item_code in batchMetaByItemCode)) {
        batchMetaByItemCode[targetItem.item_code] = {
          source_reference_id: targetItem.id,
          category: targetItem.category ?? null,
          manufacturing_date: targetItem.manufacturing_date ?? null,
          expiry_date: targetItem.expiry_date ?? null,
          batch_number: targetItem.batch_number ?? null,
          case_conversion_qty: targetItem.case_conversion_qty ?? null,
          shipment_line_item_id: targetItem.shipment_line_item_id,
          uom: targetItem.uom,
        };
      }
    }

    const submittedTotals = {};
    for (const alloc of allocations) {
      const qty =
        parseFloat(String(alloc.quantity || 0).replace(/,/g, "")) || 0;
      if (qty <= 0) continue;
      submittedTotals[alloc.item_code] =
        (submittedTotals[alloc.item_code] || 0) + qty;
    }

    for (const code of Object.keys(expectedTotals)) {
      const expected = expectedTotals[code];
      const submitted = submittedTotals[code] || 0;
      if (Math.abs(expected - submitted) > 0.001) {
        return new Response(
          JSON.stringify({
            error: `Quantity verification failure for item '${code}'. Expected total allocation of ${expected} units, but received split assignments summation of ${submitted} units.`,
          }),
          { status: 400, headers: corsHeaders },
        );
      }
    }

    const batchStatements = [];

    for (const alloc of allocations) {
      const targetLocationId = String(alloc.location_id || "")
        .trim()
        .toUpperCase();
      const targetQty =
        parseFloat(String(alloc.quantity || 0).replace(/,/g, "")) || 0;
      const cleanItemCode = String(alloc.item_code || "").trim();
      const cleanItemDesc = String(
        alloc.item_description || "Unknown Item",
      ).trim();

      if (targetQty <= 0 || !targetLocationId) continue;

      const validLocation = await env.DB.prepare(
        "SELECT id FROM locations WHERE id = ? AND warehouse_id = ?",
      )
        .bind(targetLocationId, auth.context.warehouse_id)
        .first();

      if (!validLocation) {
        return new Response(
          JSON.stringify({
            error: `Location layout mismatch: The location label '${targetLocationId}' does not exist in your warehouse directory configuration.`,
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      const itemBatchMeta = batchMetaByItemCode[cleanItemCode] || {};

      batchStatements.push(
        env.DB.prepare(
          `INSERT INTO inventory (
        id, shipment_line_item_id, inventory_source, source_reference_id, warehouse_id, location_id, item_code, 
        item_description, quantity, uom, category, manufacturing_date, expiry_date, batch_number, case_conversion_qty, client_id, stock_owner_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          "inv_" + crypto.randomUUID(),
          itemBatchMeta.shipment_line_item_id,
          "putaway",
          itemBatchMeta.source_reference_id,
          auth.context.warehouse_id,
          targetLocationId,
          cleanItemCode,
          cleanItemDesc,
          targetQty,
          itemBatchMeta.uom || "PCS",
          itemBatchMeta.category,
          itemBatchMeta.manufacturing_date,
          itemBatchMeta.expiry_date,
          itemBatchMeta.batch_number,
          itemBatchMeta.case_conversion_qty ?? null,
          originalTask.client_id,
          originalTask.stock_owner_id,
        ),
      );

      batchStatements.push(
        env.DB.prepare(
          `INSERT INTO putaway_task_item_allocations (id, warehouse_id, putaway_task_item_id, location_id, quantity)
       VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          "alloc_" + crypto.randomUUID(),
          auth.context.warehouse_id,
          itemBatchMeta.source_reference_id,
          targetLocationId,
          targetQty,
        ),
      );
    }

    batchStatements.push(
      env.DB.prepare(
        "UPDATE putaway_tasks SET status = 'completed', completed_by_user_id = ? WHERE id = ? AND warehouse_id = ?",
      ).bind(auth.context.user_id, putaway_task_id, auth.context.warehouse_id),
    );

    batchStatements.push(
      env.DB.prepare(
        `UPDATE transactions SET status = 'completed', completed_by_user_id = ?, completed_at = CURRENT_TIMESTAMP
     WHERE transaction_type = 'inbound' AND reference_id = ? AND warehouse_id = ?`,
      ).bind(
        auth.context.user_id,
        originalTask.shipment_id,
        auth.context.warehouse_id,
      ),
    );

    await env.DB.batch(batchStatements);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Putaway process finalized successfully. Balances up to date.",
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
