import { corsHeaders } from "../utils/response.js";
import { verifyPassword, signJWT, hashPassword } from "../utils/crypto.js";
import { getTenantContext } from "../middleware/authMiddleware.js";

/**
 * @api {POST} /api/auth/login
 * @description Authenticates a user, validates their operational lifecycle status, and generates a JWT.
 * Returns the user profile including warehouse billing information.
 * @access Public
 *
 * @body {string} username - The user's account username.
 * @body {string} password - The user's account password.
 *
 * @returns {200} JSON - { message: "...", token: "...", user: { ... } }
 * @returns {400|401|403|500} JSON - { error: "..." }
 */
export async function loginHandler(request, env) {
  try {
    const { username, password } = await request.json();

    if (!username || !password) {
      return new Response(
        JSON.stringify({ error: "Username and password are required." }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // LOOKUP UPDATE: Added w.company_name, w.gstin, w.address (used on billing invoices) to extract the warehouse profile
    const userRow = await env.DB.prepare(
      `
      SELECT u.id, u.username, u.password_hash, u.role, u.is_active, u.warehouse_id, w.subscription_status, w.company_name, w.gstin, w.address
      FROM users u
      LEFT JOIN warehouses w ON u.warehouse_id = w.id
      WHERE u.username = ?
    `,
    )
      .bind(username)
      .first();

    if (!userRow) {
      return new Response(
        JSON.stringify({ error: "Invalid username or password." }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const isPasswordValid = await verifyPassword(
      password,
      userRow.password_hash,
    );
    if (!isPasswordValid) {
      return new Response(
        JSON.stringify({ error: "Invalid username or password." }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Enforce operational lifecycle gates ONLY if the logging user is NOT the platform Super Admin
    if (userRow.role !== "super_admin") {
      if (Number(userRow.is_active) === 0) {
        return new Response(
          JSON.stringify({ error: "Your profile has been suspended." }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      if (userRow.subscription_status === "suspended") {
        return new Response(
          JSON.stringify({
            error: "This warehouse subscription is suspended.",
          }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // Construct the JWT token payload (Expires in 24 Hours)
    const expirationTime = Date.now() + 24 * 60 * 60 * 1000;
    const tokenPayload = {
      user_id: userRow.id,
      username: userRow.username,
      warehouse_id: userRow.warehouse_id,
      role: userRow.role,
      exp: expirationTime,
    };

    const token = await signJWT(tokenPayload, env.JWT_SECRET);

    // RESPONSE UPDATE: Added company_name inside the returned user object
    return new Response(
      JSON.stringify({
        message: "Login successful.",
        token,
        user: {
          id: userRow.id,
          username: userRow.username,
          role: userRow.role,
          warehouse_id: userRow.warehouse_id,
          company_name: userRow.company_name, // Handed down cleanly to app.js local storage
          gstin: userRow.gstin, // Warehouse GSTIN, used when generating billing invoices client-side
          address: userRow.address, // Warehouse address, used when generating billing invoices client-side
        },
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: `Login pipeline failure: ${error.message}` }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * @api {POST} /api/auth/register-operator
 * @description Registers a new sub-account linked to the admin's tenant warehouse.
 * @access Tenant Admin Only
 *
 * @body {string} username - The desired username for the new account.
 * @body {string} password - The secure password for the new account.
 * @body {string} [role="operator"] - Optional assigned role parameter (defaults to "operator").
 *
 * @returns {201} JSON - { message: "User account successfully activated." }
 * @returns {400|403|409|500} JSON - { error: "..." }
 */
export async function registerOperatorHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Access Control: Only the Tenant Warehouse Admin can spawn sub-accounts
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Forbidden: Only Warehouse Admins can create users.",
      }),
      {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    // Parse incoming request parameters dynamically from the front-end form layout
    const { username, password, role } = await request.json();
    if (!username || !password) {
      return new Response(
        JSON.stringify({
          error: "Missing required username or password fields.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Fall back safely to "operator" status if no explicit selection role string was supplied
    const assignedRole = role || "operator";

    const secureHash = await hashPassword(password);
    const newUserId = crypto.randomUUID();

    // Save dynamic assignedRole parameter to your D1 Database row instead of hardcoded 'operator'
    await env.DB.prepare(
      `
      INSERT INTO users (id, warehouse_id, username, password_hash, role, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `,
    )
      .bind(
        newUserId,
        auth.context.warehouse_id,
        username,
        secureHash,
        assignedRole,
      )
      .run();

    return new Response(
      JSON.stringify({
        message: `User account '${username}' with role '${assignedRole}' successfully activated.`,
      }),
      {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    if (error.message.includes("UNIQUE constraint failed")) {
      return new Response(
        JSON.stringify({
          error: "Username already exists on the platform registry.",
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({ error: `Registration error: ${error.message}` }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * @api {POST} /api/auth/toggle-user-status
 * @description Updates the operational lifecycle status (active/suspended) of a specific user. Prevents cross-tenant modifications.
 * @access Tenant Admin Only
 *
 * @body {string} target_user_id - The unique identifier of the user to update.
 * @body {number} set_active - Integer representing status: `1` for active, `0` for suspended.
 *
 * @returns {200} JSON - { message: "User profile operational state modified successfully..." }
 * @returns {400|403|404|500} JSON - { error: "..." }
 */
export async function toggleUserStatusHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({ error: "Forbidden: Unauthorized access." }),
      {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const { target_user_id, set_active } = await request.json(); // set_active will be 1 or 0

    if (!target_user_id || (set_active !== 0 && set_active !== 1)) {
      return new Response(
        JSON.stringify({
          error: "Invalid target parameters or status assignment integers.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Target the update. Note the 'warehouse_id = ?' clause — this prevents
    // an admin from accessing or editing a user row belonging to another tenant warehouse.
    const result = await env.DB.prepare(
      `
      UPDATE users 
      SET is_active = ? 
      WHERE id = ? AND warehouse_id = ?
    `,
    )
      .bind(set_active, target_user_id, auth.context.warehouse_id)
      .run();

    if (result.meta.changes === 0) {
      return new Response(
        JSON.stringify({
          error:
            "User account profile not found within your authorized tenant scope.",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        message: `User profile operational state modified successfully to: ${set_active}.`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: `Lifecycle status change failed: ${error.message}`,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * @api {GET} /api/users
 * @description Retrieves a directory of all user accounts associated with the authenticated admin's tenant warehouse.
 * @access Tenant Admin Only
 *
 * @returns {200} JSON - Array containing user records: [{ id, username, role, is_active }]
 * @returns {403|500} JSON - { error: "..." }
 */
export async function getUsersHandler(request, env) {
  const auth = await getTenantContext(request, env);
  if (!auth.success) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Access Control: Only the Tenant Warehouse Admin can view the workforce directory
  if (auth.context.role !== "admin") {
    return new Response(
      JSON.stringify({
        error: "Forbidden: Access restricted to Warehouse Admins.",
      }),
      {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    // Multi-tenant check: Fetch users that belong exclusively to this admin's warehouse_id
    const rows = await env.DB.prepare(
      `
      SELECT id, username, role, is_active 
      FROM users 
      WHERE warehouse_id = ? 
      ORDER BY username ASC
      `,
    )
      .bind(auth.context.warehouse_id)
      .all();

    // Return the results array wrapped perfectly for the frontend table matrix
    return new Response(JSON.stringify(rows.results || []), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: `Failed to retrieve user accounts: ${error.message}`,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}
