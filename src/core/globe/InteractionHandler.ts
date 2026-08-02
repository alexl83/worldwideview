import {
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    defined,
    SceneMode,
    SceneTransforms,
} from "cesium";
import type { Viewer as CesiumViewer, Cartesian2 } from "cesium";
import type { GeoEntity } from "@/core/plugins/PluginTypes";
import { useStore } from "@/core/state/store";
import type { AnimatableItem } from "./EntityRenderer";
import {
    findStackByEntityId, expandStack, collapseStack, getStacks
} from "./StackManager";

/**
 * Pick a WorldWideView entity at a screen position using the Cesium pick API.
 */
export function extractWwvEntityFromPick(picked: unknown): GeoEntity | null {
    if (!picked || typeof picked !== "object") return null;
    const result = picked as {
        id?: { _wwvEntity?: GeoEntity };
        primitive?: { id?: { _wwvEntity?: GeoEntity }; _wwvEntity?: GeoEntity };
    };
    return result.id?._wwvEntity
        ?? result.primitive?.id?._wwvEntity
        ?? result.primitive?._wwvEntity
        ?? null;
}

/**
 * Return the first WWV entity from Cesium's front-to-back drill-pick results.
 * Terrain, labels and model primitives may otherwise mask the clickable entity.
 */
export function extractWwvEntityFromPicks(picks: unknown[]): GeoEntity | null {
    for (const picked of picks) {
        const entity = extractWwvEntityFromPick(picked);
        if (entity) return entity;
    }
    return null;
}

export interface ScreenEntityCandidate {
    entity: GeoEntity;
    x: number;
    y: number;
    visible: boolean;
}

/** Return the closest visible entity inside the supplied screen-space radius. */
export function nearestEntityAtPosition(
    candidates: ScreenEntityCandidate[],
    position: { x: number; y: number },
    radius = 20
): GeoEntity | null {
    let nearest: GeoEntity | null = null;
    let nearestSquared = radius * radius;
    for (const candidate of candidates) {
        if (!candidate.visible) continue;
        const dx = candidate.x - position.x;
        const dy = candidate.y - position.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared <= nearestSquared) {
            nearest = candidate.entity;
            nearestSquared = distanceSquared;
        }
    }
    return nearest;
}

function findEntityByScreenDistance(
    viewer: CesiumViewer,
    position: { x: number; y: number },
    animatables: Map<string, AnimatableItem>
): GeoEntity | null {
    const candidates: ScreenEntityCandidate[] = [];
    const stackedIds = new Set<string>();

    for (const stack of getStacks().values()) {
        for (const item of stack.children) stackedIds.add(item.entity.id);

        if (stack.state === "collapsed" || stack.state === "collapsing") {
            const screen = SceneTransforms.worldToWindowCoordinates(viewer.scene, stack.hubItem.posRef);
            if (screen) {
                candidates.push({
                    entity: stack.hubItem.entity,
                    x: screen.x,
                    y: screen.y,
                    visible: !stack.hubItem._occluded,
                });
            }
            continue;
        }

        for (const item of stack.children) {
            const screen = SceneTransforms.worldToWindowCoordinates(viewer.scene, item.posRef);
            if (!screen) continue;
            const offset = item.primitive?.pixelOffset;
            candidates.push({
                entity: item.entity,
                x: screen.x + (offset?.x ?? 0),
                y: screen.y + (offset?.y ?? 0),
                visible: !item._occluded && item.primitive?.show !== false,
            });
        }
    }

    for (const item of animatables.values()) {
        if (stackedIds.has(item.entity.id)) continue;
        const screen = SceneTransforms.worldToWindowCoordinates(viewer.scene, item.posRef);
        if (!screen) continue;
        const offset = item.primitive?.pixelOffset;
        candidates.push({
            entity: item.entity,
            x: screen.x + (offset?.x ?? 0),
            y: screen.y + (offset?.y ?? 0),
            visible: !item._occluded && item.primitive?.show !== false,
        });
    }

    return nearestEntityAtPosition(candidates, position);
}

function findEntityAtPosition(
    viewer: CesiumViewer,
    position: { x: number; y: number },
    animatables?: Map<string, AnimatableItem>
): GeoEntity | null {
    if (!viewer || viewer.isDestroyed()) return null;
    const picks = viewer.scene.drillPick(position as Cartesian2, 16);
    const entity = extractWwvEntityFromPicks(picks);
    if (entity) return entity;

    // Keep the single-pick fallback for custom Scene implementations that do not
    // expose the same objects through drillPick.
    const picked = viewer.scene.pick(position as Cartesian2);
    const pickedEntity = defined(picked) ? extractWwvEntityFromPick(picked) : null;
    if (pickedEntity) return pickedEntity;

    return animatables ? findEntityByScreenDistance(viewer, position, animatables) : null;
}

