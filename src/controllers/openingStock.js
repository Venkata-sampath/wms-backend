import { corsHeaders } from "../utils/response.js";
import { getTenantContext } from "../middleware/authMiddleware.js";
import { parseAndValidateExcel } from "../utils/excel.js";

/**
 * @api {POST} /api/opening-stock/validate
 * @description Parses and validates an uploaded Excel file for opening stock records without committing changes to the database.
 * @access Authenticated Tenant User / Admin
 *
 * @body {FormData} formData - Multipart form data containing the uploaded Excel spreadsheet in the `file` field.
 *
 * @returns {200} JSON - Validation summary containing parsed rows, row count, errors, and validity flag.
 * @returns {400|401|500} JSON - { error: string }
 */
export async function validateOpeningStockHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success)
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file)
      return new Response(
        JSON.stringify({ error: "No Excel file uploaded." }),
        { status: 400, headers: corsHeaders },
      );

    const arrayBuffer = await file.arrayBuffer();
    const result = parseAndValidateExcel(arrayBuffer);

    return new Response(JSON.stringify(result), {
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
 * @api {POST} /api/opening-stock/import
 * @description Parses, validates, and atomically commits opening stock records from an Excel spreadsheet into live inventory, provisioning new storage locations and audit ledger entries.
 * @access Authenticated Tenant User / Admin
 *
 * @body {FormData} formData - Multipart form data payload:
 * @body {File} formData.file - The Excel spreadsheet file.
 * @body {string} formData.client_id - Target client UUID.
 * @body {string} formData.stock_owner_id - Target stock owner UUID.
 *
 * @returns {200} JSON - { success: true, opening_stock_import_id: string, transaction_id: string, total_rows: number }
 * @returns {400|401|500} JSON - { error: string, [errors]: Array<string> }
 */
export async function importOpeningStockHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success)
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: corsHeaders,
    });

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const clientId = formData.get("client_id");
    const stockOwnerId = formData.get("stock_owner_id");

    if (!file || !clientId || !stockOwnerId) {
      return new Response(
        JSON.stringify({
          error:
            "Missing required import parameters (file, client_id, stock_owner_id).",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const validation = parseAndValidateExcel(arrayBuffer);

    if (!validation.isValid) {
      return new Response(
        JSON.stringify({
          error: "Import rejected due to validation errors.",
          errors: validation.errors,
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    const warehouseId = auth.context.warehouse_id;
    const userId = auth.context.user_id;
    const importId = `osi_${crypto.randomUUID().slice(0, 8)}`;
    const transactionId = `tx_os_${crypto.randomUUID().slice(0, 8)}`;

    // Get existing locations to avoid duplicate insertion statements in the atomic batch
    const existingLocationsRes = await env.DB.prepare(
      "SELECT id FROM locations WHERE warehouse_id = ?",
    )
      .bind(warehouseId)
      .all();
    const knownLocationIds = new Set(
      (existingLocationsRes.results || []).map((l) => l.id),
    );

    const dbStatements = [];

    // 1. Insert Opening Stock Import Batch Header
    dbStatements.push(
      env.DB.prepare(
        `INSERT INTO opening_stock_imports (id, warehouse_id, client_id, stock_owner_id, uploaded_by_user_id, total_rows, created_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      ).bind(
        importId,
        warehouseId,
        clientId,
        stockOwnerId,
        userId,
        validation.parsedRows.length,
      ),
    );

    // 2. Insert Transaction Record
    dbStatements.push(
      env.DB.prepare(
        `INSERT INTO transactions (id, warehouse_id, reference_id, client_id, transaction_type, status, created_by_user_id, completed_by_user_id, created_at, completed_at)
         VALUES (?, ?, ?, ?, 'opening_stock', 'completed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).bind(transactionId, warehouseId, importId, clientId, userId, userId),
    );

    // 3. Process Line Items, Locations, and Live Inventory Records
    for (const row of validation.parsedRows) {
      const locUpper = row.location.toUpperCase();

      if (!knownLocationIds.has(locUpper)) {
        dbStatements.push(
          env.DB.prepare(
            `INSERT INTO locations (id, warehouse_id, status) VALUES (?, ?, 'available')`,
          ).bind(locUpper, warehouseId),
        );
        knownLocationIds.add(locUpper);
      }

      const lineItemId = `osli_${crypto.randomUUID().slice(0, 8)}`;
      dbStatements.push(
        env.DB.prepare(
          `INSERT INTO opening_stock_line_items (id, opening_stock_import_id, item_code, item_description, quantity, uom, category, batch_number, manufacturing_date, expiry_date, case_conversion_qty, location_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        ).bind(
          lineItemId,
          importId,
          row.item_code,
          row.item_description,
          row.quantity,
          row.uom,
          row.category,
          row.batch_number,
          row.manufacturing_date,
          row.expiry_date,
          row.case_conversion_qty ?? null,
          locUpper,
        ),
      );

      const inventoryId = `inv_os_${crypto.randomUUID().slice(0, 8)}`;
      dbStatements.push(
        env.DB.prepare(
          `INSERT INTO inventory (id, inventory_source, source_reference_id, shipment_line_item_id, warehouse_id, client_id, stock_owner_id, location_id, item_code, item_description, quantity, uom, category, manufacturing_date, expiry_date, batch_number, case_conversion_qty, created_at)
           VALUES (?, 'opening_stock', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        ).bind(
          inventoryId,
          lineItemId,
          warehouseId,
          clientId,
          stockOwnerId,
          locUpper,
          row.item_code,
          row.item_description,
          row.quantity,
          row.uom,
          row.category,
          row.manufacturing_date,
          row.expiry_date,
          row.batch_number,
          row.case_conversion_qty ?? null,
        ),
      );
    }

    // Execute atomic transaction rollback if any statement fails
    console.log("Statements:", dbStatements.length);
    await env.DB.batch(dbStatements);
    console.log("Batch completed");
    return new Response(
      JSON.stringify({
        success: true,
        opening_stock_import_id: importId,
        transaction_id: transactionId,
        total_rows: validation.parsedRows.length,
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
