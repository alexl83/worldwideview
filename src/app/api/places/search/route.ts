import { NextResponse } from "next/server";
import { transliterate } from "@/lib/utils/transliterate";

// Server-side cache: keyed by normalised input, 1-hour TTL
const cache = new Map<string, { data: unknown; expiresAt: number }>();
const TTL_MS = 60 * 60 * 1000; // 1 hour

interface PlaceAutocompleteSuggestion {
    placePrediction?: {
        placeId?: string;
        text?: { text?: string };
        structuredFormat?: {
            mainText?: { text?: string };
            secondaryText?: { text?: string };
        };
        types?: string[];
    };
}

interface PlaceAutocompleteResponse {
    suggestions?: PlaceAutocompleteSuggestion[];
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const input = searchParams.get("input");

    if (!input || typeof input !== "string") {
        return NextResponse.json({ error: "Input is required" }, { status: 400 });
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
    const cacheKey = `${cachePrefix}${input.toLowerCase().trim()}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
        return NextResponse.json(cached.data);
    }

    try {
        // Places API (New). The legacy GET endpoint cannot be enabled on new
        // Google Cloud projects.
        const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": apiKey,
            },
            body: JSON.stringify({ input }),
        });
        const data = await response.json() as PlaceAutocompleteResponse;

        if (!response.ok) {
            console.error("Google Places API Error:", data);
            return NextResponse.json({ error: "Failed to fetch predictions" }, { status: 500 });
        }

        const predictions = (data.suggestions ?? []).flatMap((suggestion) => {
            const p = suggestion.placePrediction;
            if (!p?.placeId) return [];
            return [{
                description: transliterate(p.text?.text ?? ""),
                placeId: p.placeId,
                mainText: transliterate(p.structuredFormat?.mainText?.text || p.text?.text || ""),
                secondaryText: transliterate(p.structuredFormat?.secondaryText?.text || ""),
                types: p.types || [],
            }];
        });

        const result = { predictions };
        cache.set(cacheKey, { data: result, expiresAt: Date.now() + TTL_MS });
        return NextResponse.json(result);
    } catch (error) {
        console.error("Error in Places Autocomplete route:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
