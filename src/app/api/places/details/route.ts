import { NextResponse } from "next/server";
import { transliterate } from "@/lib/utils/transliterate";

// Server-side cache: keyed by place_id, 24-hour TTL (place geometry is stable)
const cache = new Map<string, { data: unknown; expiresAt: number }>();
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface PlaceDetailsResponse {
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    viewport?: {
        high?: { latitude?: number; longitude?: number };
        low?: { latitude?: number; longitude?: number };
    };
    types?: string[];
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const placeId = searchParams.get("place_id");

    if (!placeId || typeof placeId !== "string") {
        return NextResponse.json({ error: "place_id is required" }, { status: 400 });
    }

    // Use user-provided key if present in header AND looks valid, otherwise fall back to .env
    const userKey = request.headers.get("X-User-Google-Key");
    const isValidUserKey = typeof userKey === "string" && userKey.length >= 20;
    const apiKey = isValidUserKey ? userKey : (process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY);
    if (!apiKey) {
        console.error("GOOGLE_MAPS_API_KEY is not defined and no user key provided");
        return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
    }

    // Separate cache entries for user-provided keys vs default
    const cachePrefix = isValidUserKey && userKey ? `user:${userKey.slice(0, 8)}:` : "";
    const cacheId = `${cachePrefix}${placeId}`;
    const cached = cache.get(cacheId);
    if (cached && Date.now() < cached.expiresAt) {
        return NextResponse.json(cached.data);
    }

    try {
        const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
        const response = await fetch(url, {
            headers: {
                "X-Goog-Api-Key": apiKey,
                "X-Goog-FieldMask": "id,displayName,formattedAddress,location,viewport,types",
            },
        });
        const data = await response.json() as PlaceDetailsResponse;

        if (!response.ok) {
            console.error("Google Places Details API Error:", data);
            return NextResponse.json({ error: "Failed to fetch place details" }, { status: 500 });
        }

        const location = data.location;
        if (location?.latitude === undefined || location.longitude === undefined) {
            return NextResponse.json({ error: "No geometry found for place" }, { status: 404 });
        }

        const viewport = data.viewport?.high?.latitude !== undefined
            && data.viewport.high.longitude !== undefined
            && data.viewport.low?.latitude !== undefined
            && data.viewport.low.longitude !== undefined ? {
            northeast: { lat: data.viewport.high.latitude, lng: data.viewport.high.longitude },
            southwest: { lat: data.viewport.low.latitude, lng: data.viewport.low.longitude },
        } : null;
        const result = {
            lat: location.latitude,
            lon: location.longitude,
            name: transliterate(data.displayName?.text ?? data.formattedAddress ?? ""),
            types: data.types || [],
            viewport,
        };
        cache.set(cacheId, { data: result, expiresAt: Date.now() + TTL_MS });
        return NextResponse.json(result);
    } catch (error) {
        console.error("Error in Places Details route:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
