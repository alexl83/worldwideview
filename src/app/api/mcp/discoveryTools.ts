/**
 * MCP Discovery Tool registrar (Phase 29 -- 29-01).
 *
 * Registers three compound/discovery MCP tools:
 *   list_available_plugins  -- list all streaming plugins with entity counts + types
 *   get_globe_context       -- full orientation snapshot in one call
 *   investigate_area        -- geocode + query + camera pan in one call
 *
 * Security:
 *   - userId comes ONLY from ctx (verified auth result); never from tool args.
 *   - place_name / entity_type / radius_km are untrusted; place_name is passed
 *     exclusively via URLSearchParams in fetchGeocode (no string concat into URL).
 *   - entity_type is matched only against the in-memory streaming plugin set;
 *     never embedded in an engine URL (T-29-01, T-29-02, T-29-03).
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getEntitiesInRegion } from "@/lib/data-query/service";
import { fetchGeocode, normalizeNominatimResult } from "@/lib/nominatim";
import { enqueueGlobeCommand } from "@/lib/globeCommandQueue";
import type { GlobeCommand } from "@/core/globe/types/GlobeCommand";
import {
    listStreamingPlugins,
    radiusKmToBbox,
    buildInvestigateProse,
    composeGlobeContext,
    resolveActiveSessionId,
} from "./discoveryHelpers";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type McpTextResult = { content: [{ type: "text"; text: string }] };

function textResult(payload: unknown): McpTextResult {
    return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
    };
}

/** Default investigation radius when the caller does not specify one. */
const DEFAULT_RADIUS_KM = 50;

/** Altitude (metres) used for camera pan commands from investigate_area. */
const INVESTIGATE_PAN_ALT = 300_000;

/** Maximum total entities returned across all plugins by investigate_area (TOOL-04). */
const INVESTIGATE_AREA_CAP = 200;

// ---------------------------------------------------------------------------
// Public registrar
// ---------------------------------------------------------------------------

