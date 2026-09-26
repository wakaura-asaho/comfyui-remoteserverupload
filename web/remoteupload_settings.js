import { app } from '../../scripts/app.js'
import { REMOTE_UPLOAD_NODES, scheduleCredentialWidgetSetup } from './remoteupload_credentials.js'
import { nodeHasConnectionData } from './remoteupload_persistence.js'

const CATEGORY = "Wakaura";
const SUBCATEGORY = "Remote Server Upload - ";
const SECTION_CONN = SUBCATEGORY + "Connection";
const SECTION_SECURITY = SUBCATEGORY + "Security";
const SECTION_TIMEOUT = SUBCATEGORY + "Timeout";
const API = "/api/wakaura/remoteupload/settings";

const DEFAULTS = {
    "RemoteUpload.Connection.DefaultAddress": "192.168.1.100",
    "RemoteUpload.Connection.DefaultPort": 8765,
    "RemoteUpload.Connection.DefaultUseCredentials": false,
    "RemoteUpload.Connection.DefaultUsername": "",
    "RemoteUpload.Connection.DefaultPassword": "",
    "RemoteUpload.Security.EncryptionSecret": "",
    "RemoteUpload.Security.SavePasswordInWorkflow": true,
    "RemoteUpload.Timeout.HealthConnectTimeout": 5.0,
    "RemoteUpload.Timeout.AssumedBandwidthMBps": 5.0,
    "RemoteUpload.Timeout.SafetyMultiplier": 3.0,
    "RemoteUpload.Timeout.MinTimeout": 30.0,
};

// Backend sync
function getVal(id) {
    const v = app.ui.settings.getSettingValue(id);
    return v !== undefined ? v : DEFAULTS[id];
}

async function pushToBackend() {
    const payload = {
        default_address: getVal("RemoteUpload.Connection.DefaultAddress"),
        default_port: getVal("RemoteUpload.Connection.DefaultPort"),
        default_use_credentials: getVal("RemoteUpload.Connection.DefaultUseCredentials"),
        default_username: getVal("RemoteUpload.Connection.DefaultUsername"),
        default_password: getVal("RemoteUpload.Connection.DefaultPassword"),
        save_password_in_workflow: getVal("RemoteUpload.Security.SavePasswordInWorkflow"),
        health_connect_timeout: getVal("RemoteUpload.Timeout.HealthConnectTimeout"),
        assumed_bandwidth_mbps: getVal("RemoteUpload.Timeout.AssumedBandwidthMBps"),
        safety_multiplier: getVal("RemoteUpload.Timeout.SafetyMultiplier"),
        min_timeout: getVal("RemoteUpload.Timeout.MinTimeout"),
    };

    console.log("[RemoteServerUpload] Pushing settings to backend:", payload);

    try {
        const res = await fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            console.error(`[RemoteServerUpload] Backend rejected settings (HTTP ${res.status})`);
        } else {
            console.log("[RemoteServerUpload] Settings accepted by backend.");
        }
    } catch (err) {
        console.error("[RemoteServerUpload] Error pushing settings:", err);
    }
}

