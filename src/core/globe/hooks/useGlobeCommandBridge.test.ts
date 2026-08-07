/**
 * Contract tests for useGlobeCommandBridge (Phase 19b Wave 0).
 *
 * BRIDGE-01 through BRIDGE-07 are INTENTIONALLY RED in Wave 0 because the hook
 * still uses setInterval + pollOnce. Wave 1 rewrites the hook to use EventSource.
 *
 *   BRIDGE-01  Hook opens EventSource to /api/globe/commands/stream?sessionId=... on mount
 *   BRIDGE-02  pan command dispatched via onmessage -> dataBus.emit("cameraGoTo", ...)
 *   BRIDGE-03  toggleLayer command dispatched via onmessage -> Zustand setLayerEnabled
 *   BRIDGE-03a toggleLayer {enabled:true} -> pluginManager.enablePlugin called
 *   BRIDGE-03b toggleLayer {enabled:false} -> pluginManager.disablePlugin called
 *   BRIDGE-04  Unknown command type via onmessage -> nothing dispatched
 *   BRIDGE-05  Empty sessionId -> EventSource never created
 *   BRIDGE-06  Unmount -> EventSource.close() called
 *   BRIDGE-07  onerror firing -> no throw
 *   BRIDGE-08  terminal CLOSED state -> explicit backoff reconnect
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGlobeCommandBridge } from "./useGlobeCommandBridge";

// ---------------------------------------------------------------------------
// Mock DataBus
// ---------------------------------------------------------------------------

const { mockEmit } = vi.hoisted(() => ({
    mockEmit: vi.fn(),
}));

vi.mock("@/core/data/DataBus", () => ({
    dataBus: {
        emit: mockEmit,
    },
}));

// ---------------------------------------------------------------------------
// Mock PluginManager
// ---------------------------------------------------------------------------

const { mockEnablePlugin, mockDisablePlugin } = vi.hoisted(() => ({
    mockEnablePlugin: vi.fn(() => Promise.resolve()),
    mockDisablePlugin: vi.fn(),
}));

vi.mock("@/core/plugins/PluginManager", () => ({
    pluginManager: {
        enablePlugin: mockEnablePlugin,
        disablePlugin: mockDisablePlugin,
    },
}));

// ---------------------------------------------------------------------------
// Mock Zustand store
// ---------------------------------------------------------------------------

const {
    mockSetLayerEnabled,
    mockToggleLayer,
    mockSetTimeWindow,
    mockSetPlaybackMode,
    mockSetCurrentTime,
    mockClearEntities,
    mockSetEntityCount,
    mockSetHoveredEntity,
    mockSetSelectedEntity,
} = vi.hoisted(() => ({
    mockSetLayerEnabled: vi.fn(),
    mockToggleLayer: vi.fn(),
    mockSetTimeWindow: vi.fn(),
    mockSetPlaybackMode: vi.fn(),
    mockSetCurrentTime: vi.fn(),
    mockClearEntities: vi.fn(),
    mockSetEntityCount: vi.fn(),
    mockSetHoveredEntity: vi.fn(),
    mockSetSelectedEntity: vi.fn(),
}));

vi.mock("@/core/state/store", () => ({
    useStore: {
        getState: vi.fn(() => ({
            setLayerEnabled: mockSetLayerEnabled,
            toggleLayer: mockToggleLayer,
            setTimeWindow: mockSetTimeWindow,
            setPlaybackMode: mockSetPlaybackMode,
            setCurrentTime: mockSetCurrentTime,
            clearEntities: mockClearEntities,
            setEntityCount: mockSetEntityCount,
            setHoveredEntity: mockSetHoveredEntity,
            setSelectedEntity: mockSetSelectedEntity,
            layers: {},
            hoveredEntity: null,
            selectedEntity: null,
        })),
        subscribe: vi.fn(() => () => undefined),
    },
}));

import { useStore } from "@/core/state/store";

const mockedUseStore = useStore as unknown as {
    getState: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
};

// ---------------------------------------------------------------------------
// MockEventSource
// ---------------------------------------------------------------------------

let mockEs: MockEventSource;
let mockEventSources: MockEventSource[];

class MockEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    url: string;
    readyState = MockEventSource.OPEN;
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    close = vi.fn();

    constructor(url: string) {
        this.url = url;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        mockEs = this;
        mockEventSources.push(this);
    }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.resetAllMocks();
    mockEventSources = [];

    // Install MockEventSource as the global before each test
    global.EventSource = MockEventSource as unknown as typeof EventSource;

    // Restore getState return value after vi.resetAllMocks() wipes call history
    mockedUseStore.getState.mockReturnValue({
        setLayerEnabled: mockSetLayerEnabled,
        toggleLayer: mockToggleLayer,
        setTimeWindow: mockSetTimeWindow,
        setPlaybackMode: mockSetPlaybackMode,
        setCurrentTime: mockSetCurrentTime,
        clearEntities: mockClearEntities,
        setEntityCount: mockSetEntityCount,
        setHoveredEntity: mockSetHoveredEntity,
        setSelectedEntity: mockSetSelectedEntity,
        layers: {},
        hoveredEntity: null,
        selectedEntity: null,
    });
});

// ---------------------------------------------------------------------------
// BRIDGE-01: EventSource connection on mount
// ---------------------------------------------------------------------------

describe("useGlobeCommandBridge EventSource connection (BRIDGE-01)", () => {
    it("opens an EventSource to /api/globe/commands/stream?sessionId=... on mount", () => {
        // Track construction via the mockEs reference populated by MockEventSource constructor
        renderHook(() => useGlobeCommandBridge("sess-1"));

        // mockEs is set by the MockEventSource constructor -- if hook never calls new EventSource,
        // mockEs will be undefined and these assertions fail (correct RED state).
        expect(mockEs).toBeDefined();
        expect(mockEs.url).toContain("/api/globe/commands/stream");
        expect(mockEs.url).toContain("sessionId=sess-1");
    });
});

// ---------------------------------------------------------------------------
// BRIDGE-02: pan command via onmessage -> cameraGoTo
// ---------------------------------------------------------------------------

describe("useGlobeCommandBridge pan dispatch (BRIDGE-02)", () => {
    it("emits cameraGoTo when a pan command arrives via onmessage", () => {
        renderHook(() => useGlobeCommandBridge("sess-1"));

        act(() => {
            mockEs.onmessage?.(
                new MessageEvent("message", {
                    data: JSON.stringify({
                        commands: [{ type: "pan", lat: 1, lon: 2, alt: 3 }],
                    }),
                }),
            );
        });

        expect(mockEmit).toHaveBeenCalledWith(
            "cameraGoTo",
            expect.objectContaining({ lat: 1, lon: 2, alt: 3 }),
        );
    });
});

// ---------------------------------------------------------------------------
// BRIDGE-03: toggleLayer command via onmessage -> Zustand action
// ---------------------------------------------------------------------------

describe("useGlobeCommandBridge toggleLayer dispatch (BRIDGE-03)", () => {
    it("calls toggleLayer when a toggleLayer command arrives via onmessage", () => {
        renderHook(() => useGlobeCommandBridge("sess-1"));

        act(() => {
            mockEs.onmessage?.(
                new MessageEvent("message", {
                    data: JSON.stringify({
                        commands: [{ type: "toggleLayer", layerId: "ais" }],
                    }),
                }),
            );
        });

        const anyLayerAction =
            mockSetLayerEnabled.mock.calls.length > 0 ||
            mockToggleLayer.mock.calls.length > 0;
        expect(anyLayerAction).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// BRIDGE-03a: toggleLayer {enabled:true} -> pluginManager.enablePlugin
// ---------------------------------------------------------------------------

describe("useGlobeCommandBridge toggleLayer enable (BRIDGE-03a)", () => {
    it("calls pluginManager.enablePlugin when toggleLayer {enabled:true} arrives", () => {
        renderHook(() => useGlobeCommandBridge("sess-1"));

        act(() => {
            mockEs.onmessage?.(
                new MessageEvent("message", {
                    data: JSON.stringify({
                        commands: [{ type: "toggleLayer", layerId: "camera", enabled: true }],
                    }),
                }),
            );
        });

        expect(mockEnablePlugin).toHaveBeenCalledWith("camera");
        expect(mockSetLayerEnabled).toHaveBeenCalledWith("camera", true);
    });
});

// ---------------------------------------------------------------------------
// BRIDGE-03b: toggleLayer {enabled:false} -> pluginManager.disablePlugin
// ---------------------------------------------------------------------------

describe("useGlobeCommandBridge toggleLayer disable (BRIDGE-03b)", () => {
    it("calls pluginManager.disablePlugin when toggleLayer {enabled:false} arrives", () => {
        renderHook(() => useGlobeCommandBridge("sess-1"));

        act(() => {
            mockEs.onmessage?.(
                new MessageEvent("message", {
                    data: JSON.stringify({
                        commands: [{ type: "toggleLayer", layerId: "camera", enabled: false }],
                    }),
                }),
            );
        });

        expect(mockDisablePlugin).toHaveBeenCalledWith("camera");
        expect(mockSetLayerEnabled).toHaveBeenCalledWith("camera", false);
        expect(mockClearEntities).toHaveBeenCalledWith("camera");
        expect(mockSetEntityCount).toHaveBeenCalledWith("camera", 0);
    });
});

// ---------------------------------------------------------------------------
// BRIDGE-04: unknown command type -> nothing dispatched
// ---------------------------------------------------------------------------

describe("useGlobeCommandBridge invalid command filtering (BRIDGE-04)", () => {
    it("does not dispatch anything for an unknown command type arriving via onmessage", () => {
        renderHook(() => useGlobeCommandBridge("sess-1"));

        act(() => {
            mockEs.onmessage?.(
                new MessageEvent("message", {
                    data: JSON.stringify({
                        commands: [{ type: "invalidCommand", foo: "bar" }],
                    }),
                }),
            );
        });

        expect(mockEmit).not.toHaveBeenCalled();
        expect(mockSetLayerEnabled).not.toHaveBeenCalled();
        expect(mockToggleLayer).not.toHaveBeenCalled();
        expect(mockSetTimeWindow).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// BRIDGE-05: empty sessionId -> EventSource never created
// ---------------------------------------------------------------------------

describe("useGlobeCommandBridge empty sessionId no-op (BRIDGE-05)", () => {
    it("never creates an EventSource when sessionId is empty string", () => {
        // Reset mockEs -- if hook creates an EventSource, MockEventSource constructor sets it
        (mockEs as MockEventSource | undefined) = undefined as unknown as MockEventSource;

        renderHook(() => useGlobeCommandBridge(""));

        // If EventSource was constructed, mockEs would be set
        expect(mockEs as MockEventSource | undefined).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// BRIDGE-06: unmount -> EventSource.close() called
// ---------------------------------------------------------------------------

describe("useGlobeCommandBridge unmount cleanup (BRIDGE-06)", () => {
    it("calls EventSource.close() on unmount", () => {
        const { unmount } = renderHook(() => useGlobeCommandBridge("sess-1"));

        unmount();

        expect(mockEs.close).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// BRIDGE-07: onerror fires -> no throw
// ---------------------------------------------------------------------------

describe("useGlobeCommandBridge onerror resilience (BRIDGE-07)", () => {
    it("does not throw when onerror fires", () => {
        renderHook(() => useGlobeCommandBridge("sess-1"));

        act(() => {
            mockEs.onerror?.(new Event("error"));
        });

        // Reaching here without an unhandled exception is the assertion
    });
});

// ---------------------------------------------------------------------------
// BRIDGE-08: terminal close -> explicit reconnect
// ---------------------------------------------------------------------------

describe("useGlobeCommandBridge terminal reconnect (BRIDGE-08)", () => {
    it("creates a fresh EventSource after a terminal CLOSED error", () => {
        vi.useFakeTimers();
        const { unmount } = renderHook(() => useGlobeCommandBridge("sess-1"));
        const first = mockEs;
        first.readyState = MockEventSource.CLOSED;

        act(() => {
            first.onerror?.(new Event("error"));
            vi.advanceTimersByTime(1_000);
        });

        expect(first.close).toHaveBeenCalledTimes(1);
        expect(mockEventSources).toHaveLength(2);
        expect(mockEs).not.toBe(first);
        expect(mockEs.url).toContain("sessionId=sess-1");
        unmount();
        vi.useRealTimers();
    });

    it("cancels a pending reconnect when the hook unmounts", () => {
        vi.useFakeTimers();
        const { unmount } = renderHook(() => useGlobeCommandBridge("sess-1"));
        mockEs.readyState = MockEventSource.CLOSED;
        act(() => mockEs.onerror?.(new Event("error")));

        unmount();
        act(() => vi.advanceTimersByTime(30_000));

        expect(mockEventSources).toHaveLength(1);
        vi.useRealTimers();
    });
});
