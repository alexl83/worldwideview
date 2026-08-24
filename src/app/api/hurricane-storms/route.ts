import { NextResponse } from "next/server";

export const revalidate = 60;

const FEED_URL = "https://dataenginev2.worldwideview.dev/api/hurricane-storms";

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
                { error: "Failed to fetch hurricane-storms data" },
                { status: 502 },
            );
        }

        const data = await response.json();

        return NextResponse.json(data);
    } catch (error) {
        console.error("[HurricaneStormsRoute] Error:", error);
        return NextResponse.json(
            { error: "Failed to fetch hurricane-storms data" },
            { status: 502 },
        );
    }
}