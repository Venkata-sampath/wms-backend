// src/middleware/authMiddleware.js
// Real-time tenant authentication middleware.
// Extracted verbatim from the original index.js.

import { verifyJWT } from "../utils/crypto.js";

export async function getTenantContext(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      success: false,
      error: "Authorization header missing or malformed.",
      status: 401,
    };
  }

  // Extract the raw token string
  const token = authHeader.substring(7);
  const payload = await verifyJWT(token, env.JWT_SECRET);

  if (!payload) {
    return {
      success: false,
      error: "Invalid or expired authentication token.",
      status: 401,
    };
  }

  try {
    // Real-time lookup to enforce live user suspension and tenant subscription status
    // Changed to LEFT JOIN so the Super Admin (who has no warehouse_id) isn't filtered out
    const liveUser = await env.DB.prepare(
      `
      SELECT u.id, u.warehouse_id, u.role, u.is_active, w.subscription_status
      FROM users u
      LEFT JOIN warehouses w ON u.warehouse_id = w.id
      WHERE u.id = ?
    `,
    )
      .bind(payload.user_id)
      .first();

    if (!liveUser) {
      return {
        success: false,
        error: "User profile no longer exists.",
        status: 401,
      };
    }

    // NEW BOOTSTRAP GATE: If the user is the platform Super Admin, bypass tenant billing gates
    if (liveUser.role === "super_admin") {
      return {
        success: true,
        context: {
          user_id: liveUser.id,
          warehouse_id: liveUser.warehouse_id, // Super admin is global
          role: liveUser.role,
        },
      };
    }

    // Standard Tenant Gateways (Only applied to Warehouse Admins and Operators)
    if (Number(liveUser.is_active) === 0) {
      return {
        success: false,
        error: "Your user profile has been suspended.",
        status: 403,
      };
    }

    if (liveUser.subscription_status === "suspended") {
      return {
        success: false,
        error: "This warehouse subscription is suspended.",
        status: 403,
      };
    }

    // Tenant context is fully validated. Return authorization data to the router.
    return {
      success: true,
      context: {
        user_id: liveUser.id,
        warehouse_id: liveUser.warehouse_id,
        role: liveUser.role,
      },
    };
  } catch (dbError) {
    return {
      success: false,
      error: `Security verification database error: ${dbError.message}`,
      status: 500,
    };
  }
}
