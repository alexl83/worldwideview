import { NextResponse } from "next/server";
import { prisma as db } from "@/lib/db";
import { getInstalledPlugins } from "@/lib/marketplace/repository";
import { isPluginInstallEnabled } from "@/core/edition";

export async function GET() {
    try {
        const cred = await db.marketplaceCredential.findUnique({
            where: { tenantId: "local" },
            select: { createdAt: true, updatedAt: true },
        });

        const plugins = await getInstalledPlugins();

        return NextResponse.json({
            connected: !!cred,
            connectedAt: cred?.createdAt.toISOString(),
            lastUpdated: cred?.updatedAt.toISOString(),
            encryptionMasterKeyConfigured: !!process.env.ENCRYPTION_MASTER_KEY,
            plugins,
            canManagePlugins: isPluginInstallEnabled,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[marketplace-status]", message);
        return NextResponse.json({
            error: "Failed to check connection status",
            encryptionMasterKeyConfigured: !!process.env.ENCRYPTION_MASTER_KEY,
        }, { status: 500 });
    }
}
