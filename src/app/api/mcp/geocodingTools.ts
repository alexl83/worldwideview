/**
 * MCP Geocoding Tool registrar (Phase 22 Wave 2, 22-02).
 *
 * Registers two MCP tools:
 *   geocode_location: resolve a place name/address to coordinates via Nominatim
 *                     (GEO-01), with a per-user rate limit + 24h Redis cache (GEO-03)
 *   fly_to: enqueue a flyTo GlobeCommand to move the browser camera (GEO-02)
 *
 * Security: userId comes ONLY from ctx (verified auth result), never from tool
 * arguments. The Nominatim URL is hardcoded; the user query is injected via
 * URLSearchParams inside fetchGeocode (no string concatenation).
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { enqueueGlobeCommand, resolveActiveSessionId } from "@/lib/globeCommandQueue";
import type { GlobeCommand } from "@/core/globe/types/GlobeCommand";
import { fetchGeocode, normalizeNominatimResult } from "@/lib/nominatim";
import type { RawNominatimItem } from "@/lib/nominatim";
import { checkRateLimit } from "@/lib/geocodingRateLimit";
import { redis } from "@/lib/redis";
import { latSchema, lonSchema } from "@/lib/mcp/coordinateSchemas";
import { SESSION_REQUIRED_PREAMBLE } from "@/lib/mcp/toolDescriptionFragments";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type McpTextResult = { content: [{ type: "text"; text: string }] };

function textResult(text: string): McpTextResult {
    return { content: [{ type: "text", text }] };
}

const NO_SESSION_RESULT = textResult("no active globe session to control");

/** Best-effort cache read: a Redis outage degrades to a miss, never an error. */
async function cacheGet(key: string): Promise<string | null> {
    try {
        return await redis.get(key);
    } catch (err) {
        console.warn("[geocodingTools] cache read failed (degrading to miss):", err);
        return null;
    }
}

/** Best-effort cache write: a Redis outage is logged and ignored. */
async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
        await redis.set(key, value, "EX", ttlSeconds);
    } catch (err) {
        console.warn("[geocodingTools] cache write failed (ignored):", err);
    }
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const DEFAULT_ALTITUDE_M = 15_000;
const CACHE_TTL_SECONDS = 86_400; // 24h

/**
 * Resolves the session to use: explicit arg takes precedence, falling back to
 * the most-recently-active session for this user. Returns null if none is live.
 */
async function resolveSession(
    userId: string,
    argSessionId: string | undefined,
    pinnedSessionId?: string,
): Promise<string | null> {
    if (pinnedSessionId) return pinnedSessionId;
    if (argSessionId !== undefined && argSessionId !== "") {
        return argSessionId;
    }
    return resolveActiveSessionId(userId);
}

// ---------------------------------------------------------------------------
// Public registrar
// ---------------------------------------------------------------------------

export function registerGeocodingTools(
    server: McpServer,
    ctx: { userId: string; pinnedSessionId?: string },
): void {
    const { userId, pinnedSessionId } = ctx;

    // GEO-01 + GEO-03: geocode_location
    server.registerTool(
        "geocode_location",
        {
            description:
                "Resolve a place name or address to coordinates and a bounding box via OpenStreetMap Nominatim. " +
                "Use before fly_to to obtain lat/lng from a name; do not guess coordinates. " +
                "Limitations: Nominatim is rate-limited per user; results are cached 24h; returns 'no results found' when nothing matches. " +
                "Parameters: query (string, required) - place name or address; limit (integer 1-20, optional, default 5). " +
                "Output: JSON array sorted by importance, each { lat, lng, name, name_en, type, addresstype, country, display_name, bbox: [west,south,east,north], importance }. " +
                "Example: geocode_location({ query: 'Paris', limit: 3 }) -> [{ lat: 48.85, lng: 2.35, name: 'Paris', bbox: [...] }].",
            inputSchema: {
                query: z.string().min(1).describe("Location name or address to geocode"),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(MAX_LIMIT)
                    .optional()
                    .describe("Max results to return (default 5, max 20)"),
            },
        },
        async (args) => {
            try {
                const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
                const cacheKey = `geocode:${args.query.toLowerCase().trim()}:${limit}`;

                const cached = await cacheGet(cacheKey);
                if (cached) return textResult(cached);

                const rateLimitResult = await checkRateLimit(userId);
                if (rateLimitResult) return textResult(JSON.stringify(rateLimitResult));

                const raw = await fetchGeocode({ query: args.query, limit });
                if (raw.length === 0) return textResult("no results found");

                const results = (raw as RawNominatimItem[]).map(normalizeNominatimResult);
                const json = JSON.stringify(results);
                await cacheSet(cacheKey, json, CACHE_TTL_SECONDS);
                return textResult(json);
            } catch (err) {
                console.error("[geocodingTools] geocode_location failed:", err);
                return textResult("geocode_location command failed");
            }
        },
    );

    // GEO-02: fly_to
    server.registerTool(
        "fly_to",
        {
            description:
                SESSION_REQUIRED_PREAMBLE +
                "Fly the live globe camera to a geocoded coordinate, optionally fitting a bounding box in view. " +
                "Requires an active globe session (read globe://sessions first); returns 'no active globe session to control' when no tab is live. " +
                "Prefer pan_globe for relative panning or focus_entity to snap to a known entity; use fly_to when you have explicit lat/lng (e.g. from geocode_location). " +
                "Parameters: lat (-90..90, required), lng (-180..180, required), altitude (metres, optional, default 15000), " +
                "bbox ([west,south,east,north], optional - fit this region in view), sessionId (optional - omit for most-recently-active tab). " +
                "Example: fly_to({ lat: 48.85, lng: 2.35 }) or fly_to({ lat: 0, lng: 0, bbox: [2.2,48.8,2.5,48.9] }).",
            inputSchema: {
                lat: latSchema.describe("Latitude [-90, 90]"),
                lng: lonSchema.describe("Longitude [-180, 180]"),
                altitude: z
                    .number()
                    .positive()
                    .optional()
                    .describe("Altitude in metres above ellipsoid (default 15000)"),
                bbox: z
                    .tuple([z.number(), z.number(), z.number(), z.number()])
                    .optional()
                    .describe("[west, south, east, north] bounding box to fit in view"),
                sessionId: z
                    .string()
                    .optional()
                    .describe("Target globe session id. Omit to target most-recently-active tab."),
            },
        },
        async (args) => {
            try {
                const sessionId = await resolveSession(userId, args.sessionId, pinnedSessionId);
                if (sessionId === null) return NO_SESSION_RESULT;

                const cmd: GlobeCommand = {
                    type: "flyTo",
                    lat: args.lat,
                    lng: args.lng,
                    alt: args.altitude ?? DEFAULT_ALTITUDE_M,
                    ...(args.bbox ? { bbox: args.bbox } : {}),
                };
                await enqueueGlobeCommand(userId, sessionId, cmd);

                const label = args.bbox
                    ? `bbox=[${args.bbox.join(",")}]`
                    : `lat=${args.lat}, lng=${args.lng}, alt=${args.altitude ?? DEFAULT_ALTITUDE_M}`;
                return textResult(`fly_to command enqueued (${label})`);
            } catch (err) {
                console.error("[geocodingTools] fly_to failed:", err);
                return textResult("fly_to command failed");
            }
        },
    );
}
