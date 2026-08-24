import { NextResponse } from "next/server";
import { getEngineUrl } from "@/lib/data-query/service";

export const revalidate = 60;

const FEED_URL = `${getEngineUrl()}/api/live-disasters`;

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
                { error: "Failed to fetch live-disasters data" },
                { status: 502 },
            );
        }

        const data = await response.json();

        return NextResponse.json(data);
    } catch (error) {
        console.error("[LiveDisastersRoute] Error:", error);
        return NextResponse.json(
            { error: "Failed to fetch live-disasters data" },
            { status: 502 },
        );
    }
}