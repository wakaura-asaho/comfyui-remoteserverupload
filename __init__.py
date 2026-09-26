import logging
from comfy_api.latest import ComfyExtension, io
from .remote_upload import (
    RemoteServerUpload,
    RemoteServerUploadVideo,
    RemoteServerUploadLoRA,
    RemoteServerUploadDataset,
    apply_settings,
)
from .define import define

logger = logging.getLogger(define.logger_name)

WEB_DIRECTORY = "./web"
__all__ = ["WEB_DIRECTORY"]

class RemoteServerUploadExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            RemoteServerUpload,
            RemoteServerUploadVideo,
            RemoteServerUploadLoRA,
            RemoteServerUploadDataset,
        ]

async def comfy_entrypoint() -> RemoteServerUploadExtension:
    return RemoteServerUploadExtension()

def _setup_settings_api():
    try:
        from aiohttp import web
        from server import PromptServer

        settings_path = "/api/wakaura/remoteupload/settings"

        @PromptServer.instance.routes.get(settings_path)
        async def get_remoteupload_settings(request):
            return web.json_response(define._settings)

        @PromptServer.instance.routes.post(settings_path)
        async def post_remoteupload_settings(request):
            try:
                data = await request.json()
                logger.info(
                    f"Received {len(data)} key(s) from frontend: "
                    f"{list(data.keys())}"
                )
                if not data:
                    logger.warning(
                        "Warning: payload is empty.\n"
                        "Frontend may be sending before settings are initialised."
                    )
                    return web.json_response({"status": "ok", "settings": define._settings})
                apply_settings(data)
                logger.info(f"Active settings after update: {define._settings}")
                return web.json_response({"status": "ok", "settings": define._settings})
            except Exception as exc:
                logger.error(f"Error applying settings: {exc}")
                return web.json_response(
                    {"status": "error", "error": str(exc)}, status=400
                )

    except Exception as exc:
        logger.error(f"Could not register API routes: {exc}")

_setup_settings_api()