/**
 * Sets up click and hover handlers on the viewer canvas.
 * Returns a cleanup function that destroys the handler and resets the cursor.
 */
export function setupInteractionHandlers(
    viewer: CesiumViewer,
    hoveredEntityIdRef: React.MutableRefObject<string | null>,
    animatablesMapRef: React.MutableRefObject<Map<string, AnimatableItem>>
): () => void {
    if (!viewer || viewer.isDestroyed() || !viewer.scene) {
        return () => { };
    }
    const {canvas} = viewer.scene;
    const handler = new ScreenSpaceEventHandler(canvas);

    /** Currently expanded stack id (only one at a time). */
    let expandedStackId: string | null = null;

    // Click → select entity or expand stack
    handler.setInputAction(
        (event: { position: { x: number; y: number } }) => {
            if (!viewer || viewer.isDestroyed()) return;
            const entity = findEntityAtPosition(viewer, event.position, animatablesMapRef.current);

            if (entity) {
                const stack = findStackByEntityId(entity.id);
                // If clicked entity is in a stack
                if (stack && stack.children.length > 1) {
                    if (stack.state === "collapsed" || stack.state === "collapsing") {
                        // Expand the stack and select the hub
                        expandStack(stack.id);
                        if (expandedStackId && expandedStackId !== stack.id) {
                            collapseStack(expandedStackId);
                        }
                        expandedStackId = stack.id;
                        useStore.getState().setSelectedEntity(entity);
                    } else {
                        // Stack is already expanded, user clicked a leaf node -> select it
                        useStore.getState().setSelectedEntity(entity);
                    }
                } else {
                    // Clicked a standalone entity -> select it and close any open stack
                    useStore.getState().setSelectedEntity(entity);
                    if (expandedStackId) {
                        collapseStack(expandedStackId);
                        expandedStackId = null;
                    }
                }
            } else {
                // Clicked empty space -> clear selection and close any open stack
                useStore.getState().setSelectedEntity(null);
                if (expandedStackId) {
                    collapseStack(expandedStackId);
                    expandedStackId = null;
                }
            }

            if (entity) {
                useStore.getState().setHoveredEntity(null, null);
                hoveredEntityIdRef.current = null;
            }

            // Immediately request a render frame to apply highlight changes
            // or to kickstart the CSS spiderifier animation loop
            viewer.scene.requestRender();
        },
        ScreenSpaceEventType.LEFT_CLICK
    );

    let latestHoverRequestId = 0;
    let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
    let isDragging = false;

    // Track camera movement to avoid expensive picking during camera pan
    const onMoveStart = () => { isDragging = true; };
    const onMoveEnd = () => { isDragging = false; };
    viewer.camera.moveStart.addEventListener(onMoveStart);
    viewer.camera.moveEnd.addEventListener(onMoveEnd);

    // Hover → show tooltip card only
    handler.setInputAction(
        (event: { endPosition: { x: number; y: number } }) => {
            const pos = { x: event.endPosition.x, y: event.endPosition.y };

            if (hoveredEntityIdRef.current) {
                useStore.getState().setHoveredEntity(useStore.getState().hoveredEntity, pos);
            }

            if (!viewer || viewer.isDestroyed()) return;
            if (viewer.scene.mode === SceneMode.MORPHING) return;

            if (isDragging) return;

            latestHoverRequestId++;
            const currentRequestId = latestHoverRequestId;

            if (hoverTimeout) clearTimeout(hoverTimeout);

            hoverTimeout = setTimeout(() => {
                if (currentRequestId !== latestHoverRequestId) return;
                if (!viewer || viewer.isDestroyed() || isDragging) return;

                const entity = findEntityAtPosition(viewer, pos);

                const prevId = hoveredEntityIdRef.current;
                const newId = entity ? entity.id : null;

                if (prevId !== newId) {
                    hoveredEntityIdRef.current = newId;
                    canvas.style.cursor = entity ? "pointer" : "default";
                    useStore.getState().setHoveredEntity(entity, entity ? pos : null);
                    // Trigger render to apply hover highlights immediately
                    viewer.scene.requestRender();
                }
            }, 60);
        },
        ScreenSpaceEventType.MOUSE_MOVE
    );

    return () => {
        if (hoverTimeout) clearTimeout(hoverTimeout);
        if (viewer && !viewer.isDestroyed()) {
            viewer.camera.moveStart.removeEventListener(onMoveStart);
            viewer.camera.moveEnd.removeEventListener(onMoveEnd);
        }
        if (handler && !handler.isDestroyed()) {
            handler.destroy();
        }
        if (canvas && canvas.style) {
            canvas.style.cursor = "default";
        }
    };
}
