"""存活与依赖自检：确认服务、配置和数据库可用。"""

from fastapi import APIRouter

from server.config import get_settings
from server.db import schema_version, session

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict[str, object]:
    settings = get_settings()
    with session() as conn:
        version = schema_version(conn)
        journal_mode = conn.execute("PRAGMA journal_mode").fetchone()["journal_mode"]
    return {
        "status": "ok",
        "data_dir": str(settings.data_dir),
        "schema_version": version,
        "journal_mode": journal_mode,
    }
