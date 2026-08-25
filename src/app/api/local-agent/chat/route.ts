import http from "node:http";
import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/ba-session";
import { readGlobeState } from "@/lib/globeStateStore";

export const runtime = "nodejs";
export const maxDuration = 600;

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOCKET_PATH = process.env.WWV_AGENT_FRONTEND_SOCKET ?? "/run/wwv-agent/chat.sock";

function callLocalAgent(payload: object): Promise<{ text?: string; error?: string }> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const request = http.request({
            socketPath: SOCKET_PATH,
            path: "/chat",
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                Authorization: `Bearer ${process.env.WWV_AGENT_SOCKET_TOKEN ?? ""}`,
            },
            timeout: 610_000,
        }, (response) => {
            let data = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { data += chunk; });
            response.on("end", () => {
                try {
                    const parsed = JSON.parse(data) as { text?: string; error?: string };
                    if ((response.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? "Agent error"));
                    else resolve(parsed);
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.on("timeout", () => request.destroy(new Error("Agent timeout")));
        request.on("error", reject);
        request.end(body);
    });
}
export async function POST(request: Request) {
    const session = await getServerSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!process.env.WWV_AGENT_SOCKET_TOKEN) {
        return NextResponse.json({ error: "Local agent is not configured" }, { status: 503 });
    }

    const body = await request.json().catch(() => null) as { prompt?: unknown; sessionId?: unknown } | null;
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    if (!prompt || prompt.length > 12_000 || !SESSION_ID_RE.test(sessionId)) {
        return NextResponse.json({ error: "Invalid prompt or session" }, { status: 400 });
    }

    const globeState = await readGlobeState(session.user.id, sessionId);
    if (!globeState) {
        return NextResponse.json({ error: "This globe tab is no longer active" }, { status: 409 });
    }

    try {
        const result = await callLocalAgent({ userId: session.user.id, sessionId, prompt });
        return NextResponse.json({ text: result.text ?? "" });
    } catch (error) {
        console.error("[local-agent] relay request failed", error instanceof Error ? error.message : "unknown");
        return NextResponse.json({ error: "Local agent unavailable" }, { status: 503 });
    }
}
