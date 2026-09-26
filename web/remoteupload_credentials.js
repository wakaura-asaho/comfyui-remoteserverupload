import { app } from "../../scripts/app.js";
import {
    applyDecryptedPassword,
    decryptPassword,
    installPasswordSerialization,
    isEncryptedPassword,
    refreshPasswordEncryptionCache,
} from "./remoteupload_crypto.js";
import {
    applyCredentialsProperty,
    installCredentialPersistence,
    syncCredentialsProperty,
} from "./remoteupload_persistence.js";

const EYE_OPEN_URL = new URL("./eye_open.svg", import.meta.url).href;
const EYE_CLOSE_URL = new URL("./eye_close.svg", import.meta.url).href;

export const REMOTE_UPLOAD_NODES = new Set([
    "RemoteServerUpload",
    "RemoteServerUploadVideo",
    "RemoteServerUploadLoRA",
    "RemoteServerUploadDataset",
]);

const PASSWORD_SETTING_ID = "RemoteUpload.Connection.DefaultPassword";

function updateWidgetVisibility(widget, visible) {
    if (!widget) return;
    widget.hidden = !visible;
    widget.disabled = !visible;
}

function hideConvertedWidget(widget) {
    widget.origType = widget.type;
    widget.origComputeSize = widget.computeSize;
    widget.computeSize = () => [0, -4];
    widget.type = "converted-widget-remoteupload-password";
    widget.hidden = true;
}

function installDrawForegroundHider(node) {
    if (node._remoteUploadPasswordDrawPatched) return;
    node._remoteUploadPasswordDrawPatched = true;

    const origOnDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function () {
        const hidden = this.widgets?.filter(
            (w) =>
                typeof w.type === "string" &&
                w.type.includes("converted-widget-remoteupload-password")
        ) ?? [];
        const savedTypes = hidden.map((w) => w.type);
        hidden.forEach((w) => {
            w.type = null;
        });

        const result = origOnDrawForeground?.apply(this, arguments);

        hidden.forEach((w, i) => {
            w.type = savedTypes[i];
        });
        return result;
    };
}

function moveWidgetToIndex(widgets, widget, targetIndex) {
    const from = widgets.indexOf(widget);
    if (from < 0) return;
    widgets.splice(from, 1);
    const clamped = Math.max(0, Math.min(targetIndex, widgets.length));
    widgets.splice(clamped, 0, widget);
}

function placePasswordAfterUsername(node, passwordDomWidget, usernameWidget) {
    const afterIdx = node.widgets.indexOf(usernameWidget);
    if (afterIdx < 0) return;
    moveWidgetToIndex(node.widgets, passwordDomWidget, afterIdx + 1);
}

function moveProgressToBottom(node) {
    const progress = node.widgets?.find(
        (w) => w.name === "upload_progress" || w.type === "remoteupload_progress"
    );
    if (!progress) return;
    const idx = node.widgets.indexOf(progress);
    if (idx >= 0 && idx < node.widgets.length - 1) {
        node.widgets.splice(idx, 1);
        node.widgets.push(progress);
    }
}

function createPasswordToggleButton(input, getVisible, setVisible) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = "Toggle password visibility";
    button.style.cssText = `
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        width: 22px;
        height: 22px;
        padding: 0;
        border: none;
        background: transparent;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.75;
    `;

    const icon = document.createElement("img");
    icon.alt = "";
    icon.draggable = false;
    icon.style.cssText = "width: 16px; height: 16px; pointer-events: none;";
    button.appendChild(icon);

    const refreshIcon = () => {
        const visible = getVisible();
        icon.src = visible ? EYE_OPEN_URL : EYE_CLOSE_URL;
        button.title = visible ? "Hide password" : "Show password";
    };

    button.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setVisible(!getVisible());
        refreshIcon();
    });

    refreshIcon();
    return { button, refreshIcon };
}

