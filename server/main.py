"""服务启动：创建 FastAPI 应用、初始化数据库并注册路由。

SDK 客户端装配与工具注册在第一阶段验证后接入 lifespan。
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from server.api.health import router as health_router
from server.db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    init_db()
    yield


app = FastAPI(title="Pebble", lifespan=lifespan)
app.include_router(health_router, prefix="/api")


if __name__ == "__main__":
    import uvicorn

    from server.config import get_settings

    settings = get_settings()
    uvicorn.run("server.main:app", host=settings.host, port=settings.port, reload=True)
