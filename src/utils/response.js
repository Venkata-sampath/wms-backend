// src/utils/response.js
// Comprehensive CORS headers, shared across every route (identical to the
// `corsHeaders` constant that used to live at the top of the monolithic
// index.js).
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/**
 * Standard JSON response with CORS headers merged in.
 * Mirrors the `{ ...corsHeaders, "Content-Type": "application/json" }`
 * pattern that was repeated at almost every return site in the original file.
 */
export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

/** Shorthand for `{ error: message }` JSON responses. */
export function errorResponse(message, status = 400, extraHeaders = {}) {
  return jsonResponse({ error: message }, status, extraHeaders);
}

/** 204 response used for CORS preflight (OPTIONS) requests. */
export function preflightResponse() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
