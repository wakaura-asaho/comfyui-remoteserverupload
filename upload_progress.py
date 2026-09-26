import logging

logger = logging.getLogger("RemoteServerUpload")

class UploadProgressTracker:
    """Track per-file upload progress and push live updates to the frontend."""

    def __init__(self, node_cls, total: int):
        self.node_cls = node_cls
        self.total = max(0, total)
        self.received = 0
        self.failed = 0
        self._report(done=False)

    def mark_received(self, count: int = 1) -> None:
        self.received += count
        self._report()

    def mark_failed(self, count: int = 1) -> None:
        self.failed += count
        self._report()

    def finish(self) -> None:
        self._report(done=True)

    def as_dict(self) -> dict:
        return {
            "total": self.total,
            "received": self.received,
            "failed": self.failed,
        }

    def _report(self, done: bool = False) -> None:
        node_id = getattr(getattr(self.node_cls, "hidden", None), "unique_id", None)
        if not node_id:
            return
        try:
            from server import PromptServer

            PromptServer.instance.send_sync(
                "remoteupload_progress",
                {
                    "node_id": str(node_id),
                    "total": self.total,
                    "received": self.received,
                    "failed": self.failed,
                    "done": done,
                },
            )
        except Exception as exc:
            logger.debug(f"Could not send upload progress: {exc}")