app.registerExtension({
    name: "Wakaura.RemoteServerUpload.Settings",
    settings: [
        {
            id: "RemoteUpload.Connection.DefaultAddress",
            name: "Default Server Address",
            type: "text",
            default: DEFAULTS["RemoteUpload.Connection.DefaultAddress"],
            category: [CATEGORY, SECTION_CONN, "Default Server Address"],
            tooltip: "Default IP address or hostname pre-filled in new Remote Server Upload nodes.",
        },
        {
            id: "RemoteUpload.Connection.DefaultPort",
            name: "Default Port",
            type: "number",
            default: DEFAULTS["RemoteUpload.Connection.DefaultPort"],
            attrs: { min: 1, max: 65535, step: 1 },
            category: [CATEGORY, SECTION_CONN, "Default Port"],
            tooltip: "Default port number pre-filled in new Remote Server Upload nodes.",
        },
        {
            id: "RemoteUpload.Connection.DefaultUseCredentials",
            name: "Use Credentials by Default",
            type: "boolean",
            default: DEFAULTS["RemoteUpload.Connection.DefaultUseCredentials"],
            category: [CATEGORY, SECTION_CONN, "Use Credentials by Default"],
            tooltip: "Pre-enable HTTP Basic Authentication on new Remote Server Upload nodes.",
        },
        {
            id: "RemoteUpload.Connection.DefaultUsername",
            name: "Default Username",
            type: "text",
            default: DEFAULTS["RemoteUpload.Connection.DefaultUsername"],
            category: [CATEGORY, SECTION_CONN, "Default Username"],
            tooltip: "Default username pre-filled in new Remote Server Upload nodes.",
        },
        {
            id: "RemoteUpload.Connection.DefaultPassword",
            name: "Default Password",
            type: "text",
            default: DEFAULTS["RemoteUpload.Connection.DefaultPassword"],
            category: [CATEGORY, SECTION_CONN, "Default Password"],
            tooltip: "Default password pre-filled in new Remote Server Upload nodes.",
        },
        {
            id: "RemoteUpload.Security.EncryptionSecret",
            name: "Workflow Password Encryption Secret",
            type: "text",
            default: DEFAULTS["RemoteUpload.Security.EncryptionSecret"],
            category: [CATEGORY, SECTION_SECURITY, "Encryption Secret"],
            tooltip:
                "Optional passphrase used to encrypt node passwords saved in workflow JSON. " +
                "Leave empty to use a browser-local key (workflows are not portable). " +
                "Set the same secret on every machine that should open encrypted workflows.",
        },
        {
            id: "RemoteUpload.Security.SavePasswordInWorkflow",
            name: "Save Password in Workflow",
            type: "boolean",
            default: DEFAULTS["RemoteUpload.Security.SavePasswordInWorkflow"],
            category: [CATEGORY, SECTION_SECURITY, "Save Password in Workflow"],
            tooltip:
                "When disabled, node passwords are omitted from saved workflow JSON. " +
                "Username and use-credentials state are still saved; re-enter the password after loading.",
        },
        {
            id: "RemoteUpload.Timeout.HealthConnectTimeout",
            name: "Health Check Timeout (s)",
            type: "number",
            default: DEFAULTS["RemoteUpload.Timeout.HealthConnectTimeout"],
            attrs: { min: 1, max: 60, step: 0.5 },
            category: [CATEGORY, SECTION_TIMEOUT, "Health Check Timeout"],
            tooltip: "Seconds allowed for the initial server reachability probe.",
        },
        {
            id: "RemoteUpload.Timeout.AssumedBandwidthMBps",
            name: "Assumed Bandwidth (MB/s)",
            type: "number",
            default: DEFAULTS["RemoteUpload.Timeout.AssumedBandwidthMBps"],
            attrs: { min: 0.1, max: 1000, step: 0.5 },
            category: [CATEGORY, SECTION_TIMEOUT, "Assumed Bandwidth"],
            tooltip:
                "Conservative upload bandwidth estimate for dynamic timeout calculation. " +
                "Lower this on slow or Wi-Fi links.",
        },
        {
            id: "RemoteUpload.Timeout.SafetyMultiplier",
            name: "Timeout Safety Multiplier",
            type: "number",
            default: DEFAULTS["RemoteUpload.Timeout.SafetyMultiplier"],
            attrs: { min: 1, max: 20, step: 0.5 },
            category: [CATEGORY, SECTION_TIMEOUT, "Safety Multiplier"],
            tooltip:
                "Theoretical transfer time is multiplied by this factor to add headroom for " +
                "server processing, TCP slow-start, etc.",
        },
        {
            id: "RemoteUpload.Timeout.MinTimeout",
            name: "Minimum Timeout (s)",
            type: "number",
            default: DEFAULTS["RemoteUpload.Timeout.MinTimeout"],
            attrs: { min: 5, max: 600, step: 5 },
            category: [CATEGORY, SECTION_TIMEOUT, "Minimum Timeout"],
            tooltip: "Floor for any computed upload timeout so small files are never given too tight a window.",
        },
    ],

    async setup() {
        const s = app.ui.settings;

        const _originalSet = s.setSettingValue.bind(s);
        s.setSettingValue = function (id, value) {
            _originalSet(id, value);
            if (id.startsWith("RemoteUpload.")) {
                console.log(`[RemoteServerUpload] Setting changed: ${id} = ${value}`);
                pushToBackend();
            }
        };

        let needsInit = false;
        for (const [id, defaultVal] of Object.entries(DEFAULTS)) {
            if (s.getSettingValue(id) === undefined) {
                console.log(`[RemoteServerUpload] Initialising unset setting: ${id} = ${defaultVal}`);
                _originalSet(id, defaultVal);
                needsInit = true;
            }
        }

        setTimeout(pushToBackend, needsInit ? 500 : 1500);

        console.log("[RemoteServerUpload] Settings extension registered.");
    },
});

app.registerExtension({
    name: "Wakaura.RemoteServerUpload.Settings.BeforeQueue",
    async beforeQueuing() {
        await pushToBackend();
    },
});

