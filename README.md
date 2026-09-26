# ComfyUI Remote Server Upload

Upload images, videos, LoRA weights, and training datasets from ComfyUI workflows to a remote HTTP file server — without saving to the local output folder first.

![Logo](https://github.com/wakaura-asaho/comfyui-remoteserverupload/blob/main/docs/logo_notitle.png)

---

## Overview

Four output nodes POST files directly to a remote server at `http://{address}:{port}/upload`:


| Node                               | Input                              | Uploaded format                                    |
| ---------------------------------- | ---------------------------------- | -------------------------------------------------- |
| **Remote Server Upload**           | Image batch                        | PNG (one file per frame)                           |
| **Remote Server Upload (Video)**   | Video                              | Container extension auto-detected (default: `mp4`) |
| **Remote Server Upload (LoRA)**    | LoRA model                         | `.safetensors`                                     |
| **Remote Server Upload (Dataset)** | Image list + optional caption list | PNG + matching `.txt` caption files                |


Every upload node shares the same connection widgets: **address** → **port** → **use_credentials** → **username** → **password**, plus a built-in **upload progress** bar at the bottom. Widget order before those fields depends on the node type (see [Nodes Included](#nodes-included)).

Before each run, the node probes the server root with `GET` and measures round-trip time. A `401` response is treated as reachable when credentials are not enabled yet (the server is up but requires login). When **use_credentials** is enabled and a **username** is set, uploads and the health check use HTTP Basic Authentication. Upload timeouts are calculated from file size, measured RTT, and your bandwidth settings. Upload nodes are marked non-idempotent so they **always execute on queue**, even when upstream inputs are unchanged.

---



## Nodes Included



### 1. Remote Server Upload

Uploads an image batch as individual PNG files.

- **Widget order:** `images` → `filename_prefix` → connection/credential fields → upload progress.
- **Image Input:** Accepts a standard ComfyUI image batch; each frame is encoded as PNG and uploaded separately.
- **Filename Prefix:** Base name for uploaded files (default: `image_%index%`). Supports dynamic tokens — right-click the node for **Insert Filename Token**.
- **Address / Port:** Target server host and port (defaults come from global settings).
- **Credentials (optional):** Toggle **use_credentials** to send HTTP Basic Auth. When enabled, **username** and **password** fields appear. Auth is sent only when both the toggle is on and **username** is non-empty. The password widget includes an eye-icon control to show or hide the value.
- **Batch Tokens:** Use `%index%` or `%batch_num%` in the prefix to give each frame a unique name.
- **Health Check:** Verifies the server is reachable before any upload begins.
- **Per-file Timeout:** Computed dynamically from file size and network RTT.
- **Progress Widget:** Live bar and counter during upload (e.g. `3/3. 3 received, 0 failed`).



### 2. Remote Server Upload (Video)

Uploads a single video file to the remote server.

- **Widget order:** `video` → `filename_prefix` → connection/credential fields → upload progress.
- **Video Input:** Accepts a ComfyUI `VIDEO` input.
- **Extension Detection:** Reads the container extension from the video source path when available; falls back to `mp4`.
- **Temp File Handling:** Writes the video to a unique file under `_temp/` so PyAV can infer the container format reliably, then deletes it on success.
- **Failure Recovery:** If the upload fails, the local temp copy is kept and its path is logged for inspection.



### 3. Remote Server Upload (LoRA)

Uploads a LoRA model as a `.safetensors` file.

- **Widget order:** `lora` → `filename_prefix` → connection/credential fields → upload progress.
- **LoRA Input:** Accepts a `LORA_MODEL` tensor dict. Connect the raw LoRA output — not a model that already has LoRA layers merged in.
- **Safetensors Encoding:** Serializes the state dict to a temp `.safetensors` file before upload.
- **Failure Recovery:** On upload failure, the temp file is preserved locally.



### 4. Remote Server Upload (Dataset)

Uploads a list of images with optional per-image caption files — useful for pushing training data to a remote machine.

- **Widget order:** `images` → `texts` (optional) → `filename_prefix` → connection/credential fields → upload progress.
- **List Input Mode:** Uses ComfyUI's input-list mode so each image (and caption) can arrive from separate upstream nodes.
- **Image Files:** Each image is saved and uploaded as PNG; include `%index%` or `%batch_num%` in the prefix for unique names.
- **Caption Files:** When a `texts` input is connected, a matching `.txt` file is uploaded alongside each image (same base name, `.txt` extension).
- **Shared Settings:** `filename_prefix`, `address`, `port`, and credential fields are taken from the first list entry.

![Overview](https://github.com/wakaura-asaho/comfyui-remoteserverupload/blob/main/docs/overview.png)

All four upload node types share the same connection and credential widgets described above.

---



## HTTP Basic Authentication

Use this when the target upload server requires a username and password.


| Widget              | Purpose                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| **use_credentials** | Enables HTTP Basic Auth for the health check and every upload request                                      |
| **username**        | Username sent in the `Authorization` header (hidden when the toggle is off). Required for auth to be sent. |
| **password**        | Password sent in the `Authorization` header (hidden when the toggle is off)                                |


- **Per-node control:** Enable **use_credentials** only on nodes that need it; leave it off for open servers.
- **Password visibility:** Click the eye icon inside the password field to toggle between masked and plain text.
- **Workflow persistence:** **use_credentials** and **username** are always saved with the workflow. **password** is saved only when **Save Password in Workflow** is enabled in global settings (default: on). Credentials survive reload and node duplication; older workflows that used positional `widgets_values` arrays are still loaded.
- **Dual storage:** Saved workflows store credentials in named `widgets_values` and in a `remote_upload_credentials` node property as a backup. On queue, the live widget password is used (not the encrypted blob).
- **Encrypted storage in workflow JSON:** When password saving is enabled, passwords are written as `RUENC1:...` blobs (AES-256-GCM) rather than plain text.
- **Omit password from workflows:** Disable **Save Password in Workflow** to strip passwords from saved JSON. The password remains in memory for the current session and queue runs; re-enter it after loading a workflow.
- **Portable workflows:** Set **Workflow Password Encryption Secret** in global settings (see below) to the same passphrase on every machine that should open encrypted workflows. If left empty, a browser-local key is used instead (workflows are not portable across browsers or profiles).

> [!TIP]
> **settings.json defaults:** Server-side defaults (`default_address`, `default_port`, `default_use_credentials`, `default_username`, `default_password`, `save_password_in_workflow`, and timeout keys) live in `settings.json`. Connection/credential defaults apply only when placing a brand-new node with no saved connection data — not when loading or duplicating an existing one.

---



## Filename Prefix Tokens

The **Filename Prefix** field on every upload node resolves dynamic tokens at upload time:


| Token           | Output                       | Example                            |
| --------------- | ---------------------------- | ---------------------------------- |
| `%date:FORMAT%` | Date/time with custom format | `%date:yyyy-MM-dd%` → `2026-07-09` |
| `%year%`        | 4-digit year                 | `2026`                             |
| `%month%`       | 2-digit month                | `07`                               |
| `%day%`         | 2-digit day                  | `09`                               |
| `%hour%`        | 2-digit hour (24 h)          | `08`                               |
| `%minute%`      | 2-digit minute               | `20`                               |
| `%second%`      | 2-digit second               | `00`                               |
| `%width%`       | Image width in pixels        | `1024`                             |
| `%height%`      | Image height in pixels       | `1024`                             |
| `%batch_num%`   | Batch frame number (0-based) | `0`, `1`, `2`                      |
| `%index%`       | Zero-padded batch index      | `00000`, `00001`                   |


`%date:FORMAT%` **notation** uses `yyyy`, `yy`, `MM`, `dd`, `HH`, `hh`, `mm`, `ss`: e.g. `uploads/%date:yyyy-MM-dd%/shot` produces `uploads/2026-07-09/shot.png`.

**Right-click "Insert Filename Token"** on any upload node to append tokens from a helper menu (date, time, image dimensions, and batch index).

---



## Upload Progress Widget

Each upload node includes an embedded progress bar and status line at the bottom of the node.

- **During upload:** The bar fills as each file completes; the counter shows progress like `20/30. 20 received, 0 failed`.
- **On success:** The bar turns green with the final count.
- **On partial failure:** The bar turns orange while uploading, then red when the run finishes with failures.
- **On re-queue:** The widget resets when execution starts and updates live over WebSocket (`remoteupload_progress` events).

No configuration is required — the widget appears automatically on all four upload node types.

---



## Global Settings

Open **ComfyUI Settings → Remote Server Upload** to configure defaults that apply to all new nodes:

### Connection


| Setting                        | Purpose                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| **Default Server Address**     | Pre-fills the `address` widget on new nodes                                          |
| **Default Port**               | Pre-fills the `port` widget on new nodes (pack default: `8765`)                      |
| **Use Credentials by Default** | Pre-enables **use_credentials** on new nodes                                         |
| **Default Username**           | Pre-fills the `username` widget on new nodes                                         |
| **Default Password**           | Pre-fills the `password` widget on new nodes (eye-icon toggle in the settings panel) |




### Security


| Setting                                 | Purpose                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Workflow Password Encryption Secret** | Optional passphrase for encrypting node passwords in saved workflow JSON. Use the same secret on every machine that should decrypt those workflows. Leave empty to use a browser-local key instead.          |
| **Save Password in Workflow**           | When enabled (default), node passwords are included in saved workflow JSON (encrypted when a secret is set). When disabled, passwords are omitted on save; username and **use_credentials** are still saved. |


> [!NOTE]
> **Save Password in Workflow** is enforced in the frontend when serializing the graph. It is synced to `settings.json` for persistence but does not affect backend upload logic.



### Timeout


| Setting                       | Purpose                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| **Health Check Timeout (s)**  | Seconds allowed for the reachability probe                     |
| **Assumed Bandwidth (MB/s)**  | Conservative bandwidth estimate for timeout math               |
| **Timeout Safety Multiplier** | Headroom factor applied to the theoretical transfer time       |
| **Minimum Timeout (s)**       | Floor so small files never get an unrealistically short window |


Settings are synced to `settings.json` in this pack via `/api/remoteupload/settings` and persist across restarts. Connection defaults (address, port, and credentials) are applied when a **new** node is placed on the canvas — not when opening or duplicating an existing workflow that already has connection data.

---



## Remote Server Protocol

These nodes expect a compatible HTTP server listening at the configured address and port. The upload endpoint must accept:

```
POST http://{address}:{port}/upload
Content-Type: multipart/form-data

files: (filename, binary data, mime type)
```

The server root (`http://{address}:{port}/`) must respond to `GET` for the health check to pass. A `401` without credentials is accepted as reachable (server is online but protected).

When **use_credentials** is enabled on a node and **username** is set, both the health check and upload requests include an HTTP Basic `Authorization` header built from that node's **username** and **password**.

> [!TIP]
> Any simple file-receive server that accepts multipart `files` uploads on `/upload` will work. For local testing, point **address** to `127.0.0.1` and **port** to your receiver (e.g. `8000`).

---



## Example Usage

A typical image-upload workflow:

1. Add a **Remote Server Upload** node at the end of your pipeline.
2. Connect your final **Image** output.
3. Set **address** and **port** to your remote server (or rely on the global defaults).
4. If the server requires login, enable **use_credentials** and enter **username** / **password**.
5. Set **filename_prefix** (e.g. `renders/%date:yyyy-MM-dd%/%index%` → `renders/2026-07-09/00000.png`).
6. Queue the prompt — images are uploaded directly; nothing is written to ComfyUI's local `output/` folder. Watch the progress bar on the node for live status.

For dataset preparation:

1. Use **Remote Server Upload (Dataset)** with a list of images.
2. Optionally connect a matching list of caption strings to **texts**.
3. Each image uploads as `image_00000.png` (with default `image_%index%`) and its caption as `image_00000.txt`.

For video or LoRA hand-off to another machine:

1. Connect a **Save Video** or LoRA loader output to the corresponding upload node.
2. Large files benefit from tuning **Assumed Bandwidth** and **Safety Multiplier** in settings if uploads time out on slow links.

---



## Installation



### Method 1: ComfyUI Manager (Recommended)

1. Install [ComfyUI-Manager](https://github.com/ltdrdata/ComfyUI-Manager).
2. Click on **"Install via Git URL"**.
3. Paste the URL: `https://github.com/wakaura-asaho/comfyui-remoteserverupload`
4. Restart ComfyUI.



### Method 2: Manual Installation

1. Copy or clone this folder into `ComfyUI/custom_nodes/comfyui-remoteserverupload`.
2. Install dependencies into your ComfyUI Python environment (only if missing from your ComfyUI install):
  ```bash
   path\to\ComfyUI\python_embeded\python.exe -m pip install -r requirements.txt
  ```
   `requirements.txt` lists packages already bundled with ComfyUI (`requests`, `tqdm`, `safetensors`, `Pillow`, `numpy`). Do **not** install `torch` or `comfyui-frontend-package` from pip into an existing ComfyUI environment.
3. Restart ComfyUI.

---



## File Structure

- `remote_upload.py`: Node class definitions, upload logic, health check, and dynamic timeout.
- `upload_helper.py`: Filename prefix token resolver.
- `upload_progress.py`: Live progress tracking and WebSocket events to the frontend.
- `define.py`: Default settings constants and author metadata.
- `settings.json`: Persisted runtime settings (auto-created on first launch). Includes connection defaults, `save_password_in_workflow`, and timeout tuning.
- `requirements.txt`: Manual install dependencies with sensitive-package warnings.
- `pyproject.toml`: ComfyUI Registry metadata and dependency declarations for Manager.
- `__init__.py`: Node registration and `/api/remoteupload/settings` API routes.
- `web/remoteupload_settings.js`: ComfyUI Settings panel, filename token menu, and node default pre-fill.
- `web/remoteupload_credentials.js`: Credential widgets, password eye toggle, and workflow restore logic.
- `web/remoteupload_crypto.js`: AES-256-GCM encrypt/decrypt helpers for workflow password storage (`RUENC1:` prefix).
- `web/remoteupload_persistence.js`: Named `widgets_values` serialization, `remote_upload_credentials` property backup, clone support, and password stripping when **Save Password in Workflow** is off.
- `web/remoteupload_progress.js`: Upload progress bar DOM widget and event handlers.
- `web/eye_open.svg` / `web/eye_close.svg`: Password visibility toggle icons.
- `_temp/`: Temporary video and LoRA files during upload (created at runtime).



## Usage Tips

> [!TIP]
> **Filename tokens:** Right-click any upload node and choose **Insert Filename Token** to append a token without typing. Combine tokens freely, e.g. `uploads/%date:yyyy-MM-dd%/%hour%-%minute%_%index%`.

> [!TIP]
> **Re-queueing:** Upload nodes always run on every queue, even when inputs are unchanged — useful for repeatedly pushing renders to a remote machine.

> [!TIP]
> **Slow or Wi-Fi links:** Lower **Assumed Bandwidth (MB/s)** in settings and/or raise **Safety Multiplier** if large video or LoRA uploads time out.

> [!TIP]
> **Health check failures:** Confirm the remote server is running, the port is open, and the root URL responds to `GET` before blaming the upload step. If the server always returns `401`, enable **use_credentials** and set **username** / **password** — an unauthenticated `401` alone does not fail the probe.

> [!TIP]
> **Dataset captions:** Connect one caption string per image in the same order. Images without a matching caption entry are still uploaded; only the `.txt` sidecar is skipped.

> [!TIP]
> **LoRA input:** Use the dedicated LoRA model output. Do not feed a checkpoint that already has LoRA layers baked in — the node serializes a raw LoRA state dict.

> [!TIP]
> **Credential defaults:** Set **Use Credentials by Default**, **Default Username**, and **Default Password** under **Remote Server Upload → Connection** so new nodes start with your usual login. Use **Save Password in Workflow** under **Security** to control whether node passwords are written into workflow files. Duplicated or loaded nodes keep their own saved values.

> [!TIP]
> **Sharing workflows securely:** Either disable **Save Password in Workflow** so passwords never enter the JSON, or leave it enabled and rely on **Workflow Password Encryption Secret** (`RUENC1:...` blobs). Share any encryption passphrase separately. Usernames are still stored in plain text unless you clear them before saving.

> [!WARNING]
> **Encryption limits:** Workflow encryption hides passwords from casual inspection of the JSON file. It is not a substitute for a dedicated secrets manager. Disabling **Save Password in Workflow** is the stronger option when you do not want passwords in workflow files at all. The encryption secret in ComfyUI settings and `default_password` in `settings.json` are still stored as plain text on disk in their respective locations.



## Compatible Versions and Notices

Designed for modern ComfyUI versions (V3 nodes).

- Tested Environment: ComfyUI >= 0.12.3, Frontend >= v1.37.11
- Runtime dependencies: `requests`, `tqdm`, `safetensors>=0.4.2`, `Pillow`, `numpy>=1.25.0`
- See `requirements.txt` for the dependency list; all listed packages ship with a standard ComfyUI install.

