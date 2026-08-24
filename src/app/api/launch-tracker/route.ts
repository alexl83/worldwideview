import { NextResponse } from "next/server";

export const revalidate = 60;

// Server-side engine base: env-overridable, default the production engine.
// Mirrors resolveEngineUrl.ts + hostGlobals.ts env-chain pattern (lint-url allow).
const ENGINE_BASE = (
    process.env.WWV_DATA_ENGINE_URL ||
    process.env.NEXT_PUBLIC_WWV_PLUGIN_DATA_ENGINE_URL ||
    "https://dataenginev2.worldwideview.dev" // lint-url: allow (default fallback, env-overridable)
).replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");

const FEED_URL = `${ENGINE_BASE.replace(/\/$/, "")}/api/launch-tracker`;

export async function GET() {
    try {
        const response = await fetch(FEED_URL, {
            headers: {
                Accept: "application/json",
                "User-Agent": "WorldWideView/1.0",
            },
            next: { revalidate },
        });

        if (!response.ok) {
            return NextResponse.json(
                { error: "Failed to fetch launch-tracker data" },
                { status: 502 },
            );
        }

        const data = await response.json();

        return NextResponse.json(data);
    } catch (error) {
        console.error("[LaunchTrackerRoute] Error:", error);
        return NextResponse.json(
            { error: "Failed to fetch launch-tracker data" },
            { status: 502 },
        );
    }
}