export function wrapInputWithPasswordToggle(input) {
    if (!input || input.dataset.remoteUploadPasswordWrapped === "1") {
        return null;
    }

    const parent = input.parentElement;
    if (!parent) return null;

    input.dataset.remoteUploadPasswordWrapped = "1";
    input.type = "password";
    input.style.paddingRight = "28px";

    if (parent.style.position !== "absolute" && parent.style.position !== "fixed") {
        parent.style.position = "relative";
    }

    const { button, refreshIcon } = createPasswordToggleButton(
        input,
        () => input.type === "text",
        (visible) => {
            input.type = visible ? "text" : "password";
        }
    );
    parent.appendChild(button);

    return {
        refreshIcon,
        unwrap: () => {
            button.remove();
            input.style.paddingRight = "";
            delete input.dataset.remoteUploadPasswordWrapped;
        },
    };
}

function createPasswordDomWidget(node, passwordWidget, usernameWidget) {
    const row = document.createElement("div");
    row.style.cssText = `
        display: flex;
        align-items: center;
        width: 100%;
        box-sizing: border-box;
        padding: 2px 4px;
        gap: 6px;
    `;

    const label = document.createElement("span");
    label.textContent = "password";
    label.style.cssText = `
        flex: 0 0 auto;
        font: 12px sans-serif;
        color: #aaa;
        opacity: 0.85;
        user-select: none;
    `;

    const fieldWrap = document.createElement("div");
    fieldWrap.style.cssText = `
        flex: 1 1 auto;
        position: relative;
        min-width: 0;
    `;

    const input = document.createElement("input");
    input.type = "password";
    input.value = "";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.cssText = `
        width: 100%;
        box-sizing: border-box;
        padding: 2px 28px 2px 4px;
        border: 1px solid #4e4e4e;
        border-radius: 4px;
        background: #1a1a1a;
        color: #ddd;
        font: 12px sans-serif;
        outline: none;
    `;

    const { button } = createPasswordToggleButton(
        input,
        () => input.type === "text",
        (visible) => {
            input.type = visible ? "text" : "password";
        }
    );

    fieldWrap.appendChild(input);
    fieldWrap.appendChild(button);
    row.appendChild(label);
    row.appendChild(fieldWrap);

    const setValue = (value) => {
        const next = value ?? "";
        if (input.value !== next) {
            input.value = next;
        }
        passwordWidget.value = next;
    };

    input.addEventListener("input", () => {
        setValue(input.value);
        if (passwordWidget.callback) {
            passwordWidget.callback(input.value);
        }
        refreshPasswordEncryptionCache(passwordWidget, input.value).catch((err) => {
            console.warn("[RemoteServerUpload] Failed to encrypt password cache:", err);
        });
        syncCredentialsProperty(node);
        app.graph?.setDirtyCanvas(true, true);
    });

    input.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
    });

    const domWidget = node.addDOMWidget("password_visible", "remoteupload_password", row, {
        serialize: false,
        hideOnZoom: false,
    });
    domWidget.computeSize = (width) => [width, 28];

    hideConvertedWidget(passwordWidget);
    installDrawForegroundHider(node);
    placePasswordAfterUsername(node, domWidget, usernameWidget);
    moveProgressToBottom(node);

    const origCallback = passwordWidget.callback;
    passwordWidget.callback = (value) => {
        if (origCallback) origCallback(value);
        if (isEncryptedPassword(value)) {
            decryptPassword(value).then((plain) => {
                passwordWidget.value = plain;
                if (input.value !== plain) {
                    input.value = plain;
                }
                refreshPasswordEncryptionCache(passwordWidget, plain).catch((err) => {
                    console.warn("[RemoteServerUpload] Failed to refresh password cache:", err);
                });
            });
            return;
        }
        if (typeof value === "string" && input.value !== value) {
            input.value = value;
        }
        refreshPasswordEncryptionCache(passwordWidget, value ?? "").catch((err) => {
            console.warn("[RemoteServerUpload] Failed to refresh password cache:", err);
        });
    };

    return { domWidget, setValue, input };
}

async function restorePasswordFromWorkflow(node, passwordWidget) {
    if (!passwordWidget) return;
    const domApi = passwordWidget._remoteUploadPasswordDom;
    const raw = passwordWidget.value ?? "";
    await applyDecryptedPassword(passwordWidget, domApi, raw);
}

