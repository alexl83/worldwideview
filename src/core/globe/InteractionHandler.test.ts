import { describe, expect, it } from "vitest";
import type { GeoEntity } from "@/core/plugins/PluginTypes";
import {
    extractWwvEntityFromPick,
    extractWwvEntityFromPicks,
    nearestEntityAtPosition,
} from "./InteractionHandler";

const aircraft = {
    id: "aviation-abc123",
    pluginId: "aviation",
    latitude: 45,
    longitude: 9,
    properties: {},
} as GeoEntity;

describe("extractWwvEntityFromPick", () => {
    it("reads billboard and point IDs", () => {
        expect(extractWwvEntityFromPick({ id: { _wwvEntity: aircraft } })).toBe(aircraft);
    });

    it("reads promoted glTF model IDs from the picked primitive", () => {
        expect(extractWwvEntityFromPick({
            primitive: { id: { _wwvEntity: aircraft } },
        })).toBe(aircraft);
    });

    it("returns null for unrelated Cesium picks", () => {
        expect(extractWwvEntityFromPick({ primitive: {} })).toBeNull();
    });

    it("skips masking primitives in drill-pick order", () => {
        expect(extractWwvEntityFromPicks([
            { primitive: { kind: "label" } },
            { id: { _wwvEntity: aircraft } },
        ])).toBe(aircraft);
    });

    it("returns null when no drill-pick result belongs to WWV", () => {
        expect(extractWwvEntityFromPicks([
            { primitive: {} },
            { id: { name: "unrelated" } },
        ])).toBeNull();
    });

    it("selects the nearest visible screen-space fallback", () => {
        const farther = { ...aircraft, id: "aviation-farther" };
        expect(nearestEntityAtPosition([
            { entity: farther, x: 114, y: 108, visible: true },
            { entity: aircraft, x: 103, y: 104, visible: true },
        ], { x: 100, y: 100 })).toBe(aircraft);
    });

    it("ignores hidden and out-of-radius fallback entities", () => {
        expect(nearestEntityAtPosition([
            { entity: aircraft, x: 101, y: 101, visible: false },
            { entity: aircraft, x: 200, y: 200, visible: true },
        ], { x: 100, y: 100 })).toBeNull();
    });
});