export function registerDiscoveryTools(
    server: McpServer,
    ctx: { userId: string; pinnedSessionId?: string },
): void {
    const { userId, pinnedSessionId } = ctx;

    // ------------------------------------------------------------------
    // TOOL-01: list_available_plugins
    // ------------------------------------------------------------------
    server.registerTool(
        "list_available_plugins",
        {
            description:
                "List all plugins currently streaming live data from the engine. Returns pluginId, pluginName, entityCount, and entityTypes (queryable field names) for each active plugin. " +
                "Use this tool BEFORE search_entities or get_entities_in_region to verify the target plugin is actually streaming -- calling those tools with a non-streaming plugin always returns plugin_not_streaming. " +
                "When the data engine is unreachable the result contains an empty plugins array and a reason field. " +
                "No parameters required. " +
                "Example: list_available_plugins({})",
            inputSchema: {},
        },
        async () => {
            try {
                const result = await listStreamingPlugins();
                return textResult(result);
            } catch (err) {
                console.error("[discoveryTools] list_available_plugins failed:", err);
                return textResult({ plugins: [], reason: "unexpected error" });
            }
        },
    );

    // ------------------------------------------------------------------
    // TOOL-02: get_globe_context
    // ------------------------------------------------------------------
    server.registerTool(
        "get_globe_context",
        {
            description:
                "Retrieve the full current globe context in one call: sessionCount, camera viewport, active layers, filter definitions (note: applied values are NOT server-tracked), and streaming plugin list. " +
                "Use this tool at the start of a session to orient yourself without reading multiple globe:// resources separately. " +
                "When no browser session is active, returns sessionCount:0 and camera:null without error -- open the app in a browser tab first to create a session. " +
                "Filters field shows definitions (field names/types) only; applied filter values are browser-side and not tracked by the server. " +
                "No parameters required. " +
                "Example: get_globe_context({})",
            inputSchema: {},
        },
        async () => {
            try {
                const payload = await composeGlobeContext(userId, pinnedSessionId);
                return textResult(payload);
            } catch (err) {
                console.error("[discoveryTools] get_globe_context failed:", err);
                return textResult({
                    sessionCount: 0,
                    camera: null,
                    layers: {},
                    filters: { note: "context unavailable" },
                    plugins: [],
                    reason: "unexpected error",
                });
            }
        },
    );

    // ------------------------------------------------------------------
    // TOOL-03: investigate_area
    // ------------------------------------------------------------------
    server.registerTool(
        "investigate_area",
        {
            description:
                "Investigate what is happening near a named place for a given entity type. Geocodes the place, finds a matching streaming plugin, queries entities in the bounding region, pans the camera when a session is active, and returns entities + a human-readable summary. " +
                "Use this tool when an agent asks 'what is near X?' or 'show me Y around Z'. Prefer this over manual geocode + search_entities sequences. " +
                "When no matching plugin streams the given entity_type, the summary explains this and suggests list_available_plugins. " +
                "When no active session is found, entities are still returned but the summary notes the camera pan was skipped. " +
                "Response is capped at 200 entities total across all matched plugins. When 'truncated' is true, 'cappedTotal' holds the sum of per-plugin results before the global cap (not the true global count, because each plugin is itself queried with its own 100-entity limit). " +
                "Parameters: place_name (required), entity_type (required, case-insensitive substring match against plugin ids/names), radius_km (optional, default 50). " +
                "Example: investigate_area({place_name:\"Auckland\",entity_type:\"flights\",radius_km:100})",
            inputSchema: {
                place_name: z.string().min(1).describe("Place name to geocode (free-text, e.g. 'Auckland', 'Tokyo Bay')"),
                entity_type: z.string().min(1).describe("Entity type to look for -- case-insensitive substring matched against streaming plugin ids/names"),
                radius_km: z.number().positive().optional().describe("Search radius in kilometres around the geocoded centre (default 50)"),
            },
        },
        async (args) => {
            const { place_name, entity_type, radius_km } = args;
            const radius = radius_km ?? DEFAULT_RADIUS_KM;

            try {
                // Step 1: Geocode the place name (limit 1 result).
                const rawItems = await fetchGeocode({ query: place_name, limit: 1 });
                if (rawItems.length === 0) {
                    return textResult({
                        entities: [],
                        summary: `Could not geocode "${place_name}". Try a more specific or differently spelled place name.`,
                    });
                }
                const geo = normalizeNominatimResult(rawItems[0]);

                // Step 2: Find matching streaming plugins by case-insensitive substring.
                const { plugins } = await listStreamingPlugins();
                const lower = entity_type.toLowerCase();
                const matched = plugins.filter(
                    (p) =>
                        p.pluginId.toLowerCase().includes(lower) ||
                        p.pluginName.toLowerCase().includes(lower),
                );

                if (matched.length === 0) {
                    return textResult({
                        entities: [],
                        summary: buildInvestigateProse({
                            displayName: geo.display_name,
                            entityType: entity_type,
                            matchedPlugin: null,
                            entityCount: 0,
                            sessionPresent: false,
                        }),
                    });
                }

                // Step 3: Compute bbox and query region for each matched plugin.
                const bbox = radiusKmToBbox(geo.lat, geo.lng, radius);
                type SearchResult = { id: string; pluginId: string; name?: string; latitude: number; longitude: number };
                const allEntities: SearchResult[] = [];
                let lastEmptyReason: string | undefined;

                for (const plugin of matched) {
                    const result = await getEntitiesInRegion({ ...bbox, pluginId: plugin.pluginId });
                    allEntities.push(...result.entities);
                    if (result.emptyReason) lastEmptyReason = result.emptyReason;
                }

                // Step 4: Pan camera when a session is active.
                const sessionId = pinnedSessionId ?? await resolveActiveSessionId(userId);
                const sessionPresent = sessionId !== null;
                if (sessionId !== null) {
                    const cmd: GlobeCommand = {
                        type: "pan",
                        lat: geo.lat,
                        lon: geo.lng,
                        alt: INVESTIGATE_PAN_ALT,
                    };
                    await enqueueGlobeCommand(userId, sessionId, cmd);
                }

                // Step 5: Apply overall cap and record truncation metadata.
                // cappedTotal is the sum of per-plugin results before the global cap.
                // It is NOT the true global count because each plugin is queried with
                // its own 100-entity limit before reaching here.
                const cappedTotal = allEntities.length;
                const truncated = cappedTotal > INVESTIGATE_AREA_CAP;
                const entities = truncated ? allEntities.slice(0, INVESTIGATE_AREA_CAP) : allEntities;

                // Step 6: Build prose summary using first matched plugin as representative.
                const representativePlugin = matched[0].pluginId;
                const summary = buildInvestigateProse({
                    displayName: geo.display_name,
                    entityType: entity_type,
                    matchedPlugin: representativePlugin,
                    entityCount: entities.length,
                    sessionPresent,
                    emptyReason: lastEmptyReason,
                });

                return textResult({
                    entities,
                    count: entities.length,
                    ...(truncated && { truncated: true, cappedTotal }),
                    summary,
                });
            } catch (err) {
                console.error("[discoveryTools] investigate_area failed:", err);
                return textResult({
                    entities: [],
                    summary: `investigate_area encountered an unexpected error for "${place_name}". Please retry shortly.`,
                });
            }
        },
    );
}
