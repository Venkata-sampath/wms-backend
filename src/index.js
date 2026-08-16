import { routes } from "./router.js";
import {
  preflightResponse,
  errorResponse,
  corsHeaders,
} from "./utils/response.js";
import { handleOcrDispatch } from "./jobs/ocrDispatch.js";
import { handleLlmDispatch } from "./jobs/llmDispatch.js";
import { sweepStuckJobs } from "./jobs/sweeper.js";

export default {
  async fetch(request, env, ctx) {
    // Handle Preflight OPTIONS requests immediately
    if (request.method === "OPTIONS") {
      return preflightResponse();
    }

    const url = new URL(request.url);

    // Walk the declarative route table
    for (const route of routes) {
      if (route.method === request.method) {
        if (route.path && route.path === url.pathname) {
          return await route.handler(request, env);
        } else if (route.pattern) {
          const matchParams = url.pathname.match(route.pattern);
          if (matchParams) {
            return await route.handler(request, env, matchParams);
          }
        }
      }
    }

    // Fallback 404 matching the original exact shape[cite: 1]
    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  },

  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const task = message.body;

      if (batch.queue === "ocr-queue") {
        try {
          await handleOcrDispatch(task, env);
          message.ack();
        } catch (err) {
          message.retry();
        }
        continue;
      }

      if (batch.queue === "llm-queue") {
        try {
          await handleLlmDispatch(task, env);
          message.ack();
        } catch (err) {
          message.retry();
        }
        continue;
      }
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepStuckJobs(env));
  },
};
