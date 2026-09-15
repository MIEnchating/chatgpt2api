"""Decode complete SSE data events without authenticated client dependencies."""

from typing import Iterator


def iter_sse_payloads(response) -> Iterator[str]:
    data_lines: list[str] = []
    for index, raw_line in enumerate(response.iter_lines()):
        line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else raw_line
        if index == 0:
            line = line.removeprefix("\ufeff")
        if not line:
            if data_lines:
                yield "\n".join(data_lines)
                data_lines.clear()
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        if field != "data":
            continue
        if value.startswith(" "):
            value = value[1:]
        data_lines.append(value)
    # SSE dispatch requires a blank line; an incomplete final event is discarded.
