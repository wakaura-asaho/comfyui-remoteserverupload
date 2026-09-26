import io as io_lib
import json
import os
import time
import uuid
import urllib.parse
import numpy as np
import requests
from requests.auth import HTTPBasicAuth
import logging
import torch
import safetensors.torch
from tqdm import tqdm
from .define import define
from .upload_helper import UploadFilenameHelper
from .upload_progress import UploadProgressTracker
from comfy_api.latest import io
from comfy_api.latest._input.video_types import VideoInput
from PIL import Image

_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "settings.json")
_TEMP_DIR = os.path.join(os.path.dirname(__file__), "_temp")

_FILENAME_PREFIX_TOOLTIP = (
    "Base name for uploaded files. Supports tokens such as "
    "%date:yyyy-MM-dd%, %year%, %hour%, %width%, %height%, %batch_num%, and %index%."
)

logger = logging.getLogger(define.logger_name)

def _load_config() -> None:
    if not os.path.exists(_CONFIG_PATH):
        logger.warning("settings.json not found: create default settings.json")
        with open(_CONFIG_PATH, "w", encoding="utf-8") as fh:
            json.dump(define._settings, fh, indent=4)
        return
    try:
        with open(_CONFIG_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        for key in define._settings:
            if key in data:
                define._settings[key] = data[key]
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning(f"Could not read settings.json: {exc}")


def save_config() -> None:
    try:
        with open(_CONFIG_PATH, "w", encoding="utf-8") as fh:
            json.dump(define._settings, fh, indent=4)
    except OSError as exc:
        logger.warning(f"Could not write settings.json: {exc}")


def apply_settings(new_settings: dict) -> None:
    """
    Merge *new_settings* into the live dict and persist to disk.
    """
    type_map = {
        "default_address": str,
        "default_port": int,
        "default_use_credentials": bool,
        "default_username": str,
        "default_password": str,
        "save_password_in_workflow": bool,
        "health_connect_timeout": float,
        "assumed_bandwidth_mbps": float,
        "safety_multiplier": float,
        "min_timeout": float,
    }
    for k, v in new_settings.items():
        if k in type_map:
            try:
                if type_map[k] is bool:
                    if isinstance(v, bool):
                        define._settings[k] = v
                    elif isinstance(v, str):
                        define._settings[k] = v.lower() in ("true", "1", "yes")
                    else:
                        define._settings[k] = bool(v)
                else:
                    define._settings[k] = type_map[k](v)
            except (ValueError, TypeError):
                pass
    save_config()


_load_config()


def tensor2pil(image: torch.Tensor) -> Image.Image:
    return Image.fromarray(
        np.clip(255.0 * image.cpu().numpy().squeeze(), 0, 255).astype(np.uint8)
    )


def _safe_video_ext(video: VideoInput) -> str:
    """
    Detect the video container extension without triggering BytesIO encoding.
    Only trusts get_stream_source() when it returns a str path (VideoFromFile).
    Falls back to 'mp4' for VideoFromComponents and all other cases.
    """
    try:
        source = video.get_stream_source()
        if isinstance(source, str):
            ext = os.path.splitext(source)[1].lstrip(".").lower()
            if ext:
                return ext
    except Exception:
        pass
    return "mp4"


def _save_video_to_temp(video: VideoInput, ext: str) -> str:
    """
    Write the video to a uniquely-named temp file and return its path.
    A real file path lets PyAV infer the container format from the extension,
    which works on all ComfyUI versions.
    """
    os.makedirs(_TEMP_DIR, exist_ok=True)
    temp_path = os.path.join(_TEMP_DIR, f"upload_{uuid.uuid4().hex}.{ext}")
    video.save_to(temp_path)
    return temp_path


def _save_lora_to_temp(lora: dict) -> str:
    """Write LoRA state dict to a uniquely-named temp .safetensors file."""
    os.makedirs(_TEMP_DIR, exist_ok=True)
    temp_path = os.path.join(_TEMP_DIR, f"upload_{uuid.uuid4().hex}.safetensors")
    safetensors.torch.save_file(lora, temp_path)
    return temp_path


def _server_root(upload_url: str) -> str:
    """Return scheme://host:port/ derived from the upload endpoint URL."""
    p = urllib.parse.urlparse(upload_url)
    return urllib.parse.urlunparse(p._replace(path="/", query="", fragment=""))


def _resolve_auth(
    use_credentials: bool, username: str, password: str
) -> HTTPBasicAuth | None:
    if not use_credentials or not username:
        return None
    return HTTPBasicAuth(username, password)


def _connection_inputs() -> list:
    return [
        io.String.Input("address", default=define._settings["default_address"]),
        io.Int.Input(
            "port",
            default=define._settings["default_port"],
            min=1,
            max=65535,
            step=1,
        ),
        io.Boolean.Input(
            "use_credentials",
            default=define._settings["default_use_credentials"],
            tooltip="Enable HTTP Basic Authentication when the target server requires credentials.",
        ),
        io.String.Input(
            "username",
            default=define._settings["default_username"],
            tooltip="Username for HTTP Basic Authentication.",
        ),
        io.String.Input(
            "password",
            default=define._settings["default_password"],
            tooltip="Password for HTTP Basic Authentication.",
        ),
    ]


def _health_ok(status_code: int, auth: HTTPBasicAuth | None) -> bool:
    if status_code < 400:
        return True
    if status_code == 401 and auth is None:
        return True
    return False


def _check_health(upload_url: str, auth: HTTPBasicAuth | None = None) -> tuple[bool, float]:
    """
    Probe the server with GET on its root path.
    Returns (reachable, rtt_seconds).
    """
    root = _server_root(upload_url)
    timeout = define._settings["health_connect_timeout"]
    response = None
    t0 = time.monotonic()
    try:
        response = requests.get(
            root, timeout=timeout, allow_redirects=False, auth=auth, stream=True
        )
        rtt = time.monotonic() - t0
        if _health_ok(response.status_code, auth):
            logger.info(
                f"Health check OK: {root} ({response.status_code}, {rtt * 1000:.0f} ms RTT)"
            )
            return True, rtt
        logger.warning(
            f"Health check FAILED: {root} returned HTTP {response.status_code}"
        )
    except requests.exceptions.RequestException as exc:
        logger.warning(f"Health check FAILED: {root} is unreachable ({exc})")
    finally:
        if response is not None:
            response.close()
    return False, 0.0


class _TqdmReader:
    """Binary IO wrapper that reports read progress to a tqdm bar."""

    def __init__(self, file_obj, pbar: tqdm):
        self._file = file_obj
        self._pbar = pbar

    def read(self, size=-1):
        data = self._file.read(size)
        if data:
            self._pbar.update(len(data))
        return data

    def seek(self, offset, whence=0):
        return self._file.seek(offset, whence)

    def tell(self):
        return self._file.tell()


def _dynamic_timeout(file_size: int, rtt: float) -> float:
    """
    Derive upload timeout from file size and measured RTT.
    All tuning constants are read live from _settings.
    """
    bandwidth = define._settings["assumed_bandwidth_mbps"] * 1024 * 1024
    rtt_buffer = rtt * 2
    transfer_secs = file_size / bandwidth
    timeout = rtt_buffer + transfer_secs * define._settings["safety_multiplier"]
    return max(define._settings["min_timeout"], timeout)


def _post_file(
    url: str,
    filename: str,
    file_obj,
    mime: str,
    label: str,
    timeout: float,
    pbar: tqdm | None = None,
    auth: HTTPBasicAuth | None = None,
) -> str | None:
    """
    POST a single file to *url*.
    *file_obj* may be any seekable binary IO (BytesIO or open file handle).
    When *pbar* is given, bytes read from *file_obj* advance the bar.
    Returns an error string on failure, None on success.
    """
    file_obj.seek(0)
    upload_obj = _TqdmReader(file_obj, pbar) if pbar is not None else file_obj
    response = None
    try:
        response = requests.post(
            url,
            files={"files": (filename, upload_obj, mime)},
            timeout=timeout,
            auth=auth,
            stream=True,
        )
        response.raise_for_status()
        logger.info(f"Uploaded {filename} -> {url} ({response.status_code})")
        return None
    except requests.exceptions.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 401:
            return (
                f"[{label}] Authentication failed for {filename}: "
                "check use_credentials, username, and password."
            )
        return f"[{label}] HTTP error for {filename}: {exc}"
    except requests.exceptions.Timeout as exc:
        return f"[{label}] Timeout ({timeout:.1f}s) for {filename}: {exc}"
    except requests.exceptions.RequestException as exc:
        return f"[{label}] Request failed for {filename}: {exc}"
    finally:
        if response is not None:
            response.close()


def _dataset_upload_total(images, texts) -> int:
    total = len(images)
    if texts:
        total += min(len(texts), len(images))
    return total


def _finish_upload(tracker: UploadProgressTracker) -> io.NodeOutput:
    data = tracker.as_dict()
    tracker.finish()
    # ComfyUI merges UI dict values as iterables; wrap the payload in a list.
    return io.NodeOutput(ui={"upload_progress": [data]})


class _RemoteUploadNodeBase(io.ComfyNode):
    @classmethod
    def fingerprint_inputs(cls, **kwargs) -> float:
        return time.time()


class RemoteServerUpload(_RemoteUploadNodeBase):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="RemoteServerUpload",
            display_name="Remote Server Upload",
            category=define.author,
            inputs=[
                io.Image.Input("images"),
                io.String.Input(
                    "filename_prefix",
                    default="image_%index%",
                    tooltip=_FILENAME_PREFIX_TOOLTIP,
                ),
                *_connection_inputs(),
            ],
            outputs=[],
            is_output_node=True,
            not_idempotent=True,
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(
        cls,
        images,
        filename_prefix: str,
        address: str,
        port: int,
        use_credentials: bool,
        username: str,
        password: str,
    ) -> io.NodeOutput:
        url = f"http://{address}:{port}/upload"
        auth = _resolve_auth(use_credentials, username, password)

        reachable, rtt = _check_health(url, auth=auth)
        if not reachable:
            raise RuntimeError(
                f"{NODEPACK_TITLE}: server at {_server_root(url)} is unreachable."
            )

        errors = []
        tracker = UploadProgressTracker(cls, len(images))

        with tqdm(total=len(images), desc="Uploading images", unit="file") as pbar:
            for batch_index, image in enumerate(images):
                buf = io_lib.BytesIO()
                tensor2pil(image).save(buf, format="PNG")
                timeout = _dynamic_timeout(buf.tell(), rtt)
                filename = UploadFilenameHelper.make_upload_filename(
                    filename_prefix,
                    "png",
                    image_width=image.shape[1],
                    image_height=image.shape[0],
                    batch_index=batch_index,
                )
                logger.info(
                    f"{filename}: "
                    f"size={buf.tell() / 1024:.1f} KB, timeout={timeout:.1f}s"
                )
                file_pbar = tqdm(
                    total=buf.tell(),
                    desc=filename,
                    unit="B",
                    unit_scale=True,
                    leave=False,
                )
                err = _post_file(
                    url,
                    filename,
                    buf,
                    "image/png",
                    "RemoteServerUpload",
                    timeout,
                    pbar=file_pbar,
                    auth=auth,
                )
                file_pbar.close()
                if err:
                    logger.error(err)
                    errors.append(err)
                    tracker.mark_failed()
                else:
                    tracker.mark_received()
                pbar.update(1)

        if errors:
            tracker.finish()
            raise RuntimeError(
                f"{NODEPACK_TITLE}: {len(errors)} of {len(images)} image(s) failed to upload.\n"
                + "\n".join(errors)
            )

        return _finish_upload(tracker)


class RemoteServerUploadVideo(_RemoteUploadNodeBase):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="RemoteServerUploadVideo",
            display_name="Remote Server Upload (Video)",
            category=define.author,
            inputs=[
                io.Video.Input("video"),
                io.String.Input(
                    "filename_prefix",
                    default="video",
                    tooltip=_FILENAME_PREFIX_TOOLTIP,
                ),
                *_connection_inputs(),
            ],
            outputs=[],
            is_output_node=True,
            not_idempotent=True,
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(
        cls,
        video,
        filename_prefix: str,
        address: str,
        port: int,
        use_credentials: bool,
        username: str,
        password: str,
    ) -> io.NodeOutput:
        url = f"http://{address}:{port}/upload"
        auth = _resolve_auth(use_credentials, username, password)

        reachable, rtt = _check_health(url, auth=auth)
        if not reachable:
            raise RuntimeError(
                f"{NODEPACK_TITLE}: server at {_server_root(url)} is unreachable for video upload."
            )

        tracker = UploadProgressTracker(cls, 1)
        ext = _safe_video_ext(video)
        filename = UploadFilenameHelper.make_upload_filename(filename_prefix, ext)

        temp_path = _save_video_to_temp(video, ext)
        file_size = os.path.getsize(temp_path)
        timeout = _dynamic_timeout(file_size, rtt)
        logger.info(
            f"{filename}: "
            f"size={file_size / (1024 * 1024):.2f} MB, timeout={timeout:.1f}s"
        )

        try:
            with (
                tqdm(
                    total=file_size,
                    desc=f"Uploading {filename}",
                    unit="B",
                    unit_scale=True,
                ) as pbar,
                open(temp_path, "rb") as fh,
            ):
                err = _post_file(
                    url,
                    filename,
                    fh,
                    f"video/{ext}",
                    "RemoteServerUploadVideo",
                    timeout,
                    pbar=pbar,
                    auth=auth,
                )
        except OSError as exc:
            tracker.mark_failed()
            tracker.finish()
            raise RuntimeError(
                f"{NODEPACK_TITLE}: could not read temp video file {temp_path}.\n{exc}"
            ) from exc

        if err:
            logger.error(err)
            logger.error(f"Upload failed: local copy kept at: {temp_path}")
            tracker.mark_failed()
            tracker.finish()
            raise RuntimeError(
                f"{NODEPACK_TITLE}: failed to upload video {filename}.\n{err}"
            )

        tracker.mark_received()
        try:
            os.remove(temp_path)
        except OSError as exc:
            logger.warning(f"Warning: could not delete temp file\n{temp_path}: {exc}")

        return _finish_upload(tracker)


class RemoteServerUploadLoRA(_RemoteUploadNodeBase):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="RemoteServerUploadLoRA",
            display_name="Remote Server Upload (LoRA)",
            category=define.author,
            inputs=[
                io.Custom("LORA_MODEL").Input(
                    "lora",
                    tooltip="The LoRA model to upload. Do not use the model with LoRA layers.",
                ),
                io.String.Input(
                    "filename_prefix",
                    default="lora",
                    tooltip=_FILENAME_PREFIX_TOOLTIP,
                ),
                *_connection_inputs(),
            ],
            outputs=[],
            is_output_node=True,
            not_idempotent=True,
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(
        cls,
        lora,
        filename_prefix: str,
        address: str,
        port: int,
        use_credentials: bool,
        username: str,
        password: str,
    ) -> io.NodeOutput:
        url = f"http://{address}:{port}/upload"
        auth = _resolve_auth(use_credentials, username, password)

        reachable, rtt = _check_health(url, auth=auth)
        if not reachable:
            raise RuntimeError(
                f"{NODEPACK_TITLE}: server at {_server_root(url)} is unreachable for LoRA upload."
            )

        tracker = UploadProgressTracker(cls, 1)
        filename = UploadFilenameHelper.make_upload_filename(
            filename_prefix, "safetensors"
        )

        temp_path = _save_lora_to_temp(lora)
        file_size = os.path.getsize(temp_path)
        timeout = _dynamic_timeout(file_size, rtt)
        logger.info(
            f"{filename}: "
            f"size={file_size / (1024 * 1024):.2f} MB, timeout={timeout:.1f}s"
        )

        try:
            with (
                tqdm(
                    total=file_size,
                    desc=f"Uploading {filename}",
                    unit="B",
                    unit_scale=True,
                ) as pbar,
                open(temp_path, "rb") as fh,
            ):
                err = _post_file(
                    url,
                    filename,
                    fh,
                    "application/octet-stream",
                    "RemoteServerUploadLoRA",
                    timeout,
                    pbar=pbar,
                    auth=auth,
                )
        except OSError as exc:
            tracker.mark_failed()
            tracker.finish()
            raise RuntimeError(
                f"{NODEPACK_TITLE}: could not read temp LoRA file {temp_path}.\n{exc}"
            ) from exc

        if err:
            logger.error(err)
            logger.error(f"Upload failed: local copy kept at: {temp_path}")
            tracker.mark_failed()
            tracker.finish()
            raise RuntimeError(
                f"{NODEPACK_TITLE}: failed to upload LoRA {filename}.\n{err}"
            )

        tracker.mark_received()
        try:
            os.remove(temp_path)
        except OSError as exc:
            logger.warning(f"Warning: could not delete temp file\n{temp_path}: {exc}")

        return _finish_upload(tracker)


class RemoteServerUploadDataset(_RemoteUploadNodeBase):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="RemoteServerUploadDataset",
            display_name="Remote Server Upload (Dataset)",
            category=define.author,
            is_input_list=True,
            inputs=[
                io.Image.Input("images", tooltip="List of images to upload."),
                io.String.Input(
                    "texts",
                    optional=True,
                    force_input=True,
                    tooltip="List of text captions to upload alongside each image.",
                ),
                io.String.Input(
                    "filename_prefix",
                    default="image_%index%",
                    tooltip=_FILENAME_PREFIX_TOOLTIP,
                ),
                *_connection_inputs(),
            ],
            outputs=[],
            is_output_node=True,
            not_idempotent=True,
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def execute(
        cls,
        images,
        filename_prefix,
        address,
        port,
        use_credentials,
        username,
        password,
        texts=None,
    ) -> io.NodeOutput:
        filename_prefix = filename_prefix[0]
        address = address[0]
        port = port[0]
        use_credentials = use_credentials[0]
        username = username[0]
        password = password[0]

        url = f"http://{address}:{port}/upload"
        auth = _resolve_auth(use_credentials, username, password)

        reachable, rtt = _check_health(url, auth=auth)
        if not reachable:
            raise RuntimeError(
                f"{NODEPACK_TITLE}: server at {_server_root(url)} is unreachable for dataset upload."
            )

        errors = []
        total_files = _dataset_upload_total(images, texts)
        tracker = UploadProgressTracker(cls, total_files)

        with tqdm(total=total_files, desc="Uploading dataset", unit="file") as pbar:
            for batch_index, image in enumerate(images):
                base_name = UploadFilenameHelper.make_upload_filename(
                    filename_prefix,
                    "png",
                    image_width=image.shape[1],
                    image_height=image.shape[0],
                    batch_index=batch_index,
                )

                buf = io_lib.BytesIO()
                tensor2pil(image).save(buf, format="PNG")
                timeout = _dynamic_timeout(buf.tell(), rtt)
                logger.info(
                    f"{base_name}: "
                    f"size={buf.tell() / 1024:.1f} KB, timeout={timeout:.1f}s"
                )
                file_pbar = tqdm(
                    total=buf.tell(),
                    desc=base_name,
                    unit="B",
                    unit_scale=True,
                    leave=False,
                )
                err = _post_file(
                    url,
                    base_name,
                    buf,
                    "image/png",
                    "RemoteServerUploadDataset",
                    timeout,
                    pbar=file_pbar,
                    auth=auth,
                )
                file_pbar.close()
                if err:
                    logger.error(err)
                    errors.append(err)
                    tracker.mark_failed()
                else:
                    tracker.mark_received()
                pbar.update(1)

                if texts and batch_index < len(texts):
                    caption = texts[batch_index]
                    caption_name = base_name.replace(".png", ".txt")
                    caption_buf = io_lib.BytesIO(caption.encode("utf-8"))
                    caption_size = caption_buf.getbuffer().nbytes
                    timeout = _dynamic_timeout(caption_size, rtt)
                    file_pbar = tqdm(
                        total=caption_size,
                        desc=caption_name,
                        unit="B",
                        unit_scale=True,
                        leave=False,
                    )
                    err = _post_file(
                        url,
                        caption_name,
                        caption_buf,
                        "text/plain",
                        "RemoteServerUploadDataset",
                        timeout,
                        pbar=file_pbar,
                        auth=auth,
                    )
                    file_pbar.close()
                    if err:
                        logger.error(err)
                        errors.append(err)
                        tracker.mark_failed()
                    else:
                        tracker.mark_received()
                    pbar.update(1)

        if errors:
            tracker.finish()
            raise RuntimeError(
                f"{NODEPACK_TITLE}: {len(errors)} error(s) occurred while uploading the dataset.\n"
                + "\n".join(errors)
            )

        return _finish_upload(tracker)