async function setupCredentialWidgets(node) {
    const useCredentialsWidget = node.widgets?.find((w) => w.name === "use_credentials");
    const usernameWidget = node.widgets?.find((w) => w.name === "username");
    const passwordWidget = node.widgets?.find((w) => w.name === "password");

    if (!useCredentialsWidget || !usernameWidget || !passwordWidget) {
        return;
    }

    if (!passwordWidget._remoteUploadPasswordDom) {
        passwordWidget._remoteUploadPasswordDom = createPasswordDomWidget(
            node,
            passwordWidget,
            usernameWidget
        );
    } else {
        placePasswordAfterUsername(
            node,
            passwordWidget._remoteUploadPasswordDom.domWidget,
            usernameWidget
        );
        moveProgressToBottom(node);
    }

    installPasswordSerialization(passwordWidget);

    if (!(await applyCredentialsProperty(node))) {
        await restorePasswordFromWorkflow(node, passwordWidget);
    }
    syncCredentialsProperty(node);

    const updateVisibility = () => {
        const enabled = !!useCredentialsWidget.value;
        updateWidgetVisibility(usernameWidget, enabled);
        updateWidgetVisibility(passwordWidget._remoteUploadPasswordDom?.domWidget, enabled);
        updateWidgetVisibility(passwordWidget, false);
        node.setDirtyCanvas?.(true, true);
    };

    const origCallback = useCredentialsWidget.callback;
    useCredentialsWidget.callback = function () {
        if (origCallback) origCallback.apply(this, arguments);
        updateVisibility();
        syncCredentialsProperty(node);
    };

    updateVisibility();

    const size = node.computeSize?.([node.size[0], node.size[1]]);
    if (size) {
        node.setSize([Math.max(node.size[0], size[0]), size[1]]);
    }
}

export function scheduleCredentialWidgetSetup(node) {
    if (node._remoteUploadCredentialSetupScheduled) {
        return;
    }
    node._remoteUploadCredentialSetupScheduled = true;
    requestAnimationFrame(async () => {
        node._remoteUploadCredentialSetupScheduled = false;
        try {
            await setupCredentialWidgets(node);
        } catch (err) {
            console.warn("[RemoteServerUpload] Failed to set up credential widgets:", err);
        }
    });
}

async function restoreAllUploadNodePasswords() {
    const nodes = app.graph?._nodes ?? app.graph?.nodes ?? [];
    for (const node of nodes) {
        if (!REMOTE_UPLOAD_NODES.has(node.comfyClass ?? node.type)) {
            continue;
        }
        await setupCredentialWidgets(node);
    }
}

function enhanceSettingsPasswordInput(input) {
    if (!input || input.dataset.remoteUploadSettingsPassword === "1") {
        return;
    }
    input.dataset.remoteUploadSettingsPassword = "1";
    wrapInputWithPasswordToggle(input);
}

function scanSettingsPanelForPasswordInput() {
    const settingRows = document.querySelectorAll("[data-setting-id]");
    for (const row of settingRows) {
        if (row.dataset.settingId !== PASSWORD_SETTING_ID) continue;
        const input = row.querySelector("input");
        enhanceSettingsPasswordInput(input);
    }

    const labels = document.querySelectorAll("label, .setting-name, .comfy-setting-name");
    for (const label of labels) {
        if (!label.textContent?.includes("Default Password")) continue;
        const container = label.closest("[data-setting-id]") ?? label.parentElement;
        const input = container?.querySelector("input");
        enhanceSettingsPasswordInput(input);
    }
}

app.registerExtension({
    name: "Wakaura.RemoteServerUpload.Credentials",

    async setup() {
        const observer = new MutationObserver(() => {
            scanSettingsPanelForPasswordInput();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        scanSettingsPanelForPasswordInput();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!REMOTE_UPLOAD_NODES.has(nodeData.name)) return;

        installCredentialPersistence(nodeType);

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = origOnNodeCreated?.apply(this, arguments);
            scheduleCredentialWidgetSetup(this);
            return result;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const result = origOnConfigure?.apply(this, arguments);
            scheduleCredentialWidgetSetup(this);
            return result;
        };
    },

    async afterConfigureGraph() {
        await restoreAllUploadNodePasswords();
    },

    loadedGraphNode(node) {
        if (!REMOTE_UPLOAD_NODES.has(node.comfyClass ?? node.type)) return;
        scheduleCredentialWidgetSetup(node);
    },
});
