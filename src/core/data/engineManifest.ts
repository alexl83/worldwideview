// src/core/data/engineManifest.ts
// Fetches /manifest from a local data engine to discover available seeders.
// Used by resolveEngineUrl for per-plugin local vs cloud routing.

let localManifest: string[] | null = null;
let manifestFetched = false;
const MANIFEST_TIMEOUT_MS = 3_000;

/**
 * Resolve the base URL of the local data engine.
 *
 * Always checks localhost:5000 — the port docker-compose.yml binds for
 * wwv-data-engine. NEXT_PUBLIC_WWV_PLUGIN_DATA_ENGINE_URL is intentionally
 * NOT used here: that variable belongs to each plugin's own declared engine
 * URL (production, third-party, etc.) and must not poison local detection.
 * Mixing the two caused the production engine to be reported as "local".
 */
function getLocalEngineBase() {
    const port = process.env.NEXT_PUBLIC_WWV_LOCAL_ENGINE_PORT || '5000';
    if (typeof window === "undefined") return `http://localhost:${port}`;
    return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

/**
 * Fetch the list of available seeders from a local engine.
 * Returns null if no local engine is detected. Failed probes are not cached so
 * a temporarily slow or still-starting engine can be detected on the next
 * plugin activation.
 *
 * The engine guarantees manifest IDs are already in kebab-case (the seeder's
 * exported `name` field is the canonical plugin ID). No client-side translation
 * is needed — what the engine reports is what the frontend uses.
 */
export async function fetchLocalEngineManifest(): Promise<string[] | null> {
  if (manifestFetched) return localManifest;
  manifestFetched = true;

  try {
    const controller = new AbortController();
    // The browser may reach the engine over a LAN hostname rather than the
    // loopback interface. Allow for DNS, Wi-Fi and a cold container.
    const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);

    const res = await fetch(`${getLocalEngineBase()}/manifest`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      manifestFetched = false;
      return null;
    }

    const data = await res.json();
    localManifest = data.plugins || [];
    console.log(
      `[EngineManifest] Local engine detected: ${localManifest!.length} seeders`,
      localManifest
    );
    return localManifest;
  } catch {
    console.log("[EngineManifest] No local engine detected, using cloud.");
    // Do not permanently cache a transient timeout or startup failure.
    manifestFetched = false;
    return null;
  }
}

/** Check if the local engine has a seeder for a given plugin ID. */
export function localEngineHasPlugin(pluginId: string): boolean {
  if (!localManifest) return false;
  return localManifest.includes(pluginId);
}

/**
 * Check if a plugin is blocklisted from using the local engine.
 *
 * Reads NEXT_PUBLIC_WWV_LOCAL_ENGINE_BLOCKLIST — a comma-separated list of
 * plugin IDs that should always use the cloud engine instead. This lets
 * operators bypass seeders that are registered but non-functional (e.g.,
 * missing API keys) without code changes.
 */
export function isPluginBlocklisted(pluginId: string): boolean {
  const blocklist = process.env.NEXT_PUBLIC_WWV_LOCAL_ENGINE_BLOCKLIST || "";
  if (!blocklist) return false;
  return blocklist.split(",").map((s) => s.trim()).includes(pluginId);
}

/** Reset the cache (for testing or reconnection). */
export function resetManifestCache(): void {
  localManifest = null;
  manifestFetched = false;
}
