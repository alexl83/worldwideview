import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/ba-session";
import { keyVerifyLimiter } from "@/lib/rateLimiters";
import { getClientIp } from "@/lib/rateLimit";

/** Minimum length sanity check before attempting verification. */
const MIN_KEY_LENGTH = 20;

async function verifyGoogleMaps(key: string): Promise<{ valid: boolean; error?: string }> {
    // Probe the API WWV actually uses for Google Photorealistic 3D Tiles.
    // Places Autocomplete (Legacy) cannot be enabled on new Google Cloud
    // projects and therefore rejects otherwise valid Map Tiles API keys.
    const url = `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if (res.ok) return { valid: true };

    const data = await res.json().catch(() => null) as {
        error?: { message?: string; status?: string };
    } | null;
    return {
        valid: false,
        error: data?.error?.message || data?.error?.status || `Map Tiles API returned HTTP ${res.status}`,
    };
}

async function verifyNasaFirms(key: string): Promise<{ valid: boolean; error?: string }> {
    // FIRMS returns 200 with "Invalid MAP_KEY." body on failure
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/VIIRS_SNPP_NRT/world/1`;
    const res = await fetch(url);
    const text = await res.text();
    if (text.trim().startsWith("Invalid MAP_KEY")) {
        return { valid: false, error: "Invalid MAP_KEY" };
    }
    return { valid: true };
}

export async function POST(request: Request) {
    const rateLimited = keyVerifyLimiter.check(getClientIp(request));
    if (rateLimited) return rateLimited;

    const session = await getServerSession();
    if (!session?.user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: { service?: string; key?: string };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { service, key } = body;
    if (!service || !key || typeof key !== "string") {
        return NextResponse.json({ error: "service and key are required" }, { status: 400 });
    }
    if (key.length < MIN_KEY_LENGTH) {
        return NextResponse.json({ valid: false, error: "Key is too short" });
    }

    try {
        switch (service) {
            case "google_maps":
                return NextResponse.json(await verifyGoogleMaps(key));
            case "nasa_firms":
                return NextResponse.json(await verifyNasaFirms(key));
            default:
                return NextResponse.json({ error: `Unknown service: ${service}` }, { status: 400 });
        }
    } catch (err) {
        console.error("[KeyVerify] Unexpected error:", err);
        return NextResponse.json({ error: "Verification request failed" }, { status: 500 });
    }
}

export const runtime = "nodejs";
