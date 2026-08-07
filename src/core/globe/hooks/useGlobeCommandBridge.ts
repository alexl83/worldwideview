import { useEffect } from "react";
import { dataBus } from "@/core/data/DataBus";
import { useStore } from "@/core/state/store";
import { isValidGlobeCommand } from "@/core/globe/types/GlobeCommand";
import type { GlobeCommand } from "@/core/globe/types/GlobeCommand";
import { setLayerActive } from "@/core/plugins/layerActivation";
import { isDemo } from "@/core/edition";

function dispatchCommand(cmd: GlobeCommand): void {
    switch (cmd.type) {
        case "pan":
            dataBus.emit("cameraGoTo", {
                lat: cmd.lat,
                lon: cmd.lon,
                alt: cmd.alt,
                // cameraGoTo exposes maxPitch (a clamp), not a target pitch angle,
                // so cmd.pitch is intentionally not forwarded here.
                ...(cmd.heading !== undefined ? { heading: cmd.heading } : {}),
            });
            break;

        case "flyTo":
            if (cmd.bbox) {
                const [west, south, east, north] = cmd.bbox;
                dataBus.emit("cameraFlyToBbox", { west, south, east, north });
            } else {
                dataBus.emit("cameraGoTo", {
                    lat: cmd.lat,
                    lon: cmd.lng, // flyTo uses "lng"; cameraGoTo expects "lon" -- explicit mapping per D-03
                    alt: cmd.alt ?? 15_000,
                });
            }
            break;


        case "focusEntity":
            if (cmd.lat !== undefined && cmd.lon !== undefined) {
                dataBus.emit("cameraGoTo", {
                    lat: cmd.lat,
                    lon: cmd.lon,
                    alt: 0,
                });
            } else if (cmd.entityId !== undefined) {
                // Entity-id-only resolution is not yet wired to the entity registry.
                // Provide lat/lon alongside entityId to trigger a camera move.
                console.warn(
                    "[useGlobeCommandBridge] focusEntity by id not yet supported; provide lat/lon",
                    cmd.entityId,
                );
            }
            break;

        case "toggleLayer": {
            if (cmd.enabled !== undefined) {
                setLayerActive(cmd.layerId, cmd.enabled);
            } else {
                const current = useStore.getState().layers[cmd.layerId]?.enabled ?? false;
                setLayerActive(cmd.layerId, !current);
            }
            break;
        }

        case "setTimeline": {
            const state = useStore.getState();
            if (cmd.timeWindow !== undefined) {
                // cmd.timeWindow is narrowed to TimeWindowLiteral by isValidGlobeCommand.
                state.setTimeWindow(cmd.timeWindow);
            }
            if (cmd.isPlaybackMode !== undefined) {
                state.setPlaybackMode(cmd.isPlaybackMode);
            }
            if (cmd.currentTime !== undefined) {
                const d = new Date(cmd.currentTime);
                if (!Number.isNaN(d.getTime())) {
                    state.setCurrentTime(d);
                }
            }
            break;
        }

        case "setFilter": {
            const state = useStore.getState();
            for (const [filterId, value] of Object.entries(cmd.filters)) {
                state.setFilter(cmd.pluginId, filterId, value);
            }
            break;
        }

        case "clearFilter": {
            const state = useStore.getState();
            if (cmd.pluginId !== undefined) {
                state.clearFilters(cmd.pluginId);
            } else {
                state.clearAllFilters();
            }
            break;
        }
    }
}

export function useGlobeCommandBridge(sessionId: string): void {
    useEffect(() => {
        if (!sessionId || isDemo) return;

        let disposed = false;
        let source: EventSource | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let reconnectAttempt = 0;

        const connect = (): void => {
            if (disposed) return;
            const es = new EventSource(
                `/api/globe/commands/stream?sessionId=${encodeURIComponent(sessionId)}`,
            );
            source = es;

            es.onopen = () => {
                reconnectAttempt = 0;
            };

            es.onmessage = (event: MessageEvent) => {
                try {
                    const parsed: unknown = JSON.parse(event.data as string);
                    if (
                        parsed !== null &&
                        typeof parsed === "object" &&
                        "commands" in parsed &&
                        Array.isArray((parsed as { commands: unknown }).commands)
                    ) {
                        (parsed as { commands: unknown[] }).commands
                            .filter(isValidGlobeCommand)
                            .forEach(dispatchCommand);
                    }
                } catch (err) {
                    console.error("[useGlobeCommandBridge] Failed to parse SSE message:", err);
                }
            };

            es.onerror = () => {
                // Native EventSource reconnects while CONNECTING. A reverse-proxy
                // or application-container restart can instead leave it CLOSED,
                // which is terminal unless the application creates a new instance.
                if (disposed || es.readyState !== EventSource.CLOSED) return;
                es.close();
                if (source === es) source = null;
                const delay = Math.min(1_000 * 2 ** reconnectAttempt, 30_000);
                reconnectAttempt += 1;
                console.error(
                    `[useGlobeCommandBridge] SSE stream closed; reconnecting in ${delay}ms`,
                );
                reconnectTimer = setTimeout(connect, delay);
            };
        };

        connect();

        return () => {
            disposed = true;
            if (reconnectTimer !== null) clearTimeout(reconnectTimer);
            source?.close();
        };
    }, [sessionId]);
}
