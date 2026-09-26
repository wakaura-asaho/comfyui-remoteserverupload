import { app } from "../../scripts/app.js";
import {
    applyDecryptedPassword,
    isEncryptedPassword,
    refreshPasswordEncryptionCache,
} from "./remoteupload_crypto.js";

export const CREDENTIAL_PROP = "remote_upload_credentials";
export const SAVE_PASSWORD_SETTING = "RemoteUpload.Security.SavePasswordInWorkflow";

export function shouldSavePasswordInWorkflow() {
    const value = app.ui?.settings?.getSettingValue(SAVE_PASSWORD_SETTING);
    return value !== undefined ? !!value : true;
}

const CONNECTION_WIDGETS = [
    "address",
    "port",
    "use_credentials",
    "username",
    "password",
];

const LEGACY_WIDGET_ORDER = {
    RemoteServerUpload: [
        "filename_prefix",
        ...CONNECTION_WIDGETS,
    ],
    RemoteServerUploadVideo: [
        "filename_prefix",
        ...CONNECTION_WIDGETS,
    ],
    RemoteServerUploadLoRA: [
        "filename_prefix",
        ...CONNECTION_WIDGETS,
    ],
    RemoteServerUploadDataset: [
        "texts",
        "filename_prefix",
        ...CONNECTION_WIDGETS,
    ],
};

function nodeTypeName(node) {
    return node.comfyClass ?? node.type;
}

function isSerializableWidget(widget) {
    return widget && widget.serialize !== false;
}

export function nodeHasConnectionData(node) {
    const saved = node.properties?.[CREDENTIAL_PROP];
    if (saved && (saved.use_credentials || saved.username || saved.password)) {
        return true;
    }

    const useCredentials = node.widgets?.find((w) => w.name === "use_credentials");
    const username = node.widgets?.find((w) => w.name === "username");
    const password = node.widgets?.find((w) => w.name === "password");

    if (useCredentials?.value) return true;
    if (username?.value) return true;
    if (password?.value) return true;
    return false;
}

export function syncCredentialsProperty(node) {
    const useCredentials = node.widgets?.find((w) => w.name === "use_credentials");
    const username = node.widgets?.find((w) => w.name === "username");
    const password = node.widgets?.find((w) => w.name === "password");
    if (!useCredentials || !username || !password) {
        return;
    }

    node.properties = node.properties || {};
    node.properties[CREDENTIAL_PROP] = {
        use_credentials: !!useCredentials.value,
        username: username.value ?? "",
        password: password._remoteUploadEncrypted ?? password.value ?? "",
    };
}

function legacyArrayToDict(nodeType, values) {
    const order = LEGACY_WIDGET_ORDER[nodeType];
    if (!order || !Array.isArray(values)) {
        return null;
    }

    const dict = {};
    for (let i = 0; i < order.length && i < values.length; i++) {
        dict[order[i]] = values[i];
    }
    return dict;
}

export function widgetDictFromConfigureInfo(node, info) {
    const raw = info?.widgets_values;
    if (!raw || typeof raw !== "object") {
        return null;
    }

    if (!Array.isArray(raw)) {
        return { ...raw };
    }

    return legacyArrayToDict(nodeTypeName(node), raw);
}

export function buildWidgetDict(node) {
    const dict = {};
    for (const widget of node.widgets ?? []) {
        if (!isSerializableWidget(widget)) {
            continue;
        }
        if (widget.name === "password") {
            dict.password = shouldSavePasswordInWorkflow()
                ? widget._remoteUploadEncrypted ?? widget.value ?? ""
                : "";
        } else {
            dict[widget.name] = widget.value;
        }
    }
    return dict;
}

export function applyWidgetDict(node, dict) {
    if (!dict) {
        return;
    }

    for (const widget of node.widgets ?? []) {
        if (!isSerializableWidget(widget)) {
            continue;
        }
        if (!(widget.name in dict)) {
            continue;
        }
        widget.value = dict[widget.name];
        widget.callback?.(widget.value);
    }
}

export async function applyCredentialsProperty(node) {
    const saved = node.properties?.[CREDENTIAL_PROP];
    if (!saved) {
        return false;
    }

    const useCredentials = node.widgets?.find((w) => w.name === "use_credentials");
    const username = node.widgets?.find((w) => w.name === "username");
    const password = node.widgets?.find((w) => w.name === "password");
    if (!useCredentials || !username || !password) {
        return false;
    }

    useCredentials.value = !!saved.use_credentials;
    username.value = saved.username ?? "";

    const encrypted = saved.password ?? "";
    password.value = encrypted;
    await applyDecryptedPassword(
        password,
        password._remoteUploadPasswordDom,
        encrypted
    );
    useCredentials.callback?.(useCredentials.value);
    return true;
}

function stripPasswordFromSerialized(serialised) {
    if (shouldSavePasswordInWorkflow() || !serialised) {
        return;
    }
    if (serialised.widgets_values && !Array.isArray(serialised.widgets_values)) {
        serialised.widgets_values.password = "";
    }
    const saved = serialised.properties?.[CREDENTIAL_PROP];
    if (saved) {
        saved.password = "";
    }
}

export function copyCredentialsProperty(source, target) {
    const saved = source.properties?.[CREDENTIAL_PROP];
    if (!saved) {
        return;
    }
    target.properties = target.properties || {};
    target.properties[CREDENTIAL_PROP] = {
        use_credentials: !!saved.use_credentials,
        username: saved.username ?? "",
        password: saved.password ?? "",
    };
}

export function installCredentialPersistence(nodeType) {
    const origOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
        const result = origOnConfigure?.apply(this, arguments);
        const dict = widgetDictFromConfigureInfo(this, info);
        applyWidgetDict(this, dict);
        return result;
    };

    const origOnSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (serialised) {
        const result = origOnSerialize?.apply(this, arguments);
        syncCredentialsProperty(this);
        serialised.widgets_values = buildWidgetDict(this);
        stripPasswordFromSerialized(serialised);
        return result;
    };

    const origClone = nodeType.prototype.clone;
    if (origClone) {
        nodeType.prototype.clone = function () {
            const cloned = origClone.apply(this, arguments);
            if (cloned) {
                copyCredentialsProperty(this, cloned);
            }
            return cloned;
        };
    }
}