function applyConnectionDefaults(node) {
    const addressWidget = node.widgets?.find(w => w.name === "address");
    if (addressWidget) {
        addressWidget.value = getVal("RemoteUpload.Connection.DefaultAddress");
    }

    const portWidget = node.widgets?.find(w => w.name === "port");
    if (portWidget) {
        portWidget.value = getVal("RemoteUpload.Connection.DefaultPort");
    }

    const useCredentialsWidget = node.widgets?.find(w => w.name === "use_credentials");
    if (useCredentialsWidget) {
        useCredentialsWidget.value = getVal("RemoteUpload.Connection.DefaultUseCredentials");
        if (useCredentialsWidget.callback) {
            useCredentialsWidget.callback(useCredentialsWidget.value);
        }
    }

    const usernameWidget = node.widgets?.find(w => w.name === "username");
    if (usernameWidget) {
        usernameWidget.value = getVal("RemoteUpload.Connection.DefaultUsername");
    }

    const passwordWidget = node.widgets?.find(w => w.name === "password");
    if (passwordWidget) {
        passwordWidget.value = getVal("RemoteUpload.Connection.DefaultPassword");
        if (passwordWidget._remoteUploadPasswordDom?.setValue) {
            passwordWidget._remoteUploadPasswordDom.setValue(passwordWidget.value);
        }
    }
}

app.registerExtension({
    name: "Wakaura.RemoteServerUpload.NodeDefaults",
    async nodeCreated(node) {
        if (!REMOTE_UPLOAD_NODES.has(node.comfyClass ?? node.type)) {
            return;
        }
        if (app.configuringGraph) {
            return;
        }
        if (nodeHasConnectionData(node)) {
            scheduleCredentialWidgetSetup(node);
            return;
        }
        applyConnectionDefaults(node);
        scheduleCredentialWidgetSetup(node);
    },
});

app.registerExtension({
    name: "Wakaura.RemoteServerUpload.FilenameTokenMenu",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!REMOTE_UPLOAD_NODES.has(nodeData.name)) return;

        const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            const r = origGetExtraMenuOptions?.apply(this, arguments);

            const widget = this.widgets?.find(w => w.name === "filename_prefix");
            if (!widget) return r;

            const node = this;
            const append = (token) => {
                widget.value = (widget.value ?? "") + token;
                node.setDirtyCanvas(true, true);
            };

            options.push({
                content: "Insert Filename Token",
                has_submenu: true,
                submenu: {
                    options: [
                        {
                            content: "date",
                            has_submenu: true,
                            submenu: {
                                options: [
                                    {
                                        content: "Full date: %date:yyyy-MM-dd%",
                                        callback: () => append("%date:yyyy-MM-dd%"),
                                    },
                                    {
                                        content: "Full datetime: %date:yyyy-MM-dd_HH-mm-ss%",
                                        callback: () => append("%date:yyyy-MM-dd_HH-mm-ss%"),
                                    },
                                    null,
                                    {
                                        content: "Year: %year%",
                                        callback: () => append("%year%"),
                                    },
                                    {
                                        content: "Month: %month%",
                                        callback: () => append("%month%"),
                                    },
                                    {
                                        content: "Day: %day%",
                                        callback: () => append("%day%"),
                                    },
                                ],
                            },
                        },
                        {
                            content: "time",
                            has_submenu: true,
                            submenu: {
                                options: [
                                    {
                                        content: "Hour: %hour%",
                                        callback: () => append("%hour%"),
                                    },
                                    {
                                        content: "Minute: %minute%",
                                        callback: () => append("%minute%"),
                                    },
                                    {
                                        content: "Second: %second%",
                                        callback: () => append("%second%"),
                                    },
                                ],
                            },
                        },
                        {
                            content: "image",
                            has_submenu: true,
                            submenu: {
                                options: [
                                    {
                                        content: "Width: %width%",
                                        callback: () => append("%width%"),
                                    },
                                    {
                                        content: "Height: %height%",
                                        callback: () => append("%height%"),
                                    },
                                ],
                            },
                        },
                        {
                            content: "batch",
                            has_submenu: true,
                            submenu: {
                                options: [
                                    {
                                        content: "Batch number: %batch_num%",
                                        callback: () => append("%batch_num%"),
                                    },
                                    {
                                        content: "Zero-padded index: %index%",
                                        callback: () => append("%index%"),
                                    },
                                ],
                            },
                        },
                    ],
                },
            });

            return r;
        };
    },
});