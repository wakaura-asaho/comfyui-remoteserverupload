import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const REMOTE_UPLOAD_NODES = new Set([
    "RemoteServerUpload",
    "RemoteServerUploadVideo",
    "RemoteServerUploadLoRA",
    "RemoteServerUploadDataset",
]);

const WIDGET_HEIGHT = 42;

function formatStatus(total, received, failed) {
    const processed = received + failed;
    return `${processed}/${total}. ${received} received, ${failed} failed`;
}

function resolveNodeId(detail) {
    if (detail == null) {
        return null;
    }
    if (typeof detail === "object") {
        return detail.node ?? detail.display_node ?? null;
    }
    return detail;
}

function normalizeProgress(progress) {
    if (!progress) {
        return null;
    }
    if (Array.isArray(progress)) {
        const entry = progress[progress.length - 1];
        return entry && typeof entry === "object" ? entry : null;
    }
    if (typeof progress === "object" && "total" in progress) {
        return progress;
    }
    return null;
}

function findUploadNode(nodeId) {
    if (nodeId == null) {
        return null;
    }

    const candidates = [String(nodeId)];
    const numericId = Number(nodeId);
    if (!Number.isNaN(numericId)) {
        candidates.push(numericId);
    }

    const graphs = [app.graph, ...(app.graph.subgraphs?.values?.() ?? [])];

    for (const graph of graphs) {
        for (const id of candidates) {
            const node = graph.getNodeById?.(id);
            if (node && REMOTE_UPLOAD_NODES.has(node.comfyClass ?? node.type)) {
                return node;
            }
        }
    }
    return null;
}

function ensureProgressWidget(node) {
    if (node._remoteUploadProgress?.widget) {
        return node._remoteUploadProgress;
    }

    const container = document.createElement("div");
    container.className = "remote-upload-progress";
    container.style.cssText = `
        width: 100%;
        box-sizing: border-box;
        padding: 4px 0 2px;
        user-select: none;
    `;

    const track = document.createElement("div");
    track.style.cssText = `
        width: 100%;
        height: 10px;
        border-radius: 5px;
        background: rgba(255, 255, 255, 0.08);
        overflow: hidden;
    `;

    const bar = document.createElement("div");
    bar.style.cssText = `
        width: 0%;
        height: 100%;
        border-radius: 5px;
        background: #4caf50;
        transition: width 0.2s ease, background-color 0.2s ease;
    `;
    track.appendChild(bar);

    const text = document.createElement("div");
    text.style.cssText = `
        margin-top: 4px;
        font: 11px/1.3 sans-serif;
        color: rgba(255, 255, 255, 0.72);
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    `;
    text.textContent = formatStatus(0, 0, 0);

    container.appendChild(track);
    container.appendChild(text);

    container.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
    });

    const widget = node.addDOMWidget(
        "upload_progress",
        "remoteupload_progress",
        container,
        {
            serialize: false,
            hideOnZoom: false,
        }
    );
    widget.computeSize = (width) => [width, WIDGET_HEIGHT];
    widget.serializeValue = () => undefined;

    const idx = node.widgets.indexOf(widget);
    if (idx >= 0 && idx < node.widgets.length - 1) {
        node.widgets.splice(idx, 1);
        node.widgets.push(widget);
    }

    node._remoteUploadProgress = { bar, text, widget, track };
    return node._remoteUploadProgress;
}

function updateProgressWidget(node, { total = 0, received = 0, failed = 0, done = false }) {
    const state = ensureProgressWidget(node);
    const processed = received + failed;
    const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;

    state.bar.style.width = `${pct}%`;
    if (failed > 0) {
        state.bar.style.background = done ? "#e53935" : "#ff9800";
    } else if (done) {
        state.bar.style.background = "#4caf50";
    } else {
        state.bar.style.background = "#4caf50";
    }

    state.text.textContent = formatStatus(total, received, failed);
    node.setDirtyCanvas?.(true, false);
}

function resetProgressWidget(node) {
    updateProgressWidget(node, { total: 0, received: 0, failed: 0, done: false });
}

app.registerExtension({
    name: "Wakaura.RemoteServerUpload.ProgressWidget",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!REMOTE_UPLOAD_NODES.has(nodeData.name)) {
            return;
        }

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = origOnNodeCreated?.apply(this, arguments);
            requestAnimationFrame(() => {
                ensureProgressWidget(this);
                const size = this.computeSize?.([this.size[0], this.size[1]]);
                if (size) {
                    this.setSize([Math.max(this.size[0], size[0]), size[1]]);
                }
            });
            return result;
        };
    },

    async afterConfigureGraph() {
        const nodes = app.graph?._nodes ?? app.graph?.nodes ?? [];
        for (const node of nodes) {
            if (!REMOTE_UPLOAD_NODES.has(node.comfyClass ?? node.type)) {
                continue;
            }
            ensureProgressWidget(node);
        }
    },

    loadedGraphNode(node) {
        if (!REMOTE_UPLOAD_NODES.has(node.comfyClass ?? node.type)) {
            return;
        }
        ensureProgressWidget(node);
    },
});

api.addEventListener("remoteupload_progress", ({ detail }) => {
    if (!detail?.node_id) {
        return;
    }
    const node = findUploadNode(detail.node_id);
    if (!node) {
        return;
    }
    updateProgressWidget(node, detail);
});

api.addEventListener("executing", ({ detail }) => {
    const nodeId = resolveNodeId(detail);
    if (nodeId == null) {
        return;
    }
    const node = findUploadNode(nodeId);
    if (node) {
        resetProgressWidget(node);
    }
});

api.addEventListener("executed", ({ detail }) => {
    if (!detail?.node) {
        return;
    }
    const node = findUploadNode(detail.node);
    if (!node) {
        return;
    }
    const progress = normalizeProgress(detail?.output?.upload_progress);
    if (progress) {
        updateProgressWidget(node, { ...progress, done: true });
    }
});
