import { describe, expect, it } from "vitest";
import type { GeoEntity } from "@/core/plugins/PluginTypes";
import { extractWwvEntityFromPick } from "./InteractionHandler";

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
});
