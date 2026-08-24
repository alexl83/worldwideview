import { NextResponse } from "next/server";
import { getEngineUrl } from "@/lib/data-query/service";

export const revalidate = 60;

const FEED_URL = `${getEngineUrl()}/api/launch-tracker`;

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