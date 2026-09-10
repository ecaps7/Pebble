"""共享 fixture：把实例持久目录指向临时路径，避免测试写入真实 .data。"""

from collections.abc import Iterator

import pytest

from server.config import Settings, get_settings


@pytest.fixture
def settings(tmp_path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Settings]:
    monkeypatch.setenv("PEBBLE_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield get_settings()
    get_settings.cache_clear()
