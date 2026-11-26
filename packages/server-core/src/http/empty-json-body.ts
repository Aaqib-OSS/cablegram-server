import type { FastifyInstance } from "fastify";

/**
 * Installed TVs send some bodiless requests with content-type application/json, which Fastify rejects with a 400
 * before the route runs. Register this inside an encapsulated scope that holds only such routes: an empty body
 * parses as {}, anything else must still be valid JSON. Every other route keeps the strict parser.
 */
export function acceptEmptyJsonBody(scope: FastifyInstance) {
  scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { done(Object.assign(new Error("invalid_json"), { statusCode: 400 })); }
  });
}
