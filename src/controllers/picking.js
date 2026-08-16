import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";

/**
 * @api {GET} /api/picking/pending
 * @description Retrieves all pending picking tasks for the tenant warehouse, enriched with client metadata, outbound shipment details, and associated item pick lines.
 * @access Tenant User, Tenant Admin
 *
 * @returns {200} JSON - { tasks: Array<Object> }
 * @returns {401|500} JSON - { error: string }
 */
export async function getPendingPickingTasksHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  try {
    const tasks = await env.DB.prepare(
      `SELECT pt.id, pt.status, pt.created_at, pt.client_id, 
              c.name AS client_name, c.code AS client_code,
              osd.eway_bill_number, osd.vehicle_number, osd.transporter_name,
              u.username AS created_by
       FROM picking_tasks pt
       LEFT JOIN clients c ON pt.client_id = c.id
       LEFT JOIN outbound_shipment_details osd ON pt.outbound_shipment_detail_id = osd.id
       LEFT JOIN users u ON pt.created_by_user_id = u.id
       WHERE pt.warehouse_id = ? AND pt.status = 'pending'
       ORDER BY pt.created_at ASC`,
    )
      .bind(auth.context.warehouse_id)
      .all();

    const taskIds = tasks.results.map((t) => t.id);
    let itemsByTask = {};
    if (taskIds.length > 0) {
      const placeholders = taskIds.map(() => "?").join(",");
      const items = await env.DB.prepare(
        `SELECT pti.*, inv.manufacturing_date, inv.case_conversion_qty 
         FROM picking_task_items pti
         LEFT JOIN inventory inv ON pti.inventory_id = inv.id
         WHERE pti.picking_task_id IN (${placeholders}) 
         ORDER BY pti.rowid ASC`,
      )
        .bind(...taskIds)
        .all();
      for (const item of items.results) {
        if (!itemsByTask[item.picking_task_id])
          itemsByTask[item.picking_task_id] = [];
        itemsByTask[item.picking_task_id].push(item);
      }
    }

    const enriched = tasks.results.map((t) => ({
      ...t,
      items: itemsByTask[t.id] || [],
    }));

    return new Response(JSON.stringify({ tasks: enriched }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

/**
 * @api {GET} /api/picking/completed
 * @description Retrieves historical completed picking tasks for the tenant warehouse with operator audit info and item pick lists.
 * @access Tenant User, Tenant Admin
 *
 * @returns {200} JSON - { tasks: Array<Object> }
 * @returns {401|500} JSON - { error: string }
 */
export async function getCompletedPickingTasksHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });
  }

  try {
    const tasks = await env.DB.prepare(
      `SELECT pt.id, pt.status, pt.created_at, pt.completed_at, pt.client_id, 
              c.name AS client_name, c.code AS client_code,
              osd.eway_bill_number, osd.vehicle_number, osd.transporter_name,
              u1.username AS created_by,
              u2.username AS completed_by
       FROM picking_tasks pt
       LEFT JOIN clients c ON pt.client_id = c.id
       LEFT JOIN outbound_shipment_details osd ON pt.outbound_shipment_detail_id = osd.id
       LEFT JOIN users u1 ON pt.created_by_user_id = u1.id
       LEFT JOIN users u2 ON pt.completed_by_user_id = u2.id
       WHERE pt.warehouse_id = ? AND pt.status = 'completed'
       ORDER BY pt.completed_at DESC`,
    )
      .bind(auth.context.warehouse_id)
      .all();

    const taskIds = tasks.results.map((t) => t.id);
    let itemsByTask = {};
    if (taskIds.length > 0) {
      const placeholders = taskIds.map(() => "?").join(",");
      const items = await env.DB.prepare(
        `SELECT pti.*, inv.manufacturing_date, inv.case_conversion_qty 
         FROM picking_task_items pti
         LEFT JOIN inventory inv ON pti.inventory_id = inv.id
         WHERE pti.picking_task_id IN (${placeholders}) 
         ORDER BY pti.rowid ASC`,
      )
        .bind(...taskIds)
        .all();
      for (const item of items.results) {
        if (!itemsByTask[item.picking_task_id])
          itemsByTask[item.picking_task_id] = [];
        itemsByTask[item.picking_task_id].push(item);
      }
    }

    const enriched = tasks.results.map((t) => ({
      ...t,
      items: itemsByTask[t.id] || [],
    }));

    return new Response(JSON.stringify({ tasks: enriched }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}

/**
 * @api {POST} /api/picking/complete
 * @description Finalizes a picking task, decrements physical and reserved inventory stock balances, marks line items and task as completed, and closes the outbound shipment and transaction records.
 * @access Tenant User, Tenant Admin (Viewers denied)
 *
 * @body {string} picking_task_id - Unique UUID of the picking task to complete.
 * @body {Array<Object>} picked_items - List of picked item records.
 * @body {string} picked_items[].picking_task_item_id - Unique UUID of the picking task line item.
 * @body {number} [picked_items[].picked_quantity] - Actual quantity picked (defaults to original quantity_to_pick).
 *
 * @returns {200} JSON - { success: true, message: string }
 * @returns {400|401|403|404|500} JSON - { error: string }
 */
export async function completePickingTaskHandler(request, env) {
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
    const { picking_task_id, picked_items } = payload;

    if (
      !picking_task_id ||
      !Array.isArray(picked_items) ||
      picked_items.length === 0
    ) {
      return new Response(
        JSON.stringify({
          error:
            "Missing required inputs: picking_task_id and picked_items array are required.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    const originalTask = await env.DB.prepare(
      "SELECT id, outbound_shipment_detail_id FROM picking_tasks WHERE id = ? AND warehouse_id = ? AND status = 'pending'",
    )
      .bind(picking_task_id, auth.context.warehouse_id)
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
      "SELECT id, inventory_id, quantity_to_pick FROM picking_task_items WHERE picking_task_id = ?",
    )
      .bind(picking_task_id)
      .all();

    const originalById = {};
    for (const row of originalItems.results) originalById[row.id] = row;

    const batchStatements = [];

    for (const picked of picked_items) {
      const original = originalById[picked.picking_task_item_id];
      if (!original) {
        return new Response(
          JSON.stringify({
            error: "Picked item does not belong to this picking task.",
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      const pickedQty =
        parseFloat(
          String(picked.picked_quantity ?? original.quantity_to_pick).replace(
            /,/g,
            "",
          ),
        ) || 0;
      if (pickedQty <= 0 || pickedQty > original.quantity_to_pick + 0.001) {
        return new Response(
          JSON.stringify({
            error: "Picked quantity is invalid for one of the line items.",
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      batchStatements.push(
        env.DB.prepare(
          "UPDATE inventory SET quantity = quantity - ?, reserved_quantity = reserved_quantity - ? WHERE id = ? AND warehouse_id = ?",
        ).bind(
          pickedQty,
          pickedQty,
          original.inventory_id,
          auth.context.warehouse_id,
        ),
      );

      batchStatements.push(
        env.DB.prepare(
          "UPDATE picking_task_items SET status = 'picked' WHERE id = ?",
        ).bind(original.id),
      );
    }

    batchStatements.push(
      env.DB.prepare(
        "UPDATE picking_tasks SET status = 'completed', completed_by_user_id = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND warehouse_id = ?",
      ).bind(auth.context.user_id, picking_task_id, auth.context.warehouse_id),
    );

    batchStatements.push(
      env.DB.prepare(
        "UPDATE outbound_shipment_details SET status = 'completed' WHERE id = ? AND warehouse_id = ?",
      ).bind(
        originalTask.outbound_shipment_detail_id,
        auth.context.warehouse_id,
      ),
    );

    batchStatements.push(
      env.DB.prepare(
        `UPDATE transactions SET status = 'completed', completed_by_user_id = ?, completed_at = CURRENT_TIMESTAMP
             WHERE transaction_type = 'outbound' AND reference_id = ? AND warehouse_id = ?`,
      ).bind(
        auth.context.user_id,
        originalTask.outbound_shipment_detail_id,
        auth.context.warehouse_id,
      ),
    );

    await env.DB.batch(batchStatements);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Picking completed successfully. Balances up to date.",
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
