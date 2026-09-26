import { app } from "../../scripts/app.js";

const ENC_PREFIX = "RUENC1:";
const LOCAL_KEY_STORAGE = "RemoteUpload.LocalCryptoKey";
const PBKDF2_SALT = "comfyui-remoteserverupload:v1";
const ENCRYPTION_SECRET_SETTING = "RemoteUpload.Security.EncryptionSecret";

export function isEncryptedPassword(value) {
    return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

async function getOrCreateLocalKey() {
    let stored = localStorage.getItem(LOCAL_KEY_STORAGE);
    if (!stored) {
        const raw = crypto.getRandomValues(new Uint8Array(32));
        stored = bytesToBase64(raw);
        localStorage.setItem(LOCAL_KEY_STORAGE, stored);
    }
    return crypto.subtle.importKey(
        "raw",
        base64ToBytes(stored),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"]
    );
}

async function getKeyFromSecret(secret) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        "PBKDF2",
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: enc.encode(PBKDF2_SALT),
            iterations: 100_000,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

export async function getCryptoKey() {
    const secret = app.ui?.settings?.getSettingValue(ENCRYPTION_SECRET_SETTING);
    if (typeof secret === "string" && secret.trim()) {
        return getKeyFromSecret(secret.trim());
    }
    return getOrCreateLocalKey();
}

export async function encryptPassword(plaintext) {
    if (!plaintext) {
        return "";
    }
    const key = await getCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(plaintext)
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return ENC_PREFIX + bytesToBase64(combined);
}

export async function decryptPassword(value) {
    if (!value) {
        return "";
    }
    if (!isEncryptedPassword(value)) {
        return value;
    }
    try {
        const key = await getCryptoKey();
        const combined = base64ToBytes(value.slice(ENC_PREFIX.length));
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            key,
            ciphertext
        );
        return new TextDecoder().decode(plain);
    } catch (err) {
        console.warn("[RemoteServerUpload] Could not decrypt saved password:", err);
        return "";
    }
}

export async function refreshPasswordEncryptionCache(passwordWidget, plaintext) {
    if (!passwordWidget) return;
    if (isEncryptedPassword(plaintext)) {
        passwordWidget._remoteUploadEncrypted = plaintext;
        return;
    }
    passwordWidget._remoteUploadEncrypted = plaintext
        ? await encryptPassword(plaintext)
        : "";
}

export function installPasswordSerialization(passwordWidget) {
    if (!passwordWidget || passwordWidget._remoteUploadSerializationInstalled) {
        return;
    }
    passwordWidget._remoteUploadSerializationInstalled = true;
    passwordWidget._remoteUploadEncrypted = "";

    // graphToPrompt uses serializeValue for execution; workflow JSON uses
    // buildWidgetDict/onSerialize which stores _remoteUploadEncrypted instead.
    passwordWidget.serializeValue = () => passwordWidget.value ?? "";
}

export async function applyDecryptedPassword(passwordWidget, domApi, value) {
    if (!passwordWidget) return;

    const plain = await decryptPassword(value);
    passwordWidget.value = plain;
    domApi?.setValue?.(plain);
    await refreshPasswordEncryptionCache(passwordWidget, plain);
}
