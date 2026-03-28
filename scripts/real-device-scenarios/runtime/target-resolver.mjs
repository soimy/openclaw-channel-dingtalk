function trimString(value) {
    return typeof value === "string" ? value.trim() : "";
}

function buildResolvedTarget({ conversationId, id, label, mode, source }) {
    return {
        source,
        status: "resolved",
        target: {
            conversationId: conversationId || undefined,
            id,
            label: label || id,
            mode,
        },
    };
}

function resolveFromLatestInbound({ latestInbound, scenario }) {
    if (!latestInbound) {
        return null;
    }
    if (scenario.target.mode === "dm" && scenario.target.resolver === "latest_inbound_sender") {
        const senderStaffId = trimString(latestInbound.senderStaffId);
        if (!senderStaffId) {
            return null;
        }
        return buildResolvedTarget({
            conversationId: trimString(latestInbound.conversationId),
            id: senderStaffId,
            label: trimString(latestInbound.senderNick) || senderStaffId,
            mode: "dm",
            source: "latest_inbound_sender",
        });
    }

    if (
        scenario.target.mode === "group" &&
        scenario.target.resolver === "latest_inbound_conversation"
    ) {
        const conversationId = trimString(latestInbound.conversationId);
        if (!conversationId) {
            return null;
        }
        return buildResolvedTarget({
            conversationId,
            id: conversationId,
            label: trimString(latestInbound.conversationTitle) || conversationId,
            mode: "group",
            source: "latest_inbound_conversation",
        });
    }

    return null;
}

function resolveFromResponse({ resolveTargetResponse, scenario }) {
    if (!resolveTargetResponse || resolveTargetResponse.status !== "completed") {
        return null;
    }

    if (scenario.target.mode === "dm") {
        const senderStaffId = trimString(resolveTargetResponse.senderStaffId);
        if (!senderStaffId) {
            return null;
        }
        return buildResolvedTarget({
            conversationId: trimString(resolveTargetResponse.conversationId),
            id: senderStaffId,
            label: trimString(resolveTargetResponse.displayName) || senderStaffId,
            mode: "dm",
            source: "resolve_target_response",
        });
    }

    if (scenario.target.mode === "group") {
        const conversationId = trimString(resolveTargetResponse.conversationId);
        if (!conversationId) {
            return null;
        }
        return buildResolvedTarget({
            conversationId,
            id: conversationId,
            label: trimString(resolveTargetResponse.displayName) || conversationId,
            mode: "group",
            source: "resolve_target_response",
        });
    }

    return null;
}

function resolveFromDirectory({ directoryState, resolveTargetResponse, scenario }) {
    if (!directoryState) {
        return null;
    }

    if (scenario.target.mode === "dm") {
        const displayName = trimString(resolveTargetResponse?.displayName);
        if (!displayName) {
            return null;
        }

        for (const [userId, entry] of Object.entries(directoryState.users || {})) {
            if (trimString(entry.currentDisplayName) !== displayName) {
                continue;
            }
            const conversationId = Array.isArray(entry.lastSeenInConversationIds)
                ? trimString(entry.lastSeenInConversationIds[0])
                : "";
            const canonicalUserId =
                trimString(entry.canonicalUserId) || trimString(entry.staffId) || trimString(userId);

            if (!canonicalUserId) {
                continue;
            }
            return buildResolvedTarget({
                conversationId,
                id: canonicalUserId,
                label: displayName,
                mode: "dm",
                source: "targets_directory",
            });
        }
    }

    if (scenario.target.mode === "group") {
        const displayName = trimString(resolveTargetResponse?.displayName);
        if (!displayName) {
            return null;
        }

        for (const entry of Object.values(directoryState.groups || {})) {
            if (trimString(entry.currentTitle) !== displayName) {
                continue;
            }
            const conversationId = trimString(entry.conversationId);
            if (!conversationId) {
                continue;
            }
            return buildResolvedTarget({
                conversationId,
                id: conversationId,
                label: displayName,
                mode: "group",
                source: "targets_directory",
            });
        }
    }

    return null;
}

function resolveFromOverride({ overrideTargetId, overrideTargetLabel, scenario }) {
    const id = trimString(overrideTargetId);
    if (!id) {
        return null;
    }
    return buildResolvedTarget({
        conversationId: "",
        id,
        label: trimString(overrideTargetLabel) || id,
        mode: scenario.target.mode,
        source: "override",
    });
}

export function resolveTarget({
    scenario,
    latestInbound,
    resolveTargetResponse,
    directoryState,
    overrideTargetId,
    overrideTargetLabel,
}) {
    return (
        resolveFromLatestInbound({ latestInbound, scenario }) ||
        resolveFromResponse({ resolveTargetResponse, scenario }) ||
        resolveFromDirectory({ directoryState, resolveTargetResponse, scenario }) ||
        resolveFromOverride({ overrideTargetId, overrideTargetLabel, scenario }) || {
            status: "needs_target_resolution",
            reason: "unable_to_resolve_target",
        }
    );
}
