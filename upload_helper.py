import re
from datetime import datetime

class UploadFilenameHelper:
    @staticmethod
    def resolve_filename_prefix(
        prefix: str,
        image_width: int = 0,
        image_height: int = 0,
        batch_index: int | None = None,
    ) -> str:
        """
        Resolve template tokens in a filename prefix string.
        """
        if "%" not in prefix and batch_index is None:
            return prefix

        now = datetime.now()

        def _replace_date(m: re.Match) -> str:
            fmt = m.group(1)
            fmt = fmt.replace("yyyy", now.strftime("%Y"))
            fmt = fmt.replace("yy", now.strftime("%y"))
            fmt = fmt.replace("MM", now.strftime("%m"))
            fmt = fmt.replace("dd", now.strftime("%d"))
            fmt = fmt.replace("HH", now.strftime("%H"))
            fmt = fmt.replace("hh", now.strftime("%I"))
            fmt = fmt.replace("mm", now.strftime("%M"))
            fmt = fmt.replace("ss", now.strftime("%S"))
            return fmt

        if "%" in prefix:
            prefix = re.sub(r"%date:([^%]+)%", _replace_date, prefix)

            prefix = prefix.replace("%year%", now.strftime("%Y"))
            prefix = prefix.replace("%month%", now.strftime("%m"))
            prefix = prefix.replace("%day%", now.strftime("%d"))
            prefix = prefix.replace("%hour%", now.strftime("%H"))
            prefix = prefix.replace("%minute%", now.strftime("%M"))
            prefix = prefix.replace("%second%", now.strftime("%S"))
            prefix = prefix.replace("%width%", str(image_width))
            prefix = prefix.replace("%height%", str(image_height))

        if batch_index is not None:
            prefix = prefix.replace("%batch_num%", str(batch_index))
            prefix = prefix.replace("%index%", f"{batch_index:05d}")

        return prefix

    @staticmethod
    def make_upload_filename(
        prefix: str,
        ext: str,
        image_width: int = 0,
        image_height: int = 0,
        batch_index: int | None = None,
    ) -> str:
        resolved = UploadFilenameHelper.resolve_filename_prefix(
            prefix, image_width, image_height, batch_index
        )
        return f"{resolved}.{ext}"