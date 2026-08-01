/**
 * MCP Globe Command Tool registrar (Phase 19a Wave 2 -- 19-03).
 *
 * Registers four MCP tools that let an AI agent control the live globe in the
 * browser. Commands are enqueued to a per-session Redis list; the browser polls
 * GET /api/globe/commands to drain them (poll-based delivery, 19a transport).
 *
 *   pan_globe      -- fly the camera to a lat/lon/altitude
 *   focus_entity   -- point the camera at a known entity or coordinate
 *   toggle_layer   -- enable or disable a named plugin layer
 *   set_timeline   -- set playback time / window / mode
 *
 * Security: userId comes ONLY from ctx (the verified auth result). It is never
 * read from tool arguments. sessionId may come from args (scopes the tab) or is
 * resolved from the user's active ZSET entry.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { enqueueGlobeCommand, resolveActiveSessionId } from "@/lib/globeCommandQueue";
import { TIME_WINDOW_VALUES } from "@/core/globe/types/GlobeCommand";
import type { GlobeCommand } from "@/core/globe/types/GlobeCommand";
import { latSchema, lonSchema, altSchema } from "@/lib/mcp/coordinateSchemas";
import { layerIdSchema, entityIdSchema } from "@/lib/mcp/identifierSchemas";
import { SESSION_REQUIRED_PREAMBLE } from "@/lib/mcp/toolDescriptionFragments";
import { listStreamingPlugins } from "./discoveryHelpers";
import { getEntityDetails } from "@/lib/data-query/service";

// Re-export so existing tests that import from this module continue to work.
export { latSchema, lonSchema, altSchema, layerIdSchema };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type McpTextResult = { content: [{ type: "text"; text: string }] };

function textResult(text: string): McpTextResult {
    return { content: [{ type: "text", text }] };
}

const NO_SESSION_RESULT = textResult("no active globe session to control");

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

export function registerGlobeCommandTools(
    server: McpServer,
    ctx: { userId: string; pinnedSessionId?: string },
): void {
    const { userId, pinnedSessionId } = ctx;

    // TOOL-01: pan_globe
    server.registerTool(
        "pan_globe",
        {
            description:
                SESSION_REQUIRED_PREAMBLE +
                "Fly the globe camera to an explicit coordinate. Requires an active globe session: READ globe://sessions first. If no tab is open, returns \"no active globe session to control\". " +
                "Prefer pan_globe over focus_entity when you have a lat/lon and no entity id, or when focus_entity entity-id resolution is not needed. " +
                "Limitations: latitude [-90, 90], longitude [-180, 180], altitude > 0 metres; out-of-range values are rejected. " +
                "Parameters: lat (required), lon (required), alt in metres (required), heading (deg, optional), pitch (deg, optional), duration (seconds, optional), sessionId (optional, omit to target most-recently-active tab). " +
                "Example: pan_globe({lat:48.8566,lon:2.3522,alt:500000})",
            inputSchema: {
                lat: latSchema.describe("Latitude in decimal degrees [-90, 90]"),
                lon: lonSchema.describe("Longitude in decimal degrees [-180, 180]"),
                alt: altSchema.describe("Altitude in metres above the ellipsoid (must be > 0)"),
                heading: z.number().optional().describe("Camera heading in degrees (0 = north)"),
                pitch: z.number().optional().describe("Camera pitch in degrees (-90 = straight down)"),
                duration: z.number().optional().describe("Flight animation duration in seconds"),
                sessionId: z.string().optional().describe("Target globe session id. Obtain valid ids by reading the globe://sessions resource. Omit to target your most-recently-active browser tab."),
            },
        },
        async (args) => {
            try {
                const sessionId = await resolveSession(userId, args.sessionId, pinnedSessionId);
                if (sessionId === null) return NO_SESSION_RESULT;

                const cmd: GlobeCommand = {
                    type: "pan",
                    lat: args.lat,
                    lon: args.lon,
                    alt: args.alt,
                    ...(args.heading !== undefined && { heading: args.heading }),
                    ...(args.pitch !== undefined && { pitch: args.pitch }),
                    ...(args.duration !== undefined && { duration: args.duration }),
                };
                await enqueueGlobeCommand(userId, sessionId, cmd);
                return textResult(`Camera panning to lat=${args.lat}, lon=${args.lon}, alt=${args.alt}`);
            } catch (err) {
                console.error("[globeCommandTools] pan_globe failed:", err);
                return textResult("pan_globe command failed");
            }
        },
    );

    // TOOL-02: focus_entity
    server.registerTool(
        "focus_entity",
        {
            description:
                SESSION_REQUIRED_PREAMBLE +
                "Point the globe camera at a known entity or coordinate. Requires an active globe session: READ globe://sessions first. If no tab is open, returns \"no active globe session to control\". " +
                "Prefer focus_entity over pan_globe when you have an entity id and want to centre on it. " +
                "When lat/lon are provided they are used directly. " +
                "When only entityId is provided (no lat/lon), the server resolves coordinates via pluginId + entityId lookup -- include pluginId for a faster, scoped lookup. " +
                "Returns an error string when entityId cannot be resolved to coordinates. " +
                "Limitations: latitude [-90, 90], longitude [-180, 180]. " +
                "Parameters: entityId (optional), pluginId (optional, scopes entity lookup), lat (optional), lon (optional), sessionId (optional). " +
                "Example: focus_entity({entityId:\"ship-123\",pluginId:\"ais\",lat:35.68,lon:139.69})",
            inputSchema: {
                entityId: entityIdSchema.optional().describe("Entity id to focus on"),
                pluginId: z.string().optional().describe("Plugin that owns this entity -- narrows the id lookup when lat/lon are not provided"),
                lat: latSchema.optional().describe("Latitude to focus on [-90, 90]"),
                lon: lonSchema.optional().describe("Longitude to focus on [-180, 180]"),
                sessionId: z.string().optional().describe("Target globe session id. Obtain valid ids by reading the globe://sessions resource. Omit to target your most-recently-active browser tab."),
            },
        },
        async (args) => {
            try {
                const sessionId = await resolveSession(userId, args.sessionId, pinnedSessionId);
                if (sessionId === null) return NO_SESSION_RESULT;

                let resolvedLat = args.lat;
                let resolvedLon = args.lon;

                // When coordinates are absent but entityId is present, resolve server-side.
                if (resolvedLat === undefined && resolvedLon === undefined && args.entityId !== undefined) {
                    if (args.pluginId !== undefined) {
                        const detail = await getEntityDetails(args.pluginId, args.entityId);
                        if (detail.data !== null) {
                            resolvedLat = detail.data.latitude;
                            resolvedLon = detail.data.longitude;
                        }
                    }

                    if (resolvedLat === undefined) {
                        // entityId could not be resolved -- return an honest failure instead of
                        // enqueuing a command the browser cannot execute.
                        return textResult(
                            `Could not resolve entityId '${args.entityId}' to coordinates. ` +
                            `Provide pluginId to scope the lookup, or include lat/lon directly.`,
                        );
                    }
                }

                const cmd: GlobeCommand = {
                    type: "focusEntity",
                    ...(args.entityId !== undefined && { entityId: args.entityId }),
                    ...(resolvedLat !== undefined && { lat: resolvedLat }),
                    ...(resolvedLon !== undefined && { lon: resolvedLon }),
                };
                await enqueueGlobeCommand(userId, sessionId, cmd);
                return textResult(
                    `Focus entity command enqueued (entityId=${args.entityId ?? "none"}, lat=${resolvedLat ?? "none"}, lon=${resolvedLon ?? "none"})`,
                );
            } catch (err) {
                console.error("[globeCommandTools] focus_entity failed:", err);
                return textResult("focus_entity command failed");
            }
        },
    );

    // TOOL-03: toggle_layer
    server.registerTool(
        "toggle_layer",
        {
            description:
                SESSION_REQUIRED_PREAMBLE +
                "Enable or disable a plugin data layer on the globe. Requires an active globe session: READ globe://sessions first. If no tab is open, returns \"no active globe session to control\". " +
                "Prefer toggle_layer over pan_globe or set_timeline when changing layer visibility, not camera position or playback time. " +
                "Use list_available_plugins to confirm valid layerIds before calling. " +
                "Limitations: layerId must match an installed plugin id. When the id is not recognized a warning is included in the response. " +
                "Parameters: layerId (required), enabled (true/false, optional -- omit to toggle current state), sessionId (optional). " +
                "Example: toggle_layer({layerId:\"ais\",enabled:true})",
            inputSchema: {
                layerId: layerIdSchema.describe("The plugin/layer identifier to toggle"),
                enabled: z.boolean().optional().describe("True to enable, false to disable, omit to toggle"),
                sessionId: z.string().optional().describe("Target globe session id. Obtain valid ids by reading the globe://sessions resource. Omit to target your most-recently-active browser tab."),
            },
        },
        async (args) => {
            try {
                const sessionId = await resolveSession(userId, args.sessionId, pinnedSessionId);
                if (sessionId === null) return NO_SESSION_RESULT;

                // Check whether the layerId matches a known streaming plugin.
                const { plugins } = await listStreamingPlugins();
                const knownIds = new Set(plugins.map((p) => p.pluginId));
                const isKnown = knownIds.has(args.layerId);

                const cmd: GlobeCommand = {
                    type: "toggleLayer",
                    layerId: args.layerId,
                    ...(args.enabled !== undefined && { enabled: args.enabled }),
                };
                await enqueueGlobeCommand(userId, sessionId, cmd);

                if (!isKnown) {
                    return textResult(
                        `Command enqueued, but layerId '${args.layerId}' is not a recognized plugin. It may be ignored.`,
                    );
                }
                return textResult(`Layer '${args.layerId}' toggle command enqueued`);
            } catch (err) {
                console.error("[globeCommandTools] toggle_layer failed:", err);
                return textResult("toggle_layer command failed");
            }
        },
    );

    // TOOL-04: set_timeline
    server.registerTool(
        "set_timeline",
        {
            description:
                SESSION_REQUIRED_PREAMBLE +
                "Set the globe timeline position, time window, or playback mode. Requires an active globe session: READ globe://sessions first. If no tab is open, returns \"no active globe session to control\". " +
                "Prefer set_timeline over toggle_layer or pan_globe when adjusting time or playback, not layer visibility or camera position. " +
                "Limitations: currentTime must be ISO 8601; timeWindow must be one of '1h','6h','24h','48h','7d'. " +
                "Parameters: currentTime (ISO 8601, optional), timeWindow (optional), isPlaybackMode (boolean, optional), sessionId (optional). " +
                "Example: set_timeline({timeWindow:\"24h\",isPlaybackMode:true})",
            inputSchema: {
                currentTime: z.string().optional().describe("ISO 8601 datetime to seek to"),
                timeWindow: z.enum(TIME_WINDOW_VALUES).optional().describe("Time window: one of '1h', '6h', '24h', '48h', '7d'"),
                isPlaybackMode: z.boolean().optional().describe("True to start playback, false to pause"),
                sessionId: z.string().optional().describe("Target globe session id. Obtain valid ids by reading the globe://sessions resource. Omit to target your most-recently-active browser tab."),
            },
        },
        async (args) => {
            try {
                const sessionId = await resolveSession(userId, args.sessionId, pinnedSessionId);
                if (sessionId === null) return NO_SESSION_RESULT;

                const cmd: GlobeCommand = {
                    type: "setTimeline",
                    ...(args.currentTime !== undefined && { currentTime: args.currentTime }),
                    ...(args.timeWindow !== undefined && { timeWindow: args.timeWindow }),
                    ...(args.isPlaybackMode !== undefined && { isPlaybackMode: args.isPlaybackMode }),
                };
                await enqueueGlobeCommand(userId, sessionId, cmd);
                return textResult("Timeline command enqueued");
            } catch (err) {
                console.error("[globeCommandTools] set_timeline failed:", err);
                return textResult("set_timeline command failed");
            }
        },
    );
}
